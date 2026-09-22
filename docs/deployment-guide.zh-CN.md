# dsh-web-fetch-playwright 部署与使用说明

> **适用版本**：`0.2.7` 基线 + 分支 `feat/proxy-capture-pipeline` 的全部改动（本仓库当前 HEAD）。
> **运行环境**：DSH Web profile（`dsh web`）+ Node.js ≥ 20；离线流水线需 Python 3.11+。
> **阅读约定**：凡是标注「**待真机验证**」的条目，都是在没有可启动浏览器的构建环境里**无法验证**的部分——请勿把本手册当作"已在真实浏览器上验证通过"的结论。判定方法见 [`end-to-end-acceptance-manual.md`](./end-to-end-acceptance-manual.md) §9。

---

## 0. TL;DR：三条最常用路径

**① 服务器无头跑（生产推荐，用托管持久浏览器 + 代理）**

```bash
# 1) 安装插件并重启 dsh web
dsh plugin --profile web add dsh-web-fetch-playwright
# 2) Web UI → 插件设置 → Playwright 网页爬取，填：
#    backend = DSH 托管持久浏览器，headless = 勾选，
#    proxyServer = socks5://127.0.0.1:1080（或 http://…），userDataDir 留空
# 3) 需要登录态的站点：先取消勾选 headless，手动登录一次，再勾回 headless
#    （登录态存在 userDataDir：默认 $DSH_HOME/web-fetch-playwright/profile）
```

**② 本机可视浏览器调试 + 服务器接管（本地 GUI + 反向隧道）**

```bash
# 本机（有 Chrome、有代理）：起浏览器并把 9222 反穿到服务器
dsh-web-fetch-launch --headful --proxy socks5://127.0.0.1:1080
# 按它打印的隧道命令在服务器侧建隧道（或本机执行）：
autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>
# 服务器侧 Web UI：backend = 远端 CDP 地址，cdpEndpoint = 127.0.0.1:9222，
# 勾选「共享浏览器上下文」以复用本机登录态
```

**③ 从抓包生成脱离浏览器与 AI 的爬虫**

```bash
# 抓包开关：Web UI 勾选「录制网络」→ 跑一次 web_fetch（或手动点几下）
# 产物：<cwd>/net-dumps/<sessionId>/{network.jsonl,har.json}
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<sessionId>/har.json -o out
pip install "httpx[http2,socks]"
python3 out/crawler.py --concurrency 32 --proxy socks5://127.0.0.1:1080 -o results.jsonl
```

---

## 1. 能力总览

| 能力 | 开关 / 入口 | 产物 |
|---|---|---|
| 用真实浏览器抓网页（降噪成 Markdown） | 模型工具 `web_fetch` + 设置页后端选择 | `WebFetchResult`（markdown 或原始 HTML） |
| 出站代理 | 设置页 `proxyServer`/`proxyBypass`/`proxyUsername`/`proxyPassword` | 插件启动的浏览器全部走代理 |
| 持久登录态（跨抓取、跨重启） | `backend = managed` + `userDataDir` | `$DSH_HOME/web-fetch-playwright/profile`（或自定义） |
| 可视浏览器 + 隧道接管 | `backend = cdp` + `bin/launch-browser.mjs` 启动器 | 一个带 `--remote-debugging-port` 的本地浏览器 |
| 网络抓包（XHR/Fetch/WS） | 设置页 `recordNetwork` | `net-dumps/<session>/{network.jsonl,har.json}`，0700/0600 |
| 离线提取业务 API + 生成爬虫 | `python3 -m netdump build` | `endpoints.json` + `crawler.py`（内嵌明文凭据） |
| 服务器高并发裸跑 | `python3 crawler.py`（httpx 异步） | 结果 JSONL（可断点续跑） |

