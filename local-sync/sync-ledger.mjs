#!/usr/bin/env node
/**
 * 本地同步脚本：从 GitHub 仓库拉取最新的台账 Excel 到本地固定位置，并打开。
 *
 * 背景：GitHub 无法主动「推」到你的电脑（关机时没人监听），
 * 所以改成「你想看的时候双击一下，把最新表拉下来」。
 *
 * 用 Node 内置 fetch + 公开 raw 地址，不依赖 git、不依赖登录。
 * （所以要求仓库是公开的；私有仓库需要 token，见下方 --token 说明）
 *
 * 用法（一般不用手敲，双击「同步台账.bat」即可）：
 *   node sync-ledger.mjs            # 拉取 + 用 Excel 打开
 *   node sync-ledger.mjs --check    # 只看远端有没有更新，不下载不打开
 *   node sync-ledger.mjs --no-open  # 下载但不打开
 *
 * 配置文件：与本脚本同目录的 sync-config.json
 *   {
 *     "repo":  "用户名/仓库名",
 *     "branch": "main",
 *     "remotePath": "history/buddy-ledger.xlsx",
 *     "localDir":  "C:/Users/Administrator/Desktop/Buddy加油站台账",
 *     "localName": "Buddy加油站台账.xlsx",
 *     "autoOpen":  true
 *   }
 *
 * 退出码：
 *   0 = 同步成功（含「已是最新」）
 *   2 = 未完成但可自愈（远端还没文件 / 仓库私有 / 拉到非 xlsx）—— 看屏幕提示即可
 *   1 = 配置或环境错误（repo 没填、配置文件缺失）—— 需要你动手改文件
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, 'sync-config.json');

const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
const CHECK_ONLY = argv.includes('--check');
const QUIET = argv.includes('--quiet') || argv.includes('-q');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const DEFAULTS = {
  repo: 'YOUR_NAME/YOUR_REPO',
  branch: 'main',
  remotePath: 'history/buddy-ledger.xlsx',
  localDir: path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Desktop', 'Buddy加油站台账'),
  localName: 'Buddy加油站台账.xlsx',
  autoOpen: true,
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`[sync] 找不到配置文件 ${CONFIG_FILE}`);
    process.exit(1);
  }
  const user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const cfg = { ...DEFAULTS, ...user };

  if (!cfg.repo || cfg.repo.startsWith('YOUR_NAME')) {
    console.error('[sync] 请先在 sync-config.json 里填上你的 repo（格式：用户名/仓库名）');
    console.error(`[sync] 配置文件位置：${CONFIG_FILE}`);
    process.exit(1);
  }
  return cfg;
}

const log = (...a) => { if (!QUIET) console.log(...a); };

// ---------------------------------------------------------------------------
// 拉取
// ---------------------------------------------------------------------------

/** 公开仓库的 raw 地址 */
function rawUrl(cfg) {
  return `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/${cfg.remotePath}`;
}

/** 取远端文件元信息（存在性 + 大小）。API 优先，失败退 raw。 */
async function headRemote(cfg) {
  // ---- 通道 1：Contents API（国内可达）----
  try {
    const rel = cfg.remotePath.split('/').map(encodeURIComponent).join('/');
    const apiUrl = `https://api.github.com/repos/${cfg.repo}/contents/${rel}?ref=${encodeURIComponent(cfg.branch)}`;
    const headers = { 'User-Agent': 'buddy-ledger-sync', Accept: 'application/vnd.github+json' };
    const token = loadPat();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(apiUrl, { headers });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      return { status: 200, ok: true, size: j?.size || 0, modified: '', url: apiUrl };
    }
    if (res.status === 404) {
      return { status: 404, ok: false, size: 0, modified: '', url: apiUrl };
    }
    // 其它状态码 → 掉到 raw 探测
  } catch { /* 掉到 raw */ }

  // ---- 通道 2：raw HEAD ----
  const url = rawUrl(cfg);
  try {
    // 用 HEAD 拿头，避免下载整个文件
    let res = await fetch(url, { method: 'HEAD' });
    // 有些 CDN 不支持 HEAD，退回 GET 但只读头
    if (!res.ok && res.status !== 404) {
      res = await fetch(url);
    }
    return {
      status: res.status,
      ok: res.ok,
      size: Number(res.headers.get('content-length') || 0),
      modified: res.headers.get('last-modified') || '',
      url,
    };
  } catch (e) {
    return { status: 0, ok: false, size: 0, modified: '', url, netError: netReason(e) };
  }
}

