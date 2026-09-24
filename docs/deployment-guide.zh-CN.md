# dsh-web-fetch-playwright 部署与使用说明

> **适用版本**：`0.2.7` 基线 + 分支 `feat/proxy-capture-pipeline` 的全部改动（本仓库当前 HEAD）。
> **本手册的写法**：先讲人话（§0），再讲细节（§1 起）。每条命令都标明**在哪台机器上跑**、**参数是什么意思**、**看到什么算成功**。
> **阅读约定**：凡是标注「**待真机验证**」的条目，都是在没有可启动浏览器的构建环境里**无法验证**的部分——请勿把本手册当作"已在真实浏览器上验证通过"的结论。

---

## 0. 先读这一节（人话版）

### 0.1 它到底是干什么的

**一句话**：让服务器上的 AI 能"开你的浏览器"去抓网站，顺手把网站真正发的请求录下来，最后变成一段**不需要浏览器、不需要 AI** 就能在服务器上自己狂跑的 Python 脚本。

**类比**：你的浏览器是一辆有钥匙、有登录状态、走你代理的车；AI 在机房里，看不见这辆车。这个插件做三件事：

1. 给车装**远程遥控口**，机房里的 AI 能开它；
2. 车上装**行车记录仪**，把沿途的网络请求录下来；
3. 把录像**翻译成自动驾驶脚本**，以后不用 AI 也能自己跑。

### 0.2 全景图

```
你本机的 Chrome（有登录状态、走你本机的代理）
        │  开了一个"遥控口" 9222
        │
        └── 隧道（把本机 9222 接到服务器上）
                    │
服务器上的 DSH ──────┘  顺着这个口接管你的 Chrome
        │
        ├─ AI 用 web_fetch 抓网页 → 结果回到 AI 那里
        ├─ 顺手把网站发的请求录下来 → 存成文件
        └─ 用一个小工具把录像翻译成 Python 爬虫 → 在服务器上裸跑
```

**重要推论**：浏览器在哪台机器上，"抓网页"就从哪台机器上网。浏览器在你本机时，用的是**你本机的网络与代理**——服务器网络好坏、有没有代理，都不影响抓取本身。

### 0.3 术语对照表（看到不懂的就查这里）

| 术语 | 人话 |
|---|---|
| 后端 / backend | 用哪种方式开浏览器（三选一） |
| 本地 / local | 插件自己开浏览器，抓完就关（最简单） |
| 托管 / managed | 一个浏览器长期开着，登录一次就记住（适合长期跑） |
| 远端 CDP / cdp | 用**已经开着**的浏览器（要配遥控口，最常见于"浏览器在本机、DSH 在服务器"） |
| CDP / 9222 端口 | 浏览器留的"远程遥控口" |
| autossh / 反向隧道 | 把**本机**浏览器的遥控口接到**服务器**上，让服务器能摸到它 |
| profile / user-data-dir | 浏览器的"用户文件夹"，登录状态存在这里 |
| 代理 / proxy | 中转服务器，让目标网站看到的是另一个 IP |
| 抓包 / dump / HAR | 行车记录仪录像；HAR 是这种录像的标准文件格式 |
| JSONL | 一行一条记录的文本文件 |
| netdump | 把录像翻译成爬虫的小工具 |
| 并发 | 同时发多少个请求 |
| 断点续跑 | 中途断了，重跑接着上次继续 |

### 0.4 三种用法怎么选

| 你的情况 | 选哪个 | 谁需要装浏览器 |
|---|---|---|
| 抓公开网页、图省事，且 DSH 所在机器**能装浏览器** | **本地**（local） | DSH 所在机器 |
| 要登录后才能看的站，且想在服务器长期跑 | **托管**（managed） | DSH 所在机器 |
| 浏览器在**你本机**、DSH 在**服务器/容器**（**服务器上没有浏览器**） | **远端 CDP**（cdp） | 只需本机有浏览器 |
| 想让浏览器独立成一个容器、保持 DSH 镜像干净 | **远端 CDP**（cdp） | 浏览器容器里 |

**一句话判断**：浏览器和 DSH 不在同一台机器上 ⇒ 只能走 **cdp**；在同一台机器上 ⇒ 用 **local**（无状态）或 **managed**（要登录态）。

> 本节只解决"浏览器放哪儿"。**"我要干的那件事该动哪些开关"** —— 抓正文 / 先给站点分流 / 接口优先生成离线爬虫 / 页面要先操作（配方）/ 本地可视调试 / 服务器无头生产 / Cloudflare 挑战，按场景走的那份手册在这里：[`usage-scenarios.zh-CN.md`](./usage-scenarios.zh-CN.md)。

### 0.5 场景 A：浏览器在你本机，DSH 在服务器（**服务器上没有浏览器时，这是唯一可用的路**）

#### 本机要做的 3 步

**第 1 步：开一个"允许被遥控"的 Chrome**

三个要点：必须用**单独的文件夹**（Chrome 新版本不允许用你日常的用户目录做遥控）、要带**代理参数**、起来后**手动登录一次**（这个新窗口不会继承你日常浏览器的登录状态）。

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-dsh" \
  --proxy-server="socks5://127.0.0.1:1080"
```

```powershell
# Windows（PowerShell，注意反引号是续行符）
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:USERPROFILE\chrome-dsh" `
  --proxy-server="socks5://127.0.0.1:1080"
```

```bash
# Linux
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-dsh" \
  --proxy-server="socks5://127.0.0.1:1080"