```
┌─────────────── DSH (dsh web) ───────────────┐
│  web_fetch 工具 ──► PlaywrightFetchProvider │
│                       ├─ local   : 每次抓取启一个浏览器，抓完即关
│                       ├─ managed : 一个持久浏览器，每次抓取开一个标签页
│                       └─ cdp     : 接管你自己的浏览器（本地 GUI + 隧道）
│  抓包探针（可选）: 每次抓取一条独立 CDP 会话 ──► net-dumps/*.jsonl + har.json
└─────────────────────────────────────────────┘
                     │ 离线（无 AI、无浏览器）
                     ▼
      python3 -m netdump build ──► endpoints.json + crawler.py ──► 服务器裸跑
```

---

## 2. 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| DSH | 有 Web profile，可运行 `dsh web` | 插件的设置卡片在 Web UI 的插件配置区 |
| Node.js | ≥ 20 | 宿主插件与启动器运行环境 |
| pnpm | 仅源码安装 / 开发需要 | `pnpm install` + `pnpm build` |
| Python | 3.11+，**仅标准库** | 离线流水线 `tools/netdump` 零第三方依赖 |
| httpx | `pip install "httpx[http2,socks]"` | **只有生成的爬虫**需要；流水线本身不需要 |
| 浏览器 | local/managed 后端需要（或 `playwright install chromium`） | cdp 后端不需要本机浏览器 |
| 代理 | 可选（`socks5://` / `http://` / `https://`） | 目标站点有 IP 限制时必需 |

---

## 3. 安装部署

### 3.1 从 npm 安装

```bash
dsh plugin --profile web add dsh-web-fetch-playwright
```

### 3.2 从 GitHub 源码安装

```bash
dsh plugin --profile web add github:<your-account>/dsh-web-fetch-playwright
```

pnpm 会执行包的 `prepare`（= `pnpm run build`）。若 pnpm 默认拦截构建脚本，请在 `profiles/web/pnpm-workspace.yaml` 里把该包加入 allowlist。

### 3.3 本地开发

```bash
git clone <repo> && cd dsh-web-fetch-playwright
pnpm install          # 依赖 + 自动构建（prepare → build）
pnpm run typecheck    # tsc --noEmit
pnpm test             # vitest：12 文件 / 323 用例（真实浏览器用例自动跳过）
pnpm build            # tsc 声明 + tsdown（lib/index.js 宿主 ESM、lib/client.js 客户端 CJS）
```

`bin/launch-browser.mjs` 通过 `import('../lib/index.js')` 取插件 API，**因此从源码使用时必须先 `pnpm build`**；发布包自带 `lib/`。

### 3.4 生效与卸载

```bash
dsh plugin --profile web remove dsh-web-fetch-playwright
```

**加装或卸载后都需要重启 `dsh web`**（bundle 层在下次启动时加载）。设置卡片里的改动则是**热生效**的（下一次抓取即按新值执行）。

