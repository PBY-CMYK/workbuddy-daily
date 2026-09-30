# 接口逆向记录（API Contract）

> 本文档是**逆向结论的存档**。原始反编译产物（官网前端 bundle、app.asar 解包目录，共约 323MB）
> 已在完成后清理，结论全部沉淀在这里与 `README.md`。

## 一、抓包 / 逆向来源

派猫接口不在桌面客户端里，而在**官网成长中心前端 bundle**。客户端点「派猫猫旅行」实际是
打开内置浏览器访问 `https://www.workbuddy.cn/profile/growth-center`，请求由该 SPA 发出。

前端资源基址：
```
//download.codebuddy.cn/web/usercenter/00259587558f692132209f5249d62317c65520b6/assets/
```

关键 chunk 与用途：

| 文件 | 用途 |
|---|---|
| `growthSpace-EIUE4QaA.js` | **接口定义全集**（travel 四件套在这里） |
| `GrowthCenterPage-BZwm0xmj.js` | 别名映射 + travel 状态机 + 文案 |
| `config-wXDbhNun.js` | axios 实例、请求拦截器、token 取法、域名判定 |

### 接口定义原文（`growthSpace-EIUE4QaA.js`）

```js
Q=()=>e.get("/activity/growth/buddy/travel/config")
W=()=>e.get("/activity/growth/buddy/travel/status")
Y=t=>e.post("/activity/growth/buddy/travel/depart",{location_id:t})   // ← 派猫
j=()=>e.post("/activity/growth/buddy/travel/claim",{})
J=(t=1,a=20)=>e.get("/activity/growth/buddy/travel/records",{params:{page:t,page_size:a}})
```

同文件里的其他接口（备查）：

```js
w=()=>e.get("/v2/activity/growth/profile")
o=()=>e.get("/v2/activity/growth/subscribe-task/status")
h=async()=>e.get("/v2/activity/growth/tasks")
p=t=>e.post("/activity/growth/tasks/accept",{task_codes:t})
v=t=>e.post(`/activity/growth/tasks/${t}/claim`)
u=()=>e.get("/v2/activity/growth/badges")
l=()=>e.get("/activity/growth/energy")
m=()=>e.get("/activity/growth/buddy/info")
b=()=>e.get("/activity/growth/buddy/list")
S=()=>e.get("/activity/growth/buddy/templates")
G=()=>e.get("/activity/growth/buddy/quota")
T=(t=1)=>e.post("/activity/growth/buddy/open",{count:t})
L=()=>e.post("/activity/growth/buddy/first")
k=t=>e.post("/activity/growth/buddy/switch",{instance_id:t})
_=()=>e.get("/activity/growth/buddy/agreement")
C=()=>e.post("/activity/growth/buddy/agreement",{agree:!0})
R=()=>e.get("/activity/growth/buddy/visible")
B=t=>e.get("/activity/growth/heatmap",{params:t})
O=()=>e.get("/activity/growth/streak")
I=()=>e.get("/activity/growth/lottery/summary")
$=()=>e.get("/activity/growth/lottery/prizes")
N=t=>e.post("/activity/growth/lottery/draw",{client_token:t})
z=()=>e.get("/activity/growth/lottery/chances")
```

### 别名映射（`GrowthCenterPage-BZwm0xmj.js`）

```js
import{J as os,I as Le,L as Ce,K as je,T as He,M as We,N as ds,O as ms,P as us,Q as hs,R as gs}
  from"./growthSpace-EIUE4QaA.js";
```

→ `gs`=config、`hs`=status、`us`=depart、`ms`=claim、`os`=records

调用点（travelStore）：

```js
fetchConfig: async () => { const n = (await gs()).data?.data; ... n?.locations ... }
fetchStatus: async () => { const n = (await hs()).data?.data; if(!n||!n.state) return; Ge(s,n) }
depart: async (a) => { const i = (await us(a)).data?.data; ... }
claim:  async ()    => { const n = (await ms()).data.data; ... }
```

---

## 二、状态机（派猫判断依据）

### 归一化函数 `Ge()`（前端原文）

```js
function Ge(s,t){
  s({
    state: t.state ?? "idle",
    location: t.location ?? null,
    departAt: t.depart_at ?? 0,
    arriveAt: t.arrive_at ?? 0,
    serverNow: t.server_now ?? 0,
    serverNowReceivedAt: Math.floor(Date.now()/1e3),
    letter: t.letter ?? null,
    useDeeplink: t.use_deeplink ?? "",
    dailyLimitReached: t.daily_limit_reached ?? !1,
    rewardCredit: t.reward_credit ?? 0
  })
}
```

### 入口决策 `handleOpenEntry`

