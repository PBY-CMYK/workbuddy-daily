#!/usr/bin/env node
/**
 * 探活：确认 checkin-status 当前（已签到后）返回的积分字段语义
 * 以及是否存在「今日已用」类字段。
 * 只读查询，不产生写操作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tok = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'token.local.json'), 'utf8'));

const ENDPOINT = 'https://copilot.tencent.com';
const headers = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${tok.accessToken}`,
  'X-Product-Code': 'workbuddy',
  'X-Client-Platform': 'web',
  'X-User-Id': tok.uid,
  'User-Agent': 'workbuddy-daily-probe/1.0',
};

async function call(method, p, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(ENDPOINT + p, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, err: e.message, cause: e?.cause?.code || '' };
  } finally {
    clearTimeout(timer);
  }
}

// 1) 主接口：checkin-status（查询语义）
const st = await call('POST', '/billing/meter/checkin-status', {});
console.log('===== checkin-status HTTP', st.status, '=====');
if (st.json) {
  const d = st.json?.data ?? {};
  console.log(JSON.stringify({
    code: st.json.code, msg: st.json.msg,
    data: {
      today_checked_in: d.today_checked_in,
      total_credits: d.total_credits,
      today_credit: d.today_credit,
      daily_credit: d.daily_credit,
      streak_days: d.streak_days,
      // 全量字段名清单（找有没有 used/consume/spent 类字段）
      all_keys: Object.keys(d),
    },
  }, null, 2));
} else {
  console.log('NO JSON', st.err, st.cause);
}

// 2) 候选「用量/流水」接口（只读试探，失败即略）
const candidates = [
  ['POST', '/billing/meter/usage-status', {}],
  ['POST', '/billing/meter/usage', {}],
  ['GET',  '/billing/meter/usage', undefined],
  ['GET',  '/billing/meter/summary', undefined],
];
for (const [m, p, b] of candidates) {
  const r = await call(m, p, b);
  const ok = r.json && r.json.code === 0;
  console.log(`----- probe ${m} ${p} → HTTP ${r.status}${ok ? ' code=0(存在!)' : ''}`);
  if (ok) {
    console.log(JSON.stringify(r.json, null, 2).slice(0, 1500));
  }
}
