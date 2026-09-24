# 端到端真机验收手册（P0 代理 → P1 托管浏览器/启动器 → P2 抓包 → P3 离线爬虫）

本手册供**用户在自己的真机上**照着执行到底，验收本轮四条交付物：

| 阶段 | 交付物 | 本文对应章节 |
| --- | --- | --- |
| P0 | 设置卡片代理字段 + 浏览器代理注入 + `WEB_FETCH_PROXY` 诊断 | §3 |
| P1 | DSH 托管持久浏览器（一键 headless/user-data-dir）+ 本地 GUI 启动器 + autossh 隧道拓扑 | §4、§5 |
| P2 | 每次 fetch 一条 CDP 会话抓 XHR/Fetch/WS，JSONL 实时落盘 + HAR 1.2 | §6 |
| P3 | `tools/netdump/` 离线流水线：过滤静态资源 → 业务 API 清单 → httpx 异步爬虫 | §7、§8 |
| P4 | 动作模型：`observe` 发现 → 配方固化 → 确定性重放（含"新标签页"与"响应条件"） | §9 |

- 适用版本：`package.json` 版本 **0.2.7** 之上的 `[Unreleased]` 变更集（本仓库分支 `feat/proxy-capture-pipeline`）。
- 本手册中出现的每个配置项名、脚本路径、CLI 参数都可在附录 A 索引里对回源码（附录 A 是逐字核对过的清单）。
- 本手册中的「预期输出」片段来自本仓库的真实执行记录（干净检出 + 真实启动器二进制 + 真实 netdump 运行），不是示意。
- 预计耗时：§1–§3 约 15 分钟；§4 或 §5 任选一条拓扑约 20 分钟；§6–§8 约 20 分钟；§9（动作模型）约 10 分钟。

---

## 1. 环境准备

| 依赖 | 用途 | 检查命令 | 预期 |
| --- | --- | --- | --- |
| DSH web profile（`dsh web`） | 宿主 | `dsh --version` | 有输出 |
| Node.js ≥ 20 | 插件与启动器 | `node -v` | `v20` 以上（本仓库验证用 v24.21.0） |
| Python 3.11（仅标准库） | P3 netdump 生成器 | `python3 -V` | `Python 3.11.x` |
| 一个 Chromium 系浏览器 | local / managed 后端 | `google-chrome --version` 或 `chromium --version` | 有输出；或让 `playwrightPath` 指向可执行文件 |
| 一个出站代理（可选） | P0 验证 | 代理服务端可达 | 没有代理也可验收 P0（留空=直连），但真机代理连通性必须由你自备 |
| `autossh`（仅拓扑 B） | 反向隧道 | `autossh -V` | 有输出 |
| `httpx`（仅 P3 生成脚本运行） | 服务器裸跑爬虫 | `python3 -c "import httpx; print(httpx.__version__)"` | 有输出；没有则 `pip install "httpx[http2,socks]"` |

> 本仓库的验证环境**没有可启动的浏览器**（`~/.cache/ms-playwright` 为空、`$PATH` 无 chromium/chrome），因此本文中所有依赖真实浏览器、真实代理、真实隧道的步骤都标注为「待你真机验证」；自动化测试里对应的真机用例会**自跳过**（详见 §12）。

---

## 2. 安装插件并打开设置卡片

```sh
# npm 源（预构建，无需构建权限）
dsh plugin --profile web add dsh-web-fetch-playwright

# 或 GitHub 源码（pnpm 会跑 prepare 构建）
dsh plugin --profile web add github:chendefine/dsh-web-fetch-playwright
```

安装/升级后**重启 `dsh web`**（bundle 插件只有重启才会进 profile 层）。卸载：`dsh plugin --profile web remove dsh-web-fetch-playwright`，同样需要重启。

打开卡片：**设置 → 插件 → 插件配置 → *Playwright 网页爬取***。

卡片里你会看到（自上而下）：

1. **Playwright 后端**（三选一，每个选项带自己的嵌套输入）
   - *本地 Playwright* → `playwrightPath`（卡片标签 `Playwright 可执行文件路径`）
   - *DSH 托管持久浏览器* → `userDataDir`（卡片标签 `持久 profile 目录（user-data-dir）`）
   - *远端 CDP 地址* → `cdpEndpoint`（卡片标签 `CDP 地址`）、`共享浏览器上下文（复用登录态）`
2. `无头运行（本插件启动的浏览器）`（`headless`，后端无关的卡片级开关）
3. `额外启动参数`（`launchArgs`）
4. `出站代理`（`proxyServer`）、`代理绕过列表`（`proxyBypass`）、`代理用户名（仅本地/托管后端）`（`proxyUsername`）、`代理密码（仅本地/托管后端）`（`proxyPassword`，输入框为密码类型，不回显明文）
5. `本地启动器命令（只读）` —— 由同一套参数拼装逻辑生成的命令预览
6. `启用降噪算法`（`denoise`）、`最大并发抓取数`（`maxConcurrency`）、`Cloudflare 挑战等待上限（毫秒）`（`challengeWaitMs`）
7. **抓包记录**：`抓包记录网络流量（XHR/Fetch/WebSocket）`（`recordNetwork`，开启后 hint 立即变成明文凭据警告）、`落盘目录`（`recordDir`）、`抓取响应正文`（`captureBodies`）、`正文字节上限`（`maxBodyBytes`）、`静态资源也记录`（`recordAllResources`）

