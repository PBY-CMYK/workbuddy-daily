#!/usr/bin/env node
/**
 * 把每日运行结果追加到 Excel 台账（history/buddy-ledger.xlsx）
 *
 * 设计（2026-10 修订版）：
 *   - 每天一行，累积保留历史；重复运行多少次，历史行永不丢失
 *   - 同一天重复跑 → 合并而不是粗暴覆盖：
 *       · 原 ✅ 行绝不会被 ❌ 覆盖（保护）
 *       · 重复签到保留原签到信息，只合并新增的领奖/派猫
 *   - 无「汇总」工作表（历史遗留的会自动删除）
 *   - 底部小结区三行：累计总积分 / 今日已用 / 还剩积分
 *   - dry-run 的行会标注出来，不混入真实台账判断
 *
 * 用法：
 *   node scripts/append-ledger.mjs                       # 读 result.json，写台账
 *   WORKBUDDY_RESULT_FILE=x.json node scripts/append-ledger.mjs
 *
 * 环境变量：
 *   WORKBUDDY_LEDGER_FILE  台账路径，默认 history/buddy-ledger.xlsx
 *   WORKBUDDY_RESULT_FILE  结果文件，默认 result.json
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const RESULT_FILE = process.env.WORKBUDDY_RESULT_FILE || 'result.json';
const LEDGER_FILE = process.env.WORKBUDDY_LEDGER_FILE || path.join('history', 'buddy-ledger.xlsx');

// ---------------------------------------------------------------------------
// 表结构（10 列 —— 2026-10 精简：去掉 签到说明/领奖说明/行程状态/地点/预计到家/整体）
// ---------------------------------------------------------------------------

const COLUMNS = [
  { header: '日期', key: 'date', width: 12 },
  { header: '时间', key: 'time', width: 10 },
  { header: '签到', key: 'checkin', width: 8 },
  { header: '签到积分', key: 'checkinCredits', width: 10 },
  { header: '领到家积分', key: 'claim', width: 12 },
  { header: '到家积分', key: 'claimCredits', width: 10 },
  // 当日合计：签到积分 + 到家积分。放在两个收入列后面，一眼看当天总共进账多少
  { header: '当日总积分', key: 'totalCredits', width: 12 },
  { header: '派猫', key: 'dispatch', width: 10 },
  { header: '派猫说明', key: 'dispatchNote', width: 52 },
  { header: '模式', key: 'mode', width: 8 },
];

// 关键列号（1-based）。当日总积分 = 第 7 列 = G 列（小结 SUM 公式引用）
const COL_TOTAL = 7;
const TOTAL_COL_LETTER = 'G';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const DASH = '—';

/** 「有内容」判断：null / undefined / 空串 都视为无 */
function has(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/** 图标化：true → ✅，false → ❌，null → — */
function mark(v) {
  if (v === true) return '✅';
  if (v === false) return '❌';
  return DASH;
}

/** 数值：有值就留着，无值用 — */
function num(v) {
  return v === null || v === undefined || v === '' ? DASH : Number(v);
}

/**
 * 转成可参与求和的数字；无值返回 null。
 */
function toCredits(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** cellText 读回的字符串 → 数值（写回时保持数字类型，避免 Excel 文本化） */
function asNum(v) {
  if (v === null || v === undefined || v === '') return DASH;
  if (/^-?\d+(\.\d+)?$/.test(String(v).trim())) return Number(v);
  return v;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** 北京时间 YYYY-MM-DD */
function bjDate(d = new Date()) {
  // 直接按 UTC+8 换算，避免 runner 时区差异
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/** 北京时间 HH:MM */
function bjTime(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

// ---------------------------------------------------------------------------
// 从 result.json 抽一行
// ---------------------------------------------------------------------------

function buildRow(r, dryRun) {
  const d = r?.cat?.dispatch || {};
  const finishedAt = r?.finishedAt ? new Date(r.finishedAt) : new Date();

  // 派猫列：派出去了就 ✅；明确跳过（已派过/达上限）记「跳过」；失败 ❌
  let dispatchMark = DASH;
  if (d.ok === true) dispatchMark = '✅ 已派';
  else if (d.attempted === true && d.ok === false) dispatchMark = '❌ 失败';
  else if (d.dispatchedToday === true || d.state === 'traveling') dispatchMark = '跳过';
  else if (has(d.note)) dispatchMark = '跳过';

  // 当日总积分 = 签到积分 + 到家积分。
  // 某一项缺失（比如签到失败拿不到积分）时按 0 计，只要另一项有值就仍然合计。
  const cNum = toCredits(r?.checkin?.credits);
  const aNum = toCredits(r?.cat?.claim?.raw?.data?.reward_credit);
  const total = cNum === null && aNum === null ? null : (cNum ?? 0) + (aNum ?? 0);

  return {
    date: bjDate(finishedAt),
    time: bjTime(finishedAt),
    checkin: mark(r?.checkin?.ok),
    checkinCredits: num(r?.checkin?.credits),
    claim: mark(r?.cat?.claim?.ok),
    claimCredits: num(r?.cat?.claim?.raw?.data?.reward_credit),
    totalCredits: total === null ? DASH : total,
    dispatch: dispatchMark,
    dispatchNote: has(d.note) ? d.note : DASH,
    mode: dryRun ? 'dry-run' : '正常',
  };
}

// ---------------------------------------------------------------------------
// 读写台账
// ---------------------------------------------------------------------------

async function loadWorkbook() {
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(LEDGER_FILE)) {
    await wb.xlsx.readFile(LEDGER_FILE);
    return wb;
  }

  // 新建：建表头
  const ws = wb.addWorksheet('每日记录', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = COLUMNS;

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };
  head.alignment = { vertical: 'middle', horizontal: 'center' };
  head.height = 22;

  return wb;
}

function getSheet(wb) {
  const ws = wb.getWorksheet('每日记录');
  if (!ws) throw new Error('台账里找不到「每日记录」工作表');
  return ws;
}

/** 历史遗留：删除旧的「汇总」工作表（用户要求去掉汇总） */
function removeLegacySummary(wb) {
  const old = wb.getWorksheet('汇总');
  if (old) {
    wb.removeWorksheet(old.id);
    console.log('[ledger] 已删除遗留的「汇总」工作表');
  }
}

/**
 * 取单元格的纯文本值。
 * xlsx 读回来时，值可能是 richText / hyperlink / formula / Date 等对象，
 * 不能直接 String() —— 必须逐个解包，否则日期列匹配会失效。
 */
function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** 找某日期已存在的行号（表头后第一行起，数据区不含底部小结区） */
function findRowByDate(ws, date, limitRow) {
  const max = Math.min(limitRow || ws.rowCount, ws.rowCount);
  for (let i = 2; i <= max; i++) {
    if (cellText(ws.getRow(i).getCell(1)).trim() === date) return i;
  }
  return -1;
}

/**
 * 按列序把一行数据写进指定行。
 * 刻意不用 `row.values = {key:...}` —— 那种写法依赖 addWorksheet 时注册的
 * columns 定义；从文件 readFile 回来的工作表没有这套定义，会写空。
 * 按序号逐格赋值才两种情况下都可靠。
 */
function writeRow(ws, rowNo, row) {
  const r = ws.getRow(rowNo);
  COLUMNS.forEach((col, i) => {
    r.getCell(i + 1).value = row[col.key];
  });
  return r;
}

/** 读回一行的关键列（merge 判定用）；数值列转回 Number 保持类型 */
function readRowValues(ws, rowNo) {
  const r = ws.getRow(rowNo);
  const t = (c) => cellText(r.getCell(c)).trim();
  return {
    date: t(1),
    time: t(2),
    checkin: t(3),
    checkinCredits: asNum(t(4)),
    claim: t(5),
    claimCredits: asNum(t(6)),
    totalCredits: asNum(t(7)),
    dispatch: t(8),
    dispatchNote: t(9),
    mode: t(10),
  };
}

/**
 * 同日合并规则（核心：历史信息永不丢失）：
 *   1) 原 ✅ + 新非✅ → 整行保留原样。防误覆盖：网络抖动/接口抽风导致的
 *      「签到失败」不允许抹掉已经成功的事实。
 *   2) 原 ✅ + 新 ✅ → 重复签到合并：签到/签到积分保留原值（积分只记一次）；
 *      领奖列取「任一 ✅」，到家积分累加（同一行程不会重复领，安全）；
 *      当日总积分重算；派猫取更详细的一条。
 *   3) 原非✅ + 新任意 → 用新行覆盖（原本就是坏行，新数据是修复）。
 */
function mergeRows(oldRow, cur) {
  const oldOk = oldRow.checkin === '✅';
  const curOk = cur.checkin === '✅';

  if (oldOk && !curOk) {
    console.log('[ledger] 原行为 ✅、新行为非 ✅ → 保留原行（防覆盖保护）');
    return { ...oldRow, mode: cur.mode };
  }

  if (oldOk && curOk) {
    const merged = { ...cur };

    // 签到只记一次：保留原值
    merged.checkin = '✅';
    merged.checkinCredits = oldRow.checkinCredits;

    // 领奖：任一 ✅ 即 ✅；积分累加（缺省按 0）
    merged.claim = oldRow.claim === '✅' || cur.claim === '✅' ? '✅' : cur.claim;
    const aOld = toCredits(oldRow.claimCredits) ?? 0;
    const aCur = toCredits(cur.claimCredits) ?? 0;
    merged.claimCredits = (aOld + aCur > 0) ? round2(aOld + aCur) : (oldRow.claimCredits === DASH && cur.claimCredits === DASH ? DASH : 0);

    // 当日总积分 = 签到 + 到家（能算就重算）
    const cN = toCredits(merged.checkinCredits) ?? 0;
    const aN = toCredits(merged.claimCredits) ?? 0;
    merged.totalCredits = (merged.checkinCredits === DASH && merged.claimCredits === DASH) ? DASH : round2(cN + aN);

    // 派猫：新行真派出去了（✅ 已派）用新行；否则保留原内容
    if (cur.dispatch !== '✅ 已派' && oldRow.dispatch === '✅ 已派') {
      merged.dispatch = oldRow.dispatch;
      merged.dispatchNote = oldRow.dispatchNote;
    }

    return merged;
  }

  // 原行本来就坏 → 新行是修复
  return cur;
}

/** 行样式：签到失败整行浅红；dry-run 浅黄；隔行浅底 */
function styleRow(ws, rowNo, row, isDry) {
  const r = ws.getRow(rowNo);

  for (let c = 1; c <= COLUMNS.length; c++) {
    const cell = r.getCell(c);
    cell.alignment = { vertical: 'middle', horizontal: c <= 3 ? 'center' : 'left' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    };
  }

  const checkinOk = row.checkin === '✅';

  if (isDry) {
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E0' } };
  } else if (!checkinOk) {
    // 签到失败 → 浅红，一眼能看见
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7E9' } };
  } else if (rowNo % 2 === 0) {
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };
  }

  // 数字列居中：签到积分(4) / 到家积分(6) / 当日总积分(7)，以及领到家积分(5) 的图标
  for (const c of [4, 5, 6, 7]) r.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };

  // 「当日总积分」加粗，便于横扫一列看每天进账
  r.getCell(COL_TOTAL).font = { bold: true };
}

// ---------------------------------------------------------------------------
// 底部小结区：累计总积分 / 今日已用 / 还剩积分
// ---------------------------------------------------------------------------

const SUMMARY_LABEL = '累计总积分';
const SUMMARY_LABELS = [SUMMARY_LABEL, '今日已用', '还剩积分'];

/** 找小结区起始行（A 列 = 「累计总积分」）；没有返回 -1 */
function findSummaryStart(ws) {
  for (let i = 2; i <= ws.rowCount; i++) {
    if (cellText(ws.getRow(i).getCell(1)).trim() === SUMMARY_LABEL) return i;
  }
  return -1;
}

/** 读上一次快照的「还剩积分」值（必须在清小结区之前调用）；读不到返回 null */
function readPrevRemain(ws) {
  const s = findSummaryStart(ws);
  if (s < 0) return null;
  const v = cellText(ws.getRow(s + 2).getCell(2)).trim();
  const n = Number(v);
  return Number.isFinite(n) && v !== '' ? n : null;
}

/** 删除旧小结区（含前置空行）；返回删除的行数（0 = 本来就没有） */
function clearSummaryRows(ws) {
  const s = findSummaryStart(ws);
  if (s < 0) return 0;
  const start = s - 1 >= 2 ? s - 1 : s; // 连同前置空行一起删
  const count = ws.rowCount - start + 1;
  if (count > 0) ws.spliceRows(start, count);
  return count;
}

/**
 * 写底部小结区（数据行之后）：
 *   （空行）
 *   累计总积分 | =SUM(G2:G{last})     ← 公式，台账自算累计签到+领奖
 *   今日已用   | <数值 或 —>
 *   还剩积分   | <数值 或 —>          ← 实时余额快照
 */
function writeSummaryBlock(ws, dataLastRow, { todayUsed, remain }) {
  ws.getRow(dataLastRow + 1); // 空行占位

  const mk = (rowNo, label, value, opts = {}) => {
    const r = ws.getRow(rowNo);
    r.getCell(1).value = label;
    r.getCell(2).value = value;
    r.getCell(1).font = { bold: true };
    r.getCell(2).font = opts.accent
      ? { bold: true, size: 13, color: { argb: 'FFC00000' } }
      : { bold: true };
    r.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };
  };

  mk(dataLastRow + 2, SUMMARY_LABEL, { formula: `SUM(${TOTAL_COL_LETTER}2:${TOTAL_COL_LETTER}${dataLastRow})` });
  mk(dataLastRow + 3, '今日已用', todayUsed);
  mk(dataLastRow + 4, '还剩积分', remain, { accent: true });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(RESULT_FILE)) {
    console.error(`[ledger] 找不到 ${RESULT_FILE}，无法记账`);
    process.exit(1);
  }

  const r = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
  const dryRun = process.env.WORKBUDDY_DRY_RUN === '1';
  const row = buildRow(r, dryRun);

  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  const wb = await loadWorkbook();
  removeLegacySummary(wb);
  const ws = getSheet(wb);

  // ---- 小结区：先读上次快照，再清掉（写完数据行后重写） ----------------
  const prevRemain = readPrevRemain(ws);
  const cleared = clearSummaryRows(ws);
  if (cleared > 0) console.log(`[ledger] 已清理旧小结区（${cleared} 行）`);

  const dataLastRow = Math.max(1, ws.rowCount); // 数据区最后一行（表头算第 1 行）
  const existing = findRowByDate(ws, row.date, dataLastRow);
  let rowNo;
  let finalRow;

  if (existing > 0) {
    rowNo = existing;
    const oldRow = readRowValues(ws, existing);
    finalRow = mergeRows(oldRow, row);
    writeRow(ws, rowNo, finalRow);
    console.log(`[ledger] ${row.date} 已存在第 ${rowNo} 行 → 合并写入`);
  } else {
    rowNo = dataLastRow + 1;
    finalRow = row;
    writeRow(ws, rowNo, finalRow);
    console.log(`[ledger] ${row.date} 新增第 ${rowNo} 行`);
  }

  styleRow(ws, rowNo, finalRow, dryRun);

  // ---- 今日已用 = 上次快照还剩 + 本次新获得 - 当前实时还剩 --------------
  // 本次新获得：真签到的积分 + 真领到的奖励（重复签到跳过时均为 0/无值）
  const gain =
    (toCredits(r?.checkin?.credits) ?? 0) +
    (toCredits(r?.cat?.claim?.raw?.data?.reward_credit) ?? 0);
  const remainNow = toCredits(r?.credit?.remain);

  let todayUsed = DASH;
  if (remainNow !== null) {
    const remainPrev = prevRemain !== null ? prevRemain : remainNow - gain;
    todayUsed = round2(Math.max(0, remainPrev + gain - remainNow));
  }

  writeSummaryBlock(ws, rowNo, {
    todayUsed,
    remain: remainNow !== null ? remainNow : DASH,
  });

  await wb.xlsx.writeFile(LEDGER_FILE);

  console.log(`[ledger] 已写入 ${LEDGER_FILE}（总 ${rowNo - 1} 天记录）`);
  console.log(
    `[ledger] 今日：签到${finalRow.checkin} 领奖${finalRow.claim} 派猫${finalRow.dispatch}`
  );
  console.log(
    `[ledger] 小结：累计总积分=SUM公式 今日已用=${todayUsed} 还剩积分=${remainNow !== null ? remainNow : DASH}`
  );
}

await main();