/** 把 fetch 的网络异常翻译成一句人话 */
function netReason(e) {
  const code = e?.cause?.code || e?.code || '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns';
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE/.test(code)) return 'blocked';
  if (/CERT|SSL|TLS/.test(code)) return 'tls';
  return code || 'unknown';
}

/** 可选 token：环境变量 GITHUB_PAT > ~/.buddy-github-pat（配置脚本保存的）。
 *  只用来提高 API 速率上限（匿名 60 次/时 → 带 token 5000 次/时），
 *  没有它也能拉公开仓库，只是配额低。绝不写进日志。 */
function loadPat() {
  const env = (process.env.GITHUB_PAT || '').trim();
  if (env) return env;
  try {
    const p = path.join(os.homedir(), '.buddy-github-pat');
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t && /^gh[pousr]_/.test(t)) return t;
    }
  } catch { /* ignore */ }
  return '';
}

/** 下载通道 1（国内首选）：GitHub Contents API，走 api.github.com。
 *  为什么优先它：一键配置脚本刚用这个域名完成上传/触发/轮询，实测可达；
 *  而 raw.githubusercontent.com 在国内常年被墙（连接被重置）。
 *  文件 <1MB 时响应体直接带 base64 内容，台账 8KB 绰绰有余。 */
async function apiDownload(cfg, token) {
  const rel = cfg.remotePath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${rel}?ref=${encodeURIComponent(cfg.branch)}`;
  const headers = {
    'User-Agent': 'buddy-ledger-sync',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    return { ok: false, reason: 'network', net: netReason(e), url };
  }
  if (res.status === 404) return { ok: false, reason: 'notfound', url };
  if (res.status === 401 || res.status === 403) {
    // 带 token 被拒（401 失效 / 403 限流）→ 匿名再试一次（公开仓库不受 token 影响）
    if (token) {
      const anon = { ...headers };
      delete anon.Authorization;
      try {
        const retry = await fetch(url, { headers: anon });
        if (retry.ok) {
          const j = await retry.json().catch(() => null);
          if (j && j.content) {
            const buf = Buffer.from(String(j.content).replace(/\s+/g, ''), 'base64');
            return saveBuffer(cfg, buf, url);
          }
        }
      } catch { /* 落到下面的错误返回 */ }
    }
    return { ok: false, reason: token ? 'api_auth' : 'api_ratelimit', url, status: res.status };
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}`, url };

  const j = await res.json().catch(() => null);
  if (!j || !j.content) return { ok: false, reason: 'api_no_content', url };
  if (j.encoding !== 'base64') return { ok: false, reason: 'api_bad_encoding', url };
  const buf = Buffer.from(String(j.content).replace(/\s+/g, ''), 'base64');
  return saveBuffer(cfg, buf, url);
}

async function download(cfg) {
  const url = rawUrl(cfg);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    // 网络层就挂了：DNS 解析不了 / 连接被重置 / 超时。
    // 国内直连 raw.githubusercontent.com 经常是这种，需要走代理。
    return { ok: false, reason: 'network', net: netReason(e), url };
  }
  if (res.status === 404) {
    return { ok: false, reason: 'notfound', url };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'private', url };
  }
  if (!res.ok) {
    return { ok: false, reason: `http_${res.status}`, url };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return saveBuffer(cfg, buf, url);
}

/** 校验内容并落盘（raw / API 两条通道共用）。
 *  空文件 / 非 xlsx（xlsx 是 zip，头两字节为 PK）→ 视为还没生成。 */
function saveBuffer(cfg, buf, url) {
  if (buf.length < 4) {
    return { ok: false, reason: 'empty', url };
  }
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return { ok: false, reason: 'not_xlsx', url, preview: buf.slice(0, 120).toString('utf8') };
  }

  fs.mkdirSync(cfg.localDir, { recursive: true });
  const dest = path.join(cfg.localDir, cfg.localName);

  // 内容没变就不写，避免每次开机都动文件（会影响 Excel 打开状态/修改时间）
  if (fs.existsSync(dest)) {
    const old = fs.readFileSync(dest);
    if (old.length === buf.length && old.equals(buf)) {
      return { ok: true, dest, changed: false, size: buf.length, url };
    }
  }

  // 先写临时文件再原子替换，避免 Excel 正开着导致写坏
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, dest);
  } catch {
    // 目标被占用（Excel 开着）→ 换个带时间戳的名字
    const alt = path.join(cfg.localDir, cfg.localName.replace(/\.xlsx$/i, `_${Date.now()}.xlsx`));
    try {
      fs.renameSync(tmp, alt);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, reason: 'write_locked', url };
    }
    return { ok: true, dest: alt, changed: true, size: buf.length, locked: dest, url };
  }

  return { ok: true, dest, changed: true, size: buf.length, url };
}