卡片写入的是 `$DSH_HOME/settings.yaml` 的 `web-fetch-playwright` 段（`$DSH_HOME` 未设置时为 `~/.dsh`）。启动器读的是**同一个**段，所以 UI 与命令行永远一致。

**排查**：卡片不出现 → 插件没进 profile 层（重启 `dsh web`）；字段灰掉 → 该字段与当前后端无关（`userDataDir` 只在托管后端可用；抓包四个字段只在 `recordNetwork` 开启后可用）；卡片顶部提示「只读」→ 该部署把设置存成只读。

---

## 3. P0：代理配置与验证

### 3.1 配置（设置卡片 → 出站代理）

| 字段 | 填法 | 说明 |
| --- | --- | --- |
| `proxyServer` | `127.0.0.1:7890` 或 `http://127.0.0.1:7890`、`https://…`、`socks4://…`、`socks5://…` | 留空 = 直连。不带 scheme 的 `host:port` 会自动补成 `http://host:port` |
| `proxyBypass` | `172.16.0.0/12,*.internal` | 逗号分隔；`127.0.0.1`、`localhost`、`::1` **始终**并入 |
| `proxyUsername` / `proxyPassword` | 代理要求认证时填 | 只对**本插件自己启动的浏览器**（local / managed）生效；CDP/启动器拓扑不下发（§5.1） |

### 3.2 验证 A：本地后端（`backend` = 本地 Playwright）

1. 填 `proxyServer`，例如 `127.0.0.1:7890`；`proxyBypass` 留空。
2. 用任意页面触发一次 `web_fetch`（例如 `https://example.com`）。
3. **预期**：抓取成功；浏览器进程的流量经代理出口（在代理服务端日志里能看到该请求）。

**失败排查**

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| 错误码 `WEB_FETCH_PROXY`，消息含代理地址与 `field proxyServer` | 代理值不可用，**或**本地/托管浏览器带该代理启动失败 | 核对地址/绕过/用户名/密码；代理不可达时先修代理，或清空 `proxyServer` 走直连 |
| 消息里出现 `***` | 这是密码脱敏，属正常 | 不用管；消息永远不含密码明文 |
| 错误码 `WEB_PROVIDER_ERROR` | 与代理无关的启动失败（没有浏览器/可执行文件） | `playwright install chromium`，或把 `playwrightPath` 指向 playwright/浏览器可执行文件 |

### 3.3 验证 B：托管后端（`backend` = DSH 托管持久浏览器）

同 §3.2，但 `backend` 选「DSH 托管持久浏览器」，`userDataDir` 留空（默认 `$DSH_HOME/web-fetch-playwright/profile`）或指向一个专用目录。代理经 `launchPersistentContext({ proxy })` 注入到那个持久浏览器上。

### 3.4 验证 C：CDP 后端（代理语义）

`backend` 选「远端 CDP 地址」，`proxyServer` 保持已填：**抓取照常执行，不会因为配置了代理而被拒绝**。代理必须在**启动那个浏览器时**用 `--proxy-server=…` 指定（§5 的启动器会从同一组设置拼出该参数）；插件对已在运行的浏览器既不注入也不校验，若手启时漏了该参数，流量就是直连。

**排查**：CDP 连接失败时错误码是 `WEB_PROVIDER_ERROR`（不是 `WEB_FETCH_PROXY`），消息里会提示 `--remote-debugging-port`、`--proxy-server` 与「already-running browser」。

---

## 4. 拓扑 A：服务器无头（`backend` = DSH 托管持久浏览器）

适用：插件与浏览器在同一台服务器上，不需要看界面。

1. 卡片：`backend` = **DSH 托管持久浏览器**；勾选 `无头运行`；`userDataDir` 填一个持久路径，例如 `/data/chrome-dsh-profile`；按需填 `proxyServer`/`proxyBypass`。
2. 触发一次 `web_fetch`。
3. **预期**：DSH 自己拉起浏览器（headless），抓取成功；之后每次抓取都是**同一个**浏览器里的新标签页（`maxConcurrency` 语义 = 并发标签页数，默认 50）。
4. 需要手动登录某个站点时：取消勾选 `无头运行`（有桌面会话时），登录一次，再勾回无头。profile 目录留在盘上，登录态跨 `dsh web` 重启保留。

**排查**

| 现象 | 处理 |
| --- | --- |
| `WEB_PROVIDER_ERROR` 提到 profile 目录 | 目录不可写或浏览器不可解析：检查路径权限、`playwrightPath` |
| `WEB_FETCH_PROXY` 提到 profile 目录 | 代理启动失败：核对代理可达性与凭据 |
| 改了 `userDataDir`/`无头运行`/`额外启动参数`/代理/`playwrightPath` 后浏览器被重启 | 预期行为（启动描述符变了就换浏览器）；改 `maxConcurrency`、`challengeWaitMs`、`denoise` 不会重启 |

---

## 5. 拓扑 B：本机可视浏览器 + autossh 反向隧道（CDP）

适用：浏览器跑在你**能看见**的机器上，插件跑在服务器上，通过反向隧道接管。

### 5.1 第 1 步：在本机启动带代理与回环调试端口的浏览器

先看预览（不启动任何东西）：

```sh
node bin/launch-browser.mjs --dry-run
# 或（npm 安装后，bin 已注册）
dsh-web-fetch-launch --dry-run
```

