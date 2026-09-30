#!/usr/bin/env node
/**
 * setup-github.mjs —— GitHub 一键部署（零 git 依赖，纯 REST API）
 *
 * 给谁用：没装 git / 没用过 GitHub 的用户。配合「配置GitHub.bat」使用。
 *
 * 做的事（按顺序）：
 *   1. 用 PAT 验证身份（GET /user）
 *   2. 建公开仓库（已存在则复用）
 *   3. 把本项目文件逐个上传（Contents API，自动跳过 node_modules / 凭证 / 运行产物）
 *   4. 把本机导出的 WorkBuddy token 写入仓库 Secret WORKBUDDY_ACCESS_TOKEN
 *      （libsodium sealed box 加密，tweetnacl + blakejs 实现；依赖缺失时降级为手动指引）
 *   5. 触发 workflow 首跑，轮询到出结果
 *   6. 首跑成功后把 仓库名 写回 local-sync/sync-config.json
 *
 * 用法（一般不用手敲，双击 local-sync/配置GitHub.bat）：
 *   GITHUB_PAT=ghp_xxx node scripts/setup-github.mjs [--repo-name workbuddy-daily]
 *
 * PAT 要求（classic）：勾选 repo + workflow 两个 scope。
 *
 * 退出码：
 *   0 = 全部成功
 *   2 = 中途失败（看屏幕提示，可重跑，已完成的步骤会自动跳过）
 *   1 = 参数/环境错误
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const API = 'https://api.github.com';
const argv = process.argv.slice(2);
const INTERACTIVE = argv.includes('--interactive');
const repoNameIdx = argv.indexOf('--repo-name');
const REPO_NAME_ARG = (repoNameIdx >= 0 ? argv[repoNameIdx + 1] : '') || '';
let REPO_NAME = REPO_NAME_ARG || 'workbuddy-daily';
let PAT = (process.env.GITHUB_PAT || '').trim();

let dispatchTime = new Date(Date.now() - 8000).toISOString(); // 轮询起点（放宽 8s）

const out = (...a) => console.log(...a);
const outErr = (...a) => console.error(...a);

// ---------------------------------------------------------------------------
// 错误兜底：必须注册在最前面。
// 原因：本文件从第 260 行起是一串顶层 await。中途 fail() 抛错时，Node 会立刻
// 检查"有没有 unhandledRejection 监听器"——如果监听器是文件末尾才挂上去的，
// 那一刻还不存在，Node 就直接把原始堆栈打出来并崩掉，用户满屏英文看不懂。
// 所以监听器必须早于任何 await 出现。handler 逻辑见文件末尾的 friendly() 调用点。
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (e) => {
  if (e && e.__setupFail) { process.exitCode = 2; return; } // fail() 已打印过原因
  outErr(`\n[setup] ❌ 意外错误：${(e && e.message) || e}`);
  const m = String((e && e.message) || e || '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) {
    outErr('   看起来是 DNS 解析失败：检查网络、代理或公司防火墙是否拦了 api.github.com。');
  } else if (/ETIMEDOUT|ECONNRESET|UND_ERR|fetch failed/i.test(m)) {
    outErr('   看起来是连接超时/被重置：换个网络重试，或稍后再试。');
  } else if (/401|Bad credentials/i.test(m)) {
    outErr('   Token 被 GitHub 拒绝：确认复制完整（ghp_ 开头），且勾了 repo + workflow。');
  } else {
    outErr('   把上面这段截图发我，我来判断。');
  }
  process.exitCode = 2;
});
process.on('uncaughtException', (e) => {
  if (e && e.__setupFail) { process.exitCode = 2; return; }
  outErr(`\n[setup] ❌ 意外错误：${(e && e.message) || e}`);
  process.exitCode = 2;
});

if (!PAT && !INTERACTIVE && !argv.includes('--list')) {
  outErr('[setup] 缺少 GITHUB_PAT 环境变量。请双击 local-sync/配置GitHub.bat 运行。');
  process.exit(1);
}
if (PAT && !/^[A-Za-z0-9_]{2,}_[A-Za-z0-9]{20,}$/.test(PAT) && !PAT.startsWith('gh')) {
  outErr('[setup] Token 形态不像 GitHub PAT（应以 ghp_ / github_pat_ 开头），先继续试一把……');
}

// ---------------------------------------------------------------------------
// 交互模式：说明、提问、记 Token 全部在 Node 里做。
// 为什么不放 bat：cmd 在 chcp 65001 + set /p（交互输入）+ UTF-8 文件时，
// 文件读指针会错位，后续行被从中间截断执行（'INPUT'/'ho' is not recognized）。
// Node 的 readline 没有这些问题，中文显示也正常。
// ---------------------------------------------------------------------------

if (INTERACTIVE && !PAT) {
  const os = await import('node:os');
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // ---------------------------------------------------------------------------
  // 为什么要有 ask() 这层包装：
  //
  // 直接 rl.question() 在"交互终端"下没问题，但一旦 stdin 不是交互终端
  // （管道、重定向、terminal 异常、被别的东西占了），question() 会永远悬空，
  // Node 会打 "Detected unsettled top-level await" 再以奇怪状态退出。
  //
  // 实测：Windows 下 process.stdin 的 'end'/'close' 事件在这种场景并不触发，
  // 靠事件判断行不通。所以改成"先听 line/close，用一个已完成标记 + 短超时"，
  // 保证 ask() 一定会在有限时间内返回（拿不到就返回默认值）。
  // ---------------------------------------------------------------------------
  const pending = [];   // 已经读到的行
  let eof = false;      // 是否已到输入末尾
  rl.on('line', (l) => pending.push(l));
  const onEnd = () => { eof = true; };
  rl.on('close', onEnd);
  process.stdin.on('end', onEnd);
  process.stdin.on('close', onEnd);
  process.stdin.on('error', onEnd);

  // 等待一行输入：优先取队列；队列空且已 eof 就返回 null；否则最多等 ms 毫秒。
  const readLine = (ms) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (pending.length) return resolve(pending.shift());
      if (eof) return resolve(null);
      if (Date.now() - t0 >= ms) return resolve(undefined); // 超时（无人输入）
      setTimeout(tick, 20);
    };
    tick();
  });

  const ask = async (q, dflt = '') => {
    process.stdout.write(q);
    // 先给队列 + EOF 一点时间稳定（管道场景下数据几乎立刻到齐）
    const ans = await readLine(120000);
    if (ans === null || ans === undefined) {
      // 没有输入（管道读完 / 超时）：走默认值
      if (dflt) process.stdout.write('\n');
      return dflt;
    }
    return String(ans).trim();
  };

  const patFile = path.join(os.homedir(), '.buddy-github-pat'); // 主目录，项目外，绝不入库

  out('============================================================');
  out('  Buddy 加油站 - GitHub 一键配置');
  out('============================================================');
  out('');
  out('本程序将自动完成：建公开仓库 → 上传代码 → 写入 Secret → 触发首跑。');
  out('');
  out('你只需要先有一个 GitHub Token（没有就先用浏览器做两步，约 3 分钟）：');
  out('  第 1 步  注册 GitHub：https://github.com/signup');
  out('  第 2 步  生成 Token（repo / workflow 已自动勾选）：');
  out('    https://github.com/settings/tokens/new?scopes=repo,workflow&description=buddy-daily');
  out('    拉到页面最底部点 Generate token，复制 ghp_ 开头的字符串。');
  out('');

  let saved = '';
  if (fs.existsSync(patFile)) saved = fs.readFileSync(patFile, 'utf8').trim();
  if (saved) out(`检测到已保存的 Token（${saved.slice(0, 7)}…）：直接回车沿用，或粘贴新的覆盖。`);

  const typed = await ask(saved ? 'Token（回车=沿用已保存）: ' : '把 Token 粘贴到这里后回车: ');
  const val = typed || saved;
  if (!val) {
    out('');
    out('[提示] Token 不能为空。');
    out('  还没有 Token 就按上面两步先去网页操作，');
    out('  拿到 ghp_ 开头的字符串后重新双击配置 bat。');
    try { rl.close(); } catch { /* 已关就忽略 */ }
    // 这里必须"停住"，否则会带着空 Token 继续往下走。
    // 用 exitCode 而非 process.exit()：保证上面中文提示先 flush。
    process.exitCode = 1;
  } else {
    PAT = val;
    fs.writeFileSync(patFile, val + '\n');

    const rn = await ask('仓库名（直接回车 = workbuddy-daily）: ');
    if (rn) REPO_NAME = rn;
    try { rl.close(); } catch { /* 已关就忽略 */ }
    out('');
  }
}

