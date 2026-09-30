# Buddy 加油站 · 每日签到 + 派猫猫旅行

用 GitHub Actions 免费定时任务，云端每天自动跑一次 WorkBuddy「Buddy 加油站」的**签到**和**派猫猫旅行**，结果推到**飞书**。

不需要常开设备 —— 跑在 GitHub 的 runner 上。

---

## 它每天做什么

1. **先领掉已经到家的旅行积分**（猫猫上一趟回来了的奖励）
2. **再判断能不能派新的一趟** —— 今天已经派过就跳过，不重复派
3. **执行签到**
4. 把结果推到飞书，**签到和猫猫的状态分开写清楚**
5. **把当天结果追加到 Excel 台账，并提交回仓库**（随时可翻历史）

容错约定：**猫猫那部分失败不影响签到结论；签到成功就算成功。**

---

## 关键特性：跟你的电脑开不开机无关

任务跑在 **GitHub 的服务器**上，你的电脑关机、出门、断网都不影响。
Excel 台账是**提交到 GitHub 仓库**里的，不是存你本地 —— 所以你下次开机打开仓库就能看到全部历史。

定时（北京时间 **09:00**）：

```yaml
schedule:
  - cron: '0 1 * * *'   # 01:00 UTC = 北京时间 09:00
```

> GitHub 的 cron 走 **UTC**（北京时间 − 8 小时）。
> 免费套餐下定时任务**有 5～30 分钟延迟**，属正常，别指望精确到 9:00:00。
> 想改时间：改上面的 `cron` 即可（例如 22:00 → `0 14 * * *`）。

---

## Excel 台账

路径：`history/buddy-ledger.xlsx`，每天自动追加一行。

### 「每日记录」工作表

| 列 | 说明 |
|---|---|
| 日期 / 时间 | 北京时间 |
| 签到 | ✅ / ❌ |
| 签到说明 / 签到积分 | 文字说明 + 获得的积分数 |
| 领到家积分 | ✅ / ❌ |
| 领奖说明 / 到家积分 | 文字说明 + 领取的积分数 |
| **当日总积分** | **签到积分 + 到家积分**（加粗，某天拿不到某项时按 0 计） |
| 派猫 | ✅ 已派 / 跳过 / ❌ 失败 |
| 行程状态 | 待命 / 旅行中 / 已到家 |
| 地点 / 预计到家 | 派出目的地与预计到家时间 |
| 派猫说明 | 完整文字（含失败原因） |
| 整体 | ✅ / ❌（以签到为准） |
| 模式 | 正常 / dry-run |

行底色：**签到失败 → 浅红**（一眼能看见）、dry-run → 浅黄、隔行浅蓝底。

### 「汇总」工作表

累计统计，全部用 **Excel 公式**（不是算好的死数字）—— 你在表里手改历史行，汇总会自动跟着变：

**积分**：累计总积分（红色加粗突出）、日均积分、签到累计积分、到家积分累计、单日最高积分
**签到**：成功 / 失败天数
**领奖**：成功天数
**派猫**：成功 / 跳过 / 失败天数
**整体**：成功天数、成功率

### 同日重复跑会怎样

**覆盖当天那一行，不会产生重复记录。** 所以手动重跑、或 workflow 重试，都不会污染台账。

---

## 接口（以实际请求为准）

这些路径是从 **实际客户端代码里抓出来的**，不是网上流传的旧接口名。

签到和派猫走的是**两套不同的后端**，base URL 也不同：

### A. 签到 —— 桌面客户端主进程

| 用途 | 方法 | 路径 |
|---|---|---|
| 查询签到状态 | POST | `/billing/meter/checkin-status` |
| 执行每日签到 | POST | `/billing/meter/daily-checkin` |

**Base URL**：`https://copilot.tencent.com`（可用仓库 Variable `WORKBUDDY_ENDPOINT` 覆盖）

### B. 猫猫旅行 —— 官网成长中心 SPA

客户端点「派猫猫旅行」时，实际是打开内置浏览器访问
`https://www.workbuddy.cn/profile/growth-center`，请求由该页面发出：

