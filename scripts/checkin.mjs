#!/usr/bin/env node
/**
 * WorkBuddy「Buddy 加油站」每日签到 + 派猫猫旅行 自动化
 *
 * 运行环境：GitHub Actions 云端 runner（无常驻设备、无本机登录态）
 * 凭证来源：仓库 Secret（由本机 refresh-token 脚本导出后手动注入）
 *
 * 接口来源：全部取自客户端 / 官网前端 bundle 里「实际发起的请求」，非网络流传的旧接口名。
 *
 * A. 签到（桌面客户端 5.5.6 主进程，baseURL = copilot.tencent.com）
 *   POST {endpoint}/billing/meter/checkin-status        查询签到状态
 *   POST {endpoint}/billing/meter/daily-checkin         执行每日签到
 *
 * B. 猫猫旅行（官网成长中心 SPA，baseURL 同源 = www.workbuddy.cn）
 *   抓包来源：
 *     接口定义  growthSpace-EIUE4QaA.js:
 *       Q=()=>e.get("/activity/growth/buddy/travel/config")
 *       W=()=>e.get("/activity/growth/buddy/travel/status")
 *       Y=t=>e.post("/activity/growth/buddy/travel/depart",{location_id:t})   ← 派猫
 *       j=()=>e.post("/activity/growth/buddy/travel/claim",{})
 *       J=(t=1,a=20)=>e.get("/activity/growth/buddy/travel/records",{params:{page:t,page_size:a}})
 *     别名映射  GrowthCenterPage-BZwm0xmj.js:
 *       import{O as ms,P as us,Q as hs,R as gs}from"./growthSpace-EIUE4QaA.js"
 *       → gs=config  hs=status  us=depart  ms=claim
 *     调用点    travelStore.fetchConfig / fetchStatus / depart / claim
 *
 *   GET  {endpoint}/activity/growth/buddy/travel/config   可派地点列表（locations）
 *   GET  {endpoint}/activity/growth/buddy/travel/status   行程状态（state/location/arrive_at/...）
 *   POST {endpoint}/activity/growth/buddy/travel/depart   派猫出行  body: {location_id}
 *   POST {endpoint}/activity/growth/buddy/travel/claim    领取「已到家」旅行奖励积分
 *
 * 执行顺序（按需求）：
 *   1) 先领掉已经到家的旅行积分
 *   2) 再判断能不能派新的一趟；今天已经派过就跳过
 *   3) 输出分区的结果，推送飞书
 *
 * 容错：猫猫部分任何失败都不影响签到结论；签到成功即视为整体成功。
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const ENDPOINT = (process.env.WORKBUDDY_ENDPOINT || 'https://copilot.tencent.com').replace(/\/+$/, '');
const ACCESS_TOKEN = (process.env.WORKBUDDY_ACCESS_TOKEN || '').trim();
const USER_ID = (process.env.WORKBUDDY_USER_ID || '').trim();

/**
 * 猫猫旅行接口走的是「官网成长中心」那套，与签到不在同一个 host。
 * 客户端点「派猫猫旅行」时是打开内置浏览器访问
 *   https://www.workbuddy.cn/profile/growth-center?fromSource=...
 * 页面里的 axios 实例 baseURL 为空（同源），所以真实请求落在 www.workbuddy.cn。
 * 可用 WORKBUDDY_WEB_ENDPOINT 覆盖，便于指向预发环境。
 */
const WEB_ENDPOINT = (process.env.WORKBUDDY_WEB_ENDPOINT || 'https://www.workbuddy.cn').replace(/\/+$/, '');

/** 派猫时优先使用的地点 id；留空则自动取 config 返回的第一个 */
const TRAVEL_LOCATION_ID = (process.env.WORKBUDDY_TRAVEL_LOCATION_ID || '').trim();

/** 已派猫标记文件：同一次 run 内以 status 为准，不依赖本地持久化 */
const TIMEOUT_MS = Number(process.env.WORKBUDDY_TIMEOUT_MS || 20000);

/** 输出原始返回（脱敏后）到日志，便于验收；默认开启 */
const DEBUG_RAW = process.env.WORKBUDDY_DEBUG_RAW !== '0';

/** 干跑：只查询不产生任何写操作（不签到、不领奖、不派猫） */
const DRY_RUN = process.env.WORKBUDDY_DRY_RUN === '1';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const log = (...a) => console.log(...a);
const logErr = (...a) => console.error(...a);