```

| 参数 | 意思 |
|---|---|
| `--remote-debugging-port=9222` | 开遥控口，端口号 9222（可换，但要和后面隧道、DSH 里的一致） |
| `--user-data-dir="$HOME/chrome-dsh"` | 登录状态存这个文件夹；**必须单独一个**，不能是你日常目录 |
| `--proxy-server="socks5://127.0.0.1:1080"` | 这个浏览器所有出站走该代理；换成你代理的地址，**不需要代理就删掉这行** |

**看到什么算成功**：弹出一个全新的 Chrome 窗口（没有你日常的书签/扩展）。在这个窗口里把要抓的网站登录一遍。

> 想让它后台跑不弹窗：加 `--headless=new`；但**第一次登录要有窗口**，登录完再换无头启动。

**第 2 步：确认代理在本机正常**

浏览器能打开目标网站即可。**如果代理需要用户名密码**：建议改用不需要密码的本地代理（例如 `ssh -D 1080 用户名@代理机` 会生成一个本地 socks5），因为 Chrome 的启动参数塞不进密码。

**第 3 步：建隧道（本机执行）**

```bash
autossh -M 0 -N -R 9222:127.0.0.1:9222 用户名@服务器地址
```

| 部分 | 意思 |
|---|---|
| `autossh` | 断线自动重连；没装就换成 `ssh`（`ssh -N -R 9222:127.0.0.1:9222 用户名@服务器`），但断了要手动重连 |
| `-N` | 只做端口转发，不执行远程命令 |
| `-M 0` | 关闭 autossh 自带的监控端口（改用 SSH 自身的保活） |
| `-R 9222:127.0.0.1:9222` | **把本机的 9222 口，推到服务器的 9222 口上** |

**看到什么算成功**：命令挂住不动（正常）。然后在**服务器上**执行下面这条，能打出一段 JSON：

```bash
curl -s http://127.0.0.1:9222/json/version
```

#### 服务器上要做的 3 步

**第 1 步：装插件并重启**

```bash
dsh plugin --profile web add github:gj513174036/dsh-web-fetch-playwright
# 装完重启 dsh web
```

| 部分 | 意思 |
|---|---|
| `dsh plugin --profile web add` | 把插件加进 web profile 的插件列表 |
| `github:...` | 从 GitHub 装；本地目录也可用 `file:/绝对路径` |
| 重启 `dsh web` | bundle 层只在启动时加载，**加装/卸载都必须重启**（设置卡片里的改动是热生效的，不用重启） |

**看到什么算成功**：重启后 Web UI 的插件配置区出现 **「Playwright 网页爬取」** 卡片。

**第 2 步：卡片里只填这 4 项**（其他全部留空）

| 卡片上的名字 | 填什么 | 为什么 |
|---|---|---|
| Playwright 后端 | **远端 CDP 地址** | 浏览器不在本机，只能"接管已有浏览器" |
| CDP 地址 | `127.0.0.1:9222` | 隧道落点，默认就是这个 |
| 共享浏览器上下文 | **勾上** | 用你本机浏览器里已登录的状态 |
| 代理地址 | 留空或随意 | **cdp 模式下这一项只用于生成/预览启动命令，不生效**；真正生效的是你第 1 步给 Chrome 加的 `--proxy-server` |

**第 3 步：验证能用**

让 AI 抓一个需要登录、或只有走代理才能打开的网页。

- 成功 → 整条链路通了
- `cannot connect to the CDP endpoint` → 隧道断了，或本机 Chrome 没开
- 抓回来是"未登录"的样子 → 本机 Chrome 里没登录成功，或"共享浏览器上下文"没勾

#### 抓包 → 生成爬虫（都在服务器上做）

1. 卡片里打开 **「录制网络」**
2. 让 AI 抓一次网页（每次抓取都会把这次的所有网络请求录下来）
3. 录像在服务器上 `net-dumps/<那次的编号>/`，含 `network.jsonl`（实时一行行写）与 `har.json`（抓完导出的标准格式）
4. 翻译成爬虫（命令详解见 §8）：

```bash
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<编号>/har.json -o out
```

5. 在服务器上裸跑它（命令详解见 §9）：

```bash
pip install "httpx[http2,socks]"
python3 out/crawler.py --concurrency 32 --proxy socks5://127.0.0.1:1080 -o results.jsonl
```

> ⚠️ **最容易忽略的区别**：抓网页时走的是**你本机的**代理；脚本是在**服务器上**跑的，走的是**服务器的**网络。目标站只认你本机出口 IP 时，脚本在服务器上会失败——那就在服务器上配一个同出口代理，或把脚本放本机跑。

### 0.6 场景 B：让 DSH 自己开浏览器（DSH 所在机器能装浏览器时）

**第 1 步：装插件并重启**（同 0.5）

**第 2 步：卡片里填**

| 卡片上的名字 | 无状态抓取（local） | 要登录态（managed，推荐长期用） |
|---|---|---|
| Playwright 后端 | 本地 Playwright | **DSH 托管持久浏览器** |
| Playwright 可执行文件路径 | 留空，或填浏览器绝对路径（如 `/usr/bin/chromium`） | 同左 |
| 代理地址 | 例如 `http://127.0.0.1:7890` | 同左 |
| 运行无头模式 | （无关） | 勾上（服务器没有显示器） |
| user-data-dir | （无关） | 留空 = `$DSH_HOME/web-fetch-playwright/profile`，或填挂载卷路径 |
| 最大并发抓取数 | 4（每个并发 = 一个浏览器进程） | 50（每个并发 = 一个标签页） |

**第 3 步（仅 managed，拿登录态）**：先**取消勾选**「运行无头模式」→ 用 `web_fetch` 打开目标站 → 手动登录 → 再**勾回**无头。之后所有抓取都带这个登录态，重启 `dsh web` 也不丢。

**第 4 步**：抓包与生成爬虫同 0.5 的后半段。

---

