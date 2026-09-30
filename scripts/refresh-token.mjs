#!/usr/bin/env node
/**
 * refresh-token.mjs —— 本机登录态导出工具（★ 只在本机运行，绝不进仓库 ★）
 *
 * 作用：读取 WorkBuddy 桌面客户端在本机保存的登录态，导出 access token，
 *       供你手动填入 GitHub 仓库 Secret（云端 runner 没有本机登录态）。
 *
 * 知识点（从客户端 5.5.6 包内实现得到）：
 *   - 登录态文件： <basePath>/Data/Public/auth/<authenticationId>.info
 *       Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info
 *       macOS  : ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/*.info
 *       Linux  : ~/.local/share/CodeBuddyExtension/Data/Public/auth/*.info
 *   - 文件是 JSON，其中敏感字段（auth.accessToken / auth.refreshToken 等）为
 *     AES-256-GCM 加密，密钥由系统安全存储托管。
 *   - 因此本脚本优先尝试「调用客户端自身 CLI 打印」的方式；若失败，
 *     退化为读取未加密字段并给出明确指引。
 *
 * 为什么不做纯手写解密：密钥托管在系统凭据库，绕过它既不可靠也不合适。
 * 与其猜，不如让客户端自己吐。
 *
 * 用法：
 *   node refresh-token.mjs              # 自动尝试，输出 token
 *   node refresh-token.mjs --json       # 以 JSON 输出（便于管道处理）
 *   node refresh-token.mjs --set-secret # 直接写入 GitHub Secret（需已装并登录 gh）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
const SET_SECRET = args.includes('--set-secret');

const out = (...a) => console.log(...a);
const outErr = (...a) => console.error(...a);

// ---------------------------------------------------------------------------
// 1. 定位登录态文件
// ---------------------------------------------------------------------------

function basePath() {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin': return path.join(home, 'Library/Application Support/CodeBuddyExtension');
    case 'win32':  return path.join(home, 'AppData', 'Local', 'CodeBuddyExtension');
    default:       return path.join(home, '.local', 'share', 'CodeBuddyExtension');
  }
}

function findAuthFiles() {
  const dir = path.join(basePath(), 'Data', 'Public', 'auth');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.info'))
    .map((f) => path.join(dir, f));
}

// ---------------------------------------------------------------------------
// 2. 尝试从客户端 CLI 取（首选：最稳，不碰加密细节）
// ---------------------------------------------------------------------------

function tryCliToken() {
  const candidates = [
    // workbuddy CLI / codebuddy CLI 的常见位置
    path.join(os.homedir(), '.workbuddy', 'bin', 'workbuddy'),
    path.join(os.homedir(), '.codebuddy', 'bin', 'codebuddy'),
    'workbuddy',
    'codebuddy',
  ];

  for (const bin of candidates) {
    for (const argv of [['auth', 'token'], ['whoami', '--json'], ['auth', 'status', '--json']]) {
      try {
        const res = spawnSync(bin, argv, { encoding: 'utf8', timeout: 15000, shell: false });
        if (res.status !== 0 || !res.stdout) continue;
        const text = res.stdout.trim();

        // 直接是 token
        if (/^[A-Za-z0-9._\-]{40,}$/.test(text)) return { token: text, via: `${bin} ${argv.join(' ')}` };

        // JSON 里找
        try {
          const j = JSON.parse(text);
          const t = j.accessToken || j.access_token || j.token ||
                    j?.auth?.accessToken || j?.data?.accessToken;
          if (typeof t === 'string' && t.length > 20) {
            return { token: t, via: `${bin} ${argv.join(' ')}` };
          }
        } catch { /* 非 JSON */ }
      } catch { /* 该 bin 不存在或无该子命令，继续试 */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. 退化方案：读登录态文件里的非加密字段
// ---------------------------------------------------------------------------

function readPlainFields() {
  const files = findAuthFiles();
  const results = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const j = JSON.parse(raw);
      results.push({
        file: f,
        uid: j?.account?.uid ?? null,
        authPresent: !!j?.auth,
        accessTokenEncrypted: !!j?.auth?.accessToken,
        // 加密字段通常形如 { v: ..., iv: ..., data: ... } 或字符串 "enc:..."
        accessTokenShape: describe(j?.auth?.accessToken),
        domain: j?.auth?.domain ?? null,
        accounts: Array.isArray(j?.accounts) ? j.accounts.length : 0,
      });
    } catch (e) {
      results.push({ file: f, error: e.message });
    }
  }
  return results;
}

