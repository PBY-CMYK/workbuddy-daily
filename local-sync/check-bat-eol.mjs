#!/usr/bin/env node
/**
 * 检查 local-sync 目录里的 .bat 是否是可用的 CRLF 行尾。
 *
 * 为什么需要：cmd.exe 解析 .bat 时按行读取，只认 CRLF。如果文件被编辑器
 * 或 git 转成 LF-only，双击后窗口会一闪而过、完全没有任何输出 —— 极难排查。
 *
 * 用法：node check-bat-eol.mjs
 * 退出码：0 = 全部正常；1 = 有文件行尾不对
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const targets = fs.readdirSync(HERE).filter((f) => /\.(bat|cmd)$/i.test(f));

if (targets.length === 0) {
  console.log('[check] 目录里没有 .bat / .cmd 文件，跳过。');
  process.exit(0);
}

let bad = 0;
for (const name of targets) {
  const buf = fs.readFileSync(path.join(HERE, name));
  const crlf = (buf.toString('latin1').match(/\r\n/g) || []).length;
  const lfTotal = (buf.toString('latin1').match(/\n/g) || []).length;
  const bareLf = lfTotal - crlf;
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

  const problems = [];
  if (bareLf > 0) problems.push(`${bareLf} 行是 LF-only（应为 CRLF）`);
  if (bom) problems.push('带 UTF-8 BOM（cmd 可能把首行 @echo off 当成命令而报错）');

  if (problems.length) {
    bad++;
    console.log(`[FAIL] ${name}  →  ${problems.join('；')}`);
  } else {
    console.log(`[ OK ] ${name}  CRLF=${crlf} 行，无 BOM`);
  }
}

if (bad) {
  console.log('');
  console.log('[check] 修复方法（任选其一）：');
  console.log('  1. git add --renormalize . && git checkout -- local-sync');
  console.log('  2. 用记事本「另存为」时选 ANSI/UTF-8 并保证是 Windows 行尾');
  console.log('  3. 跑 node local-sync/repair-bat.mjs （若存在）');
  process.exit(1);
}

console.log('');
console.log('[check] 全部通过。');