真机预期输出（本仓库实测；`$DSH_HOME/settings.yaml` 里已配 `proxyServer: '127.0.0.1:7890'`、`proxyBypass: '*.corp'`、`proxyUsername/proxyPassword`、`launchArgs: '--lang=zh-CN'`）：

```
settings: /path/to/settings.yaml (read)
  browser: command-line flag
  proxy-server: settings card (proxyServer)
  proxy-bypass: settings card (proxyBypass)
  launch-args: settings card (launchArgs)
  user-data-dir: command-line flag
  profile source: command-line flag
warning: proxyUsername/proxyPassword are set in the settings card but are NOT sent to the browser: a Chromium command line cannot carry proxy credentials. If the proxy requires authentication, use an auth-free local hop instead (e.g. `ssh -D 1080 user@host` with --proxy socks5://127.0.0.1:1080, or an IP allowlist on the proxy), or answer the authentication once in a headful browser.
profile copy: /path/to/real-profile → /path/to/copy (locks, caches, and crash dumps excluded)
/bin/echo --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=/path/to/copy --headless=new --proxy-server=http://127.0.0.1:7890 '--proxy-bypass-list=*.corp;127.0.0.1;localhost;::1' --lang=zh-CN
would expose CDP on 127.0.0.1:9222; from the plugin host, reach it with:
  autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>
```

真正启动（去掉 `--dry-run`；本机 Chrome 路径可用 `--browser` 指定）：

```sh
dsh-web-fetch-launch --headful --profile "$HOME/.config/google-chrome" \
  --user-data-dir "$HOME/.config/chrome-dsh-profile"
```

要点：

- **代理**：`--proxy-server` 来自卡片的 `proxyServer`（自动补 scheme），`--proxy-bypass-list` 用 `;` 分隔并已并入回环例外。
- **代理凭据不下发**：`proxyUsername`/`proxyPassword` 不会进命令行；设置里填了它们时启动器会打印上面那条 `warning:`。认证代理请改用免鉴权的本机跳（`ssh -D 1080 user@host` + `--proxy socks5://127.0.0.1:1080`）、代理侧 IP 白名单，或先有头启动手动应答一次。
- **profile 复制**：默认复制真实 profile 的副本到 `--user-data-dir`（默认 `$DSH_HOME/chrome-dsh-profile`），排除 `SingletonLock`/`SingletonCookie`/`SingletonSocket`、`Cache`/`Code Cache`/`GPUCache`/`Service Worker` 等大缓存与崩溃残留，保留 cookie、`Login Data`、`Local Storage`、`Preferences`、扩展。
- **目标已存在会被拒绝**（`error: the target profile … already exists; pass --force to overwrite it (or --user-data-dir to copy somewhere else)`，退出码 2）；确认要覆盖时加 `--force`。目标目录里若有 `SingletonLock`（浏览器正在用）则无论 `--force` 都拒绝。
- **`--address` 只接受回环**（`127.0.0.1`、`127.0.0.0/8`、`::1`、`localhost`；`[::1]` 会被归一化成裸 `::1`）。传 `0.0.0.0` 会得到：
  `error: --address 0.0.0.0 is not a loopback address: the DevTools port grants full control of this browser and access to the logins in its profile, …`（退出码 2）。
- **报错不泄露凭据**：任何回显（未知 flag、`--port`、`--address`、规划失败）都会剥离 `user:pass@`；例如 `--proxyy=http://user:secret@proxy:1080` 只会打印 `--proxyy=http://proxy:1080`。
- 全部可用参数见 `dsh-web-fetch-launch --help`：`--dry-run`、`--browser`、`--profile`、`--user-data-dir`、`--no-copy`、`--force`、`--proxy`、`--proxy-bypass`、`--launch-args`、`--headless`/`--headful`、`--port`、`--address`、`--settings`、`--help`。

### 5.2 第 2 步：把回环端口送到服务器

```sh
autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>
```

保持隧道**只绑回环**（`-R 9222:127.0.0.1:9222`）。这条隧道等于「对你已登录浏览器的访问权限」，不要改成 `0.0.0.0`。

### 5.3 第 3 步：在插件宿主机配置 CDP 端点

卡片：`backend` = **远端 CDP 地址**；`CDP 地址`（`cdpEndpoint`）= `127.0.0.1:9222`（留空也是这个默认值）；`共享浏览器上下文（复用登录态）` 勾选 = profile 模式（用远端浏览器真实 profile 的登录态，抓完只关标签页），取消 = 隔离模式（每次抓取一个全新上下文）。

**预期**：抓取成功且页面看到的是你浏览器里的登录身份（profile 模式）；并发抓取是同一浏览器里的多个标签页。

**排查**

| 现象 | 处理 |
| --- | --- |
| `WEB_PROVIDER_ERROR` 提到无法连接 CDP 端点 | 隧道没起来/端口不对/浏览器没带 `--remote-debugging-port`；消息里会给出 `--proxy-server` 与「already-running browser」提示 |
| 抓取成功但出口不是代理 | 该浏览器启动时漏了 `--proxy-server`（CDP 下插件不注入也不校验）——用 §5.1 的启动器重开 |
| 隧道通了但登录态不对 | 检查是否 profile 模式；确认启动器的 `--user-data-dir` 指向的是真实 profile 的副本，而不是一次性目录 |

---

## 6. P2：抓包开关与落盘

### 6.1 配置