### 3.5 关键路径一览

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/settings.yaml` → `web-fetch-playwright` 段 | 本插件全部设置（启动器读同一份） |
| `$DSH_HOME/web-fetch-playwright/profile` | `backend=managed` 的默认 profile 目录（**含登录态凭据**） |
| `<cwd>/net-dumps/<sessionId>/` | 抓包产物 `network.jsonl` + `har.json`（目录 0700 / 文件 0600） |
| `<cwd>/net-dumps/` | 默认抓包根目录，本仓库已在 `.gitignore` 中排除 |
| `bin/launch-browser.mjs`（`dsh-web-fetch-launch`） | 本地可视浏览器启动器 |
| `tools/netdump/` | 离线流水线（Python 包） |

---

## 4. 配置页字段全表

位置：Web UI → 插件配置 → **Playwright 网页爬取**。写入 `$DSH_HOME/settings.yaml` 的 `web-fetch-playwright` 段。

| 字段 | 默认值 | 作用与注意 |
|---|---|---|
| `backend` | `local` | `local`（每次抓取启一个浏览器）/ `managed`（DSH 托管持久浏览器，推荐生产）/ `cdp`（接管你自己的浏览器） |
| `playwrightPath` | 空 | local/managed：`playwright` 可执行文件或 Chromium 系浏览器二进制路径；空 = 先 `$PATH`，再回退到内置 `playwright-core` |
| `cdpEndpoint` | 空 → `127.0.0.1:9222` | cdp：`host:port` / `http(s)://` / `ws(s)://`；隧道拓扑下填隧道落点 |
| `shareBrowserContext` | `true` | cdp：勾选 = 每次抓取在远端浏览器的**真实 profile** 里开标签页（复用登录态）；取消 = 每次全新隔离上下文 |
| `denoise` | `true` | Readability + DOMPurify 清洗导航/侧栏/页脚/广告后再转 Markdown；关闭则返回原始 HTML |
| `maxConcurrency` | 空 → local 4 / managed 50 / cdp 50 | 并发上限（1–200）。local 的槽位 = 整个浏览器；managed/cdp 的槽位 = 标签页 |
| `challengeWaitMs` | `15000` | Cloudflare 挑战在该标签页内的有界自然等待（0–60000）；`0` = 关闭（首响应即结果） |
| `challengeRetries` | `1` | 等待窗口耗尽后的同页重导航次数（0–3） |
| `proxyServer` | 空 | **代理开关**：`host:port`（按 http 处理）或 `http(s)/socks4/socks5` URL；空 = 直连 |
| `proxyBypass` | 空 | 绕过列表（逗号分隔）；`127.0.0.1`/`localhost`/`::1` **始终**自动并入 |
| `proxyUsername` / `proxyPassword` | 空 | 仅 HTTP 代理可用；**只作用于插件自己启动的浏览器**，不会下发到 CDP/启动器拓扑（见 §6.4） |
| `headless` | `true` | managed 后端：无头/有头。**后端无关字段**——对 local 与 cdp 只影响启动器命令/预览 |
| `userDataDir` | 空 → `$DSH_HOME/web-fetch-playwright/profile` | managed：持久 profile 目录。**视为凭据目录**，插件从不清理 |
| `launchArgs` | 空 | 额外 Chromium 参数（shell 风格拆分），对插件启动的每个浏览器生效 |
| `recordNetwork` | `false` | **抓包开关**。开启后每次抓取落盘含明文凭据的 dump，见 §7 |
| `recordDir` | 空 → `<cwd>/net-dumps` | dump 根目录（其下按 sessionId 建子目录，basename 固定 `net-dumps`） |
| `captureBodies` | `true` | 是否落盘响应体（默认开，离线流水线需要它才能判定 JSON 业务接口） |
| `maxBodyBytes` | `262144` | 单个响应体截断上限（0–16 MiB）；**`0` = 不限制** |
| `recordAllResources` | `false` | 是否连静态资源也记录。注意 image/font/media 会被抓取自身的资源过滤提前 abort，**打开也只能看到它们的 URL/取消事件**；stylesheet 可完整记录 |

---

## 5. 三种后端部署

### 5.1 `local`（默认，最省事）

```yaml
# $DSH_HOME/settings.yaml（也可只在 UI 里点）
web-fetch-playwright:
  backend: local
  denoise: true
  proxyServer: socks5://127.0.0.1:1080
```

- 每次 `web_fetch` 启动一个浏览器、抓完即关；**登录态不保留**（每次全新上下文）。
- 需要浏览器：`pnpm exec playwright install chromium`，或把 `playwrightPath` 指向系统 Chrome。
- 适合：公开页面批量抓取、无需登录态、无需人工调试。

### 5.2 `managed`（推荐生产：一个有状态浏览器）

```yaml
web-fetch-playwright:
  backend: managed
  headless: true
  userDataDir: /data/dsh-chrome-profile     # 建议显式指定并纳入备份/权限管理
  proxyServer: http://127.0.0.1:7890
  maxConcurrency: 50
```