| 用途 | 方法 | 路径 |
|---|---|---|
| 可派地点配置 | GET | `/activity/growth/buddy/travel/config` |
| 行程状态 | GET | `/activity/growth/buddy/travel/status` |
| **派猫出行** | **POST** | **`/activity/growth/buddy/travel/depart`** |
| 领取「已到家」奖励 | POST | `/activity/growth/buddy/travel/claim` |
| 历史行程 | GET | `/activity/growth/buddy/travel/records` |

**Base URL**：`https://www.workbuddy.cn`（可用 Variable `WORKBUDDY_WEB_ENDPOINT` 覆盖）

**`depart` 的请求体**：`{ "location_id": <地点 id> }`

**认证**：`Authorization: Bearer <accessToken>`，
并带 `X-Product-Code: workbuddy`、`X-Client-Platform: web`。

> 抓包出处（前端 bundle）：
> `growthSpace-EIUE4QaA.js` 里
> ```js
> Q=()=>e.get("/activity/growth/buddy/travel/config"),
> W=()=>e.get("/activity/growth/buddy/travel/status"),
> Y=t=>e.post("/activity/growth/buddy/travel/depart",{location_id:t}),
> j=()=>e.post("/activity/growth/buddy/travel/claim",{})
> ```
> 别名映射见 `GrowthCenterPage-BZwm0xmj.js`：
> `import{O as ms,P as us,Q as hs,R as gs}from"./growthSpace-EIUE4QaA.js"`
> → `gs`=config、`hs`=status、`us`=depart、`ms`=claim

### 行程状态机（决定「今天要不要派」）

`travel/status` 返回的 `state` 是判断依据：

| state | 含义 | 本次动作 |
|---|---|---|
| `traveling` | 猫猫正在路上 | 今天已派出，**跳过** |
| `arrived` | 到家了，有奖励待领 | 先领奖，**可以再派一趟** |
| `idle` | 待命 | `daily_limit_reached` 为 true 则跳过，否则**派出** |

`daily_limit_reached` 为 `true` 时无论 state 如何都跳过（对应前端文案「累啦，明天再来吧」）。

---

## 部署步骤

### ★ 零基础推荐：一键部署（不需要 git / gh / 命令行）

只需在网页上做两件事（各一次），剩下的全部自动：

1. **注册 GitHub**：https://github.com/signup
2. **生成 Token**：打开 https://github.com/settings/tokens/new?scopes=repo,workflow&description=buddy-daily
   勾选 `repo` 和 `workflow`，页面拉到底点 **Generate token**，复制 `ghp_` 开头的字符串
3. **双击 `local-sync/配置GitHub.bat`**，粘贴 Token，回车

脚本会自动完成：建公开仓库 → 上传全部代码 → 加密写入 Secret（WorkBuddy token 自动从本机登录态提取）→ 触发首跑并等待结果 → 把仓库名写回 `sync-config.json`。完成后双击「同步台账」bat 即可看台账。

> 可重跑：中途失败（如网络抖动）直接再双击一次，已完成的步骤会自动跳过。
> 仓库需**公开**（本地同步走公开 raw 地址）；不想公开就告诉我，改成带 token 的拉取方式。
> Token 只存进 GitHub 加密 Secret，不进代码、不进台账。

### 手动部署（熟悉 git 的话）

#### 1. 建仓库

把本目录推到你的 GitHub 仓库（公开/私有都行，私有更合适）。

```bash
cd workbuddy-daily
git init
git add .
git commit -m "feat: buddy 加油站每日签到自动化"
git branch -M main
git remote add origin git@github.com:<你>/<仓库名>.git
git push -u origin main
```

> ⚠️ 注意：`refresh-token.mjs` 会读你的登录态，**不要**把它跑出来的 token 写进任何文件。
> 仓库里只放脚本，不放凭证。

#### 2. 本机导出 token

云端 runner 没有本机登录态，所以要**先在本机把 token 导出来**，再塞进仓库 Secret。

```bash
node scripts/refresh-token.mjs
```