```js
await N();                       // fetchStatus
const G = X.getState().state;
G === "traveling" ? M("countdown")        // 出行中 → 倒计时弹窗
: G === "arrived" ? (R(!1), M("letter"))  // 已到家 → 领奖信弹窗
: Z.dailyLimitReached || M("location")    // 待命 → 未达上限则弹地点选择
```

### 状态语义表

| `state` | 含义 | 本次动作 | 前端文案 |
|---|---|---|---|
| `traveling` | 在路上 | 跳过（今天已派） | 旅行倒计时 |
| `arrived` | 到家，有奖励待领 | 先领奖，**可再派一趟** | 领取礼物 |
| `idle` | 待命 | `daily_limit_reached` 为真则跳过，否则派出 | 派猫猫旅行 |

`daily_limit_reached === true` 时无论 state 如何都跳过，文案「累啦，明天再来吧」。

### depart 错误语义（前端 catch 分支原文）

```js
httpCode === 429 || msg.includes("daily limit")     → "猫猫今天累啦，明天再来吧"
msg.includes("no active buddy")                     → "请先领取 buddy"
msg.includes("already traveling")                   → 重新 fetchStatus
msg.includes("location not available")              → "该地点暂时不可用"
其他                                                 → "网络异常，请重试"
```

claim 的错误语义：

```js
msg.includes("not arrived yet") || msg.includes("no unclaimed travel") → 重新 fetchStatus（不算失败）
httpCode === 500 && msg.includes("grant credits failed")               → "积分发放异常，请联系客服"
```

---

## 三、认证与请求头

### 前端 axios 实例与请求拦截器（`config-wXDbhNun.js` 原文）

```js
const Ne = 6e4, ut = "Authorization";
const p  = te.create({ timeout: Ne, withCredentials: !0, headers: { "Content-Type": "application/json" } });
const pt = te.create({ timeout: Ne, withCredentials: !0, headers: { "Content-Type": "application/json" } });

function ke(e) {
  e.headers["X-Client-Platform"] = ct();
  if (oe()) { const t = dt(); t && (e.headers[ut] = `Bearer ${t}`); }
  return e;
}
p.interceptors.request.use(e => ke(e), e => Promise.reject(e));
pt.interceptors.request.use(e => {
  ke(e);
  const t = window.sessionStorage.getItem("profile-enterpriseId");
  if (t) e.headers["X-Enterprise-Id"] = t;
  return e;
}, e => Promise.reject(e));
```

### 常量

```js
Ee = "growth-center-platform"    // sessionStorage key
Oe = "growth-center-token"       // sessionStorage key ← token 在这
ee = "miniProgram"; Qe = "miniprogram"; et = "web"

oe() { return window.sessionStorage.getItem("growth-center-platform") === "miniProgram" }  // 是否小程序
ct() { return oe() ? "miniprogram" : "web" }                                               // X-Client-Platform
dt() { return window.sessionStorage.getItem("growth-center-token") || "" }                 // token
```

### 结论（云端脚本用的部分）

| 项 | 值 |
|---|---|
| Base URL（web） | `https://www.workbuddy.cn` |
| Base URL（签到，桌面侧） | `https://copilot.tencent.com` |
| 认证头 | `Authorization: Bearer <accessToken>` |
| 平台头 | `X-Client-Platform: web` |
| 产品头 | `X-Product-Code: workbuddy` |
| 其他 | `withCredentials: true`（同源 cookie 也会带上） |

**注意**：桌面侧 `/v2/activity/growth/buddy/info` 与官网侧 `/activity/growth/buddy/info` 是两条不同路径，
`v2` 前缀只出现在桌面主进程那套里（`main/server.js` 110769 行附近）。

---

## 四、部署侧关键点（易踩）

1. **两套 host**：签到打 `copilot.tencent.com`，派猫打 `www.workbuddy.cn`。混用会 404。
2. **`location_id` 来源**：由 `travel/config` 的 `data.locations[].id` 提供，不是硬编码。
   本文档未记录到真实 id 形态（未拿到有效 token 实测），脚本按 `id ?? location_id` 兼容取值。
3. **缺 `X-Product-Code`** 可能被后端拒（400 / code 17043），脚本已默认带。
4. **`daily_limit_reached` 优先于 `state`**：即便 `state=idle` 也不能派。
5. **签到与派猫互不阻断**：任何一侧失败，另一侧照常执行；整体结论只由签到决定。

---

## 五、验证记录

| 验证方式 | 结果 |
|---|---|
| 假 token 打真实网关 | 四个 endpoint 全部 APISIX `401 Authorization Required`（非 404）→ 路由正确 |
| 本地 mock 四场景 | `traveling` 跳过 / `arrived` 领奖后派出 / `limit` 跳过 / `checkin_fail` 派猫仍成功 |
| 请求顺序 | `claim → status → config → depart → checkin`，符合「先领奖再判断」 |