/** 带超时的 fetch */
async function request(method, path, { body, token, base, platform } = {}) {
  const url = `${base || ENDPOINT}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token ?? ACCESS_TOKEN}`,
    // 客户端对消息中心/活动接口会带 X-Product-Code，缺省可能被后端拒（400 17043）
    'X-Product-Code': 'workbuddy',
    // 成长中心 SPA 的请求拦截器固定写入：X-Client-Platform = "web"（非小程序分支）
    'X-Client-Platform': platform || 'web',
    'User-Agent': 'workbuddy-daily-action/1.0',
  };
  if (USER_ID) headers['X-User-Id'] = USER_ID;

  const init = { method, headers, signal: controller.signal };
  if (body !== undefined) init.body = JSON.stringify(body);

  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
    return { ok: res.ok, status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

/** 业务成功判定：HTTP 2xx 且 envelope code === 0 */
function isBizOk(r) {
  if (!r) return false;
  if (typeof r.json?.code === 'number') return r.json.code === 0;
  return r.ok;
}

/** 从 envelope 里取业务错误描述 */
function bizMsg(r) {
  return r?.json?.msg || r?.json?.message || (r ? `HTTP ${r.status}` : 'no response');
}

/**
 * 脱敏：把 token / 手机号 / uid 之类替换掉，再打印原始返回。
 * 用于验收时展示「原始返回（脱敏后）」。
 */
export function sanitize(value) {
  const SENSITIVE_KEYS = new Set([
    'accessToken', 'access_token', 'refreshToken', 'refresh_token',
    'token', 'id_token', 'authorization', 'cookie', 'sessionId',
    'phoneNumber', 'phone', 'mobile', 'email', 'nickname',
    'uid', 'userId', 'user_id', 'oneidAccountId', 'openid', 'unionid',
  ]);

  const maskToken = (s) => {
    if (typeof s !== 'string') return s;
    if (s.length <= 12) return '***';
    return `${s.slice(0, 4)}***${s.slice(-4)}`;
  };

  const walk = (node, key) => {
    if (node === null || node === undefined) return node;

    if (Array.isArray(node)) return node.map((v) => walk(v, key));

    if (typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (SENSITIVE_KEYS.has(k)) {
          out[k] = typeof v === 'string' ? maskToken(v) : '***';
        } else {
          out[k] = walk(v, k);
        }
      }
      return out;
    }

    // 裸字符串里的 Bearer / 长 token 形态
    if (typeof node === 'string') {
      let s = node.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
      // 形如 uuid 的 uid
      s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) =>
        `${m.slice(0, 8)}-****-****-****-************`);
      return s;
    }
    return node;
  };

  return walk(value, null);
}

/** 打印一段原始返回（脱敏后），供验收 */
function dumpRaw(label, r) {
  if (!DEBUG_RAW) return;
  const payload = {
    http_status: r?.status ?? null,
    ok: r?.ok ?? false,
    body: r?.json ?? r?.text ?? null,
  };
  log(`\n----- [raw:${label}] (sanitized) -----`);
  log(JSON.stringify(sanitize(payload), null, 2));
  log(`----- [/raw:${label}] -----\n`);
}

// ---------------------------------------------------------------------------
// 业务动作
// ---------------------------------------------------------------------------

/** 查询签到状态 */
async function getCheckinStatus() {
  const r = await request('POST', '/billing/meter/checkin-status', { body: {} });
  return { ok: isBizOk(r), res: r, data: r?.json?.data ?? null };
}

/** 执行每日签到 */
async function claimDailyCheckin() {
  const r = await request('POST', '/billing/meter/daily-checkin', { body: {} });
  return { ok: isBizOk(r), res: r, data: r?.json?.data ?? null };
}

/**
 * 积分余额聚合（客户端「余额/档位/付费状态聚合」同款接口，POST 无业务参数）。
 * 返回 Packages[]，每包含：
 *   CycleTotalCapacity / CycleRemainCapacity / CycleUsedCapacity（字符串数字）
 *   CapacityUnit（credits）/ PackageCode
 * 客户端 sumSummaryCapacity 的口径：跨包求和 → total / remain / used。
 */