## 1. 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| DSH | 有 Web profile，可运行 `dsh web` | 设置卡片在 Web UI 的插件配置区 |
| Node.js | ≥ 20 | 宿主插件与启动器运行环境（**DSH 所在机器**需要） |
| Python | 3.11+，**仅标准库** | 离线流水线 `tools/netdump` 零第三方依赖（可在服务器或本机跑） |
| httpx | `pip install "httpx[http2,socks]"` | **只有生成的爬虫**需要；流水线本身不需要 |
| 浏览器 | 见 §5 | **local / managed 必须有**；cdp 不需要 |
| 代理 | 可选（`socks5://` / `http://` / `https://`） | 目标站点有 IP 限制时必需 |

---

## 2. 安装部署

### 2.1 三种装法（都在 DSH 所在机器上跑）

```bash
# ① 从 npm（若已发布）
dsh plugin --profile web add dsh-web-fetch-playwright

# ② 从 GitHub（你的 fork）
dsh plugin --profile web add github:gj513174036/dsh-web-fetch-playwright

# ③ 从本地目录
dsh plugin --profile web add file:/绝对路径/web_fetch_playwright
```

| 部分 | 意思 |
|---|---|
| `--profile web` | 装进名为 web 的 profile（`dsh web` 用的就是它） |
| `add <来源>` | 来源可以是 npm 包名、`github:用户/仓库`、`file:/本地路径` |
| 之后重启 `dsh web` | bundle 层只在启动时加载；不重启看不到卡片 |

若 pnpm 默认拦截第三方包的构建脚本，需把该包加入 `profiles/web/pnpm-workspace.yaml` 的 allowlist（pnpm 会提示）。

### 2.2 源码开发/自建

```bash
git clone <repo> && cd dsh-web-fetch-playwright
pnpm install          # 依赖 + 自动构建（prepare → build）
pnpm run typecheck    # 类型检查
pnpm test             # 单元/集成测试（当前 22 文件 / 588 用例；无可用浏览器时真机用例自动跳过）
pnpm build            # 产出 lib/index.js（宿主）与 lib/client.js（界面卡片）
```

> `bin/launch-browser.mjs` 通过 `import('../lib/index.js')` 取插件 API，**从源码用必须先 `pnpm build`**；npm 包自带 `lib/`。

### 2.3 卸载

```bash
dsh plugin --profile web remove dsh-web-fetch-playwright
# 同样需要重启 dsh web
```

### 2.4 关键路径一览

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/settings.yaml` → `web-fetch-playwright` 段 | 本插件全部设置（启动器读同一份） |
| `$DSH_HOME/web-fetch-playwright/profile` | `managed` 的默认浏览器用户目录（**含登录态凭据**） |
| `<工作目录>/net-dumps/<编号>/` | 抓包产物（目录 0700 / 文件 0600） |
| `tools/netdump/` | 离线流水线（Python 包） |
| `bin/launch-browser.mjs` | 本地可视浏览器启动器（命令名 `dsh-web-fetch-launch`） |

---

## 3. 配置页字段全表

位置：Web UI → 插件配置 → **Playwright 网页爬取**。写入 `$DSH_HOME/settings.yaml` 的 `web-fetch-playwright` 段；留空即用默认值。

| 字段 | 默认值 | 填什么 / 注意 |
|---|---|---|
| `backend`（后端） | `local` | `local` / `managed`（DSH 托管持久浏览器）/ `cdp`（远端 CDP） |
| `playwrightPath` | 空 | local/managed 用。填**浏览器可执行文件绝对路径**（如 `/usr/bin/chromium`）最稳；留空则先找 `$PATH` 上的 `playwright`，再回退到内置 `playwright-core`（它找默认缓存里的浏览器） |
| `cdpEndpoint`（CDP 地址） | 空 → `127.0.0.1:9222` | cdp 用。`host:port`、`http(s)://`、`ws(s)://` 都行；独立浏览器容器填容器名，如 `dsh-browser:9222` |
| `shareBrowserContext`（共享浏览器上下文） | 勾选 | cdp 用。勾 = 用被接管浏览器的真实登录态；不勾 = 每次全新匿名上下文 |
| `denoise`（启用降噪算法） | 勾选 | 抓完自动去掉导航/侧栏/页脚/广告再转 Markdown；不勾则返回原始 HTML |
| `maxConcurrency`（最大并发抓取数） | 空 → local 4 / managed 50 / cdp 50 | 上限 200。local 的每个并发是一个**浏览器进程**；managed/cdp 的每个并发是一个**标签页** |
| `challengeWaitMs`（Cloudflare 挑战等待上限） | 15000 | 0–60000；0 = 关闭（首响应即结果）。遇 Cloudflare 拦截时调大 |
| `challengeRetries` | 1 | 0–3。等待窗口用完后同页重试次数 |
| `proxyServer`（代理地址） | 空 | **代理开关**：`host:port`（按 http 处理）或 `http(s)/socks4/socks5://…`；空 = 直连 |
| `proxyBypass`（代理绕过列表） | 空 | 逗号分隔；`127.0.0.1`/`localhost`/`::1` **始终**自动绕过 |
| `proxyUsername` / `proxyPassword` | 空 | 仅 HTTP 代理可用，且**只作用于插件自己启动的浏览器**；cdp/启动器拓扑不下发（见 §6.4） |
| `headless`（运行无头模式） | 勾选 | managed 用；服务器没显示器就保持勾选。**要人工登录时先取消勾选** |
| `userDataDir` | 空 → `$DSH_HOME/web-fetch-playwright/profile` | managed 用，登录态存这里。**当凭据目录对待**，插件从不清理；容器里建议挂持久卷 |
| `launchArgs`（额外启动参数） | 空 | 追加给 Chromium，例如容器里加 `--disable-dev-shm-usage`（见 §5.2） |
| `recordNetwork`（录制网络） | 不勾 | **抓包开关**。开启后每次抓取落盘含明文凭据的 dump |
| `recordDir` | 空 → `<工作目录>/net-dumps` | dump 根目录（其下按本次编号建子目录） |
| `captureBodies` | 勾选 | 是否落盘响应体；离线流水线判定 JSON 接口需要它 |
| `maxBodyBytes` | 262144 | 单个响应体截断上限（0–16 MiB）；**0 = 不限制** |
| `recordAllResources` | 不勾 | 连静态资源也记录；注意图片/字体/媒体已被抓取自身的资源过滤提前中断，打开也只能看到它们的 URL |
| `observe` | 不勾 | **观察模式**：返回页面的可操作状态（可触及控件 + 标签 + `checked`/`unchecked`/`disabled`/`covered`、完整计数、可见文本开头）而不是正文。面对陌生页面时先开它——"这页要求 5 项全勾"这种前置条件任何标签里都读不出来。它是模式而非每次调用的选项（抓取入口只带一个 URL） |
| `dismissConsent` | 不勾 | 点掉已知同意管理器的"全部接受"控件（OneTrust、TrustArc、Cookiebot… 十余家，外加同意类界面里的兜底文本候选）。默认关闭：这次点击会在**抓取所用的 profile** 里记录你的同意。整页同意插页（不是横幅）它处理不了，那种站要写配方（见场景手册 §5） |
| `targetsFile` | 空 | **配方文件**（JSON）的显式路径：为"读取文档之前要先做动作"的 URL 提供具名配方。插件拿到的是**进程工作目录**，不是本会话工作区，所以要写绝对路径。放进仓库评审与 diff，**不要写任何凭据**（cookie 走 profile）。写法与三个真机配方见场景手册 §5 与 [`targets/README.md`](../targets/README.md) |

