#!/usr/bin/env node
/**
 * append-ledger.mjs 行为验证（临时台账上跑，不碰正式文件）
 *   A) 重复签到 + 领奖失败 → 原 ✅ 行信息完整保留（防覆盖）
 *   B) 原始 ✅ 行 + 新 ❌ 行 → 整行保护
 *   C) 次日正常签到 + 白天消费 → 今日已用 = 快照差值，累计=SUM
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import ExcelJS from 'exceljs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const NODE = process.execPath;
const APPEND = path.join(HERE, 'append-ledger.mjs');
const SEED = process.argv[2]; // 重建好的台账
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}

async function readLedger(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('每日记录');
  const sheets = wb.worksheets.map((s) => s.name);
  const cell = (r, c) => ws.getRow(r)?.getCell(c)?.value ?? null;
  const rows = [];
  let legacyLabelRow = -1;
  for (let i = 2; i <= ws.rowCount; i++) {
    const a = String(cell(i, 1) ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(a)) {
      rows.push({
        rowNo: i, date: a,
        checkin: String(cell(i, 3) ?? ''),
        checkinCredits: cell(i, 4), claim: String(cell(i, 5) ?? ''),
        claimCredits: cell(i, 6), totalCredits: cell(i, 7),
        dispatch: String(cell(i, 8) ?? ''), dispatchNote: String(cell(i, 9) ?? ''),
      });
    }
    if (a === '累计总积分') legacyLabelRow = i;
  }
  // 小结定位：优先新版 K1:L3（K1 = 第1行第11列，值在 L 列 = 第12列）；
  // 兼容旧版 A 列底部小结（值在 B 列 = 第2列）
  let summary = null;
  if (String(cell(1, 11) ?? '').trim() === '累计总积分') {
    summary = { totalRow: 1, usedRow: 2, remainRow: 3, valCol: 12 };
  } else if (legacyLabelRow > 0) {
    summary = { totalRow: legacyLabelRow, usedRow: legacyLabelRow + 1, remainRow: legacyLabelRow + 2, valCol: 2 };
  }
  return { ws, sheets, cell, rows, summary, legacyLabelRow, rowCount: ws.rowCount };
}

async function runAppend(resultObj, ledgerFile) {
  const rf = path.join(TMP, `result-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(rf, JSON.stringify(resultObj));
  const rr = spawnSync(NODE, [APPEND], {
    env: { ...process.env, WORKBUDDY_RESULT_FILE: rf, WORKBUDDY_LEDGER_FILE: ledgerFile },
    encoding: 'utf8',
  });
  if (rr.status !== 0) throw new Error(`append-ledger 退出码 ${rr.status}\n${rr.stdout}\n${rr.stderr}`);
  return rr.stdout;
}

/** 把 K 列小结种子改造成「旧版 A 列底部小结」文件（场景 D 输入） */
async function makeLegacySeed(src, dest) {
  fs.copyFileSync(src, dest);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(dest);
  const ws = wb.getWorksheet('每日记录');
  // 数据末行：从底往上按 A 列日期找（不能用 rowCount —— K 列小结会把它撑到 3）
  let last = 1;
  for (let i = ws.rowCount; i >= 2; i--) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(ws.getRow(i).getCell(1).value ?? '').trim())) { last = i; break; }
  }
  for (const addr of ['K1', 'L1', 'K2', 'L2', 'K3', 'L3']) {
    const c = ws.getCell(addr);
    c.value = null;
    c.style = {};
  }
  ws.getRow(last + 2).getCell(1).value = '累计总积分';
  ws.getRow(last + 2).getCell(2).value = { formula: `SUM(G2:G${last})` };
  ws.getRow(last + 3).getCell(1).value = '今日已用';
  ws.getRow(last + 3).getCell(2).value = 25.92;
  ws.getRow(last + 4).getCell(1).value = '还剩积分';
  ws.getRow(last + 4).getCell(2).value = 1653.15;
  await wb.xlsx.writeFile(dest);
}

const base = (over = {}) => ({
  ok: true,
  startedAt: '2026-09-30T16:16:00Z',
  finishedAt: '2026-09-30T16:16:40Z',
  checkin: { attempted: true, ok: true, alreadyCheckedIn: false, note: '签到成功，获得 100 积分', credits: 100, raw: null },
  credit: { attempted: true, ok: true, total: 3505, remain: 1679.07, used: 1825.93, unit: 'credits', raw: null },
  cat: {
    travel: null,
    claim: { attempted: true, ok: true, note: '已领取到家积分 5', raw: { data: { reward_credit: 5 } } },
    dispatch: {
      attempted: true, ok: true, note: '已派出猫猫前往「咖啡馆」（预计 9-30 20:16 到家）',
      state: 'traveling', dispatchedToday: true, locationId: 1, arriveAt: 1790799377,
    },
  },
  ...over,
});