/** 用系统默认程序打开文件（Windows） */
function openFile(p) {
  try {
    // start 是 cmd 内置命令，需要 shell
    execFile('cmd', ['/c', 'start', '""', p], { windowsHide: true }, () => {});
  } catch {
    /* 打开失败不影响同步 */
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  const PAT = loadPat();
  log(`[sync] 仓库 ${cfg.repo}@${cfg.branch}`);
  log(`[sync] 远端 ${cfg.remotePath}`);

  if (CHECK_ONLY) {
    const info = await headRemote(cfg);
    if (info.netError) {
      log('[sync] 远端状态：连不上（网络 / 代理问题）');
      process.exit(2);
    }
    log(`[sync] 远端状态：${info.status}  大小 ${info.size}  修改 ${info.modified || '-'}`);
    if (info.status === 404) {
      log('[sync] 远端还没有这个文件（任务还没成功跑过一次）');
      process.exit(2);
    }
    return;
  }

  // 下载通道：API 优先（国内可达，配置脚本刚验证过），raw 兜底
  let r = await apiDownload(cfg, PAT);
  if (!r.ok && r.reason === 'network') {
    log('[sync] API 通道连不上，改试 raw 直连……');
    r = await download(cfg);
  }

  if (!r.ok) {
    const NET_MSG = {
      dns: '域名解析不了（DNS 被污染或断网）',
      blocked: '连接被重置 —— api.github.com 和 raw 都连不上，需要检查网络/代理',
      tls: 'HTTPS 握手失败（证书 / TLS 被拦截，通常是代理没设好）',
      unknown: '网络请求失败',
    }[r.net] || '网络请求失败';

    const msg = {
      network: NET_MSG,
      notfound: '远端还没有这个文件（说明任务还没成功跑过一次）',
      private: '仓库是私有的，匿名拉不到 —— 需要配置里带 token 的方式',
      empty: '远端文件是空的',
      not_xlsx: '拉到的不是 Excel 文件（可能是登录页 HTML）',
      api_auth: 'Token 被 GitHub 拒绝（失效或没勾 repo 权限），匿名重试也没成功',
      api_ratelimit: 'GitHub API 速率限制（匿名 60 次/小时）—— 等一会再试',
      api_no_content: 'API 返回里没有文件内容',
      api_bad_encoding: 'API 返回了未知编码',
      write_locked: '本地文件被 Excel 占用且无法另存 —— 请关掉 Excel 再同步',
    }[r.reason] || `拉取失败：${r.reason}`;

    log(`[sync] ${msg}`);
    if (r.reason === 'network') {
      log('[sync] 建议：');
      log('[sync]   1. 先确认浏览器能打开 https://github.com');
      log('[sync]   2. 打不开就是断网/代理问题；打得开但脚本不行，设 HTTPS_PROXY 环境变量');
      log('[sync]   3. 也可以直接在 GitHub 网页上下载 history/buddy-ledger.xlsx');
    }
    if (r.preview) log(`[sync] 响应片段：${r.preview.slice(0, 80)}`);

    if (!CHECK_ONLY) {
      notify(`台账同步失败\n\n${msg}\n\n${r.url}`);
    }
    process.exit(2);
  }

  if (r.changed) {
    log(`[sync] 已更新 → ${r.dest}（${(r.size / 1024).toFixed(1)} KB）`);
    if (r.locked) log(`[sync] 注意：${r.locked} 被占用，已另存为带时间戳的文件`);
  } else {
    log(`[sync] 已是最新：${r.dest}（${(r.size / 1024).toFixed(1)} KB）`);
  }

  if (cfg.autoOpen && !NO_OPEN && !r.locked) {
    log('[sync] 打开表格……');
    openFile(r.dest);
  }
}

/** 弹窗提示（Windows）；失败就算了，不阻断 */
function notify(text) {
  try {
    const ps = `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.MessageBox]::Show(${JSON.stringify(text)}, 'Buddy 台账同步') | Out-Null`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => {});
  } catch {
    /* ignore */
  }
}

try {
  await main();
} catch (e) {
  // 兜底：任何没预料到的异常都不要把 node 的堆栈直接糊到用户脸上
  console.error(`[sync] 出错了：${e?.message || e}`);
  console.error('[sync] 如果把上面这句话截图发出来，就能定位问题。');
  process.exit(2);
}