---

## 4. 三种后端详解

### 4.1 `local`（本地 Playwright）

- **它做什么**：每次 `web_fetch` 启动一个全新浏览器，抓完即关。**不保留登录态**。
- **适合**：公开页面批量抓取、无需登录、不想维护浏览器状态。
- **需要**：DSH 所在机器上有一个可用浏览器（见 §5）。
- **并发**：每个并发 = 一个浏览器进程，建议 4–8。

### 4.2 `managed`（DSH 托管持久浏览器）

- **它做什么**：DSH 用 `launchPersistentContext()` 拉起**一个**浏览器并长期复用；每次抓取只开一个标签页，标签页用完即关，浏览器与用户目录**不按抓取关闭**。
- **登录态流程**：取消勾选「运行无头模式」→ `web_fetch` 打开目标站 → 手动登录 → 勾回无头。登录态跨抓取、跨 `dsh web` 重启保留。
- **改设置会换浏览器**：`userDataDir`/`headless`/`launchArgs`/代理/`playwrightPath` 任一变化 → 下次抓取重建浏览器；改 `challengeWaitMs`/`denoise`/`maxConcurrency` 不会。
- **适合**：需要登录态的长期抓取；服务器上跑生产。

### 4.3 `cdp`（远端 CDP / 接管已有浏览器）

- **它做什么**：DSH 连上一个**已经在跑**、开着遥控口的浏览器；每次抓取在里面开一个标签页，用完关闭，你的其它标签页不受影响。
- **适合**：浏览器在另一台机器/另一个容器（见 §5.3、§5.4）；或你想亲眼看它操作。
- **代理**：插件**无法**给已在运行的浏览器注入代理——必须在启动那个浏览器时带 `--proxy-server`（本插件自带的启动器会自动带上设置页里的代理值）。

**本插件自带的启动器**（本机有 Node 时可用；它把"复制用户目录 + 开遥控口 + 带代理 + 打印隧道命令"一次做完）：

```bash
dsh-web-fetch-launch --help          # 看全部参数
dsh-web-fetch-launch --dry-run --headful --proxy socks5://127.0.0.1:1080   # 只看命令不执行
dsh-web-fetch-launch --headful --proxy socks5://127.0.0.1:1080             # 真启动
```

| 参数 | 意思 |
|---|---|
| `--dry-run` | 只打印要执行的命令，不真的启动 |
| `--headful` / `--headless` | 有窗口 / 无窗口（首次登录用 `--headful`） |
| `--proxy <地址>` | 覆盖设置页里的代理 |
| `--user-data-dir <目录>` | 用哪个用户目录（默认是复制出来的副本） |
| `--profile <目录>` | 复制哪个真实 Chrome 用户目录（默认自动找系统 Chrome 的） |
| `--no-copy` | 不复制，直接用 `--user-data-dir` 指定的目录 |
| `--force` | 目标目录已存在时覆盖（**默认拒绝覆盖**，安全设计） |
| `--port <n>` / `--address <ip>` | 遥控口端口（默认 9222）/ 绑定地址（**只接受回环地址**） |
| `--launch-args "<参数>"` | 追加浏览器参数，如 `--disable-dev-shm-usage` |
| `--settings <文件>` | 用别的 settings.yaml |

命令行会打印它拼出的 Chrome 命令和这行隧道提示：

```
autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>
```

**安全说明**：启动器**只允许回环地址**，因为遥控口等于浏览器与其中凭据的完全控制权；跨机请用反向隧道，不要把它暴露到公网。代理用户名/密码**不会**下发给该浏览器（Chrome 命令行无处承载），启动器会打印一条 `warning:` 并建议替代方案（见 §6.4）。

---

## 5. 【专题】DSH 跑在容器里，浏览器放哪儿？

### 5.1 结论速查