- DSH 自己 `launchPersistentContext()` 拉起**一个**浏览器并长期复用，每次抓取只开一个标签页（标签页用完即关，浏览器与 profile 永不按抓取关闭）。
- **登录态流程**：把 `headless` 取消勾选 → 在 `web_fetch` 打开目标站点 → 人工登录 → 再把 `headless` 勾回。之后所有抓取都带该登录态，跨 `dsh web` 重启仍有效。
- **改设置会换浏览器**：`userDataDir`/`headless`/`launchArgs`/代理/`playwrightPath` 任一变化，都会在下次抓取时重建浏览器；改 `challengeWaitMs`/`denoise`/`maxConcurrency` 不会。
- 插件卸载或 `dsh web` 退出会关闭浏览器，但**保留 profile 目录**；浏览器被外部杀掉会在下次抓取时自动重启。
- **Chrome 政策提醒**：不要把 `userDataDir` 指向你日常使用的默认 profile（会白屏或直接退出），必须用独立副本目录。**待真机验证**：跨机器打包迁移 profile 时，cookie 受 OS keyring/DPAPI/Keychain 加密，可能无法解密——请在目标机实测。

### 5.3 `cdp`（可视浏览器 + 反向隧道；调试首选）

**本机（有 Chrome、有代理）：**

```bash
dsh-web-fetch-launch --help          # 全部参数
dsh-web-fetch-launch --headful --proxy socks5://127.0.0.1:1080
# 它会把真实 Chrome profile 复制到副本目录、带上 DevTools 端口与代理启动浏览器，
# 并打印隧道命令：
#   autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>
```

启动器要点：

- 默认**拒绝覆盖**已存在的副本目录，需要覆盖时显式加 `--force`；
- `--address` **只接受回环**（`127.0.0.1`/`::1`/`localhost`）——DevTools 端口等于浏览器与 profile 凭据的完全控制权；
- 复制 profile 时排除 `Singleton*` 锁与大缓存（`Cache`/`Code Cache`/`Service Worker`…），不会复制回源；
- 输出 `--dry-run` 可先看命令而不执行；
- **不带代理凭据**（Chromium 命令行无处承载）：需要鉴权时用免鉴权本地代理（如 `ssh -D 1080` 得到 `socks5://127.0.0.1:1080`）、在代理侧做 IP 白名单，或在有头浏览器里手动应答一次。

**服务器侧（跑 DSH）：**

```yaml
web-fetch-playwright:
  backend: cdp
  cdpEndpoint: 127.0.0.1:9222
  shareBrowserContext: true      # 复用本机登录态
  proxyServer: socks5://127.0.0.1:1080   # 仅用于生成启动命令/预览，不影响 fetch
```

- 隧道打通后，`web_fetch` 每次在你的本地浏览器里开一个标签页并关闭；你自己的标签页不受影响（资源过滤与弹窗守卫只装在抓取自己的标签页上）。
- **代理注意**：cdp 模式下插件无法给已在运行的浏览器注入代理；请在启动该浏览器时用 `--proxy-server=` 指定（启动器已按设置页的值生成）。

---

## 6. 代理配置（两条**互相独立**的通道）

### 6.1 通道一：浏览器出站（本插件负责）

| 后端 | 代理如何生效 |
|---|---|
| `local` | 插件 `chromium.launch({ proxy })` 注入，每个一次性浏览器都走代理 |
| `managed` | 插件 `launchPersistentContext({ proxy })` 注入，共享浏览器走代理 |
| `cdp` | **插件无法注入**。必须在启动该浏览器时带 `--proxy-server=…`（用本插件启动器即自动带上设置页的值） |

代理地址归一化：无 scheme 的 `host:port` 按 `http://` 处理；支持 `http(s)://`、`socks4://`、`socks5://`。回环地址始终绕过代理（避免把 DSH 自身的本地流量绕进代理）。