卡片 → 抓包记录：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `recordNetwork` | `false` | 打开后才记录；打开瞬间 hint 变成**明文凭据警告** |
| `recordDir` | 空 | 基目录；留空 = `<dsh web 进程工作目录>/net-dumps`；每次抓取在其下新建 `<sessionId>` 子目录 |
| `captureBodies` | `true` | 是否通过 `Network.getResponseBody` 读响应正文 |
| `maxBodyBytes` | `262144`（256 KiB） | 每个正文/WS 帧的字节上限，`0` = 不截断，上限 16 MiB |
| `recordAllResources` | `false` | 是否连 image/font/media/stylesheet 一起记录（默认丢弃） |

### 6.2 执行与预期产物

打开 `recordNetwork` 后触发一次 `web_fetch`，然后在 `recordDir` 下找到本次会话目录：

```
<recordDir>/<sessionId>/
├── network.jsonl   # 抓取进行中持续追加；一行一个 JSON 对象
└── har.json        # 抓取结束时导出（成功/抛错/被 abort/插件卸载都会导出）
```

预期（本仓库实测，权限在 Linux/macOS 上；`recordDir` 基目录与 `<sessionId>` 子目录都是 0700，两个文件都是 0600）：

```sh
ls -l <recordDir>/<sessionId>/
# -rw-------  har.json
# -rw-------  network.jsonl

head -1 <recordDir>/<sessionId>/network.jsonl
# {"kind":"session","at":1790071134404,"wallTime":1790071134.404,"timestamp":1790071134.404,
#  "fetchUrl":"https://example.com/app","backend":"local","dir":"…/<sessionId>",
#  "captureBodies":true,"maxBodyBytes":262144,"recordAllResources":false,
#  "staticResourceTypes":["image","font","media","stylesheet"],"session":"…/<sessionId>"}
```

一次典型的 XHR 抓取会在 `network.jsonl` 里留下 `session` → `request` → `response` → `responseBody` → `finished` 这样的行序（真实实测）。

`network.jsonl` 行类型（`kind`）：`session`（头行，字段名是 `fetchUrl` 而不是 `url`）、`request`、`response`、`responseBody`、`finished`（或 `failed`）、`requestExtra`、`responseExtra`、`websocketCreated`、`websocketFrame`、`websocketClosed`。每行带时间戳；重定向的每一跳各自成一对 `response`/`finished`；每跳的 Cookie/Set-Cookie 归属由该跳自身身份（请求侧 `:path`+`:authority`，响应侧状态码）配对，**某一跳完全没有 extra-info 事件（例如被缓存的 301）时也不会串到下一跳**。

`har.json` 是 HAR 1.2：`log.version` = `1.2`、`log.creator`、`log.entries`；WebSocket 流量放在 Chrome 的 `_webSocketMessages` 扩展字段里。

### 6.3 排查

| 现象 | 处理 |
| --- | --- |
| 没有目录 | `recordNetwork` 没开；或看的是 `dsh web` 进程的工作目录（`recordDir` 相对路径按该目录解析） |
| 目录在但正文为空 | `captureBodies` 关了，或正文超过 `maxBodyBytes` 被截断（行内 `bodyTruncated: true`，`bodyBytes` 是原始大小） |
| 抓不到静态资源 | 默认行为；`recordAllResources` 打开。注意 image/font/media 子请求会被抓取本身主动 abort，所以只会记录到 URL 与取消，不会有响应正文；stylesheet 会完整记录 |
| 抓取仍然成功但抓包报错 | 预期：录制是 best-effort，任何录制/落盘异常都不会让 `web_fetch` 失败（问题会出现在 recorder 报告里） |
| 其它标签页的流量被记了 | 不应该：每条会话只挂在本次 fetch 自己打开的标签页上，不做 `Target.setAutoAttach` |

> **产物含明文凭据**：`Cookie`/`Set-Cookie`/`Authorization`/token 与请求响应正文按原样保存。目录 0700、文件 0600、`net-dumps/` 已在本仓库 `.gitignore` 中——但复制出去或提交上去就再无保护，**不要分享、不要提交**。

---

## 7. P3：netdump 离线流水线

生成器只依赖 Python 3.11 标准库，不需要浏览器、网络或 AI。

```sh
# 概览（不落盘，stdout 不打印任何凭据）
PYTHONPATH=tools/netdump python3 -m netdump summary net-dumps/<sessionId>/network.jsonl

# 生成 endpoints.json + crawler.py（JSONL 与 HAR 两种输入都行）
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<sessionId>/network.jsonl -o netdump-out
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<sessionId>/har.json        -o netdump-out

# 也可以进入目录直接跑，无需 PYTHONPATH
cd tools/netdump && python3 -m netdump build /path/to/network.jsonl -o /path/to/out
```

真机预期输出（本仓库对 committed fixture 的实测）：

```
[netdump] 输入：…/sample.jsonl（jsonl，6 条记录）
[netdump] 过滤静态/噪音 1 条，保留 5 条 → HTTP 接口 4 个 / WS 通道 1 个
[netdump] 涉及域名：api.example.com
[netdump] 接口排名（method urlTemplate  calls  score）：
  - POST   https://api.example.com/v1/orders  calls=1  score=100
  - GET    https://api.example.com/v1/users/{id}/profile  calls=1  score=80
  - GET    https://api.example.com/v1/reports/{id}/summary  calls=1  score=75
  - GET    https://api.example.com/v1/ping  calls=1  score=40
  - WS     wss://api.example.com/v1/stream/{id}  frames=2
[netdump] 输出目录：/path/to/out
[netdump] 生成爬虫：/path/to/out/crawler.py（含明文凭据，权限 0600，勿提交）
```

