#!/usr/bin/env node
/**
 * 把每日运行结果追加到 Excel 台账（history/buddy-ledger.xlsx）
 *
 * 设计：
 *   - 每天一行，累积保留历史，随时可翻
 *   - 文件不存在则新建（含表头 + 列宽 + 冻结首行）
 *   - 同一天重复跑 → 覆盖当天那一行，不产生重复记录
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
// 表结构
// ---------------------------------------------------------------------------

const COLUMNS = [
  { header: '日期', key: 'date', width: 12 },
  { header: '时间', key: 'time', width: 10 },
  { header: '签到', key: 'checkin', width: 8 },
  { header: '签到说明', key: 'checkinNote', width: 30 },
  { header: '签到积分', key: 'checkinCredits', width: 10 },
  { header: '领到家积分', key: 'claim', width: 12 },
  { header: '领奖说明', key: 'claimNote', width: 26 },
  { header: '到家积分', key: 'claimCredits', width: 10 },
  // 当日合计：签到积分 + 到家积分。放在两个收入列后面，一眼看当天总共进账多少
  { header: '当日总积分', key: 'totalCredits', width: 12 },
  { header: '派猫', key: 'dispatch', width: 10 },
  { header: '行程状态', key: 'travelState', width: 10 },
  { header: '地点', key: 'location', width: 14 },
  { header: '预计到家', key: 'arriveAt', width: 16 },
  { header: '派猫说明', key: 'dispatchNote', width: 40 },
  { header: '整体', key: 'overall', width: 8 },
  { header: '模式', key: 'mode', width: 8 },
];

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
 * 与 num() 的区别：num() 给的是展示用的 '—'，这里要的是能算数的值。
 */