| 方案 | 本容器要装浏览器吗 | 用哪个后端 | 适合谁 |
|---|---|---|---|
| A. 装进 DSH 容器 | **要** | `local` 或 `managed` | 想让服务器自给自足，不依赖你本机 |
| B. 另起一个浏览器容器 | 不要 | **`cdp`** | 想保持 DSH 镜像干净、浏览器独立升级 |
| C. 用你本机的浏览器 + 隧道 | 不要 | **`cdp`** | 要复用你本机的登录态/本机代理（§0.5） |

> **关键概念**：`local`/`managed` 的含义是"**插件自己把浏览器进程拉起来**"，所以浏览器必须和插件在同一台机器上。**另起容器跑浏览器 ⇒ 只能走 `cdp`**，不是 `local`。

### 5.2 方案 A：把浏览器装进 DSH 容器（用 `local` 或 `managed`）

**三种安装方式，选一种：**

```bash
# ① Playwright 官方安装器（需要 root 装系统依赖；最省事）
pnpm exec playwright install --with-deps chromium

# ② 只下载浏览器、不装系统依赖（无 root 时用；若容器缺系统库会启动失败）
pnpm exec playwright install chromium

# ③ 发行版自带的 chromium
apt-get update && apt-get install -y chromium     # Debian/Ubuntu
apk add --no-cache chromium                       # Alpine
```

```dockerfile
# ④ 干脆用官方镜像当基础镜像（系统依赖齐全，最省事）
FROM mcr.microsoft.com/playwright:v1.62.1-noble
```

**设置里 `playwrightPath` 填什么：**

| 安装方式 | `playwrightPath` |
|---|---|
| ③ 发行版包 | 填浏览器绝对路径，如 `/usr/bin/chromium`（插件用内置 playwright-core 驱动它；**最稳**） |
| ① / ② | 留空：先找 `$PATH` 上的 `playwright`，找不到就用内置 `playwright-core` 去默认缓存找浏览器；也可设环境变量 `PLAYWRIGHT_BROWSERS_PATH` 指到浏览器所在目录 |
| ④ 官方镜像 | 留空（镜像已带浏览器） |

**容器特有的 6 个坑：**

| 坑 | 现象 | 解决 |
|---|---|---|
| `/dev/shm` 太小（Docker 默认 64MB） | 浏览器随机崩溃 | 启动容器加 `--shm-size=1g`，或在设置 `launchArgs` 填 `--disable-dev-shm-usage` |
| 没有显示器 | 有头模式起不来 | 保持 `headless` 勾选（默认就是勾的） |
| 容器重建后浏览器没了 | 抓取突然报"找不到浏览器" | 把安装写进镜像，或把浏览器目录挂持久卷 + `PLAYWRIGHT_BROWSERS_PATH` |
| 镜像膨胀 | 镜像 +300–500MB | 可接受就留着；想瘦身改用方案 B |
| 用 root 跑 | 一般没事（Playwright 默认已关沙箱）；但要留意容器逃逸风险 | 尽量用非 root 用户跑 DSH |
| `managed` 的用户目录在容器内 | 重建后登录态丢失 | `userDataDir` 指向挂载的持久卷 |

**验证**：卡片里选 `local`，让 AI 抓一个公开网页；成功即通。失败时看报错里的 `source` 字段，它会写明浏览器是从哪儿解析到的。

**要不要为了 `local` 单开一个浏览器容器？** 不需要——`local` 必须是插件自己拉进程；跨容器就用 `cdp`（方案 B）。

### 5.3 方案 B：另起一个浏览器容器（用 `cdp`）

```bash
# 1) 建一个私有网络（DSH 容器和浏览器容器都要接进来）
docker network create dsh-net

# 2) 起浏览器容器：开遥控口、绑到容器网络、用持久卷存登录态、带上代理
docker run -d --name dsh-browser --network dsh-net \
  -v dsh-chrome-profile:/data/profile \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  /bin/bash -lc 'chromium --headless=new --no-sandbox \
     --remote-debugging-port=9222 \
     --remote-debugging-address=0.0.0.0 \
     --user-data-dir=/data/profile \
     --proxy-server=socks5://10.0.0.5:1080'
```

| 参数 | 意思 |
|---|---|
| `--network dsh-net` | 和 DSH 容器同一私有网络，DSH 才能用容器名连上它 |
| `-v dsh-chrome-profile:/data/profile` | 登录态存卷里，容器重建不丢 |
| `--remote-debugging-address=0.0.0.0` | 允许**容器网络内**的其它容器连入（**注意：绝不能把 9222 发布到公网**） |
| `--user-data-dir=/data/profile` | Chrome 新版本要求遥控口必须配一个非默认用户目录 |
| `--proxy-server=...` | 这个浏览器的出站代理（方案 B 里代理由**浏览器容器**决定，不是 DSH） |
| `--no-sandbox` | 容器里常需要（本次未在真机验证） |

**DSH 侧配置**：`backend = cdp`、`cdpEndpoint = dsh-browser:9222`、勾选「共享浏览器上下文」。

**验证**（在 DSH 容器里）：

```bash
curl -s http://dsh-browser:9222/json/version
```

**安全**：这个端口 = 浏览器与其凭据的完全控制权。只用私有 docker 网络，**不要** `-p 9222:9222`。

### 5.4 方案 C：不装浏览器（用你本机的浏览器 + 隧道）

就是 §0.5 那条路：本机 Chrome（带代理 + 单独用户目录）→ `autossh` 反向隧道 → DSH 用 `cdp` 连 `127.0.0.1:9222`。

**这是"服务器上没有浏览器、也不想装"时的标准答案**，代价是本机要保持开机、Chrome 和隧道要一直开着。

### 5.5 选哪个？

| 你的偏好 | 建议 |
|---|---|
| 服务器自己搞定，不想依赖你本机常开 | **方案 A**（容器内装；`managed` + 持久卷） |
| 想复用你本机登录态/本机代理 | **方案 C**（本机 Chrome + 隧道） |
| 想保持 DSH 镜像干净、浏览器单独升级/排障 | **方案 B**（浏览器容器 + `cdp`） |
| 只抓公开网页、无登录 | 方案 A 的 `local` 最省事 |