产物：`endpoints.json`（目录 0700、文件 0600）与 `crawler.py`（0600）。`endpoints.json` 每个接口含 `method`、`urlTemplate`、`sampleUrl`、`sampleUrls`、`requestHeaders`、`query`、`bodyShape`、`sampleBody`、`callCount`、`score`、`scoreFactors`、`rankReason`，被过滤的条目进 `filtered` 并带原因，WebSocket 单独放 `websockets` 分组；顶层还有 `scoreModel`（评分权重表）。

常用参数（`python3 -m netdump build --help`）：`--format {auto,har,jsonl}`、`--include-static`、`--include-documents`、`--no-websockets`、`--top N`、`--quiet`、`-o/--output-dir`、`--no-crawler`、`--crawler-name`、`--endpoints-name`、`--concurrency`、`--timeout`、`--retries`、`--proxy`（可重复）、`--proxies-file`。

**排查**

| 现象 | 处理 |
| --- | --- |
| 接口清单为空 | 抓包本身可能只含静态资源/HTML 文档；用 `--include-static`/`--include-documents` 复核，或确认抓包确实发生了 XHR/Fetch |
| 静态后缀但确实是接口的 URL 被丢了 | 若抓包**明确**给出 `script`/`image` 等类型，静态过滤是硬性的；只有 URL 后缀或由 mime 兜底推断出的静态类型才会走「后缀像静态但返回 JSON」例外（`rankReason: api-over-static-extension`） |
| `python3 -m netdump` 找不到模块 | 用 `PYTHONPATH=tools/netdump`，或 `cd tools/netdump` 后再跑 |

---

## 8. 生成爬虫的服务器裸跑

把 `endpoints.json`（可选）与 `crawler.py` 拷到服务器（**按凭据文件对待**），然后：

```sh
pip install "httpx[http2,socks]"

# 先空跑看计划（不需要 httpx，不打印凭据）
python3 crawler.py --dry-run

# 直连，16 并发，结果写 results.jsonl（断点续跑依据）
python3 crawler.py --concurrency 16 --timeout 30 --out results.jsonl

# 走代理轮换（每个代理一个连接池）
python3 crawler.py --concurrency 32 --proxy socks5://user:pass@127.0.0.1:1080
python3 crawler.py --concurrency 32 --proxies-file proxies.txt

# 强制重跑 / 补全模板参数 / 限量
python3 crawler.py --no-resume
python3 crawler.py --expand-templates
python3 crawler.py --limit 20
```

`crawler.py` 内嵌抓到的 Headers/Cookie（明文，顶部有 SECURITY WARNING 注释块），使用 `httpx.AsyncClient(http2=True)`、`asyncio.Semaphore` 控并发、指数退避 + 抖动 + `Retry-After` 重试、结果 JSONL 逐行 `flush`+`fsync` 并支持断点续跑（中断留下的半行会被修掉）。结果目录 0700、结果文件 0600。全部参数见 `python3 crawler.py --help`：`--endpoints`、`-o/--out`、`--concurrency`、`--timeout`、`--retries`、`--proxy`、`--proxies-file`、`--dry-run`、`--no-resume`、`--expand-templates`、`--limit`、`--body-bytes`、`--insecure`。

真机预期：`--dry-run` 打印计划（含 `pending`、`concurrency`、`timeout`、`retries`、`proxyMode`、`out`、`resume`、`targetsPreview`，**不含任何凭据**）；正式运行时 stdout 只打印进度与统计（`[crawler] 结束：ok=… failed=… retries=… elapsed=… -> /abs/results.jsonl`），退出码 `0` 表示全部成功、`1` 表示有失败、`2` 表示缺 httpx 或参数错误。

**排查**

| 现象 | 处理 |
| --- | --- |
| `[crawler] 缺少 httpx…` 退出码 2 | `pip install "httpx[http2,socks]"`（`--dry-run` 不需要） |
| 全部 401/403 | 凭据过期；重新抓一次包并重新生成 crawler |
| 结果文件没有新增 | 断点续跑认为目标已完成：`--no-resume`，或换 `--out` |
| 代理连接失败 | `--proxy` 支持 `http(s)/socks5`；socks 需要 `httpx[socks]` |

---

## 9. P4：动作模型（目标 / observe / 重放）

前置：一个带 `--remote-debugging-port` 的浏览器（拓扑 B），或本机能跑 `local`/`managed`。

### 9.1 观察（发现阶段）

设置卡片打开 `observe`，抓一次目标页。预期：返回**可操作状态**而不是正文——最终 URL 与标题、可触及控件及其标签与状态（`checked`/`unchecked`/`disabled`/`covered`、以标签形式可见）、完整计数、可见文本开头。

判定：从这份报告里能读出"这页要求什么、下一步能点什么"。读不出来就说明这个站不适合动作模型（可能该走接口路径，§7）。

### 9.2 重放（固化之后）

设置 `targetsFile` 指向仓库里的配方（例如 `targets/nmpa-datasearch.json`），把 `dismissConsent` 关掉（闸门类站点由配方接管；开启时它自己会以 `WEB_FETCH_CONSENT` 失败）：

```
web_fetch("https://datasearch.nmpa.gov.cn/datasearch/home-index.html")
```

真机预期（本仓库 0.2.26 实测，逐字）：