async function getCreditSummary() {
  const r = await request('POST', '/billing/meter/get-user-resource-summary', { body: {} });
  const ok = isBizOk(r);
  let sum = null;
  if (ok) {
    const pkgs = Array.isArray(r?.json?.data?.Packages) ? r.json.data.Packages : [];
    const toN = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const round2 = (n) => Math.round(n * 100) / 100;
    sum = {
      total: round2(pkgs.reduce((s, p) => s + toN(p?.CycleTotalCapacity), 0)),
      remain: round2(pkgs.reduce((s, p) => s + toN(p?.CycleRemainCapacity), 0)),
      used: round2(pkgs.reduce((s, p) => s + toN(p?.CycleUsedCapacity), 0)),
      unit: pkgs[0]?.CapacityUnit || 'credits',
      packages: pkgs.length,
    };
  }
  return { ok, res: r, sum };
}

// --- 猫猫旅行（官网成长中心，base = www.workbuddy.cn）---------------------

/** 可派地点配置 GET /activity/growth/buddy/travel/config */
async function getTravelConfig() {
  const r = await request('GET', '/activity/growth/buddy/travel/config', { base: WEB_ENDPOINT });
  return { ok: isBizOk(r), res: r, data: r?.json?.data ?? null };
}

/** 行程状态 GET /activity/growth/buddy/travel/status */
async function getTravelStatus() {
  const r = await request('GET', '/activity/growth/buddy/travel/status', { base: WEB_ENDPOINT });
  return { ok: isBizOk(r), res: r, data: r?.json?.data ?? null };
}

/** 派猫出行 POST /activity/growth/buddy/travel/depart  body {location_id} */
async function departTravel(locationId) {
  const r = await request('POST', '/activity/growth/buddy/travel/depart', {
    body: { location_id: locationId },
    base: WEB_ENDPOINT,
  });
  return { ok: isBizOk(r), res: r, data: r?.json?.data ?? null };
}

/** 领取「已到家」的旅行奖励积分（接口无业务 data，按 envelope code 判成功） */
async function claimTravelReward() {
  const r = await request('POST', '/activity/growth/buddy/travel/claim', {
    body: {},
    base: WEB_ENDPOINT,
  });
  return { ok: isBizOk(r), res: r, data: r?.json?.data ?? null };
}

/**
 * 猫猫（成长 Buddy）状态。
 * 桌面侧 /v2/activity/growth/buddy/info 与官网 /activity/growth/buddy/info 都存在；
 * 先试官网侧（与 travel/* 同源，字段口径一致），失败再退回桌面侧。
 */
async function getBuddyInfo() {
  const web = await request('GET', '/activity/growth/buddy/info', { base: WEB_ENDPOINT });
  if (isBizOk(web)) return { ok: true, res: web, data: web?.json?.data ?? null };

  const desk = await request('GET', '/v2/activity/growth/buddy/info');
  if (isBizOk(desk)) return { ok: true, res: desk, data: desk?.json?.data ?? null, fallback: 'desktop' };

  // 两个都不通：返回 web 那次的结果（更贴近 travel 口径）
  return { ok: false, res: web, data: web?.json?.data ?? null };
}

/**
 * 把 travel/status（或 travel/depart、travel/claim）的返回归一化成前端同一套字段。
 * 对应抓包到的前端实现：
 *   function Ge(s,t){ s({ state:t.state??"idle", location:t.location??null,
 *     departAt:t.depart_at??0, arriveAt:t.arrive_at??0, serverNow:t.server_now??0,
 *     letter:t.letter??null, useDeeplink:t.use_deeplink??"",
 *     dailyLimitReached:t.daily_limit_reached??!1, rewardCredit:t.reward_credit??0 }) }
 */
function normalizeTravel(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    state: String(data.state ?? 'idle'),
    location: data.location ?? null,
    departAt: Number(data.depart_at ?? 0),
    arriveAt: Number(data.arrive_at ?? 0),
    serverNow: Number(data.server_now ?? 0),
    letter: data.letter ?? null,
    useDeeplink: data.use_deeplink ?? '',
    dailyLimitReached: data.daily_limit_reached === true,
    rewardCredit: Number(data.reward_credit ?? 0),
  };
}

