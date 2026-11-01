#!/usr/bin/env node
/**
 * apply-patch.mjs —— 令牌自动续期「根治补丁」一键落地
 *
 * 做的事（全部幂等，可重复运行）：
 *   ① 把改造后的文件传到仓库（覆盖同名文件）
 *   ② 写两个 Secret：
 *        WORKBUDDY_REFRESH_TOKEN ← 本机 token.local.json 里的 refreshToken（60 天滚动）
 *        GH_PAT                 ← 你给的 PAT（供云端每天回写 refreshToken）
 *   ③ 触发一次 daily.yml，验证并顺带修正当天台账
 *
 * 用法：
 *   GITHUB_PAT=ghp_xxx node scripts/apply-patch.mjs
 *   （或双击 local-sync/应用根治补丁.bat，按提示粘贴 PAT）
 *
 * PAT 要求：classic token，勾 repo + workflow 两个 scope。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath：直接取 import.meta.url 的 pathname 会拿到百分号编码串
// （本机路径带中文，'%E9%A2%86...' 这种），后面 existsSync 全部落空。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';
const OWNER = 'PBY-CMYK';
const REPO = 'workbuddy-daily';
const BRANCH = 'main';

const PAT = (process.env.GITHUB_PAT || '').trim();
const out = (...a) => console.log('[patch]', ...a);

if (!PAT) {
  console.error('[patch][error] 缺少 GITHUB_PAT。用法：GITHUB_PAT=ghp_xxx node scripts/apply-patch.mjs');
  process.exit(1);
}

// 需要上传的文件（相对仓库根目录）
const FILES = [
  '.github/workflows/daily.yml',
  'package.json',
  'package-lock.json',
  'scripts/token-rotate.mjs',
  'scripts/push-secret.mjs',
  'scripts/apply-patch.mjs',
  'local-sync/sync-ledger.mjs',
  'local-sync/同步台账.bat',
  'local-sync/应用根治补丁.bat',
];

async function gh(method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'workbuddy-daily-patch',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 留 null */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function seal(publicKeyB64, value) {
  const { default: nacl } = await import('tweetnacl');
  const _b = await import('blakejs');
  const bl = _b.default || _b;
  const { blake2bInit, blake2bUpdate, blake2bFinal } = bl;

  const rpk = new Uint8Array(Buffer.from(publicKeyB64, 'base64'));
  const ekp = nacl.box.keyPair();
  const cat = new Uint8Array(64);
  cat.set(ekp.publicKey, 0);
  cat.set(rpk, 32);
  const ctx = blake2bInit(24, null);
  blake2bUpdate(ctx, cat);
  const nonce = blake2bFinal(ctx);
  const boxed = nacl.box(new Uint8Array(Buffer.from(value, 'utf8')), nonce, rpk, ekp.secretKey);
  return Buffer.concat([Buffer.from(ekp.publicKey), Buffer.from(boxed)]).toString('base64');
}

function readToken() {
  const cands = [
    path.join(ROOT, 'token.local.json'),
    path.join(ROOT, '..', '工具2', 'token.local.json'),
    path.join(process.env.USERPROFILE || '', 'Desktop', 'token.local.json'),
  ];
  for (const p of cands) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      if (j?.refreshToken) return { refresh: j.refreshToken, file: p };
    } catch { /* 下一个 */ }
  }
  return null;
}

const enc = (rel) => rel.split('/').map(encodeURIComponent).join('/');