脚本会尝试调用客户端 CLI 直接打印 token；如果拿不到，会告诉你本机登录态文件的字段情况，
并给出几种可行的取 token 方式（开发者工具 / 抓包 / refreshToken 换取）。

> 登录态文件位置（脚本会自动找）：
> - Windows：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`
> - macOS：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/*.info`
> - Linux：`~/.local/share/CodeBuddyExtension/Data/Public/auth/*.info`
>
> 其中 `accessToken` 是 AES-256-GCM 加密的，密钥托管在系统安全存储里。
> 脚本不做绕过解密 —— 与其猜，不如让客户端自己吐。

#### 3. 配仓库 Secret

**Settings → Secrets and variables → Actions → New repository secret**

| Name | 必填 | 说明 |
|---|---|---|
| `WORKBUDDY_ACCESS_TOKEN` | ✅ | 上一步导出的 access token |
| `FEISHU_WEBHOOK_URL` | ✅ | 飞书群自定义机器人 webhook |
| `FEISHU_WEBHOOK_SECRET` | 可选 | 机器人开了「签名校验」才需要 |
| `WORKBUDDY_USER_ID` | 可选 | 需要带 `X-User-Id` 时填 |

可选 Variable（**Settings → Secrets and variables → Actions → Variables**）：

| Name | 默认 | 说明 |
|---|---|---|
| `WORKBUDDY_ENDPOINT` | `https://copilot.tencent.com` | 签到接口 base，非公有云环境改这个 |
| `WORKBUDDY_WEB_ENDPOINT` | `https://www.workbuddy.cn` | 猫猫旅行接口 base |
| `WORKBUDDY_TRAVEL_LOCATION_ID` | 空（自动取第一个） | 指定派猫地点 id |

**飞书机器人怎么拿 webhook**：飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人 → 复制 webhook 地址。

#### 4. 跑通一次

**Actions → Buddy 加油站每日任务 → Run workflow**

- 勾上 `dry_run`：只查询、不做任何写操作，用来先验证 token 通不通。
- 不勾：真跑（会真的签到和领奖）。

#### 5. 开通写权限（台账提交必需）

**Settings → Actions → General → Workflow permissions** → 选 **Read and write permissions** → Save。

不开这个，台账写得了但**推不回仓库**（job 里会看到 warning，任务本身仍算成功）。
不想让任务写仓库的话，把 `daily.yml` 顶部的 `permissions:` 改回 `contents: read`，
台账就只生成在 runner 上、跑完即弃（等于没有历史）。

---

## 关于「派猫」这一步

**已实现。** 派猫的写接口不在桌面客户端里，而在**官网成长中心**的前端 bundle 里，
路径为 `POST /activity/growth/buddy/travel/depart`，请求体 `{ location_id }`。

完整流程：

1. `POST travel/claim` —— 领掉上一趟到家的积分
2. `GET travel/status` —— 看 `state`
3. `state=idle` 且未达上限 → `GET travel/config` 取地点 → `POST travel/depart`
4. `state=traveling` → 跳过（今天已派过）

想指定固定地点，设仓库 Variable `WORKBUDDY_TRAVEL_LOCATION_ID`；
留空则自动取 `config` 返回的第一个地点。

### 本机抓包脚本

`scripts/probe-cat.mjs` 是个**只读探针**，在你本机跑（有登录态），
把 `status` / `config` 的脱敏原始返回打出来：

```bash
# 只查状态和地点（不派猫）
WORKBUDDY_ACCESS_TOKEN=xxx node scripts/probe-cat.mjs

# 顺带试领到家积分
WORKBUDDY_ACCESS_TOKEN=xxx node scripts/probe-cat.mjs --claim

# 真的派一趟
WORKBUDDY_ACCESS_TOKEN=xxx node scripts/probe-cat.mjs --depart

# 指定地点
WORKBUDDY_ACCESS_TOKEN=xxx node scripts/probe-cat.mjs --depart --location=xxx
```

---

## 验收：原始返回

每次运行，job 日志里都会有分段的**脱敏原始返回**：

