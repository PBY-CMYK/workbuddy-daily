#!/usr/bin/env node
/**
 * 把 checkin.mjs 的结果推送到飞书群自定义机器人。
 *
 * 用法：
 *   node scripts/notify-feishu.mjs                 # 读 result.json
 *   WORKBUDDY_RESULT_FILE=xxx node scripts/notify-feishu.mjs
 *
 * 环境变量：
 *   FEISHU_WEBHOOK_URL  飞书群自定义机器人 webhook（必填）
 *   FEISHU_WEBHOOK_SECRET  若机器人开启了「签名校验」则必填
 *
 * 需求：签到和猫猫的状态分开写清楚。
 */

import process from 'node:process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const WEBHOOK = (process.env.FEISHU_WEBHOOK_URL || '').trim();
const SECRET = (process.env.FEISHU_WEBHOOK_SECRET || '').trim();
const RESULT_FILE = process.env.WORKBUDDY_RESULT_FILE || 'result.json';

function die(msg) {
  console.error(`[notify-feishu] ${msg}`);
  process.exit(1);
}

if (!WEBHOOK) {
  // 未配置 webhook 属于正常情况：安静跳过，不算失败（workflow 里已无 if: 守卫，
  // 因为 secrets 上下文不能用于 if: 条件，见 daily.yml 注释）
  console.log('[notify-feishu] 未配置 FEISHU_WEBHOOK_URL，跳过推送（不影响签到结果）');
  process.exit(0);
}

if (!fs.existsSync(RESULT_FILE)) die(`找不到结果文件 ${RESULT_FILE}`);
const r = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));

// ---------------------------------------------------------------------------
// 组装消息（分成「签到」与「猫猫」两段）
// ---------------------------------------------------------------------------

const yes = (b) => (b ? '✅' : '❌');
const warn = (b) => (b ? '✅' : '⚠️');

const checkinLine =
  `${yes(r.checkin?.ok)} **签到**：${r.checkin?.note || '无结果'}` +
  (r.checkin?.credits != null ? `（+${r.checkin.credits}）` : '');

// 猫猫：把 state / 地点 / 预计到家 一起写上，便于一眼看懂
const d = r.cat?.dispatch || {};
const stateLabel = { idle: '待命', traveling: '旅行中', arrived: '已到家' }[d.state] || d.state || '-';

const catLines = [
  `${warn(r.cat?.claim?.ok)} **领到家积分**：${r.cat?.claim?.note || '未执行'}`,
  `🐱 **派猫出行**：${d.note || '未执行'}`,
  `　　· 行程状态：${stateLabel}` +
    (d.locationId ? `　· 地点：${d.locationId}` : '') +
    (d.arriveAt ? `　· 预计到家：${fmtTs(d.arriveAt)}` : ''),
].join('\n');

function fmtTs(sec) {
  const n = Number(sec);
  if (!n || n <= 0) return '';
  const dt = new Date(n * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${dt.getMonth() + 1}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

const headLine = r.ok ? '**⛽ Buddy 加油站 · 今日完成**' : '**⛽ Buddy 加油站 · 今日异常**';

// 飞书 interactive 卡片：lark_md 支持换行与加粗
const card = {
  msg_type: 'interactive',
  card: {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Buddy 加油站 · 每日任务' },
      template: r.ok ? 'green' : 'red',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: headLine } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: checkinLine } },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**猫猫旅行**\n${catLines}`,
        },
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `执行时间 ${r.finishedAt || r.startedAt || '-'}`,
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// 签名（机器人开启签名校验时）
// ---------------------------------------------------------------------------

function sign(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

const payload = { ...card };
if (SECRET) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  payload.timestamp = timestamp;
  payload.sign = sign(timestamp, SECRET);
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------

const res = await fetch(WEBHOOK, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const text = await res.text();
let json = null;
try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }

console.log(`[notify-feishu] http=${res.status} resp=${JSON.stringify(json) ?? text}`);

// 飞书成功：code === 0（旧版为 StatusCode === 0）
const okCode = json?.code ?? json?.StatusCode;
if (okCode !== 0) {
  console.error('[notify-feishu] 推送失败');
  process.exit(1);
}
console.log('[notify-feishu] 推送成功');
