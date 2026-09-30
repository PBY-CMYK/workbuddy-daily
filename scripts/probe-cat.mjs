#!/usr/bin/env node
/**
 * 派猫猫旅行 —— 只读探针 / 抓包脚本
 *
 * 用途：在你自己的机器上（有本机登录态）跑一次，把 travel 四个接口的
 * 「原始返回（脱敏后）」打出来，用来验收接口口径、确认 state 取值与
 * locations 的 id 形态。它 **不会** 真的派出猫（默认 dry），
 * 只有显式加 --depart 才会真正调 depart。
 *
 * 接口来源（抓包自官网成长中心 bundle，非网上流传的旧接口）：
 *   growthSpace-EIUE4QaA.js:
 *     Q=()=>e.get("/activity/growth/buddy/travel/config")
 *     W=()=>e.get("/activity/growth/buddy/travel/status")
 *     Y=t=>e.post("/activity/growth/buddy/travel/depart",{location_id:t})
 *     j=()=>e.post("/activity/growth/buddy/travel/claim",{})
 *   GrowthCenterPage-BZwm0xmj.js 别名映射：
 *     import{O as ms,P as us,Q as hs,R as gs}from"./growthSpace-EIUE4QaA.js"
 *
 * 用法：
 *   node scripts/probe-cat.mjs                     # 只查 status + config
 *   node scripts/probe-cat.mjs --depart            # 查完并真的派一趟
 *   node scripts/probe-cat.mjs --claim             # 顺带试领到家积分
 *   node scripts/probe-cat.mjs --platform=miniprogram   # 换客户端平台头
 *
 * 环境变量：
 *   WORKBUDDY_ACCESS_TOKEN   必填（从桌面登录态导出）
 *   WORKBUDDY_WEB_ENDPOINT   默认 https://www.workbuddy.cn
 *   WORKBUDDY_USER_ID        可选
 */

import process from 'node:process';
import { sanitize } from './checkin.mjs';

const BASE = (process.env.WORKBUDDY_WEB_ENDPOINT || 'https://www.workbuddy.cn').replace(/\/+$/, '');
const TOKEN = (process.env.WORKBUDDY_ACCESS_TOKEN || '').trim();
const USER_ID = (process.env.WORKBUDDY_USER_ID || '').trim();

const args = process.argv.slice(2);
const DO_DEPART = args.includes('--depart');
const DO_CLAIM = args.includes('--claim');
const PLATFORM = (args.find((a) => a.startsWith('--platform='))?.split('=')[1]) || 'web';
const LOCATION_ID = args.find((a) => a.startsWith('--location='))?.split('=')[1] || '';

if (!TOKEN) {
  console.error('[probe-cat] 缺少 WORKBUDDY_ACCESS_TOKEN');
  process.exit(1);
}

function ts() {
  return new Date().toISOString().slice(11, 19);
}

async function call(method, path, body) {
  const url = `${BASE}${path}`;
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TOKEN}`,
    'X-Product-Code': 'workbuddy',
    'X-Client-Platform': PLATFORM,
    'User-Agent': 'workbuddy-probe/1.0',
  };
  if (USER_ID) headers['X-User-Id'] = USER_ID;

  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const started = Date.now();
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  const ms = Date.now() - started;

  console.log(`\n${'='.repeat(78)}`);
  console.log(`[${ts()}] ${method} ${path}   -> HTTP ${res.status}  (${ms}ms)`);
  if (body !== undefined) console.log(`  req body : ${JSON.stringify(body)}`);
  console.log(`${'-'.repeat(78)}`);
  console.log(JSON.stringify(sanitize(json ?? text), null, 2));
  console.log(`${'='.repeat(78)}`);

  return { status: res.status, ok: res.ok, json };
}

console.log(`[probe-cat] base=${BASE} platform=${PLATFORM} depart=${DO_DEPART} claim=${DO_CLAIM}`);

// 1) 行程状态
const st = await call('GET', '/activity/growth/buddy/travel/status');
const travel = st.json?.data ?? null;
if (travel) {
  console.log(
    `\n[probe-cat] 解析: state=${travel.state} ` +
    `location=${travel.location?.name ?? travel.location?.id ?? '-'} ` +
    `arrive_at=${travel.arrive_at ?? 0} ` +
    `daily_limit_reached=${travel.daily_limit_reached}`
  );
}

// 2) 到家积分
if (DO_CLAIM) {
  await call('POST', '/activity/growth/buddy/travel/claim', {});
}

// 3) 地点配置
const cfg = await call('GET', '/activity/growth/buddy/travel/config');
const locations = cfg.json?.data?.locations ?? [];
if (locations.length) {
  console.log(`\n[probe-cat] 可用地点 ${locations.length} 个：`);
  for (const l of locations.slice(0, 10)) {
    console.log(`   - id=${l.id} name=${l.name ?? '-'}`);
  }
} else {
  console.log('\n[probe-cat] 警告：locations 为空，无法派猫');
}

// 4) 派猫（需显式 --depart）
if (DO_DEPART) {
  const locId = LOCATION_ID || locations[0]?.id;
  if (!locId) {
    console.error('\n[probe-cat] 没有可用的 location_id，跳过 depart');
    process.exit(2);
  }
  console.log(`\n[probe-cat] >>> 即将真实派出，location_id=${locId}`);
  const dep = await call('POST', '/activity/growth/buddy/travel/depart', { location_id: locId });
  if (dep.json?.code === 0) {
    console.log('[probe-cat] ✅ 派猫成功');
  } else {
    console.log(`[probe-cat] ❌ 派猫失败：${dep.json?.msg ?? 'unknown'}`);
  }
} else {
  console.log('\n[probe-cat] 未加 --depart，未真实派猫（只读探针）');
}
