#!/usr/bin/env node
/**
 * 把 local-sync 目录下所有 .bat / .cmd 的行尾强制修成 CRLF，并去掉 BOM。
 *
 * 什么时候用：双击 .bat 后窗口一闪而过、完全没输出 —— 99% 是行尾被改成 LF 了。
 * 跑一下这个脚本就能修好。
 *
 * 用法：node repair-bat.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const targets = fs.readdirSync(HERE).filter((f) => /\.(bat|cmd)$/i.test(f));

if (targets.length === 0) {
  console.log('[repair] 目录里没有 .bat / .cmd 文件，跳过。');
  process.exit(0);
}

let fixed = 0;
for (const name of targets) {
  const p = path.join(HERE, name);
  let buf = fs.readFileSync(p);
  const original = buf.length;

  // 1) 去 BOM
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
  }

  // 2) 统一行尾为 CRLF：先把已有的 \r\n 归一成 \n，再把所有 \n 换成 \r\n
  const text = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out = Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8');

  if (!out.equals(fs.readFileSync(p))) {
    fs.writeFileSync(p, out);
    fixed++;
    console.log(`[repair] ${name}  ${original} → ${out.length} 字节`);
  } else {
    console.log(`[ OK ] ${name}  本来就没问题`);
  }
}

console.log('');
console.log(`[repair] 完成，修正 ${fixed} 个文件。`);