// ============ 场景 A：重复签到（alreadyCheckedIn）+ 领奖失败 ============
console.log('\n场景 A：重复签到跳过 + 领奖失败 → 原 ✅ 行必须完整保留');
{
  const f = path.join(TMP, 'A.xlsx');
  fs.copyFileSync(SEED, f);
  await runAppend(base({
    finishedAt: '2026-09-30T16:30:00Z',
    checkin: { attempted: false, ok: true, alreadyCheckedIn: true, note: '今日已签到', credits: null, raw: null },
    cat: {
      travel: null,
      claim: { attempted: true, ok: false, note: '领取失败：系统繁忙', raw: null },
      dispatch: {
        attempted: false, ok: false, note: '猫猫正在旅行中（state=traveling），今天已派出，跳过派新行程',
        state: 'traveling', dispatchedToday: true, locationId: null, arriveAt: null,
      },
    },
  }), f);
  const L = await readLedger(f);
  const row = L.rows.find((x) => x.date === '2026-10-01');
  check('行数=1（不重复加行）', L.rows.length === 1, `实际 ${L.rows.length}`);
  check('签到列保持 ✅', row?.checkin === '✅', String(row?.checkin));
  check('签到积分保持 100', Number(row?.checkinCredits) === 100, String(row?.checkinCredits));
  check('领奖 ✅ 保留', row?.claim === '✅', String(row?.claim));
  check('到家积分保持 5', Number(row?.claimCredits) === 5, String(row?.claimCredits));
  check('当日总积分保持 105', Number(row?.totalCredits) === 105, String(row?.totalCredits));
  check('派猫说明保留原文', row?.dispatchNote?.includes('咖啡馆'), String(row?.dispatchNote));
  check('K 列小结区存在', !!L.summary && L.summary.valCol === 12, JSON.stringify(L.summary));
  const remain = Number(L.cell(L.summary.remainRow, L.summary.valCol));
  const used = Number(L.cell(L.summary.usedRow, L.summary.valCol));
  check('还剩积分=1679.07', remain === 1679.07, String(remain));
  check('今日已用=0', used === 0, String(used));
  check('无「汇总」表', !L.sheets.includes('汇总'), L.sheets.join(','));
}

// ============ 场景 B：原 ✅ 行 + 新 ❌ 行（接口抽风）→ 防覆盖 ============
console.log('\n场景 B：新结果为 ❌ 签到失败 → 整行保留 ✅');
{
  const f = path.join(TMP, 'B.xlsx');
  fs.copyFileSync(SEED, f);
  await runAppend(base({
    finishedAt: '2026-09-30T17:00:00Z',
    checkin: { attempted: true, ok: false, alreadyCheckedIn: false, note: '签到失败：HTTP 500', credits: null, raw: null },
    cat: {
      travel: null,
      claim: { attempted: true, ok: false, note: '领取失败：超时', raw: null },
      dispatch: { attempted: false, ok: false, note: '状态查询失败', state: null, dispatchedToday: null, locationId: null, arriveAt: null },
    },
  }), f);
  const L = await readLedger(f);
  const row = L.rows.find((x) => x.date === '2026-10-01');
  check('签到列仍为 ✅（未被 ❌ 覆盖）', row?.checkin === '✅', String(row?.checkin));
  check('当日总积分仍 105', Number(row?.totalCredits) === 105, String(row?.totalCredits));
}

// ============ 场景 C：次日新行 + 白天消费 → 今日已用/累计 ============
console.log('\n场景 C：次日签到 100+5、白天已消费 210 → 今日已用=210 累计=210');
{
  const f = path.join(TMP, 'C.xlsx');
  fs.copyFileSync(SEED, f);
  await runAppend(base({
    finishedAt: '2026-10-01T16:20:00Z', // 次日（北京时间 10-02 00:20）
    checkin: { attempted: true, ok: true, alreadyCheckedIn: false, note: '签到成功，获得 100 积分', credits: 100, raw: null },
    credit: { attempted: true, ok: true, total: 3505, remain: 1574.07, used: 2035.93, unit: 'credits', raw: null },
  }), f);
  const L = await readLedger(f);
  check('行数=2（新增一天）', L.rows.length === 2, `实际 ${L.rows.length}`);
  const r2 = L.rows.find((x) => x.date === '2026-10-02');
  check('新行 ✅ 100 / ✅ 5 / 105',
    r2?.checkin === '✅' && Number(r2?.checkinCredits) === 100 && Number(r2?.claimCredits) === 5 && Number(r2?.totalCredits) === 105,
    JSON.stringify(r2));
  const used = Number(L.cell(L.summary.usedRow, L.summary.valCol));
  const remain = Number(L.cell(L.summary.remainRow, L.summary.valCol));
  check('今日已用=210（快照差值）', used === 210, String(used));
  check('还剩积分=1574.07', remain === 1574.07, String(remain));
  const totalCell = L.cell(L.summary.totalRow, L.summary.valCol);
  const totalVal = totalCell?.formula ? 'SUM公式' : String(totalCell);
  check('累计总积分是 SUM 公式', totalVal === 'SUM公式', totalVal);
}