/**
 * 依据 travel/status 的 state 判定「今天能不能派新的一趟」。
 *
 * 前端状态机（GrowthCenterPage-BZwm0xmj.js）：
 *   handleOpenEntry → await fetchStatus()
 *     state === "traveling" → 出行中（弹倒计时，不能再派）
 *     state === "arrived"   → 已到家（弹领奖信，先领奖）
 *     state === "idle"      → dailyLimitReached ? 提示"累啦，明天再来吧" : 弹地点选择 → depart
 *
 * 返回值：
 *   { state, dispatchedToday, canDispatch, reason }
 *   - dispatchedToday: true=行程未结束（traveling）或已达每日上限；false=可派；null=未知
 *   - canDispatch: 是否应当发起 depart
 */
function evaluateTravel(travel) {
  if (!travel) {
    return { state: null, dispatchedToday: null, canDispatch: false, reason: '状态字段缺失' };
  }

  const { state, dailyLimitReached } = travel;

  if (state === 'traveling') {
    return {
      state, dispatchedToday: true, canDispatch: false,
      reason: '猫猫正在旅行中（state=traveling），今天已派出，跳过派新行程',
    };
  }

  if (state === 'arrived') {
    return {
      state, dispatchedToday: false, canDispatch: true,
      reason: '猫猫已到家（state=arrived），已在上一步领取积分，本轮可以再派一趟',
    };
  }

  if (dailyLimitReached) {
    return {
      state, dispatchedToday: true, canDispatch: false,
      reason: '已达今日派猫上限（daily_limit_reached=true），跳过',
    };
  }

  if (state === 'idle') {
    return {
      state, dispatchedToday: false, canDispatch: true,
      reason: '猫猫待命中（state=idle），可以派出',
    };
  }

  return {
    state, dispatchedToday: null, canDispatch: false,
    reason: `未识别的 state=${state}，保守跳过派新行程`,
  };
}

/**
 * 从 travel/config 返回体里挑一个可用地点 id。
 * 抓包结构：{ locations: [{ id, name, cover_url, traveling_photos, preview_photos, ... }],
 *             intro_slogans, intro_slogan_items }
 */
function pickLocationId(configData) {
  if (TRAVEL_LOCATION_ID) return { id: TRAVEL_LOCATION_ID, name: '(env 指定)' };

  const list = configData?.locations;
  if (!Array.isArray(list) || list.length === 0) return null;

  const first = list.find((l) => l && (l.id ?? l.location_id) != null);
  if (!first) return null;

  const id = first.id ?? first.location_id;
  return { id, name: first.name || String(id), total: list.length };
}