// 交互模式下用户没给 Token 就到此为止（exitCode 已置 1，见上面分支）。
// 用一层总开关拦住后续所有网络步骤，避免拿着空 PAT 去请求 API。
if (!PAT && !argv.includes('--list')) {
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// GitHub API 基础请求
// ---------------------------------------------------------------------------

async function gh(method, urlPath, body) {
  let res;
  try {
    res = await fetch(`${API}${urlPath}`, {
      method,
      headers: {
        'User-Agent': 'buddy-daily-setup',
        Authorization: `Bearer ${PAT}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`连不上 api.github.com（${e?.cause?.code || e?.code || e?.message}）。国内网络可能需要代理后重试。`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 保留 null */ }
  return { status: res.status, ok: res.ok, json, text };
}

function fail(msg) {
  outErr(`\n[setup] ❌ ${msg}`);
  // 不用 process.exit(2)：Windows 上 stdout/stderr 是管道/控制台时可能还未 flush，
  // 直接退出会吞掉上面几行中文提示。改用抛错 + 顶层 catch 统一置码（见文件末尾）。
  const e = new Error(msg);
  e.__setupFail = true;
  throw e;
}

// ---------------------------------------------------------------------------
// 文件收集（放在最前，--list 模式可以不上网就预览）
// ---------------------------------------------------------------------------

const EXCLUDE_RE = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)result\.json$/,
  /\.token$/,
  /(^|\/)token\.local\.json$/,
  /(^|\/)\.token-extract\.log$/,
  /buddy-ledger-demo.*\.xlsx$/i,
  /(^|\/)~\$/,
  /\.zip$/i,
  /(^|\/)\.workbuddy(\/|$)/,
];

function collectFiles() {
  const files = [];
  const pushFile = (abs, rel) => {
    if (EXCLUDE_RE.some((re) => re.test(rel.replaceAll('\\', '/')))) return;
    if (fs.statSync(abs).isFile()) files.push({ abs, rel: rel.replaceAll('\\', '/') });
  };
  const walk = (dir, base) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.join(base, name);
      if (EXCLUDE_RE.some((re) => re.test(rel.replaceAll('\\', '/')))) continue;
      if (fs.statSync(abs).isDirectory()) walk(abs, rel);
      else pushFile(abs, rel);
    }
  };

  const whitelistDirs = ['.github', 'scripts', 'docs', 'local-sync'];
  for (const d of whitelistDirs) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs, d);
  }
  for (const f of ['README.md', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes']) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) pushFile(abs, f);
  }
  // history 目录要有东西，台账提交才有落点
  const historyDir = path.join(ROOT, 'history');
  if (fs.existsSync(historyDir)) {
    walk(historyDir, 'history');
  } else {
    files.push({ abs: null, rel: 'history/.gitkeep', virtual: '' });
  }
  return files;
}

// --list：不上网预览将要上传的文件（验证排除规则用，也不需要 PAT）
if (argv.includes('--list')) {
  const preview = collectFiles();
  for (const f of preview) out(f.rel);
  out(`--- 共 ${preview.length} 个文件`);
  process.exit(0);
}

// 交互模式下用户没给 Token：到此为止，不再往下走网络请求。
// （用 exitCode 而非 process.exit，保证上面的中文提示先 flush 出去。）
if (!PAT) {
  outErr('[setup] 没有拿到 Token，已停止。');
  process.exitCode = 1;
} else {

// ---------------------------------------------------------------------------
// 1) 身份
// ---------------------------------------------------------------------------

out('① 验证 Token ……');
const me = await gh('GET', '/user');
if (!me.ok) {
  fail(`Token 验证失败（HTTP ${me.status}）。${me.status === 401 ? 'Token 无效或过期；也可能是没勾选 repo / workflow 权限。' : ''}`);
}
const OWNER = me.json.login;
out(`   ✅ 你好，${OWNER}`);

// ---------------------------------------------------------------------------
// 2) 建仓库（公开）
// ---------------------------------------------------------------------------

out(`② 检查/创建仓库 ${OWNER}/${REPO_NAME} ……`);
const repoGet = await gh('GET', `/repos/${OWNER}/${REPO_NAME}`);
if (repoGet.status === 200) {
  const priv = repoGet.json.private;
  out(`   ✅ 仓库已存在（${priv ? '私有' : '公开'}），复用。`);
  if (priv) {
    out('   ⚠️ 仓库是私有的 —— 本地同步脚本走公开 raw 地址将拉不到台账。');
    out('     可在网页 Settings → General → 底部 Danger Zone 改为 Public，');
    out('     或直接跑：gh api -X PATCH /repos/... -f private=false（如果以后装了 gh）');
  }
} else if (repoGet.status === 404) {
  const created = await gh('POST', '/user/repos', {
    name: REPO_NAME,
    private: false,
    description: 'WorkBuddy Buddy 加油站每日签到 + 猫猫旅行云端自动化台账',
    has_issues: false,
    has_wiki: false,
    has_projects: false,
    auto_init: false,
  });
  if (!created.ok) fail(`建仓库失败（HTTP ${created.status}）：${created.json?.message || created.text?.slice(0, 200)}`);
  out('   ✅ 仓库已创建（公开）。');
} else {
  fail(`查仓库失败（HTTP ${repoGet.status}）：${repoGet.json?.message || ''}`);
}

// ---------------------------------------------------------------------------
// 3) 上传文件
// ---------------------------------------------------------------------------

out('③ 上传项目文件 ……');
const files = collectFiles();
out(`   共 ${files.length} 个文件`);

let uploaded = 0;
for (const f of files) {
  const contentB64 = f.virtual !== undefined
    ? Buffer.from(f.virtual, 'utf8').toString('base64')
    : fs.readFileSync(f.abs).toString('base64');

  // 已存在的文件要带 sha 才能覆盖
  let sha;
  const ex = await gh('GET', `/repos/${OWNER}/${REPO_NAME}/contents/${encodeURIComponent(f.rel).replaceAll('%2F', '/')}`);
  if (ex.status === 200) sha = ex.json.sha;

  const put = await gh('PUT', `/repos/${OWNER}/${REPO_NAME}/contents/${encodeURIComponent(f.rel).replaceAll('%2F', '/')}`, {
    message: `chore: upload ${f.rel} [skip ci]`,
    content: contentB64,
    ...(sha ? { sha } : {}),
  });
  if (!put.ok) {
    fail(`上传 ${f.rel} 失败（HTTP ${put.status}）：${put.json?.message || ''}` +
      (put.status === 422 && /workflow/.test(put.json?.message || '') ? ' ← Token 缺 workflow 权限，重新生成时记得勾选 workflow' : ''));
  }
  uploaded++;
  out(`   ✅ ${f.rel}${sha ? '（覆盖）' : ''}`);
}
out(`   上传完成：${uploaded}/${files.length}`);

// ---------------------------------------------------------------------------
// 4) 写 Secret（WorkBuddy token）
// ---------------------------------------------------------------------------

out('④ 配置 Secret WORKBUDDY_ACCESS_TOKEN ……');
const tokenFile = path.join(ROOT, 'token.local.json');
if (!fs.existsSync(tokenFile)) {
  out('   ⚠️ 找不到 token.local.json（本机导出的登录态）。');
  out('     这一步先跳过 —— 稍后需要你手动加 Secret，否则云端任务跑不了：');
  out('     仓库网页 → Settings → Secrets and variables → Actions → New repository secret');
  out('     Name: WORKBUDDY_ACCESS_TOKEN   Value: <你的 token>');
} else {
  const tokenVal = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).accessToken;
  const pk = await gh('GET', `/repos/${OWNER}/${REPO_NAME}/actions/secrets/public-key`);
  if (!pk.ok) fail(`取仓库公钥失败（HTTP ${pk.status}）：${pk.json?.message || ''}`);

  let sealed;
  try {
    const { default: nacl } = await import('tweetnacl');
    // blakejs 是 CJS 包：优先取 default，再兜底命名空间本身
    const _b = await import('blakejs');
    const bl = _b.default || _b;
    const blake2bInit = bl.blake2bInit;
    const blake2bUpdate = bl.blake2bUpdate;
    const blake2bFinal = bl.blake2bFinal;

    const rpk = new Uint8Array(Buffer.from(pk.json.key, 'base64'));
    const ekp = nacl.box.keyPair(); // 一次性密钥对

    // sealed box 的 nonce = BLAKE2b-24(ephemeral_pk || recipient_pk)
    const cat = new Uint8Array(64);
    cat.set(ekp.publicKey, 0);
    cat.set(rpk, 32);
    const ctx = blake2bInit(24, null);
    blake2bUpdate(ctx, cat);
    const nonce = blake2bFinal(ctx);

    const boxed = nacl.box(new Uint8Array(Buffer.from(tokenVal, 'utf8')), nonce, rpk, ekp.secretKey);
    sealed = Buffer.concat([Buffer.from(ekp.publicKey), Buffer.from(boxed)]);
  } catch (e) {
    out(`   ⚠️ 加密库不可用（${e.message}），跳过自动写 Secret。`);
    out('     请手动：仓库网页 → Settings → Secrets and variables → Actions → New repository secret');
    out('     Name: WORKBUDDY_ACCESS_TOKEN   Value: token.local.json 里的 accessToken');
    sealed = null;
  }

  if (sealed) {
    const putSecret = await gh('PUT', `/repos/${OWNER}/${REPO_NAME}/actions/secrets/WORKBUDDY_ACCESS_TOKEN`, {
      encrypted_value: sealed.toString('base64'),
      key_id: pk.json.key_id,
    });
    if (!putSecret.ok) fail(`写 Secret 失败（HTTP ${putSecret.status}）：${putSecret.json?.message || ''}`);
    out('   ✅ Secret 已写入（加密传输，Token 不会出现在仓库里）。');
  }
}

// ---------------------------------------------------------------------------
// 5) 触发首跑并轮询
// ---------------------------------------------------------------------------

out('⑤ 触发 workflow 首跑 ……');
dispatchTime = new Date(Date.now() - 3000).toISOString();
const disp = await gh('POST', `/repos/${OWNER}/${REPO_NAME}/actions/workflows/daily.yml/dispatches`, { ref: 'main' });
if (disp.status === 204) {
  out('   ✅ 已触发。');
} else {
  fail(`触发失败（HTTP ${disp.status}）：${disp.json?.message || disp.text?.slice(0, 200)}` +
    (disp.status === 404 ? ' ← 检查 .github/workflows/daily.yml 是否上传成功' : ''));
}

out('   等待运行结果（最长 6 分钟，每 10 秒查一次）……');
let runConclusion = null;
let runUrl = '';
const deadline = Date.now() + 6 * 60 * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10000));
  const runs = await gh('GET', `/repos/${OWNER}/${REPO_NAME}/actions/runs?per_page=5`);
  if (!runs.ok) continue;
  const list = runs.json.workflow_runs || [];
  const mine = list.find((r) => r.event === 'workflow_dispatch' && r.created_at >= dispatchTime);
  if (!mine) { process.stdout.write('.'); continue; }
  runUrl = mine.html_url;
  if (mine.status === 'completed') {
    runConclusion = mine.conclusion;
    break;
  }
  process.stdout.write('.');
}

if (!runConclusion) {
  out(`\n   ⏳ 6 分钟内没等到结果（任务可能还在跑）。`);
  out(`   手动看这里：${runUrl || `https://github.com/${OWNER}/${REPO_NAME}/actions`}`);
  out('   只要最后一次运行成功，直接双击 local-sync/同步台账.bat 就能拉台账。');
  process.exit(0);
}

if (runConclusion !== 'success') {
  outErr(`\n   ❌ 首跑结论：${runConclusion}`);
  outErr(`   看日志：${runUrl}`);
  outErr('   常见原因：WORKBUDDY_ACCESS_TOKEN 缺失/过期、网络抖动。修好后重跑本脚本即可（会自动跳过已完成步骤）。');
  process.exitCode = 2; // 见 fail() 注释：不硬退，保证提示先 flush
}
out(`   ✅ 首跑成功！`);

// 验证台账已生成
const ledger = await gh('GET', `/repos/${OWNER}/${REPO_NAME}/contents/history/buddy-ledger.xlsx`);
out(ledger.status === 200
  ? `   ✅ 台账已生成：history/buddy-ledger.xlsx（${Math.round((ledger.json.size || 0) / 1024)} KB）`
  : `   ⚠️ 台账文件还没出现（HTTP ${ledger.status}），可能任务没走到写台账那步，看日志：${runUrl}`);

// ---------------------------------------------------------------------------
// 6) 写回本地同步配置
// ---------------------------------------------------------------------------

out('⑥ 更新 local-sync/sync-config.json ……');
const cfgPath = path.join(ROOT, 'local-sync', 'sync-config.json');
try {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.repo = `${OWNER}/${REPO_NAME}`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  out(`   ✅ repo = ${cfg.repo}`);
} catch (e) {
  out(`   ⚠️ 写配置失败（${e.message}）。请手动把 local-sync/sync-config.json 的 repo 改成：${OWNER}/${REPO_NAME}`);
}

// ---------------------------------------------------------------------------
// 完成
// ---------------------------------------------------------------------------

out('');
out('==============================================');
out('  🎉 全部完成！');
out('==============================================');
out(`  仓库：https://github.com/${OWNER}/${REPO_NAME}`);
out(`  Actions：https://github.com/${OWNER}/${REPO_NAME}/actions`);
out(`  每天北京时间 09:00 自动执行（电脑关机也照跑）`);
out(`  看台账：双击 local-sync/同步台账.bat`);
out('==============================================');

} // end if (PAT)