// ============ 场景 D：旧版 A 列底部小结 → 自动迁移 K1:L3 ============
console.log('\n场景 D：旧版 A 列底部小结 → 自动迁移 K 列（行数不变、K1:L3 重建）');
{
  const f = path.join(TMP, 'D.xlsx');
  await makeLegacySeed(SEED, f);
  await runAppend(base({
    finishedAt: '2026-10-01T16:20:00Z',
    checkin: { attempted: true, ok: true, alreadyCheckedIn: false, note: '签到成功，获得 100 积分', credits: 100, raw: null },
    credit: { attempted: true, ok: true, total: 3505, remain: 1548.15, used: 2057.93, unit: 'credits', raw: null },
  }), f);
  const L = await readLedger(f);
  check('行数=2', L.rows.length === 2, `实际 ${L.rows.length}`);
  check('旧 A 列小结已删除', L.legacyLabelRow === -1, `legacyLabelRow=${L.legacyLabelRow}`);
  check('K1=累计总积分', String(L.cell(1, 11) ?? '').trim() === '累计总积分', String(L.cell(1, 11)));
  check('K 列小结区存在', !!L.summary && L.summary.valCol === 12, JSON.stringify(L.summary));
  const used = Number(L.cell(L.summary.usedRow, L.summary.valCol));
  const remain = Number(L.cell(L.summary.remainRow, L.summary.valCol));
  check('今日已用=210（1653.15+105-1548.15）', used === 210, String(used));
  check('还剩积分=1548.15', remain === 1548.15, String(remain));
  const totalCell = L.cell(1, 12);
  check('累计总积分是 SUM 公式', totalCell?.formula === 'SUM(G2:G3)', JSON.stringify(totalCell));
}

// ============ 场景 E：同日重复记账 → 今日已用累加（不覆盖丢账） ============
console.log('\n场景 E：同日多次记账 → 今日已用 0→25.92→69.60 累加不丢');
{
  const f = path.join(TMP, 'E.xlsx');
  fs.copyFileSync(SEED, f);
  const idle = (remain, used) => base({
    finishedAt: '2026-09-30T18:00:00Z',
    checkin: { attempted: true, ok: true, alreadyCheckedIn: true, note: '今日已签到', credits: null, raw: null },
    cat: {
      travel: null,
      claim: { attempted: false, ok: false, note: '未领取', raw: null },
      dispatch: { attempted: false, ok: false, note: '—', state: null, dispatchedToday: null, locationId: null, arriveAt: null },
    },
    credit: { attempted: true, ok: true, total: 3505, remain, used, unit: 'credits', raw: null },
  });
  await runAppend(idle(1653.15, 1851.92), f);
  let L = await readLedger(f);
  let used = Number(L.cell(L.summary.usedRow, L.summary.valCol));
  check('第1次记账：今日已用=25.92（快照差）', used === 25.92, String(used));
  check('第1次记账：还剩=1653.15', Number(L.cell(L.summary.remainRow, L.summary.valCol)) === 1653.15, String(L.cell(L.summary.remainRow, L.summary.valCol)));
  check('第1次记账：行数仍=1', L.rows.length === 1, `实际 ${L.rows.length}`);

  await runAppend(idle(1609.47, 1895.6), f);
  L = await readLedger(f);
  used = Number(L.cell(L.summary.usedRow, L.summary.valCol));
  check('第2次记账：今日已用=69.6（25.92+43.68 累加，不覆盖）', used === 69.6, String(used));
  check('第2次记账：还剩=1609.47', Number(L.cell(L.summary.remainRow, L.summary.valCol)) === 1609.47, String(L.cell(L.summary.remainRow, L.summary.valCol)));
  check('第2次记账：行数仍=1', L.rows.length === 1, `实际 ${L.rows.length}`);
  check('第2次记账：签到积分仍=100', Number(L.rows[0]?.checkinCredits) === 100, String(L.rows[0]?.checkinCredits));
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
