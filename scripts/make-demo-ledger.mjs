#!/usr/bin/env node
/**
 * 生成台账「演示版」，用于预览表格长什么样。
 * 用模拟数据跑，产出到 history/buddy-ledger-demo.xlsx（与真实台账分开，避免混淆）。
 *
 * 用法：node scripts/make-demo-ledger.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEMO_OUT = process.env.WORKBUDDY_DEMO_OUT || path.join('history', 'buddy-ledger-demo.xlsx');

// 目标文件被 Excel 占用时，自动换一个带时间戳的名字，不打断
function pickOutput() {
  if (!fs.existsSync(DEMO_OUT)) return DEMO_OUT;
  try {
    fs.renameSync(DEMO_OUT, DEMO_OUT); // 同路径改名：被占用会抛 EBUSY
    return DEMO_OUT;
  } catch {
    const alt = DEMO_OUT.replace(/\.xlsx$/i, `-${Date.now()}.xlsx`);
    console.log(`[demo] ${DEMO_OUT} 被占用（Excel 开着？），改写到 ${alt}`);
    return alt;
  }
}

// 造 7 天模拟数据，覆盖各种情况：正常、旅行中跳过、达上限、签到失败、dry-run
const DAYS = [
  {
    date: '2026-09-24T01:01:12Z', dry: false, checkinOk: true, credits: 10,
    claimOk: true, claimCredit: 30, dispatchOk: true, state: 'idle',
    loc: 'loc_tokyo', arrive: 1759360000,
    note: '已派出猫猫前往「东京」',
  },
  {
    date: '2026-09-25T01:02:41Z', dry: false, checkinOk: true, credits: 10,
    claimOk: true, claimCredit: 0, dispatchOk: false, state: 'traveling',
    loc: null, arrive: 0,
    note: '猫猫正在旅行中（state=traveling），今天已派出，跳过派新行程',
  },
  {
    date: '2026-09-26T01:00:55Z', dry: false, checkinOk: true, credits: 10,
    claimOk: true, claimCredit: 45, dispatchOk: true, state: 'arrived',
    loc: 'loc_paris', arrive: 1759450000,
    note: '已派出猫猫前往「巴黎」',
  },
  {
    date: '2026-09-27T01:03:20Z', dry: false, checkinOk: true, credits: 10,
    claimOk: true, claimCredit: 0, dispatchOk: false, state: 'traveling',
    loc: null, arrive: 0,
    note: '猫猫正在旅行中（state=traveling），今天已派出，跳过派新行程',
  },
  {
    date: '2026-09-28T01:01:47Z', dry: false, checkinOk: true, credits: 10,
    claimOk: true, claimCredit: 20, dispatchOk: true, state: 'idle',
    loc: 'loc_london', arrive: 1759540000,
    note: '已派出猫猫前往「伦敦」',
  },
  {
    // 签到失败 —— 整行浅红
    date: '2026-09-29T01:04:03Z', dry: false, checkinOk: false, credits: null,
    claimOk: true, claimCredit: 20, dispatchOk: true, state: 'arrived',
    loc: 'loc_kyoto', arrive: 1759630000,
    note: '已派出猫猫前往「京都」',
  },
  {
    // dry-run —— 整行浅黄
    date: '2026-09-30T01:05:31Z', dry: true, checkinOk: true, credits: 10,
    claimOk: true, claimCredit: 25, dispatchOk: false, state: 'idle',
    loc: null, arrive: 0,
    note: 'dry-run：本可派出（state=idle），跳过实际 depart',
  },
];

function mkResult(d) {
  return {
    ok: d.checkinOk,
    startedAt: d.date,
    finishedAt: d.date,
    checkin: {
      attempted: true, ok: d.checkinOk,
      note: d.checkinOk ? `签到成功，获得 ${d.credits} 积分` : '签到失败：HTTP 401',
      credits: d.credits,
    },
    cat: {
      claim: {
        attempted: true, ok: d.claimOk,
        note: d.claimOk ? `已领取到家积分 ${d.claimCredit}` : '无待领取的到家积分',
        raw: { data: { reward_credit: d.claimCredit } },
      },
      dispatch: {
        attempted: d.dispatchOk, ok: d.dispatchOk, note: d.note,
        state: d.state, dispatchedToday: d.state === 'traveling',
        locationId: d.loc, arriveAt: d.arrive,
        statusRaw: null, configRaw: null, departRaw: null,
      },
    },
  };
}

fs.mkdirSync('history', { recursive: true });

const OUT = pickOutput();
// 有旧文件先清掉，避免上一版残留的行混进来
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

// 逐天跑 append-ledger，走的就是真实代码路径，保证演示与真实行为一致
const tmpResult = '.demo-result.json';
for (const d of DAYS) {
  fs.writeFileSync(tmpResult, JSON.stringify(mkResult(d), null, 2), 'utf8');
  execFileSync(process.execPath, ['scripts/append-ledger.mjs'], {
    stdio: 'pipe',
    env: {
      ...process.env,
      WORKBUDDY_RESULT_FILE: tmpResult,
      WORKBUDDY_LEDGER_FILE: OUT,
      WORKBUDDY_DRY_RUN: d.dry ? '1' : '0',
    },
  });
}
fs.unlinkSync(tmpResult);

console.log(`\n演示台账已生成：${OUT}`);
console.log(`共 ${DAYS.length} 天模拟记录（含签到失败、dry-run、旅行中跳过等场景）`);