### 6.2 通道二：DSH 自身出站（不由本插件管理）

插件之外的请求（LLM API、联网搜索、MCP over HTTP）走进程级代理策略，由环境变量决定：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export NO_PROXY=127.0.0.1,localhost
```

**Chromium 不读这些变量**，所以两条通道要分别配置，缺一不可。

### 6.3 如何验证代理确实生效

```bash
# 浏览器侧：让 web_fetch 抓一个只显示出口 IP 的页面，比对是否为你代理的出口
# DSH 侧：观察设置页保存后 web_fetch 是否仍能连通（走代理失败会返回明确错误码）
```

代理不可用或地址非法时返回 `WEB_FETCH_PROXY`（消息含代理地址、已剥离 `user:pass@`，绝不含密码明文）。

### 6.4 已知约束：CDP/启动器拓扑不下发代理凭据

HTTP 代理的 `proxyUsername`/`proxyPassword` **只在插件自己启动的浏览器上生效**。在 cdp/启动器拓扑下，启动器会打印一条显式 `warning:`，并建议：

1. 用**免鉴权的本地代理**（`ssh -D 1080 user@host` → `--proxy socks5://127.0.0.1:1080`）；
2. 或在代理侧做 IP 白名单；
3. 或在有头浏览器里手动应答一次鉴权。

---

## 7. 网络抓包（P2）

### 7.1 打开

Web UI 勾选 **录制网络**（`recordNetwork`）。开启后**每次** `web_fetch` 都会在它自己打开的标签页上挂一条独立 CDP 会话并落盘。

> 抓取范围是**本次抓取打开的标签页**（不做全浏览器 attach）。要抓你手动操作的流量，请用 `backend = cdp` + `shareBrowserContext`，让插件在你的浏览器里开标签页。

### 7.2 落盘位置与权限

```
<cwd>/net-dumps/<sessionId>/
  network.jsonl      # 一行一个 JSON 对象，抓取进行中持续追加（可边跑边读）
  har.json           # 抓取结束时导出的 HAR 1.2
```

目录 `0700`、文件 `0600`；目录名唯一（同毫秒也不会共享目录）。文件**含明文 Cookie / Token / Authorization 与响应正文**——`net-dumps/` 已在本仓库 `.gitignore` 中，但请自行确保不提交、不随意外传。

### 7.3 记录内容

`network.jsonl` 的行类型（`kind`）：`session`（头行，含 `fetchUrl`）、`request`、`response`、`responseBody`、`finished`、`failed`、`requestExtra`、`responseExtra`、`websocketCreated`、`websocketFrame`、`websocketClosed`。重定向每一跳独立成对 `response`/`finished`（`301→200` 产出两条记录）。

`requestExtra`/`responseExtra` 是 CDP 的"真正上线的原始头"（Cookie/Set-Cookie 常只在这里），按**跳的身份**（请求侧 `:path` + `:authority`，响应侧状态码）配对。配对范围与三条已文档化的例外见 README（en/zh）的「配对范围与例外」小节。

### 7.4 抓包失败不影响抓取

录制是 best-effort：CDP 错误、目录不可写等只会输出一条 `console.warn`（`dsh-web-fetch-playwright: network capture problem (the fetch is unaffected): …`），**只含错误文本，不含任何 header/body**，且同一种错误只报一次。

### 7.5 清理

dump 不会被自动清理。建议按需删除：

```bash
rm -rf net-dumps/<sessionId>      # 或定期清理整个 net-dumps/
```

---

## 8. 离线流水线 netdump（P3）

零第三方依赖（Python 3.11 标准库），**无 AI、无浏览器、无网络**参与生成。

### 8.1 运行