async function main() {
  // 身份校验
  const who = await gh('GET', '/user');
  if (!who.ok) {
    console.error(`[patch][error] PAT 无效（HTTP ${who.status}）`);
    process.exit(2);
  }
  out(`PAT 属于 ${who.json.login}`);

  // ① 上传文件
  out(`① 上传 ${FILES.length} 个文件到 ${OWNER}/${REPO}@${BRANCH} ……`);
  for (const rel of FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      out(`   ⚠️ 本地缺文件，跳过：${rel}`);
      continue;
    }
    const content = fs.readFileSync(abs).toString('base64');
    const ex = await gh('GET', `/repos/${OWNER}/${REPO}/contents/${enc(rel)}?ref=${BRANCH}`);
    const sha = ex.status === 200 ? ex.json.sha : undefined;
    const put = await gh('PUT', `/repos/${OWNER}/${REPO}/contents/${enc(rel)}`, {
      message: `fix(token): ${rel} 自动续期 [skip ci]`,
      content,
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    });
    if (!put.ok) {
      const msg = put.json?.message || put.text?.slice(0, 200);
      console.error(`[patch][error] 上传 ${rel} 失败（HTTP ${put.status}）：${msg}` +
        (/workflow/.test(msg || '') ? ' ← PAT 缺 workflow 权限' : ''));
      process.exit(3);
    }
    out(`   ✅ ${rel}${sha ? '（覆盖）' : '（新增）'}`);
  }

  // ② 写 Secret
  out('② 写 Secret（加密传输，明文不进仓库也不进日志）……');
  const tok = readToken();
  if (!tok) {
    console.error('[patch][error] 找不到带 refreshToken 的 token.local.json，无法配置自动续期');
    process.exit(4);
  }
  const pkRes = await gh('GET', `/repos/${OWNER}/${REPO}/actions/secrets/public-key`);
  if (!pkRes.ok) {
    console.error(`[patch][error] 取公钥失败（HTTP ${pkRes.status}）`);
    process.exit(4);
  }
  const pk = pkRes.json;

  const secrets = [
    ['WORKBUDDY_REFRESH_TOKEN', tok.refresh, `（来自 ${tok.file}，有效期至 60 天后且每日滚动）`],
    ['GH_PAT', PAT, '（供云端回写 refreshToken）'],
  ];
  for (const [name, value, note] of secrets) {
    const sealed = await seal(pk.key, value);
    const put = await gh('PUT', `/repos/${OWNER}/${REPO}/actions/secrets/${name}`, {
      encrypted_value: sealed,
      key_id: pk.key_id,
    });
    if (put.status !== 201 && put.status !== 204) {
      console.error(`[patch][error] 写 Secret ${name} 失败（HTTP ${put.status}）`);
      process.exit(5);
    }
    out(`   ✅ ${name} ${note}`);
  }

  // ③ 触发一次
  out('③ 触发一次 daily.yml 验证（顺带修正今天的台账行）……');
  const disp = await gh('POST', `/repos/${OWNER}/${REPO}/actions/workflows/daily.yml/dispatches`, { ref: BRANCH });
  if (disp.status !== 204) {
    console.error(`[patch][error] 触发失败（HTTP ${disp.status}）：${disp.json?.message || ''}`);
    out('   文件与 Secret 已就绪，明早 09:00 仍会自动跑起来，只是这次没能现场验证。');
    process.exit(6);
  }
  out('   ✅ 已触发，可在仓库 Actions 页看结果');

  // 轮询最多 3 分钟
  const since = new Date(Date.now() - 5000).toISOString();
  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const runs = await gh('GET', `/repos/${OWNER}/${REPO}/actions/workflows/daily.yml/runs?per_page=3&event=workflow_dispatch`);
    const run = runs.json?.workflow_runs?.find((r) => r.created_at >= since);
    if (!run) continue;
    if (run.status === 'completed') {
      out(`   ${run.conclusion === 'success' ? '✅ 运行成功' : '❌ 运行失败'}：${run.html_url}`);
      process.exit(run.conclusion === 'success' ? 0 : 7);
    }
    out(`   …运行中（${run.status}）`);
  }
  out('   3 分钟内没等到结果，去 Actions 页看：https://github.com/PBY-CMYK/workbuddy-daily/actions');
  process.exit(0);
}

main().catch((e) => {
  console.error(`[patch][error] 未预期异常：${e.message}`);
  process.exit(9);
});