---

## 6. 代理配置（两条**互相独立**的通道）

### 6.1 通道一：浏览器的出站（本插件负责）

| 后端 | 代理怎么生效 | 你该在哪配 |
|---|---|---|
| `local` | 插件 `chromium.launch({ proxy })` 注入 | 设置页 `proxyServer` |
| `managed` | 插件 `launchPersistentContext({ proxy })` 注入 | 设置页 `proxyServer` |
| `cdp`（本机浏览器） | **插件注入不了**；由那个浏览器的启动参数决定 | 启动 Chrome 时的 `--proxy-server=`，或用 `dsh-web-fetch-launch --proxy` |
| `cdp`（浏览器容器） | 同上，由浏览器容器决定 | 容器启动命令里的 `--proxy-server=` |

地址写法：`host:port`（按 http 处理）、`http://`、`https://`、`socks4://`、`socks5://`。回环地址始终绕过代理。

### 6.2 通道二：DSH 自身的出站（不由本插件管理）

AI 调用模型、联网搜索等请求走环境变量：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export NO_PROXY=127.0.0.1,localhost
```

**Chromium 不读这些变量**，所以两条通道要分别配，缺一不可。

### 6.3 怎么验证代理真的生效

| 目的 | 做法 |
|---|---|
| 验证浏览器出站 | 让 `web_fetch` 抓一个"显示我的出口 IP"的页面，比对是否为你代理的出口 |
| 验证 DSH 出站 | 用一个只有走代理才能访问的 API/搜索服务 |
| 看错误 | 代理不可用或地址非法会返回 `WEB_FETCH_PROXY`（消息含代理地址、已剥离 `user:pass@`，**绝不含密码明文**） |

### 6.4 已知约束：CDP/启动器拓扑不下发代理凭据

HTTP 代理的 `proxyUsername`/`proxyPassword` **只在插件自己启动的浏览器上生效**。cdp/启动器拓扑下启动器会打印 `warning:`，替代方案：

1. 用**免鉴权的本地代理**（`ssh -D 1080 user@host` → `--proxy socks5://127.0.0.1:1080`）；
2. 在代理侧做 **IP 白名单**；
3. 在**有头**浏览器里手动应答一次鉴权。

---

## 7. 网络抓包

### 7.1 打开与范围

卡片里勾选 **「录制网络」**。开启后**每次** `web_fetch` 都会在它自己打开的那个标签页上录。

> 只录**本次抓取打开的标签页**。想录你手动操作的流量：用 `backend = cdp` + 勾选「共享浏览器上下文」，让插件在你的浏览器里开标签页。

### 7.2 落盘位置与权限

```
<工作目录>/net-dumps/<本次编号>/
  network.jsonl      # 一行一个 JSON，抓取进行中持续追加
  har.json           # 抓取结束时导出的标准 HAR 1.2
```

目录 `0700`、文件 `0600`；编号唯一（同毫秒也不会共用目录）。

**边跑边看**（在服务器上）：

```bash
ls -l net-dumps/                              # 看有哪些场次
head -n 1 net-dumps/<编号>/network.jsonl      # 看头行（本次抓的入口 URL）
grep -c '"kind":"request"' net-dumps/<编号>/network.jsonl   # 数一下录到多少请求
```

### 7.3 录了什么

`network.jsonl` 的行类型（`kind`）共 11 种：`session`（头行）、`request`、`response`、`responseBody`、`finished`、`failed`、`requestExtra`、`responseExtra`、`websocketCreated`、`websocketFrame`、`websocketClosed`。重定向每一跳独立成对记录（`301→200` 会有两条）。

`requestExtra`/`responseExtra` 是浏览器"真正发出去的原始头"（Cookie/Set-Cookie 常只出现在这里）。

### 7.4 录制失败不影响抓取

录制是 best-effort：出错只会往 stderr 打一条

```
dsh-web-fetch-playwright: network capture problem (the fetch is unaffected): <原因>
```

**只含错误文本，不含任何 header/正文**，且同一种错误只报一次。

### 7.5 清理

dump 不会自动删除：

```bash
rm -rf net-dumps/<编号>      # 清理单次
rm -rf net-dumps/*           # 清理全部（注意里面有明文凭据）
```

---

## 8. 离线流水线 netdump（录像 → 爬虫）

零第三方依赖（Python 3.11 标准库），**无 AI、无浏览器、无网络**参与生成。

### 8.1 最常用的一条命令

```bash
# 在哪跑：服务器或本机都行（只要能读到抓包文件）
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<编号>/har.json -o out
```

| 部分 | 意思 |
|---|---|
| `PYTHONPATH=tools/netdump` | 让 Python 找到这个包（因为它在子目录里） |
| `python3 -m netdump build` | 跑"生成"子命令 |
| `net-dumps/<编号>/har.json` | 输入：抓包文件。`network.jsonl` 也可以，格式自动识别 |
| `-o out` | 输出目录（自动建，权限 0700） |

**看到什么算成功**：终端打印一份"接口排行榜"（方法 + URL 模板 + 调用次数 + 评分），并在 `out/` 下生成两个文件：

| 文件 | 内容 |
|---|---|
| `out/endpoints.json` | 接口清单（含被过滤项及原因，可审计） |
| `out/crawler.py` | **能独立跑的爬虫**，已内嵌录到的明文 Headers/Cookie（文件 0600） |

### 8.2 只看不生成

```bash
PYTHONPATH=tools/netdump python3 -m netdump summary net-dumps/<编号>/har.json
```

只打印接口排行，不写文件——**先用它确认"录到的接口对不对"，再决定要不要生成爬虫**。