function describe(v) {
  if (v == null) return 'absent';
  if (typeof v === 'string') {
    if (v.startsWith('enc:') || v.startsWith('v1:')) return 'encrypted-string';
    return `plain(len=${v.length})`;
  }
  if (typeof v === 'object') return `encrypted-object(keys=${Object.keys(v).join(',')})`;
  return typeof v;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

out('=== WorkBuddy 登录态导出 ===\n');

const cli = tryCliToken();
if (cli) {
  out(`✅ 已通过客户端 CLI 取得 token（来源：${cli.via}）\n`);
  if (AS_JSON) {
    out(JSON.stringify({ accessToken: cli.token }, null, 2));
  } else {
    out('----- ACCESS TOKEN（请勿外泄，勿提交进仓库）-----');
    out(cli.token);
    out('--------------------------------------------------');
  }

  if (SET_SECRET) {
    out('\n正在写入 GitHub Secret WORKBUDDY_ACCESS_TOKEN ...');
    try {
      execFileSync('gh', ['secret', 'set', 'WORKBUDDY_ACCESS_TOKEN', '--body', cli.token], {
        stdio: 'inherit',
      });
      out('✅ 已写入。');
    } catch (e) {
      outErr(`❌ 写入失败：${e.message}`);
      outErr('   请确认本机已安装并登录 GitHub CLI，且当前目录是仓库目录。');
      process.exit(1);
    }
  } else {
    out('\n下一步：把上面的 token 填到仓库 Secret：');
    out('  Settings → Secrets and variables → Actions → New repository secret');
    out('  Name:  WORKBUDDY_ACCESS_TOKEN');
    out('  Value: <上面那串>');
    out('\n或在本机仓库目录执行（需已登录 gh）：');
    out('  node refresh-token.mjs --set-secret');
  }
  process.exit(0);
}

// 退化路径
outErr('⚠️  未能通过客户端 CLI 直接取得 token。');
outErr('    下面列出本机登录态文件的字段情况，用于判断加密方式：\n');

const info = readPlainFields();
if (info.length === 0) {
  outErr(`未找到登录态文件。预期位置：`);
  outErr(`  ${path.join(basePath(), 'Data', 'Public', 'auth', '*.info')}`);
  outErr('请确认 WorkBuddy 桌面客户端已安装并已登录。');
  process.exit(1);
}

out(JSON.stringify(info, null, 2));

out(`
说明：登录态里的 accessToken 是 AES-256-GCM 加密的，密钥托管在系统安全存储中，
脚本无法（也不应）绕过它解密。

可行的取 token 方式（任选其一）：

  A) 用客户端自带的调试入口
     在 WorkBuddy 中打开开发者工具（Ctrl+Shift+I / Cmd+Opt+I），
     在 Console 里执行：await window.wb.auth.getAccessToken?.()
     或从 Application → Local Storage 中找到 accessToken。

  B) 直接从抓包拿
     打开客户端 → 抓一次任意 /v2/ 请求（如打开「Buddy 加油站」页面），
     复制请求头里的 Authorization: Bearer <token> 后半段。

  C) 改用长期有效的凭证
     如果 refreshToken 可用，可把 refreshToken 存进 Secret，
     由 Actions 定时换取 accessToken（需要额外的换 token 接口，可再来找我加）。

拿到 token 后，写入仓库 Secret：
  Name:  WORKBUDDY_ACCESS_TOKEN
  Value: <token>
`);

process.exit(2);
