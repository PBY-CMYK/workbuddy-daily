# 本地同步台账（双击即用）

把 GitHub 仓库里每天更新的台账 Excel，拉到本地固定位置，然后自动用 Excel 打开。

## 为什么不能「自动推送到电脑」

GitHub 无法主动推文件到你电脑 —— 你关机时没有程序在监听。所以做成
**你想看的时候双击一下，主动把最新表拉下来**，这是唯一可靠的方式。

## 用法

**双击 `同步台账.bat`** 就行（`sync-ledger.bat` 是同一个文件的英文名副本，双击哪个都一样）。

它会：
1. 从 GitHub 拉取最新的 `history/buddy-ledger.xlsx`
2. 存到 `桌面\Buddy加油站台账\Buddy加油站台账.xlsx`
3. 自动用 Excel 打开

内容没变时不会重复写文件，也不会重复打开（避免每次双击都弹一堆窗口）。

### 退出码

| 退出码 | 含义 | 你要做什么 |
|---|---|---|
| `0` | 同步成功（含「已是最新」） | 什么都不用做 |
| `1` | 配置错误（`repo` 没填 / 配置文件缺失） | 改 `sync-config.json` |
| `2` | 未完成但可自愈（远端没文件 / 仓库私有 / 网络不通） | 看屏幕上的中文提示 |

> **关于 `.bat` 的行尾**：Windows 的 `cmd.exe` 要求 `.bat` 用 **CRLF**（`\r\n`）行尾。
> 如果这个文件被编辑器（或 git）转成了 LF-only，双击后会**完全没有任何输出、窗口一闪而过**。
> 本文件的 `.gitattributes` 已把 `*.bat` 固定为 CRLF，别用会自动改行尾的工具去动它。

## 一次性配置

打开 `sync-config.json`，把 `repo` 改成你自己的：

```json
{
  "repo": "你的用户名/你的仓库名",
  "branch": "main",
  "remotePath": "history/buddy-ledger.xlsx",
  "localDir": "C:/Users/Administrator/Desktop/Buddy加油站台账",
  "localName": "Buddy加油站台账.xlsx",
  "autoOpen": true
}
```

| 字段 | 说明 |
|---|---|
| `repo` | **必改**。格式 `用户名/仓库名`，就是浏览器地址栏里 GitHub 仓库路径那一段 |
| `branch` | 分支名，一般是 `main` |
| `remotePath` | 台账在仓库里的路径，默认 `history/buddy-ledger.xlsx`，不用改 |
| `localDir` | 存到本地哪个文件夹，默认桌面 |
| `localName` | 本地文件名 |
| `autoOpen` | 拉完是否自动打开，`false` 则只下载 |

## 前提条件

1. **仓库是公开的** —— 脚本走 GitHub 的公开 raw 地址，私有仓库拉不到。
   （如果你要私有仓库，告诉我，我改成带 token 的方式。）
2. **任务至少成功跑过一次** —— 台账文件是 workflow 跑完生成的，
   跑之前仓库里没有这个文件，脚本会提示「远端还没有这个文件」。
3. **本机有 Node** —— `.bat` 会自动找 WorkBuddy 自带的 node，一般不用管。

## 用什么打开

用系统默认的 Excel 关联程序（Excel / WPS / 其他）。想换成固定的程序，
在 `sync-ledger.mjs` 的 `openFile()` 里改成指定 exe 路径即可。

## 命令行用法（可选）

```bash
node sync-ledger.mjs              # 拉取 + 打开
node sync-ledger.mjs --no-open    # 拉取不打开
node sync-ledger.mjs --check      # 只看远端有没有更新
```

## 排查

| 现象 | 原因 |
|---|---|
| **双击后窗口一闪、什么都没显示** | `.bat` 行尾被改成了 LF。**双击 `修复bat行尾.bat`** 即可修好 |
| 提示「远端还没有这个文件」 | 任务还没成功跑过第一次，仓库里没生成台账 |
| 提示「仓库是私有的」 | 需要改成带 token 的方式，告诉我 |
| 提示「请先填 repo」 | `sync-config.json` 里的 `repo` 还是占位符 |
| 提示「连接被重置 / 域名解析不了」 | 网络到 `raw.githubusercontent.com` 不通 —— 挂代理，或直接在 GitHub 网页下载 |
| 拉到了但打开是乱码 | 检查是不是拉到了 HTML（说明路径不对或仓库私有） |
| 提示「被占用，已另存」 | 你正开着 Excel，脚本会换个带时间戳的文件名存，不覆盖你正在看的 |

## 目录里的文件

| 文件 | 作用 |
|---|---|
| `同步台账.bat` | **双击这个**（拉取台账 + 打开） |
| `sync-ledger.bat` | 同上，纯英文文件名副本 |
| `sync-ledger.mjs` | 真正的同步逻辑 |
| `sync-config.json` | 配置（要改 `repo`） |
| `修复bat行尾.bat` | 双击无输出时，双击这个修一下 |
| `repair-bat.mjs` | 把 `.bat` 强制修成 CRLF（命令行版） |
| `check-bat-eol.mjs` | 检查 `.bat` 行尾是否正常 |

根目录 `package.json` 里也挂了两个快捷命令：

```bash
npm run bat:check     # 检查 .bat 行尾
npm run bat:repair    # 修复 .bat 行尾
```
