#!/usr/bin/env node
/**
 * token-rotate.mjs —— 云端令牌自动续期（跑在 GitHub Actions 里）
 *
 * 背景：WORKBUDDY_ACCESS_TOKEN 只有 30 天寿命，写死在 Secret 里必然每月失效一次
 *       （2026-10-30、2026-11-30 就各死过/会死一次，表现为签到 HTTP 401）。
 *
 * 做法：Secret 里改存 workbuddy 的 refreshToken（60 天、每次续期都滚动换新）。
 *       每天任务开始前用它换一张新的 accessToken 给 checkin.mjs 用，
 *       跑完把新的 refreshToken 回写 Secret（见 push-secret.mjs）——
 *       只要 60 天内跑过一次，链条就永远不断，再不用手工换令牌。
 *
 * 环境变量：
 *   WORKBUDDY_REFRESH_TOKEN        首选（新机制）
 *   WORKBUDDY_ACCESS_TOKEN         兜底（老 Secret 还有效时也能跑）
 *   GITHUB_ENV                     Actions 注入，用于向下游步骤传新 accessToken
 *   RUNNER_TEMP                    新 refreshToken 落盘位置（供回写步骤读取）
 *
 * 安全：任何情况下都不把令牌明文打到日志里。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const REFRESH_URL = 'https://www.workbuddy.cn/v2/plugin/auth/token/refresh';
const TIMEOUT_MS = Number(process.env.WORKBUDDY_TIMEOUT_MS || 20000);

const REFRESH_TOKEN = (process.env.WORKBUDDY_REFRESH_TOKEN || '').trim();
const FALLBACK_ACCESS = (process.env.WORKBUDDY_ACCESS_TOKEN || '').trim();

const log = (...a) => console.log('[token]', ...a);

/** 解 JWT 的 exp，仅用于日志里报有效期，失败返回 0 */
function jwtExp(tok) {
  try {
    const seg = tok.split('.')[1];
    if (!seg) return 0;
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const m = json.match(/"exp"\s*:\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function fmtExp(exp) {
  if (!exp) return '未知';
  // 后端是 UTC 秒；这里按东八区显示，跟人看到的一致
  return new Date((exp + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** 把 key=value 追加进 GITHUB_ENV，下游步骤即可读到 */
function exportEnv(key, value) {
  const f = process.env.GITHUB_ENV;
  if (!f) {
    log(`[warn] 没有 GITHUB_ENV（本地跑？），跳过导出 ${key}`);
    return;
  }
  fs.appendFileSync(f, `${key}=${value}\n`, 'utf8');
}

/** 降级：直接用老 accessToken 跑，保证「续期挂了也不至于当天断粮」 */
function fallback(reason) {
  if (!FALLBACK_ACCESS) {
    console.error(`[token][error] ${reason}；且没有 WORKBUDDY_ACCESS_TOKEN 可兜底，任务无法继续。`);
    process.exit(1);
  }
  log(`[warn] ${reason} → 退回使用 Secret 里的 WORKBUDDY_ACCESS_TOKEN（有效期至 ${fmtExp(jwtExp(FALLBACK_ACCESS))}）。`);
  log('[warn] 该令牌到期后本条兜底也会失效，请尽快确认 WORKBUDDY_REFRESH_TOKEN / GH_PAT 两个 Secret 是否正确。');
  process.exit(0);
}

async function main() {
  if (!REFRESH_TOKEN) {
    fallback('没有配置 WORKBUDDY_REFRESH_TOKEN');
    return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Refresh-Token': REFRESH_TOKEN,
        'X-Auth-Refresh-Source': 'plugin',
        Domain: 'www.workbuddy.cn',
      },
      body: '{}',
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    fallback(`续期请求失败：${e.name === 'AbortError' ? '超时' : e.message}`);
    return;
  }
  clearTimeout(timer);

  const text = await res.text();
  if (res.status !== 200) {
    // 401 基本就是 refreshToken 本身过期/被消费掉了
    fallback(`续期接口 HTTP ${res.status}${res.status === 401 ? '（refreshToken 已失效）' : ''}`);
    return;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fallback('续期返回不是 JSON');
    return;
  }

  // 后端可能把令牌包在 data 里，两种形态都认
  const d = json?.data ?? json;
  const accessToken = String(d?.accessToken ?? d?.access_token ?? '').trim();
  const refreshToken = String(d?.refreshToken ?? d?.refresh_token ?? '').trim();

  if (!accessToken) {
    fallback('续期返回里没有 accessToken');
    return;
  }

  exportEnv('WORKBUDDY_ACCESS_TOKEN', accessToken);
  log(`✅ 已换新 accessToken，有效期至 ${fmtExp(jwtExp(accessToken))}`);

  // 新 refreshToken 交给回写步骤（只在确实换了新的时候写）
  if (refreshToken && refreshToken !== REFRESH_TOKEN) {
    const dir = process.env.RUNNER_TEMP || os.tmpdir();
    const f = path.join(dir, 'new_refresh.txt');
    fs.writeFileSync(f, refreshToken, 'utf8');
    log(`✅ 新 refreshToken 已暂存（有效期至 ${fmtExp(jwtExp(refreshToken))}），任务结束后回写 Secret`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `rotated=true\nrefresh_file=${f}\n`, 'utf8');
    }
  } else {
    log('refreshToken 未变化，无需回写');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'rotated=false\n', 'utf8');
  }
}

main().catch((e) => fallback(`未预期异常：${e.message}`));
