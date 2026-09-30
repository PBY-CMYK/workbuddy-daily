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

/** 取远端文件元信息（存在性 + 大小 + 修改时间） */
async function headRemote(cfg) {
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

  // 空文件 / 非 xlsx（xlsx 是 zip，头两字节为 PK）→ 视为还没生成
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
    fs.renameSync(tmp, alt);
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

  const r = await download(cfg);

  if (!r.ok) {
    const NET_MSG = {
      dns: '域名解析不了（raw.githubusercontent.com 被污染或断网）',
      blocked: '连接被重置 —— 国内直连 GitHub raw 常被墙，需要挂代理',
      tls: 'HTTPS 握手失败（证书 / TLS 被拦截，通常是代理没设好）',
      unknown: '网络请求失败',
    }[r.net] || '网络请求失败';

    const msg = {
      network: NET_MSG,
      notfound: '远端还没有这个文件（说明任务还没成功跑过一次）',
      private: '仓库是私有的，raw 地址拉不到 —— 需要改用带 token 的方式',
      empty: '远端文件是空的',
      not_xlsx: '拉到的不是 Excel 文件（可能是登录页 HTML）',
    }[r.reason] || `拉取失败：${r.reason}`;

    log(`[sync] ${msg}`);
    if (r.reason === 'network') {
      log('[sync] 建议：');
      log('[sync]   1. 先确认浏览器能打开 https://raw.githubusercontent.com');
      log('[sync]   2. 打不开就挂代理，或在系统里设 HTTPS_PROXY 环境变量');
      log('[sync]   3. 实在拉不动，也可以直接在 GitHub 网页上下载 history/buddy-ledger.xlsx');
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
    log(`[sync] 已是最新，无需更新（${(r.size / 1024).toFixed(1)} KB）`);
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