```
> actions: 1. waitFor text "使用提示" — met
  · 2. click selector "a[title=\"境内生产药品\"]" -> a — clicked (unverified)
  · 3. type selector "input[data-step=\"4\"]" -> textbox (now "阿司匹林") — met
  · 4. click selector "button[data-step=\"5\"]" -> button (it opened a page; the rest of the target runs there) — clicked
  · 5. waitFor response under https://datasearch.nmpa.gov.cn/datasearch/data/nmpadata/countNums — met
  · 6. waitFor text "阿司匹林肠溶片" — met
  → final document https://datasearch.nmpa.gov.cn/datasearch/search-result.html (HTTP 200)
```

判定要点：

- 第 4 步是 `clicked`（不是 `clicked (unverified)`）——被第 5 步的响应条件证明；第 2 步后面紧挨着 `type`，如实标 `clicked (unverified)`。
- 正文是登记册自己的结果表（`国药准字H23022137 | 阿司匹林肠溶片 | …`）。
- 抓取前后浏览器标签页数不变（没有野标签页）。

### 9.3 负向对照（必做）

把配方第 5 步换成一个页面从不调用的端点，重跑。预期：**响亮失败**，而不是空等到超时说不清原因：

```
WEB_FETCH_ACTION
target "…" step 5 (waitFor) did not hold: response under …/never-this-endpoint:
  the last response was …/config/ff80808183cad75001840881f848179f.json?date=… (HTTP 200)
  (not met within 10000ms) — at https://datasearch.nmpa.gov.cn/datasearch/search-result.html
```

### 9.4 配方文件的其它判定

| 判定 | 预期 |
| --- | --- |
| 两条一样具体的 `match` | 抓取失败 `WEB_FETCH_TARGET`，消息点名两个 target |
| 配方 JSON 非法 / 结构非法 | `WEB_FETCH_TARGET`，消息带 JSON 路径 |
| 没有目标命中该 URL | 照常抓取，正文**不出现**动作摘要 |
| 某步标了 `"optional": true` 且没达成 | 该步在摘要里记 `skipped`，其余步骤仍严格 |
| 中间隔着别的动作时 | 前面的点击不会被后面的等待"背书"（记 `clicked (unverified)`） |
| 动作打开的页面 | 标 `"opensPage": true` 的点击会接管它，之后所有步骤与抓取读取的文档都在那一页，且它随抓取关闭 |

配方资产清单与每份配方的用途：[`targets/README.md`](../targets/README.md)；写法的完整语法与场景：[`usage-scenarios.zh-CN.md`](./usage-scenarios.zh-CN.md) §5。

---

## 10. 待你真机验证项（本环境无法验证，**未声称已验证**）

| 项 | 为什么本环境无法验证 | 你在真机上的判定方法 |
| --- | --- | --- |
| **真实代理连通性**（含认证代理） | 验证环境没有代理服务端，也没有可启动的浏览器 | §3.2/§3.3 抓一次包，在代理服务端日志确认请求经过；认证代理按 §5.1 用免鉴权跳或代理侧白名单 |
| **本机 Chrome profile 跨机迁移后的可解密性** | 需要真实 Chrome profile 与操作系统凭据库（Linux 上 Chrome 用 `libsecret`/`kwallet` 派生密钥加密 `Login Data`） | §5.1 在**目标机**上启动副本浏览器，打开一个需要登录的站点，看是否仍是登录态；若被要求重新登录，属平台密钥不同导致的预期行为，用有头模式手动登录一次 |
| **真实站点鉴权流量抓取效果** | 需要真实登录会话与目标站点 | §6 打开 `recordNetwork` 抓一个登录后的接口，确认 `network.jsonl`/`har.json` 里出现该接口且带 `Authorization`/`Cookie`；再喂给 §7 生成 crawler 并在服务器跑通 |
| 真实浏览器三后端渲染、Cloudflare 挑战、并发标签页 | `~/.cache/ms-playwright` 为空且 `$PATH` 无 chromium/chrome，自动化里的真机用例自跳过（§12） | 按 §3/§4/§5 手工跑一遍，确认抓取返回真实文章而不是 `Just a moment…` |
| `autossh` 反向隧道端到端 | 没有隧道目标主机 | §5.2 建隧道后在插件宿主机 `curl http://127.0.0.1:9222/json/version`，应返回该浏览器的 DevTools 版本信息 |
| 真实 CDP 的 extra-info 到达顺序/省略情形 | 自动化只用**合成** CDP 事件流覆盖（README 与 `src/recorder.ts` 均如此声明） | §6 抓一个真实 301 跳转站点，检查 `network.jsonl` 里每跳 `requestExtra`/`responseExtra` 的 `hop` 与凭据归属 |

---

## 11. 最终门禁结论

复核方式：从最终提交 `d95361a` 用 `git archive` 取**干净检出**到 `/tmp/t8-clean`（不含 `node_modules`、`lib/`），在干净检出里 `pnpm install --frozen-lockfile` 重装依赖（`prepare` 顺带产出 `lib/`），再跑三条门禁。

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0（`Done in 10.5s using pnpm v12.4.2`） |
| `pnpm run typecheck` | **exit 0**（输出仅 `$ tsc --noEmit`） |
| `pnpm test` | **exit 0**：全部通过（当前 `Test Files 22 passed (22)` / `Tests 588 passed (588)`；本节里那份 12/323 是 P0–P3 那轮交付时的快照） |
| `python3 -m unittest discover -s tools/netdump/tests -t tools/netdump` | **exit 0**：`Ran 140 tests … OK` |

