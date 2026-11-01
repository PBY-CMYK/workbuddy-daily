#!/usr/bin/env node
/**
 * push-secret.mjs —— 用 PAT 写仓库 Secret（libsodium sealed box 加密）
 *
 * 两个用途：
 *   1) 本机一次性初始化：把当前 refreshToken / PAT 写进仓库 Secret
 *   2) 云端每日回写：token-rotate.mjs 换出的新 refreshToken 写回 Secret，
 *      实现「60 天滚动续期、永不手工维护」
 *
 * 用法：
 *   GITHUB_PAT=ghp_xxx node scripts/push-secret.mjs --repo owner/name --name WORKBUDDY_REFRESH_TOKEN --from-file /tmp/new_refresh.txt
 *   GITHUB_PAT=ghp_xxx node scripts/push-secret.mjs --repo owner/name --name WORKBUDDY_USER_ID --value 01bd2...
 *
 * 注意：GitHub 禁止 Secret 名以 GITHUB_ 开头。
 */

import fs from 'node:fs';
import process from 'node:process';

const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const PAT = (process.env.GITHUB_PAT || process.env.GH_PAT || '').trim();
const REPO = arg('--repo', process.env.GITHUB_REPOSITORY || 'PBY-CMYK/workbuddy-daily');
const NAME = arg('--name');
const VALUE_FILE = arg('--from-file');
const VALUE_INLINE = arg('--value');

const log = (...a) => console.log('[secret]', ...a);

function die(msg, code = 1) {
  console.error(`[secret][error] ${msg}`);
  process.exit(code);
}

if (!PAT) die('缺少 GITHUB_PAT（需要 repo + workflow 权限的 classic PAT）');
if (!NAME) die('缺少 --name');
if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(NAME)) die(`Secret 名不合法：${NAME}`);
if (NAME.startsWith('GITHUB_')) die('Secret 名不能以 GITHUB_ 开头');

let VALUE = VALUE_INLINE;
if (!VALUE && VALUE_FILE) {
  if (!fs.existsSync(VALUE_FILE)) die(`找不到 --from-file 指定的文件：${VALUE_FILE}`);
  VALUE = fs.readFileSync(VALUE_FILE, 'utf8').trim();
}
if (!VALUE) die('没有可写入的值（--value 或 --from-file 二者其一）');

const api = (p, init = {}) =>
  fetch(`https://api.github.com${p}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'workbuddy-daily-secret-pusher',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });

async function seal(publicKeyB64, value) {
  const { default: nacl } = await import('tweetnacl');
  const _b = await import('blakejs');
  const bl = _b.default || _b;
  const { blake2bInit, blake2bUpdate, blake2bFinal } = bl;

  const rpk = new Uint8Array(Buffer.from(publicKeyB64, 'base64'));
  const ekp = nacl.box.keyPair();

  // sealed box 的 nonce = BLAKE2b-24(ephemeral_pk || recipient_pk)
  const cat = new Uint8Array(64);
  cat.set(ekp.publicKey, 0);
  cat.set(rpk, 32);
  const ctx = blake2bInit(24, null);
  blake2bUpdate(ctx, cat);
  const nonce = blake2bFinal(ctx);

  const boxed = nacl.box(new Uint8Array(Buffer.from(value, 'utf8')), nonce, rpk, ekp.secretKey);
  return Buffer.concat([Buffer.from(ekp.publicKey), Buffer.from(boxed)]).toString('base64');
}

async function main() {
  // 先确认 PAT 能读这个仓库，报错更直观
  const who = await api('/user');
  if (!who.ok) die(`PAT 无效（HTTP ${who.status}）`, 2);
  const me = (await who.json()).login;

  const pkRes = await api(`/repos/${REPO}/actions/secrets/public-key`);
  if (!pkRes.ok) die(`取仓库公钥失败（HTTP ${pkRes.status}）：${(await pkRes.text()).slice(0, 200)}`, 2);
  const pk = await pkRes.json();

  const encrypted_value = await seal(pk.key, VALUE);
  const put = await api(`/repos/${REPO}/actions/secrets/${NAME}`, {
    method: 'PUT',
    body: JSON.stringify({ encrypted_value, key_id: pk.key_id }),
  });

  if (put.status === 201 || put.status === 204) {
    log(`✅ ${REPO} 的 Secret ${NAME} 已更新（由 ${me} 写入，值长度 ${VALUE.length}，未打印明文）`);
    process.exit(0);
  }
  die(`写 Secret 失败（HTTP ${put.status}）：${(await put.text()).slice(0, 300)}`, 2);
}

main().catch((e) => die(`未预期异常：${e.message}`, 3));