### 8.3 参数（`build` 与 `summary` 共用筛选参数）

| 参数 | 什么时候用 |
|---|---|
| `--format {auto,har,jsonl}` | 自动识别失败时强制指定输入格式 |
| `--include-static` | 接口数为 0、怀疑被当静态资源过滤掉时，加它看看全量 |
| `--include-documents` | 想连 HTML 页面请求一起看 |
| `--no-websockets` | 不关心 WebSocket 时 |
| `--top N` | 只要评分最高的 N 个接口 |
| `--quiet` | 不打印总结（脚本里用） |

`build` 独有：`-o/--output-dir`（输出目录）、`--no-crawler`（只出 `endpoints.json`）、`--crawler-name`、`--endpoints-name`、`--concurrency`、`--timeout`、`--retries`、`--proxy`、`--proxies-file`（后五项写进生成脚本当默认值，省得每次命令行再传）。

### 8.4 筛选与排序逻辑（可调）

- **丢弃**：图片/字体/媒体/样式/脚本类资源、静态扩展名（`.js/.css/.png/.jpg/.svg/.woff…`）、HTML 页面。
- **保留**：`xhr`/`fetch` 请求、JSON 响应、带 `Authorization`/`Cookie` 的请求、带 body 的非 GET 请求。
- **例外**：URL 以静态扩展名结尾但**确实返回 JSON** 的接口会被保留（弱证据被 JSON 响应推翻；抓包明确给出的资源类型是强证据，仍会被过滤）。
- **排序**：按评分（JSON 响应、鉴权头、非 GET、调用频次等），依据写在 `scoreFactors`/`rankReason` 里。

---

## 9. 生成脚本在服务器上裸跑

### 9.1 装依赖

```bash
pip install "httpx[http2,socks]"     # socks5 代理需要 [socks]；HTTP/2 需要 h2
```

### 9.2 先空跑，再真跑

```bash
cd out
python3 crawler.py --dry-run                 # 只打印计划，不发请求（不需要 httpx）
python3 crawler.py --concurrency 32 -o results.jsonl
```

**看到什么算成功**：`--dry-run` 打印将请求的接口列表；真跑时结果逐行写入 `results.jsonl`。

### 9.3 参数全表（`python3 crawler.py --help`）

| 参数 | 默认 | 什么意思 |
|---|---|---|
| `--endpoints PATH` | 空 | 改用外部 `endpoints.json`（默认用脚本里内嵌的抓包结果） |
| `-o/--out PATH` | `results.jsonl` | 结果文件，**同时是断点续跑的凭据** |
| `--concurrency N` | `8` | 同时发多少个请求 |
| `--timeout S` | `30.0` | 单请求超时（秒） |
| `--retries N` | `3` | 失败重试次数（指数退避，尊重 `Retry-After`） |
| `--proxy URL` | 空 | 代理地址，**可以重复传多个**；支持 `http(s)/socks5` |
| `--proxies-file PATH` | 空 | 代理列表文件（每行一个，`#` 注释），按请求轮换 |
| `--dry-run` | 关 | 只打印计划，不发请求 |
| `--no-resume` | 关 | 忽略已有结果，从头重跑 |
| `--expand-templates` | 关 | 用录到的路径参数补全 `{id}`/`{uuid}`/`{hash}` |
| `--limit N` | `0` | 最多请求多少个目标（0 = 不限） |
| `--body-bytes N` | `512` | 结果里保留的响应体前缀字节数 |
| `--insecure` | 关 | 跳过 TLS 证书校验（自签证书时用） |

### 9.4 退出码（写脚本/监控用）

| 码 | 含义 |
|---|---|
| `0` | 全部成功（或 `--dry-run`） |
| `1` | 有目标重试后仍失败 |
| `2` | 配置/输入错误（代理列表文件不存在、缺 httpx…） |
| `130` | 被 Ctrl-C 中断（已写入的结果保留，重跑自动续跑） |

### 9.5 常驻运行

```bash
# 简单后台
nohup python3 crawler.py --concurrency 64 --proxies-file proxies.txt \
  -o results.jsonl > crawler.log 2>&1 &
```