**自跳过说明（跳过 ≠ 通过）**：`tests/integration.browser.spec.ts` 的 **18 个用例**（3 个 browser smoke + 6 个 CDP smoke + 6 个 challenge A/B + 3 个响应条件）在无可用浏览器时于用例体内提前 return，vitest 把它们计入 passed；`beforeAll` 的启动探针会打印 `skipping browser smoke: browserType.launch: Executable doesn't exist at …/ms-playwright/…`。因此「真机浏览器」相关的行为在本仓库**未被验证**，必须按 §10 由你在真机上确认。

结论：**代码门禁全绿**；配置卡片、README(en/zh)、`SECURITY.md`、`package.json` 的 `dsh.disclosure.permissions`、`CHANGELOG.md` 相互一致（核对明细见 §12 与任务报告）；本轮交付可以进入发布评审，真机项按 §9 验收。

---

## 12. 交付物自洽核对（摘要）

- README(en/zh) 与 `SECURITY.md` 对「代理在各后端的行为」「CDP 拓扑不下发代理凭据」「DevTools 端口只绑回环」「profile 复制排除与 `--force`」「抓包产物 0700/0600 且含明文凭据」的描述逐条一致。
- 旧声明已清理：README 里裸的 `no proxy rotation` 已改写为「配置的代理是单一静态出口，插件不按请求轮换」（离线 crawler 的 `--proxy`/`--proxies-file` 轮换属于生成物，不是插件行为）；`always headless` 的表述已改为「按 `headless` 设置，作用于 local 与 managed，CDP 下只影响启动器命令」。
- `package.json` 的 `dsh.disclosure.permissions` 覆盖代理出口、托管持久 profile（`fs:write`）、启动器 `process:spawn`；抓包写盘属于已披露的 `fs:write` 能力类，但条目文案只举了托管 profile 一例（见任务报告中的低severity finding，建议在下一轮把「抓包 dump 写盘」补进该条说明）。
- `CHANGELOG.md` 的 `[Unreleased]` 已补齐 P2 抓包与 P3 netdump 条目以及各修复轮次（本轮由 t8 收口）。

---

## 附录 A：标识符对齐索引

| 手册中的名字 | 事实来源（最终提交） |
| --- | --- |
| 设置段 `web-fetch-playwright` | `src/index.ts`（`WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE`） |
| 卡片标题 *Playwright 网页爬取* | `src/client/locales.ts`（`title`，zh/en） |
| 字段 `backend` / `playwrightPath` / `headless` / `userDataDir` / `launchArgs` / `cdpEndpoint` / `shareBrowserContext` / `proxyServer` / `proxyBypass` / `proxyUsername` / `proxyPassword` / `denoise` / `maxConcurrency` / `challengeWaitMs` / `challengeRetries` / `recordNetwork` / `recordDir` / `captureBodies` / `maxBodyBytes` / `recordAllResources` | `src/config.ts`（`Config` schema） |
| 默认值 `127.0.0.1:9222`、`15000`、`1`、`262144`、`net-dumps`、并发 `4/50/50` | `src/config.ts` 的 `DEFAULT_*` 常量 |
| 托管 profile 默认 `$DSH_HOME/web-fetch-playwright/profile` | `src/config.ts`（`MANAGED_PROFILE_DIRECTORY`、`effectiveUserDataDir`） |
| 启动器命令名 `dsh-web-fetch-launch` / 脚本 `bin/launch-browser.mjs` | `package.json` 的 `bin`、`bin/launch-browser.mjs` |
| 启动器参数与默认值（`--dry-run`…`--help`、端口 9222、地址 127.0.0.1、`$DSH_HOME/chrome-dsh-profile`） | `src/launcher.ts`（`launcherUsage`、`parseLauncherArgs`、`planLauncher`）、`src/launch-args.ts`（`LAUNCHER_CDP_PORT`、`LAUNCHER_CDP_ADDRESS`） |
| `autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>` | `src/launcher.ts`（`TUNNEL_HINT`） |
| 抓包文件名 `network.jsonl` / `har.json`、行类型、0700/0600 | `src/recorder.ts`（`NETWORK_JSONL_FILE`、`HAR_FILE`、`DUMP_DIR_MODE`、`DUMP_FILE_MODE`、`kind` 字面量） |
| HAR 1.2 结构（`log.version`/`creator`/`entries`、`_webSocketMessages`） | `src/har.ts` |
| `tools/netdump` CLI（`build`/`summary` 与全部参数） | `tools/netdump/netdump/cli.py`、`tools/netdump/README.md` |
| `endpoints.json` 字段与 `api-over-static-extension` | `tools/netdump/netdump/endpoints.py`、`classify.py`、`har.py` |
| 生成爬虫参数与行为（`httpx.AsyncClient(http2=True)`、Semaphore、退避、断点续跑、代理轮换、0600/0700） | `tools/netdump/netdump/emit.py` |
| 错误码 `WEB_FETCH_PROXY` / `WEB_FETCH_CHALLENGE` / `WEB_PROVIDER_ERROR` | `src/provider.ts` |
| 安装命令 `dsh plugin --profile web add …` | `README.md`（Installation） |

## 附录 B：面向 upstream 的 PR 描述草稿

> 目标仓库：`chendefine/dsh-web-fetch-playwright`（分支 `feat/proxy-capture-pipeline`）。