```
----- [raw:checkin-status(before)] (sanitized) -----
----- [raw:travel/claim] (sanitized) -----
----- [raw:travel/status] (sanitized) -----
----- [raw:travel/config] (sanitized) -----      # 仅在需要派猫时出现
----- [raw:travel/depart] (sanitized) -----      # 仅在需要派猫时出现
----- [raw:daily-checkin] (sanitized) -----
```

脱敏规则（`checkin.mjs` 的 `sanitize()`）：
- `accessToken` / `refreshToken` / `token` / `phoneNumber` / `nickname` / `uid` 等键 → 打码
- 字符串里的 `Bearer xxx` → `Bearer ***`
- UUID 形态的 uid → 首 8 位 + `****`

不想看原始返回，把 `WORKBUDDY_DEBUG_RAW=0` 设上即可。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `.github/workflows/daily.yml` | 定时任务定义，解释器路径用 `command -v` 动态取 |
| `scripts/checkin.mjs` | 主逻辑：领奖 → 判状态 → 派猫 → 签到 → 汇总 |
| `scripts/append-ledger.mjs` | 把当天结果追加到 `history/buddy-ledger.xlsx` |
| `scripts/notify-feishu.mjs` | 飞书卡片推送，签到与猫猫分开两段 |
| `scripts/setup-github.mjs` | **一键部署**：建仓库 + 传代码 + 写 Secret + 触发首跑（配 `配置GitHub.bat` 使用） |
| `scripts/refresh-token.mjs` | **本机用**：导出登录态 token（不进仓库） |
| `scripts/probe-cat.mjs` | **本机用**：派猫接口只读探针 / 抓包 |
| `token.local.json` | 本机导出的 WorkBuddy token（**绝不进仓库**，`.gitignore` + 上传排除双保险） |
| `history/buddy-ledger.xlsx` | Excel 台账（**由任务自动生成并提交**，初始不存在） |
| `package.json` | 依赖声明（exceljs） |
| `docs/api-contract.md` | 接口逆向记录 |

---

## 安全

- token 只经仓库 Secret 注入，**不写进任何文件、不进日志**
- workflow 权限仅开通必需项：`contents: write`（用于提交台账；若不想要台账可改回 `read`）
- 所有原始返回输出前**先脱敏**
- `.gitignore` 已排除 `result.json`、`node_modules/` 与 `*.token` 等；
  `history/` 下的台账是**故意提交**的
- 台账里不含 token / uid / 手机号 —— 只记积分与状态文字

---

## 排查

| 现象 | 原因 / 处理 |
|---|---|
| `401 Authorization Required`（APISIX 页面） | token 过期或没配。重新跑 `refresh-token.mjs` 更新 Secret |
| `400` 且 code `17043` | 缺 `X-Product-Code`，脚本已默认带上 |
| 签到报 `already claimed` | 今天已经签过了，脚本按「已签到」处理，算成功 |
| 飞书没收到 | 检查 `FEISHU_WEBHOOK_URL`；若机器人开了签名校验，补 `FEISHU_WEBHOOK_SECRET` |
| 定时没跑 | GitHub 免费套餐对 cron 有延迟；确认仓库有活动（长期无提交的仓库 cron 会被暂停，可点一下 Run workflow 唤醒） |
| 派猫报「没有可用的旅行地点」 | `travel/config` 的 `locations` 为空 —— 先用 `probe-cat.mjs` 看原始返回确认 |
| 派猫报「猫猫今天累啦」 | `daily_limit_reached` 或 HTTP 429，当天已到上限，属正常 |
| 派猫报「还没有 buddy」 | 账号还没在客户端领过 buddy，需先在客户端操作一次 |
| 台账没更新 | 看 job 里「写入每日台账 Excel」那步日志；若 `result.json` 缺失会跳过记账 |
| 台账提交失败 | 确认仓库 Settings → Actions → General → Workflow permissions 勾了 **Read and write** |
| 台账出现空白行 | 旧版本 bug（已修）。删掉 `history/buddy-ledger.xlsx` 让下次重建即可 |