```ini
# systemd：/etc/systemd/system/netdump-crawler.service
[Unit]
Description=netdump crawler
After=network-online.target
[Service]
WorkingDirectory=/opt/crawler
ExecStart=/usr/bin/python3 /opt/crawler/crawler.py --concurrency 64 --proxies-file /opt/crawler/proxies.txt -o /opt/crawler/results.jsonl
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

结果逐行 `flush + fsync` 落盘；中断留下的半行下次启动会自动修复。

### 9.6 ⚠️ 网络出口的区别（最容易踩）

| 阶段 | 走谁的网络 |
|---|---|
| 抓网页（浏览器） | **浏览器所在那台机器**的网络与代理 |
| 生成的爬虫（Python） | **跑脚本那台机器**的网络与代理 |

所以在"本机浏览器 + 服务器脚本"的组合下，两边的出口 IP 可能不同。目标站只认某一侧时，要么在另一侧配同出口代理（`--proxy`），要么把脚本换到浏览器那台机器上跑。

---

## 10. 运维与调参

| 场景 | 建议 |
|---|---|
| 抓取并发上不去 | local 每个并发是一个浏览器进程，建议 4–8；managed/cdp 每个并发是标签页，可到 50 |
| 频繁 `WEB_FETCH_TIMEOUT` | 单次抓取预算 45s、排队超时 20s；提高 `maxConcurrency` 或降低并发 |
| Cloudflare 过不去 | 调大 `challengeWaitMs`（上限 60000）与 `challengeRetries`（上限 3）；用带登录态的 managed/cdp 用户目录通常更有效 |
| 磁盘增长 | 抓包是主要来源：定期清理 `net-dumps/`；`maxBodyBytes` 调小或 `captureBodies` 关掉 |
| 登录态失效 | managed：重建/清理 `userDataDir` 后重新登录；cdp：在浏览器那台机器重新登录 |
| 隧道断了 | 用 `autossh`（自动重连）而不是 `ssh -N -R`；DSH 侧会报 `cannot connect to the CDP endpoint` |
| 想看抓包是否失败 | stderr 里的 `network capture problem (the fetch is unaffected): …` |

---

## 11. 故障排查

| 现象 / 错误码 | 原因 | 处置 |
|---|---|---|
| `WEB_FETCH_PROXY` | 代理地址不可用/非法；或 local/managed 因代理启动失败 | 检查 `proxyServer` 写法与代理连通性；cdp 模式下该字段仅用于生成启动命令 |
| `WEB_FETCH_CHALLENGE` | 站点持续返回 Cloudflare 挑战 | 调大 `challengeWaitMs`/`challengeRetries`；改用已有登录态的 profile |
| `WEB_PROVIDER_ERROR` | 浏览器启动失败 / CDP 连不上 | local/managed：检查 `playwrightPath` 或装浏览器（§5）；cdp：确认遥控口开着且隧道/网络可达 |
| `WEB_FETCH_TIMEOUT` | 单次 > 45s，或排队 > 20s | 提高 `maxConcurrency`；检查代理/目标站是否极慢 |
| `WEB_ABORTED` | 调用方取消 | 无需处置 |
| `WEB_UNSUPPORTED_CONTENT_TYPE` | 返回的不是 HTML/文本/JSON/XML | 该 URL 不适合用本插件 |
| `WEB_INVALID_URL` / `WEB_BLOCKED_URL` | URL 非法、超长、含内嵌凭据 | 修正 URL（凭据别放 URL 里） |
| 启动器报"目标已存在" | 覆盖保护生效 | 确认后加 `--force`，或换 `--user-data-dir` |
| 启动器报"非回环地址" | `--address` 传了非回环值 | 用默认 `127.0.0.1` + 反向隧道（刻意的安全限制） |
| 容器里浏览器随机崩溃 | `/dev/shm` 太小 | `--shm-size=1g` 或 `launchArgs` 加 `--disable-dev-shm-usage` |
| `netdump` 产出 0 个接口 | 全被判定为静态/页面请求 | 加 `--include-static`/`--include-documents` 看看；确认抓包时 `captureBodies` 为开 |
| 脚本报缺 httpx | 未装依赖 | `pip install "httpx[http2,socks]"`，或先 `--dry-run` |
| 脚本大量 401/403 | 录到的 Token 过期 | 重新抓包再生成；或接上刷新逻辑 |

---

## 12. 安全清单

- **凭据三处落地**，都按凭据管理：设置页的代理账号密码（`settings.yaml` 明文）、`managed` 的用户目录、以及抓包 dump（含明文 Cookie/Token/Authorization）。
- dump 目录 `0700` / 文件 `0600`；`net-dumps/` 已在本仓库 `.gitignore` 中。**生成的 `crawler.py` 内嵌明文凭据**（0600）——别提交进任何仓库。
- 遥控口（9222）等于浏览器与其凭据的完全控制权：本插件启动器**只绑回环**；跨机走隧道；容器方案只放私有网络，**不要发布到公网**。
- 代理凭据不会出现在任何错误信息里（`user:pass@` 被剥离，密码永不打印）。
- 本插件不做验证码破解、不做指纹/UA 伪装、不做代理轮换（配置的代理是**单一静态出口**）；Cloudflare 只做"有界自然等待"。
- 包披露见 `package.json` 的 `dsh.disclosure`（permissions / retention 均已覆盖代理出口、持久用户目录、启动器与抓包落盘）。

---

## 13. 已知限制与待真机验证项

### 13.1 已文档化的限制（**非已验证行为**）

抓包的 ExtraInfo 按跳配对有三条例外，同时写在 `src/recorder.ts` 注释与 README（en/zh）：

1. **无身份回退会错配**：ExtraInfo 缺 `:path`/`:authority` 时回退到"按到达序号配对"，遇某跳缺此类事件即错配（身份可用时正确，现代 API 常态）。
2. **双方无身份的反转序**：某跳的 extra 晚于更后一跳的 extra 到达，且两者都无可用身份——事件层面本地无法区分。
3. **响应侧仅靠状态码**：连续同状态码跳（如 `http→https→www` 三个 301）且较早跳缺 `responseExtra` 时，较晚跳的 `responseExtra`（及其 `Set-Cookie`）会落到较早跳。让响应侧可靠的是**状态码彼此不同**，而不是跳的顺序。

### 13.2 必须由你在真机上确认的 7 项

1. 真实代理连通性（含需鉴权的 HTTP 代理）；
2. Chrome 用户目录**跨机迁移后的可解密性**（绑定 OS keyring/DPAPI/Keychain）；
3. 真实站点鉴权流量抓取（真实 Token/Cookie 的 XHR/WS）；
4. 真实浏览器三种后端 + Cloudflare 挑战 + 响应条件（无可用浏览器时 `tests/integration.browser.spec.ts` 的 18 个用例**自跳过**，**跳过≠通过**）；
5. `autossh` 反向隧道端到端；
6. 真实 CDP extra-info 的**到达顺序与省略情形**（限制 1–3 的根源）；
7. 生成脚本的真实 httpx 运行（本环境未安装 httpx，测试用等价假模块；`httpx < 0.26` 回退分支未实测）。

第 4 条里的浏览器容器 `--no-sandbox` 组合亦未在真机验证。

逐步判定方法与预期输出见 [`end-to-end-acceptance-manual.md`](./end-to-end-acceptance-manual.md)。