**Title:** `feat: outbound proxy, DSH-managed persistent browser + launcher, per-fetch CDP capture, offline netdump pipeline`

**What this changes**

1. **Outbound proxy (P0).** Four settings-card fields — `proxyServer`, `proxyBypass`, `proxyUsername`, `proxyPassword` — injected through Playwright's `launch({ proxy })` / `launchPersistentContext({ proxy })` for the browsers this plugin launches, with loopback always merged into the bypass list. An unusable address, or a launch through the proxy that fails, is reported as the provider-specific `WEB_FETCH_PROXY` code naming the proxy (userinfo stripped) and the settings field it came from; the password is masked in the card and never echoed.
2. **DSH-managed persistent browser (P1).** New `backend: managed` plus `headless` / `userDataDir` / `launchArgs`: one `launchPersistentContext` browser kept for the provider's lifetime, every fetch a tab in it (never a new browser, never a closed context), `maxConcurrency` meaning concurrent tabs (default 50). Changing a launch descriptor replaces the browser; a browser the user killed is relaunched.
3. **Local GUI launcher + tunnel topology (P1).** New `dsh-web-fetch-launch` (`bin/launch-browser.mjs`) reads the same settings section the card writes, copies the real profile to a throwaway directory (locks/caches/crash droppings excluded), builds `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=<copy> [--headless=new] [--proxy-server=… --proxy-bypass-list=…] <launchArgs>`, and prints the `autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>` line. `--force` is required to overwrite an existing copy target; `--address` accepts loopback only; every echoed argument is credential-scrubbed.
4. **Per-fetch CDP capture (P2).** `recordNetwork` opens one CDP session on the tab each fetch creates and streams that tab's XHR/Fetch/WebSocket traffic to `<recordDir>/<sessionId>/network.jsonl` (directory 0700, files 0600) while the fetch runs, exporting HAR 1.2 (`har.json`, WebSocket frames under `_webSocketMessages`) on success, on a thrown error, on abort, and on plugin teardown. Extra-info headers/cookies are paired per redirect hop by the hop's own identity, so a hop with no extra event of its own (a cached 301) cannot inherit the next hop's credentials. Recording is best-effort: no capture failure can fail a fetch.
5. **Offline netdump pipeline (P3).** New `tools/netdump/` (Python 3.11 standard library only) turns a JSONL dump or a HAR 1.2 file into `endpoints.json` (method, URL template, headers, query, body shape, call count, score + reasons; static resources filtered; WebSocket channels grouped separately) and a runnable `crawler.py` with the captured headers/cookies embedded, `httpx.AsyncClient(http2=True)`, a real semaphore around the request, exponential backoff with jitter and `Retry-After`, `--proxy`/`--proxies-file` rotation, and resumable JSONL output.
6. **Fixes found on the way.** `maxConcurrency` queue release no longer strands waiters (a 20-fetch burst at 4 slots used to complete 8–10 and time out); the CDP backend no longer refuses proxied fetches (proxy is a launch-time property of a browser started elsewhere — it is explained, not policed); the launcher's profile-copy guard is wired to the CLI; YAML quoting, IPv6 bind normalization, and credential scrubbing in launcher diagnostics were hardened.

**Why**

The plugin could render pages but could not: egress through a proxy, keep a logged-in browser alive on a server, hand a developer a visible browser over a tunnel, capture the API traffic behind a page, or turn that capture into a crawler that runs without a browser or an AI. This change closes that loop end to end.

**How it was verified**

- `pnpm run typecheck`, `pnpm test` (12 files / 323 tests), `pnpm build`, and `python3 -m unittest discover -s tools/netdump/tests -t tools/netdump` (140 tests) all pass **on a clean checkout** (`git archive` of the final commit + `pnpm install --frozen-lockfile`).
- Independent probes (outside the test suite) drove the real `chromium.launch` call through a stub Playwright package to confirm proxy injection, drove `NetworkRecorder` with a synthetic CDP session to confirm 0700/0600 on the real filesystem plus JSONL/HAR shape, and ran the generated `crawler.py` against a stub `httpx` to observe concurrency capping, proxy rotation, 503 retry and resume.
- Real-browser integration cases **self-skip** in this environment (no launchable Chromium); `docs/end-to-end-acceptance-manual.md` lists every step that still needs a real machine.

**Risks / limitations**

- CDP mode cannot inject or verify a proxy (documented in the card, README and error messages); a browser started without `--proxy-server` egresses directly.
- The launcher cannot deliver `proxyUsername`/`proxyPassword` (a Chromium command line has no place for them): it warns, and the docs give auth-free-hop / allowlist / manual-auth workarounds.
- Per-hop extra-info pairing falls back to arrival order when a hop carries no usable identity; the fallback's preconditions and two explicit exceptions are documented in `src/recorder.ts` and the README, and are covered only by synthetic event streams.
- Dumps contain plaintext credentials by design (0700/0600, gitignored); `SECURITY.md` documents the handling rules.

**Disclosure changes**

`package.json`'s `dsh.disclosure.permissions` gains the proxy egress, the DSH-managed persistent profile (`fs:write`) and the launcher's `process:spawn`; `retention` documents the persistent profile and the launcher's profile copy. README (en/zh) gains the proxy chapter, the managed-backend notes, the two-topology manual and the capture chapter; `SECURITY.md` distinguishes the backends and adds credential/profile/threat-model rows.
