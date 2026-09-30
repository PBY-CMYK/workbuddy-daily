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
  return await saveBuffer(cfg, buf, url);
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
  return await saveBuffer(cfg, buf, url);
}

/** 校验内容并落盘（raw / API 两条通道共用）。
 *  空文件 / 非 xlsx（xlsx 是 zip，头两字节为 PK）→ 视为还没生成。
 *  目标被 Excel/WPS 占用时重试若干次，仍失败就明确报错——
 *  绝不另存「_时间戳」副本（用户要求：台账永远只有一份）。 */
const SAVE_RETRIES = 3;
const SAVE_RETRY_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function saveBuffer(cfg, buf, url) {
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

  // 先写临时文件再原子替换，避免写坏
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, buf);

  let renamed = false;
  for (let i = 0; i < SAVE_RETRIES; i++) {
    try {
      fs.renameSync(tmp, dest);
      renamed = true;
      break;
    } catch {
      // 多半是 Excel/WPS 还开着：等一下再试
      if (i < SAVE_RETRIES - 1) await sleep(SAVE_RETRY_MS);
    }
  }
  if (!renamed) {
    // rename 反复失败：目标被无 FILE_SHARE_DELETE 权限的句柄占着
    // （Defender/索引服务常见，未必真是 Excel 开着）。降级为直接覆盖写——
    // 目标允许写时就能成功；Excel 真独占（deny-write）时仍失败并报错。
    try {
      fs.writeFileSync(dest, buf);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      renamed = true;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, reason: 'write_locked', url };
    }
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
  } else {
    log(`[sync] 已是最新：${r.dest}（${(r.size / 1024).toFixed(1)} KB）`);
  }

  // 同步成功后（打开之前）：实时刷新台账底部的「今日已用 / 还剩积分」
  await refreshSummaryRows(r.dest);

  if (cfg.autoOpen && !NO_OPEN) {
    log('[sync] 打开表格……');
    openFile(r.dest);
  }
}

// ---------------------------------------------------------------------------
// 实时积分小结刷新
// ---------------------------------------------------------------------------

const WB_ENDPOINT = 'https://copilot.tencent.com';

/** 读本地登录态（workbuddy-daily/token.local.json，与本脚本同级目录的上一级） */
function loadBuddyToken() {
  const candidates = [
    path.join(HERE, '..', 'token.local.json'),
    path.join(HERE, 'token.local.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j?.accessToken) return { token: j.accessToken, uid: j.uid || '' };
    } catch { /* 试下一个 */ }
  }
  return null;
}

/** 查询积分余额：POST /billing/meter/get-user-resource-summary（客户端同款聚合接口） */
async function fetchCreditRemain(t) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${t.token}`,
    'X-Product-Code': 'workbuddy',
    'X-Client-Platform': 'web',
    'User-Agent': 'buddy-ledger-sync/1.0',
  };
  if (t.uid) headers['X-User-Id'] = t.uid;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${WB_ENDPOINT}/billing/meter/get-user-resource-summary`, {
      method: 'POST', headers, body: '{}', signal: ctrl.signal,
    });
    const j = await res.json().catch(() => null);
    if (!j || j.code !== 0) return null;
    const pkgs = Array.isArray(j?.data?.Packages) ? j.data.Packages : [];
    const toN = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const remain = Math.round(pkgs.reduce((s, p) => s + toN(p?.CycleRemainCapacity), 0) * 100) / 100;
    const total = Math.round(pkgs.reduce((s, p) => s + toN(p?.CycleTotalCapacity), 0) * 100) / 100;
    return pkgs.length ? { remain, total } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 刷新 K 列小结区的「今日已用 / 还剩积分」（K1=累计总积分、K2=今日已用、K3=还剩积分）：
 *   还剩积分(L3) ← 实时余额（get-user-resource-summary 汇总）
 *   今日已用(L2) ← 上次快照还剩 - 当前还剩（本地不签到，消耗只会让余额变小；
 *                  差值为负说明中间有别的入账，按 0 处理）
 * 兼容旧版 A 列底部小结（s=累计总积分行 → s+1/s+2 的 B 列）。
 * 任何一步失败都只提示、不阻断（台账本身已经同步成功了）。
 */
/** 截掉末尾连续的空行槽。ExcelJS writeFile 会把内存里物化出来的空行
 *  写成 <row> 空元素（幽灵行），读回后 rowCount 虚高、表格下方多空行。 */
function trimTrailingEmptyRows(ws) {
  let end = ws.rowCount;
  while (end >= 1) {
    const r = ws.getRow(end);
    if (!r) { end--; continue; }
    let hasValue = false;
    r.eachCell({ includeEmpty: true }, (c) => {
      if (c.value !== null && c.value !== undefined) hasValue = true;
    });
    if (hasValue) break;
    end--;
  }
  if (end < ws.rowCount) ws._rows.length = end;
}

async function refreshSummaryRows(dest) {
  try {
    if (!fs.existsSync(dest)) return;
    const t = loadBuddyToken();
    if (!t) {
      log('[sync] 未找到 token.local.json，跳过积分小结刷新（不影响台账）');
      return;
    }

    const sum = await fetchCreditRemain(t);
    if (!sum) {
      log('[sync] 积分余额查询失败，台账小结保持上一次的值');
      return;
    }

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(dest);
    const ws = wb.getWorksheet('每日记录');
    if (!ws) return;

    // 定位小结：新版 K 列优先，旧版 A 列底部兜底
    let usedCell, remainCell;
    if (String(ws.getCell('K1').value ?? '').trim() === '累计总积分') {
      usedCell = ws.getCell('L2');
      remainCell = ws.getCell('L3');
    } else {
      let s = -1;
      for (let i = 2; i <= ws.rowCount; i++) {
        if (String(ws.getRow(i).getCell(1).value ?? '').trim() === '累计总积分') { s = i; break; }
      }
      if (s < 0) {
        log('[sync] 台账里没有积分小结区，跳过刷新');
        return;
      }
      remainCell = ws.getRow(s + 2).getCell(2);
      usedCell = ws.getRow(s + 1).getCell(2);
    }

    // 旧值是「—」/空时不推算今日已用，只刷新还剩
    const raw = remainCell.value;
    const oldRemain = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    let usedText = usedCell.value;
    if (Number.isFinite(oldRemain)) {
      const inc = Math.max(0, Math.round((oldRemain - sum.remain) * 100) / 100);
      const prevUsed = Number(usedCell.value);
      // 白天多次同步：在旧「今日已用」上累加本次快照差（覆盖式会丢此前
      // 已累计的消费）；余额没变时 inc=0，重复运行幂等。
      // 跨天清零由每天第一次 append 记账重置。
      usedText = Number.isFinite(prevUsed)
        ? Math.round((prevUsed + inc) * 100) / 100
        : inc;
    }
    remainCell.value = sum.remain;
    usedCell.value = usedText;

    trimTrailingEmptyRows(ws);
    await wb.xlsx.writeFile(dest);
    log(`[sync] 积分小结已刷新：还剩 ${sum.remain}（今日已用 ${usedText}）`);
  } catch (e) {
    log(`[sync] 积分小结刷新失败（不影响台账）：${e?.message || e}`);
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