```bash
# 从本插件 JSONL 或任意 HAR 1.2 生成接口清单 + 爬虫
PYTHONPATH=tools/netdump python3 -m netdump build <capture.jsonl|capture.har> -o netdump-out

# 只看接口排名，不生成文件
PYTHONPATH=tools/netdump python3 -m netdump summary <capture>

# 在 tools/netdump 目录内也可直接：
cd tools/netdump && python3 -m netdump build /path/to/capture -o /path/to/out
```

### 8.2 参数

`build` 与 `summary` 共用筛选参数：

| 参数 | 作用 |
|---|---|
| `--format {auto,har,jsonl}` | 强制输入格式（默认自动嗅探） |
| `--include-static` | 不过滤静态资源（默认过滤 js/css/图片/字体/媒体） |
| `--include-documents` | 保留 document（HTML 页面）请求 |
| `--no-websockets` | 不保留 WebSocket 通道 |
| `--top N` | 只保留评分最高的 N 个接口（0 = 全部） |
| `--quiet` | 不打印总结 |

`build` 独有：`-o/--output-dir`（目录 0700）、`--no-crawler`（只出 `endpoints.json`）、`--crawler-name`、`--endpoints-name`、`--concurrency`、`--timeout`、`--retries`、`--proxy`、`--proxies-file`（后四项作为生成脚本的默认值写进脚本）。

### 8.3 输出物

| 文件 | 内容 |
|---|---|
| `endpoints.json` | 接口清单：`method`、`urlTemplate`、`sampleUrl(s)`、`requestHeaders`、`cookies`、`query`、`bodyShape`、`callCount`、`statuses`、`score`、`scoreFactors`、`rankReason`，外加 `filtered`（被过滤项及原因，可审计）与分组后的 `websockets` |
| `crawler.py` | 可直接裸跑的 httpx 异步爬虫，**内嵌抓到的明文 Headers/Cookie**；文件 0600 |

两份产物均为 `0600`，输出目录 `0700`。

### 8.4 判定与排序（可调）

- 默认丢弃：`image`/`font`/`media`/`stylesheet`/`script` 资源类型、静态扩展名（`.js/.css/.png/.jpg/.svg/.woff…`）、HTML document。
- 保留为业务 API：`xhr`/`fetch`、JSON 响应、带 `Authorization`/`Cookie`、非 GET 且带 body。
- **例外**：URL 以静态扩展名结尾但**确实返回 JSON** 的接口会被保留并标记（弱证据可被 JSON 响应推翻；抓包明确给出的资源类型是强证据，仍会被过滤）。
- 排序按评分（JSON 响应、鉴权头、非 GET、调用频次等），依据写在 `scoreFactors`/`rankReason` 里。

---

## 9. 生成脚本部署到服务器裸跑

### 9.1 依赖

```bash
pip install "httpx[http2,socks]"      # socks5 代理需要 [socks]；http2 需要 h2
```

### 9.2 参数全表（`python3 crawler.py --help`）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--endpoints PATH` | 空 | 改用外部 `endpoints.json`（默认用脚本内嵌的抓包结果） |
| `-o/--out PATH` | `results.jsonl` | 结果 JSONL 路径，**同时是断点续跑的凭据** |
| `--concurrency N` | `8` | 并发请求数（真正的 `asyncio.Semaphore` 闸门） |
| `--timeout S` | `30.0` | 单请求超时（秒） |
| `--retries N` | `3` | 失败重试次数（指数退避 + 抖动，尊重 `Retry-After`） |
| `--proxy URL` | 空 | 代理地址，**可重复**；支持 `http(s)/socks5` |
| `--proxies-file PATH` | 空 | 代理列表文件（每行一个，`#` 注释），按请求轮换 |
| `--dry-run` | off | 只打印计划，不发请求（**不需要 httpx**） |
| `--no-resume` | off | 忽略已有结果，从头重跑 |
| `--expand-templates` | off | 用抓到的路径参数补全 `{id}`/`{uuid}`/`{hash}` |
| `--limit N` | `0` | 最多请求多少个目标（0 = 不限） |
| `--body-bytes N` | `512` | 结果里保留的响应体前缀字节数 |
| `--insecure` | off | 跳过 TLS 证书校验 |

