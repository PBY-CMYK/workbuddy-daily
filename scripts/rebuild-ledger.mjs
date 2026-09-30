#!/usr/bin/env node
/**
 * 一次性重建修复版台账（history/buddy-ledger.xlsx）：
 *   - 「每日记录」10 列新结构
 *   - 从 git 历史找回的 2026-10-01 00:16 ✅ 好行
 *   - 底部小结三行：累计总积分(SUM公式) / 今日已用 / 还剩积分
 *   - 无「汇总」表
 *
 * 用法：node scripts/rebuild-ledger.mjs <输出.xlsx> [remain]
 *   remain：当前实时余额（可选，缺省 1679.07）
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const OUT = process.argv[2] || path.join('history', 'buddy-ledger.xlsx');
const REMAIN = Number(process.argv[3] || 1679.07);

const COLUMNS = [
  { header: '日期', key: 'date', width: 12 },
  { header: '时间', key: 'time', width: 10 },
  { header: '签到', key: 'checkin', width: 8 },
  { header: '签到积分', key: 'checkinCredits', width: 10 },
  { header: '领到家积分', key: 'claim', width: 12 },
  { header: '到家积分', key: 'claimCredits', width: 10 },
  { header: '当日总积分', key: 'totalCredits', width: 12 },
  { header: '派猫', key: 'dispatch', width: 10 },
  { header: '派猫说明', key: 'dispatchNote', width: 52 },
  { header: '模式', key: 'mode', width: 8 },
];

// 从 git 历史 commit f1f3b4bb0d 的台账取回的好行（16 列 → 新 10 列映射）
const GOOD_ROW = [
  '2026-10-01', '00:16', '✅', 100, '✅', 5, 105,
  '✅ 已派', '已派出猫猫前往「咖啡馆」（预计 9-30 20:16 到家）', '正常',
];

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('每日记录', { views: [{ state: 'frozen', ySplit: 1 }] });
ws.columns = COLUMNS;

const head = ws.getRow(1);
head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };
head.alignment = { vertical: 'middle', horizontal: 'center' };
head.height = 22;

// ---- 数据行 -------------------------------------------------------------
const r = ws.getRow(2);
GOOD_ROW.forEach((v, i) => { r.getCell(i + 1).value = v; });

for (let c = 1; c <= COLUMNS.length; c++) {
  r.getCell(c).alignment = { vertical: 'middle', horizontal: c <= 3 ? 'center' : 'left' };
  r.getCell(c).border = {
    top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
  };
}
for (const c of [4, 5, 6, 7]) r.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };
r.getCell(7).font = { bold: true };
r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };

// ---- 底部小结 -----------------------------------------------------------
const mk = (rowNo, label, value, accent = false) => {
  const row = ws.getRow(rowNo);
  row.getCell(1).value = label;
  row.getCell(2).value = value;
  row.getCell(1).font = { bold: true };
  row.getCell(2).font = accent
    ? { bold: true, size: 13, color: { argb: 'FFC00000' } }
    : { bold: true };
  row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };
};

mk(4, '累计总积分', { formula: 'SUM(G2:G2)' });
mk(5, '今日已用', 0);
mk(6, '还剩积分', REMAIN, true);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await wb.xlsx.writeFile(OUT);
console.log(`[rebuild] 已生成 ${OUT}`);
console.log('[rebuild] 行1 = 2026-10-01 00:16 ✅ 100 + 5 = 105（git 历史找回）');
console.log('[rebuild] 小结：累计=SUM(G2:G2) 今日已用=0 还剩=' + REMAIN);