function toCredits(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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

/** 秒级时间戳 → 北京 MM-DD HH:MM */
function bjTs(sec) {
  const n = Number(sec);
  if (!n || n <= 0) return DASH;
  const t = new Date(n * 1000 + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

/** state 中文名 */
function stateLabel(s) {
  return { idle: '待命', traveling: '旅行中', arrived: '已到家' }[s] || (has(s) ? s : DASH);
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
    checkinNote: has(r?.checkin?.note) ? r.checkin.note : DASH,
    checkinCredits: num(r?.checkin?.credits),
    claim: mark(r?.cat?.claim?.ok),
    claimNote: has(r?.cat?.claim?.note) ? r.cat.claim.note : DASH,
    claimCredits: num(r?.cat?.claim?.raw?.data?.reward_credit),
    totalCredits: total === null ? DASH : total,
    dispatch: dispatchMark,
    travelState: stateLabel(d.state),
    location: has(d.locationId) ? d.locationId : DASH,
    arriveAt: bjTs(d.arriveAt),
    dispatchNote: has(d.note) ? d.note : DASH,
    overall: mark(r?.ok),
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
  // 必须精确定位「每日记录」—— 表里还有一张「汇总」，不能靠 worksheets[0] 兜底
  const ws = wb.getWorksheet('每日记录');
  if (!ws) throw new Error('台账里找不到「每日记录」工作表');
  return ws;
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

/** 找某日期已存在的行号（表头后第一行起） */
function findRowByDate(ws, date) {
  for (let i = 2; i <= ws.rowCount; i++) {
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
  const overallOk = row.overall === '✅';

  if (isDry) {
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E0' } };
  } else if (!checkinOk) {
    // 签到失败 → 浅红，一眼能看见
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7E9' } };
  } else if (!overallOk) {
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E0' } };
  } else if (rowNo % 2 === 0) {
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };
  }

  // 数字列居中
  for (const c of [5, 8, 9]) r.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };

  // 「当日总积分」加粗，便于横扫一列看每天进账
  r.getCell(9).font = { bold: true };
}

/**
 * 重建「汇总」工作表：从每日记录算出累计值。
 * 用真实公式而不是算好的数字，这样你在 Excel 里改历史行，汇总会自动跟着变。
 */
function rebuildSummary(wb) {
  const daily = wb.getWorksheet('每日记录');
  if (!daily) return null;

  // 已有就删掉重建，保证跟每日记录一致
  const old = wb.getWorksheet('汇总');
  if (old) wb.removeWorksheet(old.id);

  const ws = wb.addWorksheet('汇总');

  const lastRow = Math.max(daily.rowCount, 2);
  const F = (col) => `'每日记录'!${col}2:${col}${lastRow}`;

  const rows = [
    ['统计区间', `${cellText(daily.getRow(2).getCell(1))} ~ ${cellText(daily.getRow(lastRow).getCell(1))}`],
    ['记录天数', `COUNTA(${F('A')})`],
    ['', ''],
    // ---- 积分 ----
    ['累计总积分', `SUM(${F('I')})`],
    ['日均积分', `IFERROR(SUM(${F('I')})/COUNT(${F('I')}),0)`],
    ['签到累计积分', `SUM(${F('E')})`],
    ['到家积分累计', `SUM(${F('H')})`],
    ['单日最高积分', `IFERROR(MAX(${F('I')}),0)`],
    ['', ''],
    // ---- 签到 ----
    ['签到成功天数', `COUNTIF(${F('C')},"✅")`],
    ['签到失败天数', `COUNTIF(${F('C')},"❌")`],
    ['', ''],
    // ---- 领奖 ----
    ['领奖成功天数', `COUNTIF(${F('F')},"✅")`],
    ['', ''],
    // ---- 派猫 ----
    ['派猫成功天数', `COUNTIF(${F('J')},"✅ 已派")`],
    ['派猫跳过天数', `COUNTIF(${F('J')},"跳过")`],
    ['派猫失败天数', `COUNTIF(${F('J')},"❌ 失败")`],
    ['', ''],
    // ---- 整体 ----
    ['整体成功天数', `COUNTIF(${F('O')},"✅")`],
    ['成功率', `IFERROR(COUNTIF(${F('O')},"✅")/COUNTA(${F('A')}),0)`],
    ['', ''],
    ['最近更新', bjDate() + ' ' + bjTime()],
  ];

  ws.getColumn(1).width = 16;
  ws.getColumn(2).width = 34;

  rows.forEach(([label, value], i) => {
    const r = ws.getRow(i + 1);
    r.getCell(1).value = label;
    r.getCell(2).value = typeof value === 'string' && value.startsWith('=') ? { formula: value.slice(1) } : value;
    r.getCell(1).font = { bold: true };
  });

  // 百分比格式（成功率在「成功率」那一行）
  const rateRowNo = rows.findIndex(([l]) => l === '成功率') + 1;
  if (rateRowNo > 0) ws.getCell(`B${rateRowNo}`).numFmt = '0.0%';

  // 「累计总积分」突出显示
  const totalRowNo = rows.findIndex(([l]) => l === '累计总积分') + 1;
  if (totalRowNo > 0) {
    ws.getCell(`B${totalRowNo}`).font = { bold: true, size: 13, color: { argb: 'FFC00000' } };
  }

  return ws;
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
  const ws = getSheet(wb);

  const existing = findRowByDate(ws, row.date);
  let rowNo;

  if (existing > 0) {
    // 同一天重复跑 → 覆盖当天行（按列序写，避免 read 回来的表丢列定义）
    rowNo = existing;
    writeRow(ws, rowNo, row);
    console.log(`[ledger] ${row.date} 已存在，覆盖第 ${rowNo} 行`);
  } else {
    rowNo = ws.rowCount + 1;
    writeRow(ws, rowNo, row);
    console.log(`[ledger] ${row.date} 新增第 ${rowNo} 行`);
  }

  styleRow(ws, rowNo, row, dryRun);
  rebuildSummary(wb);
  await wb.xlsx.writeFile(LEDGER_FILE);

  console.log(`[ledger] 已写入 ${LEDGER_FILE}（总 ${ws.rowCount - 1} 天记录）`);
  console.log(
    `[ledger] 今日：签到${row.checkin} 领奖${row.claim} 派猫${row.dispatch} 整体${row.overall}`
  );
}

await main();