### 9.3 退出码

| 码 | 含义 |
|---|---|
| `0` | 全部成功（或 `--dry-run` 空跑） |
| `1` | 有目标在重试后仍失败 |
| `2` | 配置/输入错误（代理列表文件不存在、缺 httpx 等） |
| `130` | 被 Ctrl-C 中断（已写入的结果保留，重跑自动续跑） |

### 9.4 常驻运行

```bash
# 简单后台
nohup python3 crawler.py --concurrency 64 --proxies-file proxies.txt \
  -o results.jsonl > crawler.log 2>&1 &

# systemd（/etc/systemd/system/netdump-crawler.service）
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

结果按行 `flush + fsync` 落盘，中断留下的半行会在下次启动时自动修复。

### 9.5 代理轮换与断点续跑

```bash
# proxies.txt：每行一个代理，# 开头为注释
socks5://127.0.0.1:1080
http://user:pass@10.0.0.2:3128
```

- 多个代理时按请求轮换；单个代理也可只用 `--proxy`（可重复传多次）。
- 重复运行同一条命令即自动续跑（以 `-o` 的结果文件为准）；要强制重跑加 `--no-resume`。

---

## 10. 运维与调参

| 场景 | 建议 |
|---|---|
| 抓取并发上不去 | local 后端每槽位是一个浏览器，`maxConcurrency` 建议 4–8；managed/cdp 每槽位是一个标签页，可到 50 |
| 频繁 `WEB_FETCH_TIMEOUT` | 提高 `maxConcurrency`（队列等待超时 20s），或减少并发；单次抓取预算 45s |
| Cloudflare 挑战过不去 | 提高 `challengeWaitMs`（上限 60000）与 `challengeRetries`（上限 3）；用带登录态的 `managed`/`cdp` profile 通常更有效 |
| 磁盘增长 | 抓包是主要的增长来源：定期清理 `net-dumps/`；`maxBodyBytes` 调小（如 65536）或 `captureBodies=false` |
| 登录态失效 | `managed`：删除/重建 `userDataDir` 后重新登录；`cdp`：在本地浏览器里重新登录 |
| 想看抓包问题 | stderr 里的 `network capture problem (the fetch is unaffected): …` 即为录制失败提示（不影响抓取） |

---

## 11. 故障排查

| 现象 / 错误码 | 原因 | 处置 |
|---|---|---|
| `WEB_FETCH_PROXY` | 代理地址不可用/非法；或 local/managed 因代理启动失败 | 检查 `proxyServer` 写法与代理连通性；CDP 模式下该字段仅用于生成启动命令 |
| `WEB_FETCH_CHALLENGE` | 站点持续返回 Cloudflare 挑战，浏览器未自然通过 | 提高 `challengeWaitMs`/`challengeRetries`；改用已有通关记录/登录态的 profile |
| `WEB_PROVIDER_ERROR` | 浏览器启动失败、CDP 连不上等 | local/managed：检查 `playwrightPath` 或 `playwright install chromium`；cdp：确认浏览器带了 `--remote-debugging-port` 且隧道可达 |
| `WEB_FETCH_TIMEOUT` | 单次抓取超过 45s，或并发槽位排队超 20s | 提高 `maxConcurrency`；检查代理/目标站是否极慢 |
| `WEB_ABORTED` | 调用方取消 | 无需处置 |
| `WEB_UNSUPPORTED_CONTENT_TYPE` | 返回的不是 HTML/文本/JSON/XML | 该 URL 不适合用本插件抓取 |
| `WEB_INVALID_URL` / `WEB_BLOCKED_URL` | URL 非法、超长、含内嵌凭据 | 修正 URL（凭据请走抓包/请求头，不要放进 URL） |
| 启动器报"目标已存在" | 覆盖保护生效 | 确认后加 `--force`，或换 `--user-data-dir` |
| 启动器报"非回环地址" | `--address` 传了非回环值 | 用默认 `127.0.0.1` + 反向隧道（这是刻意的安全限制） |
| `netdump` 产出接口数为 0 | 全部被判定为静态/文档请求 | 用 `--include-static`/`--include-documents` 重跑看看；或确认抓包时 `captureBodies` 为开 |
| 生成的爬虫报缺 httpx | 未安装依赖 | `pip install "httpx[http2,socks]"`，或先 `--dry-run` |
| 爬虫返回大量 401/403 | 抓包时的 Token/Cookie 已过期 | 重新抓一次包再生成，或把结果与刷新逻辑对接 |

---

## 12. 安全清单

- **凭据三处落地**，都要按凭据管理：设置页的代理用户名/密码（`settings.yaml` 明文）、`managed` 的 `userDataDir` profile、以及抓包 dump（`network.jsonl`/`har.json`，含明文 Cookie/Token/Authorization）。
- dump 目录 `0700` / 文件 `0600`；`net-dumps/` 已在 `.gitignore` 中。**生成的 `crawler.py` 内嵌明文凭据**，其文件权限也是 `0600`——请勿提交到任何仓库。
- 启动器的 DevTools 端口**只绑定回环**；跨机通过 `autossh` 反向隧道暴露，不要把 9222 直接暴露到公网。
- 代理凭据不会出现在任何错误信息里（`user:pass@` 会被剥离，密码永不打印）。
- 本插件不做验证码破解、不做指纹/UA 伪装、不做代理轮换（配置的代理是**单一静态出口**）。Cloudflare 挑战只做"有界自然等待"。
- 包披露见 `package.json` 的 `dsh.disclosure`（permissions / retention 均已覆盖代理出口、持久 profile、启动器与抓包落盘）。

---

## 13. 已知限制与待真机验证项

### 13.1 已文档化的限制（**非已验证行为**）

抓包的 ExtraInfo 按跳配对存在三条已知例外，均同时写在 `src/recorder.ts` 注释与 README（en/zh）中：

1. **无身份回退会错配**：ExtraInfo 缺 `:path`/`:authority`（无可用身份）时回退到按到达序号配对，遇某跳缺此类事件即错配（身份可用时正确，现代 API 常态）。
2. **双方无身份的反转序**：某跳的 extra 晚于更后一跳的 extra 到达，且两者都无可用身份——事件层面本地无法区分。
3. **响应侧仅靠状态码**：连续同状态码跳（如 `http→https→www` 三个 301）且较早跳缺 `responseExtra` 时，较晚跳的 `responseExtra`（及其 `Set-Cookie`）会落到较早跳。让响应侧可靠的是**状态码彼此不同**，而不是跳的顺序。

### 13.2 必须由你在真机上确认的 7 项

1. 真实代理连通性（含需鉴权的 HTTP 代理）；
2. Chrome profile 跨机迁移后的**可解密性**（os keyring/DPAPI/Keychain 绑定）；
3. 真实站点鉴权流量抓取（真实 Token/Cookie 的 XHR/WS）；
4. 真实浏览器三种后端 + Cloudflare 挑战（本环境 15 个集成用例**自跳过**，vitest 记为 passed 但**跳过≠通过**）；
5. `autossh` 反向隧道端到端（服务器侧 CDP 端点可达）；
6. 真实 CDP extra-info 的**到达顺序与省略情形**（上述限制 1–3 的根源）；
7. 生成脚本的真实 httpx 运行（本环境未安装 httpx，测试用等价假模块驱动；`httpx < 0.26` 的 `proxies=` 回退分支未实测）。

逐步判定方法与预期输出见 [`end-to-end-acceptance-manual.md`](./end-to-end-acceptance-manual.md)。