/** 秒级时间戳 → 本地可读（用于「预计到家」展示） */
function fmtTs(sec) {
  const n = Number(sec);
  if (!n || n <= 0) return '';
  const d = new Date(n * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * claim 的「无事可做」语义（抓包自前端 catch 分支）：
 *   msg 含 "not arrived yet" / "no unclaimed travel" → 前端只是重新 fetchStatus，不当失败处理
 */
function looksLikeNothingToClaim(r) {
  const msg = String(bizMsg(r) || '').toLowerCase();
  return /not\s*arrived|no\s*unclaimed|already|claimed|no\s*(pending|record|reward)|none|empty|not\s*found/.test(msg);
}

/** depart 失败时后端返回的语义（抓包自前端 catch 分支） */
function explainDepartError(r) {
  const msg = String(bizMsg(r) || '').toLowerCase();
  if (r?.status === 429 || msg.includes('daily limit')) return '猫猫今天累啦（已达每日上限）';
  if (msg.includes('no active buddy')) return '还没有 buddy，需先在客户端领取';
  if (msg.includes('already traveling')) return '猫猫已经在旅行中';
  if (msg.includes('location not available')) return '该地点暂时不可用';
  return `派猫失败：${bizMsg(r)}`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function main() {
  const startedAt = new Date();
  log(`[start] endpoint=${ENDPOINT} dryRun=${DRY_RUN} debugRaw=${DEBUG_RAW}`);

  if (!ACCESS_TOKEN && !DRY_RUN) {
    throw new Error('缺少 WORKBUDDY_ACCESS_TOKEN（请在仓库 Secret 中配置）');
  }

  const result = {
    ok: false,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    checkin: { attempted: false, ok: false, alreadyCheckedIn: false, note: '', credits: null, raw: null },
    credit: {
      // 积分余额快照（POST /billing/meter/get-user-resource-summary，客户端同款接口）
      attempted: false, ok: false,
      total: null, remain: null, used: null, unit: 'credits',
      raw: null,
    },
    cat: {
      travel: null,
      claim: { attempted: false, ok: false, note: '', raw: null },
      dispatch: {
        attempted: false, ok: false, note: '',
        state: null, dispatchedToday: null,
        locationId: null, arriveAt: null,
        statusRaw: null, configRaw: null, departRaw: null,
      },
    },
  };

  // ---- 0) 前置状态查询 -------------------------------------------------
  // 注意字段名：接口返回的是 today_checked_in（布尔），不是 claimed_today。
  // 预检命中「今日已签到」→ 直接标记 alreadyCheckedIn，步骤3 不再重复 POST。
  // （此前中文报错「今天已签到，请明天再来」匹配不到英文正则，
  //   且重复 POST 后台账把 ✅ 好行覆盖成 ❌，就是这里埋的雷。）
  try {
    const st = await getCheckinStatus();
    dumpRaw('checkin-status(before)', st.res);
    if (st.data) {
      const already = st.data.today_checked_in === true;
      result.checkin.alreadyCheckedIn = already;
      if (already) {
        result.checkin.ok = true;
        result.checkin.note = '今日已签到';
      } else {
        result.checkin.note = '今日未签到';
      }
    }
  } catch (e) {
    logErr(`[warn] checkin-status 查询失败（不阻断）: ${e.message}`);
  }

  // ---- 1) 先领掉已经到家的旅行积分 ------------------------------------
  try {
    result.cat.claim.attempted = true;
    if (DRY_RUN) {
      result.cat.claim.note = 'dry-run：跳过实际领取';
    } else {
      const c = await claimTravelReward();
      dumpRaw('travel/claim', c.res);
      result.cat.claim.raw = c.res?.json ?? null;
      if (c.ok) {
        const got = c.data?.reward_credit ?? c.data?.credit ?? c.data?.credits ?? null;
        result.cat.claim.ok = true;
        result.cat.claim.note = got != null ? `已领取到家积分 ${got}` : '已领取到家积分';
      } else if (looksLikeNothingToClaim(c.res)) {
        result.cat.claim.ok = true;
        result.cat.claim.note = '无待领取的到家积分';
      } else {
        result.cat.claim.note = `领取失败：${bizMsg(c.res)}`;
      }
    }
  } catch (e) {
    result.cat.claim.note = `领取异常：${e.message}`;
    logErr(`[warn] 到家积分领取异常（不影响签到）: ${e.message}`);
  }

  // ---- 2) 查状态 → 判断能否派新的一趟 → 派出 --------------------------
  try {
    const st = await getTravelStatus();
    dumpRaw('travel/status', st.res);
    result.cat.dispatch.statusRaw = st.res?.json ?? null;

    if (!st.ok) {
      result.cat.dispatch.note = `行程状态查询失败：${bizMsg(st.res)}`;
    } else {
      const travel = normalizeTravel(st.data);
      result.cat.travel = travel;

      const verdict = evaluateTravel(travel);
      result.cat.dispatch.dispatchedToday = verdict.dispatchedToday;
      result.cat.dispatch.state = verdict.state;

      if (!verdict.canDispatch) {
        result.cat.dispatch.note = verdict.reason;
      } else {
        // 需要派新的一趟：先拿地点
        result.cat.dispatch.attempted = true;

        if (DRY_RUN) {
          result.cat.dispatch.note = `dry-run：本可派出（state=${verdict.state}），跳过实际 depart`;
        } else {
          const cfg = await getTravelConfig();
          dumpRaw('travel/config', cfg.res);
          result.cat.dispatch.configRaw = cfg.res?.json ?? null;

          const loc = pickLocationId(cfg.data);
          if (!cfg.ok || !loc) {
            result.cat.dispatch.note = cfg.ok
              ? '没有可用的旅行地点（locations 为空）'
              : `地点列表查询失败：${bizMsg(cfg.res)}`;
          } else {
            const dep = await departTravel(loc.id);
            dumpRaw('travel/depart', dep.res);
            result.cat.dispatch.departRaw = dep.res?.json ?? null;

            if (dep.ok) {
              const after = normalizeTravel(dep.data);
              result.cat.dispatch.ok = true;
              result.cat.dispatch.note =
                `已派出猫猫前往「${loc.name}」` +
                (after?.arriveAt ? `（预计 ${fmtTs(after.arriveAt)} 到家）` : '');
              result.cat.dispatch.locationId = loc.id;
              result.cat.dispatch.arriveAt = after?.arriveAt ?? null;
            } else {
              result.cat.dispatch.note = explainDepartError(dep.res);
            }
          }
        }
      }
    }
  } catch (e) {
    result.cat.dispatch.note = `派猫流程异常：${e.message}`;
    logErr(`[warn] 派猫流程异常（不影响签到）: ${e.message}`);
  }

  // ---- 3) 执行签到（猫猫部分失败也不影响这里） ------------------------
  try {
    if (result.checkin.alreadyCheckedIn) {
      // 步骤0 预检已确认今天签过：跳过重复 POST，保持 ✅ 语义
      // （不重复记积分，也不给台账制造「签到失败」假象）
      result.checkin.attempted = false;
    } else {
      result.checkin.attempted = true;
      if (DRY_RUN) {
        result.checkin.ok = true;
        result.checkin.note = 'dry-run：跳过实际签到';
      } else {
        const c = await claimDailyCheckin();
        dumpRaw('daily-checkin', c.res);
        result.checkin.raw = c.res?.json ?? null;
        if (c.ok) {
          const credits = c.data?.credits ?? c.data?.credit ?? c.data?.reward_credit ?? null;
          result.checkin.ok = true;
          result.checkin.credits = credits;
          result.checkin.note = credits != null ? `签到成功，获得 ${credits} 积分` : '签到成功';
        } else {
          const msg = bizMsg(c.res);
          // 已经是领取态也算业务上「无需再签」，但结论应与真正失败区分开。
          // 正则必须认中文：后端实际返回「今天已签到，请明天再来」（今天/明日 两种措辞都见过）
          if (/already|claimed|已签到|明日再来|明天再来|重复/i.test(msg)) {
            result.checkin.ok = true;
            result.checkin.alreadyCheckedIn = true;
            result.checkin.note = `今日已签到（${msg}）`;
          } else {
            result.checkin.note = `签到失败：${msg}`;
          }
        }
      }
    }
  } catch (e) {
    result.checkin.note = `签到异常：${e.message}`;
    logErr(`[error] 签到异常: ${e.message}`);
  }

  // ---- 4) 查询积分余额（台账小结用；只读，失败不影响主结论） ----------
  try {
    result.credit.attempted = true;
    const cs = await getCreditSummary();
    dumpRaw('credit-summary', cs.res);
    result.credit.raw = cs.res?.json ?? null;
    if (cs.ok && cs.sum) {
      result.credit.ok = true;
      result.credit.total = cs.sum.total;
      result.credit.remain = cs.sum.remain;
      result.credit.used = cs.sum.used;
      result.credit.unit = cs.sum.unit || 'credits';
    } else {
      result.credit.note = `余额查询失败：${bizMsg(cs.res)}`;
    }
  } catch (e) {
    result.credit.note = `余额查询异常：${e.message}`;
    logErr(`[warn] 积分余额查询异常（不影响签到）: ${e.message}`);
  }

  // ---- 收尾：签到成功即整体成功 ---------------------------------------
  result.ok = result.checkin.ok;
  result.finishedAt = new Date().toISOString();

  log('\n===== 汇总 =====');
  log(`签到 : ${result.checkin.ok ? '✅' : '❌'} ${result.checkin.note}`);
  log(`领奖 : ${result.cat.claim.ok ? '✅' : '⚠️'} ${result.cat.claim.note}`);
  log(`派猫 : ${result.cat.dispatch.note}`);
  if (result.credit.ok) {
    log(`积分 : 余额 ${result.credit.remain} / 总量 ${result.credit.total}（已用 ${result.credit.used} ${result.credit.unit}）`);
  }

  return result;
}

// 直接执行时（非 import）
const isEntryPoint = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const r = await main();
  // 落一份机器可读结果给后续步骤（飞书推送）用
  const fs = await import('node:fs');
  const out = process.env.WORKBUDDY_RESULT_FILE || 'result.json';
  fs.writeFileSync(out, JSON.stringify(r, null, 2), 'utf8');
  log(`\n[result written] ${out}`);
  process.exit(r.ok ? 0 : 1);
}
