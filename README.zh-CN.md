# dsh-web-fetch-playwright

[English](./README.md) · [npm](https://www.npmjs.com/package/dsh-web-fetch-playwright) · [GitHub](https://github.com/chendefine/dsh-web-fetch-playwright)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）双端插件：为内置 `web_fetch` 工具提供 **Playwright/CDP 后端**——用真实浏览器渲染网页，经 **Readability + DOMPurify + Turndown + GFM** 降噪（清洗导航栏、侧边栏、页脚、贴片广告）后输出 Markdown。

![npm](https://img.shields.io/npm/v/dsh-web-fetch-playwright) ![license](https://img.shields.io/npm/l/dsh-web-fetch-playwright) ![node](https://img.shields.io/node/v/dsh-web-fetch-playwright) ![CI](https://img.shields.io/github/actions/workflow/status/chendefine/dsh-web-fetch-playwright/ci.yml) ![stars](https://img.shields.io/github/stars/chendefine/dsh-web-fetch-playwright)

## 特性

- **目标（URL → 动作）** —— 一个 JSON 文件提供具名配方：精确或前缀的 URL 匹配，随后是一串有序步骤，每步的后置条件必须成立才会读取文档。最长匹配者胜；两条同样具体的匹配是配置错误；没有命中的 URL 与今天完全一致地抓取。`waitFor` 等的是可见文本出现/消失、URL、固定时长、**一串候选之上的状态**（全部选中 / 全部未选 / 全部可用 / 全部禁用）——这种正是闸门需要的：它的要求住在状态里，任何标签上都没写——或者**某个 URL 的响应到达**（用与目标相同的 match 子句）：这是"数据已经到了"的直接信号，从动作开始那一刻就在听，所以页面加载时就取到的响应不能充当等待的答案。响应是**事件**而不是状态，因此每次等待各认领一次到达——同一个接口等两次就需要两个响应——而运行手里早就有的响应会让它前面那个点击记成 `clicked (unverified)` 而不是被它证明；反过来，点击自己引发的那次到达（点击还在途中就落地，正是等到等待才开始听会漏掉的那一场竞争）既能满足等待，也把点击验成真的。`click` 说的是**意图**加一串**有序候选**（CSS 选择器、可见文本、角色+可访问名），点的是第一个**够得着**的候选——够不够得着（存在、占布局、没被盖住、没禁用）在**点之前**就验过；候选全部落空则整次抓取失败，错误里带第几步、试过哪些候选、当时 URL。标了 `"opensPage": true` 的点击**预期会开一个新标签页**（`target="_blank"`、`window.open`）：整次运行会等它、接着在它上面跑，抓取读的也是**那一页**的文档；没开出来就这一步失败，而不是拿它停留的那一页冒充结果。点击**不替页面承诺效果**：跟在它后面的 `waitFor` 才是判据，没有后续 `waitFor` 确认的点击在摘要里标成 `clicked (unverified)`。`type` 把值写进第一个够得着的输入框，并且**让页面真的收到**（先聚焦、走**原型链上的** value setter、再派发 `input` 与 `change`）；它替换原有内容而不是追加，写完回读一次——页面把改动还原回去时会响亮失败，而不是拿一个空查询框去搜。`check` 满足一个前置条件：按人的做法把控件置入某状态——点控件本身，或点把点击转发给它的 `<label>`——并且**只有在控件事后确实报出该状态时**才算通过；已经在目标状态里的控件不会被再点一次。某步不成立时以 `WEB_FETCH_ACTION` 停止抓取，而不是读取一个目标从未到达的页面；目标跑过后，正文首行是"跑了什么、最终落在哪一页"的一行摘要：
  ```json
  { "targets": [ { "name": "example-search",
      "match": { "kind": "prefix", "url": "https://example.com/search" },
      "actions": [ { "verb": "waitFor", "condition": { "kind": "text", "text": "结果" } },
                   { "verb": "waitFor", "condition": { "kind": "response", "match": { "kind": "prefix", "url": "https://example.com/api/search" } } },
                   { "verb": "check", "candidates": [ { "text": "全部同意" } ] },
                   { "verb": "click", "candidates": [ { "role": "button", "name": "查询" }, { "text": "查询" } ] } ] } ] }
  ```
- **观察模式** —— 返回页面**在要求什么**（控件、标签、状态、计数），而不是它的正文；用于「闸门的要求根本没写在文本里」这类情况。见下方 `observe` 设置。
- **真实浏览器渲染** —— 以用户视角加载页面，SPA 客户端渲染内容也能抓到，而非只有原始 HTML。
- **降噪管线** —— Mozilla Readability 提取正文，DOMPurify 移除布局/噪音标签（导航、侧边栏、页脚、广告、表单），Turndown + GFM 插件按与内置 `tool-web` 渲染器一致的风格转成 Markdown。内联 `data:` 图片（Docusaurus 等构建工具会把截图以 base64 内嵌进 HTML）会被替换为带大小的占位符，如 `![alt](data:image/png;base64,...8.9KB)`，避免 base64 字符流刷屏。
- **三种后端** —— 本地每次抓取启动一次性 Playwright 浏览器；**DSH 托管持久浏览器**（在 `user-data-dir` 上只启动一个浏览器、按标签页复用，headless 由配置决定）；或通过 DevTools 协议（CDP）驱动一个已在运行的浏览器。
- **出站代理** —— 代理地址、绕过列表、用户名、密码只配一次：本插件启动的每个浏览器（**本地**与 **DSH 托管**）都会注入该代理；对 **CDP** 后端，同一组设置会由随包启动器拼成 `--proxy-server` 命令，供你启动那个浏览器时使用。
- **浏览器解析** —— 配置路径 → `$PATH` 上的 `playwright` CLI → 插件自带的 `playwright-core`；CDP 模式完全不需要本地浏览器。
- **共享或隔离会话** —— 每次抓取限定为一个标签页，外加目标步骤开出来并**接管**的标签页（随本次抓取一起关闭）。本地后端每次抓取启动并关闭自己的浏览器；DSH 托管后端与 CDP 后端各保持**一个共享浏览器**，每次抓取只在其里开一个标签页、用完即关。CDP 默认该标签页位于远端浏览器的**真实 profile**（沿用其 cookie、localStorage 与已登录会话，效果类似 `playwright-cli open`）；取消勾选「共享浏览器上下文」则切换为每次抓取全新隔离 context。
- **可视调试用本地启动器** —— `dsh-web-fetch-launch` 复制你的真实 profile、用 `--remote-debugging-port`（并带上配置好的代理）启动你自己的 Chrome，并打印把该端口送到插件宿主机的 `autossh` 反向隧道命令（见 [两种拓扑](#两种拓扑可视浏览器--服务器无头)）。
- **抓包记录** —— 每次抓取一条 CDP 会话，把该标签页的 XHR/Fetch/WebSocket 流量（URL、Method、Headers、载荷、响应正文、WS 帧）在抓取进行中就追加进 JSONL，结束时导出 HAR 1.2；默认关闭，且产物按设计含明文凭据（见[抓包记录](#抓包记录xhr--fetch--websocket)）。
- **热配置** —— 「设置 → 插件 → 插件配置」卡片可随时切换后端、上下文模式、降噪开关与并发数，改动对下一次抓取即时生效，无需重启。
- **预算控制** —— 单次抓取 45s 超时；并发按后端定价（`maxConcurrency`，默认本地 4 个浏览器 / CDP 与 DSH 托管后端 **50 个标签页**；排队的抓取等不到空位会在 20s 内尽快报错并提示重试，而不是一直挂到被工具层中止）；拦截图片/字体/媒体子请求；返回体 10 万字符封顶。
- **Cloudflare 挑战有界等待** —— 导航落到验证中间页（"Just a moment…" 及其多语言同族，通过官方 `cf-mitigated: challenge` 响应头 + 结构性页面标记识别）时，抓取保持**同一标签页与上下文**，等待浏览器自行通过验证：跟踪*最后一次*主 frame 响应（真实页面随后重载进来），并轮询活 DOM 以捕获 SPA 式清除。有界且可配置（`challengeWaitMs`，默认 15s；`0` 恢复旧版首响应行为），附带同标签页有界重试（`challengeRetries`，默认 1）。预算耗尽时以独立的 `WEB_FETCH_CHALLENGE` 错误码明确失败，而不是把中间页当正文返回。同理，同意闸门在接受之后仍未清除时，以 `WEB_FETCH_CONSENT` 明确失败，而不是把闸门页当正文返回。全程不点击、不注入验证码答案、不伪造浏览器状态、不导出或复制 cookie。

## 工作原理

| 半端 | 位置 | 职责 |
| --- | --- | --- |
| 宿主（服务端） | `src/` | 向 `ctx.web` 注册 fetch provider（id `playwright`）；`cordis.patch.yml` 把 web seam 的 `fetchProvider` 固定为本插件，并启用 `web_fetch` 工具（60s 预算）。 |
| 浏览器（客户端） | `src/client/` | 注册 *Playwright 网页爬取* 配置卡片，通过 settings 服务把改动热写入 `$DSH_HOME/settings.yaml`。 |
| 本地启动器 | `bin/launch-browser.mjs` | `dsh-web-fetch-launch`：复制你的 profile、带着 DevTools 端口与配置好的代理启动你的浏览器，并打印隧道命令。 |

```
web_fetch (tool-web)
   └─ ctx.web.fetchProvider = playwright
        ├─ local:   解析（路径 → $PATH → 内置 playwright-core）→ chromium.launch（每次抓取一个浏览器）
        ├─ managed: 解析 → chromium.launchPersistentContext(userDataDir, {headless, proxy, args})
        │            └─ 整个生命周期只启动一个浏览器；每次抓取是它的一个标签页
        ├─ cdp:     connectOverCDP(endpoint) → 一条共享连接；每次抓取一个标签页
        ├─ page.goto → 等待稳定（networkidle，尽力而为）→ page.content()
        ├─ 降噪：剥离非正文子树 → jsdom → 内联 data: 图片改占位符 → Readability（抽错则整页回退）→ DOMPurify → Turndown(GFM)
        └─ Markdown（关闭降噪时返回原始 HTML）
```

## 环境要求

- DSH web profile（`dsh web`），Node.js ≥ 20。
- **本地**后端：装有 Chromium 的 Playwright、Chromium 系浏览器可执行文件，或默认缓存里有浏览器的 `playwright-core`。
- **DSH 托管**后端：与本地后端相同的浏览器解析；由插件在 `user-data-dir` 上启动（默认无头）。
- **CDP** 后端：任意已带 `--remote-debugging-port` 启动的浏览器（如 `chromium --headless --remote-debugging-port=9222`，或用下方随包启动器）。

## 安装

从 npm registry 安装（预构建产物，无需构建授权）：

```sh
dsh plugin --profile web add dsh-web-fetch-playwright
```

从 GitHub 仓库安装（源码型，pnpm 会在安装时跑 `prepare` 构建；若 pnpm 拦截构建脚本，请在 `profiles/web/pnpm-workspace.yaml` 中放行该包）：

```sh
dsh plugin --profile web add github:chendefine/dsh-web-fetch-playwright
```

或通过 DSH 插件市场（设置 → DSH插件市场）一键安装——本仓库带 `dsh-plugin` topic，会被自动收录。

bundle 插件加入 profile 层栈后需**重启 `dsh web`** 生效；卸载用 `dsh plugin --profile web remove dsh-web-fetch-playwright` 后重启。

## 配置项

设置卡片（设置 → 插件 → 插件配置 → *Playwright 网页爬取*）实时编辑 `web-fetch-playwright` 设置段：

![Playwright 网页爬取 plugin configuration card](./playwright-plugin-config.png)

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `local` | radio：*本地 Playwright*（每次抓取一次性浏览器）/ *DSH 托管持久浏览器*（在 `user-data-dir` 上长期保留一个浏览器）/ *远端 CDP 地址*（你自己启动的浏览器），每个选项内嵌各自的填空。 |
| `playwrightPath` | 空 | 本地与托管后端：`playwright` 可执行文件或 Chromium 系浏览器二进制路径；留空按 `$PATH` 查找，再回退到内置 `playwright-core`。 |
| `headless` | `true` | 作用于本插件启动的每个浏览器（本地与 DSH 托管）以及启动器的 `--headless=new`。桌面环境下可取消勾选，手动登录一次。CDP 后端下它只改变启动器命令（卡片预览会同步反映），可在命令行用 `--headful` 覆盖。 |
| `userDataDir` | 空 | 托管后端：持久 profile 目录——登录态、cookie、扩展都在这里；留空 = `$DSH_HOME/web-fetch-playwright/profile`。**该目录属于凭据数据，插件永不清理。** |
| `launchArgs` | 空 | 追加到本插件启动的每个浏览器以及启动器命令的额外 Chromium 参数，如 `--lang=zh-CN --disable-gpu`；按空格拆分，含空格的值请加引号。CDP 后端下只有启动器命令会带上它们，可在命令行用 `--launch-args` 覆盖。 |
| `cdpEndpoint` | `127.0.0.1:9222` | 远端后端：`host:port`、`http(s)://…` 或 `ws(s)://…`。 |
| `shareBrowserContext` | `true` | 仅 CDP 后端。**勾选（profile 模式）**：每次抓取是远端浏览器默认 context（真实 profile）里的一个标签页，cookie/localStorage 与之互通、已登录会话直接生效，抓取结束只关标签页；**取消勾选（隔离模式）**：每次抓取使用全新隐身式 context，互不共享。托管后端始终使用自己的持久 profile；本地后端忽略此字段。 |
| `proxyServer` | 空 | 出站代理：`host:port` 或 `http(s)/socks4/socks5` 地址；留空 = 直连。**本地/托管**：注入所启动的浏览器；**CDP**：插件不生效（见[出站代理](#出站代理)），只用于生成启动器的 `--proxy-server`。 |
| `proxyBypass` | 空 | 逗号分隔的绕过主机；回环地址（`127.0.0.1`、`localhost`、`::1`）始终并入；启动器会把它改写成 Chromium 的 `;` 分隔形式。 |
| `proxyUsername` / `proxyPassword` | 空 | 供**本插件自己启动的浏览器**（本地与 DSH 托管）以 `Proxy-Authorization` 发送的代理凭据；与其他设置一同保存，密码永远不会出现在错误信息里（卡片以掩码显示）。**CDP/启动器拓扑下不会下发**——Chromium 命令行无处承载，启动器会改为给出警告（见[两种拓扑](#两种拓扑可视浏览器--服务器无头)）。 |
| `denoise` | `true` | 是否启用降噪；关闭时返回整页渲染 HTML，交由工具层转换。 |
| `targetsFile` | *（空）* | 指向一个 JSON 文件的路径：为"读取文档之前需要先做动作"的 URL 提供具名配方。填显式路径（插件拿到的是进程工作目录，不是本会话的工作区）。请放进仓库以便评审与 diff，且**不要写入凭据**。形态见上方特性列表。 |
| `observe` | `false` | 返回页面的**可操作状态**而不是正文：可触及控件的标签与状态（`checked`/`unchecked`、`disabled`、`covered`、以标签形式可见）、完整计数、可见文本开头。用于面对陌生页面——没有任何标签会写出来的前置条件，往往就是一个计数——它是模式而非每次调用的选项，因为抓取入口只带一个 URL。 |
| `dismissConsent` | `false` | 页面稳定后、读取之前，点击已知同意管理器的"全部接受"控件（OneTrust、TrustArc、Cookiebot、Didomi、Osano、Usercentrics、CookieYes、Complianz、Iubenda、Klaro、Google Funding Choices、Quantcast）；这些都没命中时，退而点击任何位于同意类界面里的"全部接受 / accept all"控件（判据：位于对话框、同意命名的祖先容器、固定/粘性浮层之中；若是整页同意插页（接受控件以上三者都没有），则该页本身够短且 URL/标题命中同意语境即可）。默认关闭：这次点击会在抓取所用的 profile 里记录**你的**同意（CDP 与托管后端下就是你的真实 profile），同意 cookie 会留在那里。尽力而为：没有横幅、后端不支持 `evaluate`、点击抛错，都不会影响抓取结果。 |
| `maxConcurrency` | *（自动）* | 同时渲染的页面上限（1–200）。留空按后端取默认：本地 **4**（每个槽位启动一个浏览器）/ CDP 与 DSH 托管后端 **50 个标签页**（浏览器已在运行，一个并发名额就是一个标签页）。超出的请求短暂排队；20s 内等不到空位则以 `WEB_FETCH_TIMEOUT` 尽快失败并提示重试或调大该值，而不是一直挂起直到工具层预算中止。 |
| `challengeWaitMs` | `15000` | Cloudflare 挑战的**有界**自然等待上限（毫秒，0–60000），在同一标签页内等待浏览器自行通过验证。`0` 关闭整条挑战处理链路——直接返回首次响应（0.2.5 之前的旧行为）。 |
| `challengeRetries` | `1` | 一个等待窗口耗尽后的**同标签页**重新导航次数（0–3）；浏览器已拿到的通关 cookie 留在上下文里供重试使用。总耗时始终受 45s 单次抓取预算约束。 |
| `recordNetwork` | `false` | 记录每次抓取的 XHR/Fetch/WebSocket 流量，产出 JSONL + HAR 1.2。默认关闭：产物含明文凭据。 |
| `recordDir` | 空 | 抓包基目录；每次抓包在其下新建独立的 `<sessionId>` 子目录。留空 = `<工作目录>/net-dumps`（已 gitignore；目录 `0700`、文件 `0600`）。 |
| `captureBodies` | `true` | 通过 `Network.getResponseBody` 读取响应正文。关闭则只记 URL、状态、Headers 与请求载荷。 |
| `maxBodyBytes` | `262144` | 单条正文 / WebSocket 帧的存储上限（0–16 MiB）。被截断的标记 `bodyTruncated` 并保留原始 `bodyBytes`。 |
| `recordAllResources` | `false` | 同时记录 image/font/media/stylesheet（默认丢弃：对提取业务 API 是噪音）。 |

本地后端解析顺序：

1. 配置的路径（自动判别 Playwright CLI / 浏览器二进制）；
2. `$PATH` 上的 `playwright`（其包自带该安装的浏览器注册表）；
3. 插件内置的 `playwright-core`——需要 `PLAYWRIGHT_BROWSERS_PATH` 或默认缓存里有浏览器，否则报错会提示 `playwright install chromium`。

> **Windows 说明** —— `$PATH` 已按平台分隔符（`;`）扫描，但 npm/pnpm 全局安装暴露的 `playwright` 是 `.cmd`/`.ps1` 垫片，从垫片位置向上找不到包根，自动发现可能仍落在第 3 步（内置 core）。要使用指定安装的浏览器注册表，请把 `playwrightPath` 显式指向 `playwright` 包目录或浏览器二进制。

CDP 模式不需要本地浏览器：插件在生命周期内对远端浏览器保持**一条共享连接**（连接断开自动重连，地址改动后自动换连），每次抓取只租用远端浏览器里的一个标签页，抓取结束即关闭。因此并发数按"标签页"计，默认也更高（50）。插件卸载时断开共享连接（绝不会关闭远端浏览器本身）。

### DSH 托管持久浏览器

`backend: managed` 把浏览器交给 DSH 自己管：插件调用一次 `launchPersistentContext(userDataDir, { headless, proxy, args })`，并在整个生命周期内保留这一个浏览器，所以每次抓取都是**同一个**浏览器、**同一个** profile 目录里的一个标签页。登录态、cookie、localStorage、扩展会跨抓取、跨 `dsh web` 重启、跨插件重载保留——在桌面环境取消勾选「无头运行」手动登录一次，再勾回去即可用于生产。

- **并发即标签页。** 浏览器已在运行，因此 `maxConcurrency`（默认 50）表示同时可开多少标签页，与 CDP 后端一致。
- **改启动设置会换浏览器。** 共享浏览器由启动描述符做键（profile 目录、headless、额外参数、代理、Playwright 路径）：改动其中任意一项，下一次抓取会关闭旧浏览器并启动新的；改 `challengeWaitMs`、`denoise`、`maxConcurrency` 不会。
- **卸载即关闭。** 卸载插件（或 `dsh web` 退出）会关闭浏览器，profile 目录留在磁盘上；若浏览器被用户手动关掉（`isClosed()`），下一次抓取会自动重启它。
- **profile 需要你自行保护。** 登录会话产生的缓存与凭据都在该目录里；请把 `userDataDir` 指向你愿意按凭据对待的路径，插件不会清理、导出或复制它。删除它即登出。

### 出站代理

卡片里的代理字段是「一组设置、两种用法」，因为代理本质上属于浏览器**进程**：

| 后端 | 代理设置的作用 |
| --- | --- |
| `local` | 通过 Playwright 的 `launch({ proxy })` 注入：每个一次性浏览器都走该代理，并自动并入回环例外。 |
| `managed` | 同样通过 `launchPersistentContext({ proxy })` 注入到那个持久浏览器上。 |
| `cdp` | **不注入、也不校验。** 浏览器是别人启动的，代理是它自身的启动期属性：必须用它启动时的 `--proxy-server=…` 指定（下方启动器会用同一组设置替你拼好）。插件不会因此拒绝抓取；若手启时漏了该参数，流量就直连。 |

通用细节：

- `proxyServer` 支持 `host:port`（自动补成 `http://host:port`）或显式的 `http://`、`https://`、`socks4://`、`socks5://`；留空即直连，不可用的值会让抓取以 provider 专属错误码 `WEB_FETCH_PROXY` 失败。
- 回环地址 `127.0.0.1`、`localhost`、`::1` 始终绕过（`PROXY_LOOPBACK_BYPASS`），并与 `proxyBypass` 里填的内容合并。
- 凭据走 Playwright 的 `proxy.username` / `proxy.password`，与其他设置一起保存；`WEB_FETCH_PROXY` 消息只会给出代理地址（已剥离 userinfo）与解析来源，**绝不打印密码**。
- 启动器输出的是 Chromium 的写法：`--proxy-server=<规范化的地址>` 加 `--proxy-bypass-list=<a;b;c>`（分号分隔，含回环例外）。
- 代理不可达时，本地/托管后端会以 `WEB_FETCH_PROXY` 报出启动失败，消息里写明是哪个代理、来自哪个设置项。

### 两种拓扑（可视浏览器 ↔ 服务器无头）

**（a）纯服务器、无头** —— `backend: managed`：只需把 `headless` 勾上、`userDataDir` 指向持久路径（如 `/data/chrome-dsh-profile`），浏览器由 DSH 自己启动，没有别的要跑。需要手动登录时，在桌面环境临时取消勾选 `headless` 登录一次再勾回。

**（b）浏览器在你本机可见、插件在服务器** —— 浏览器跑在你**看得见**的地方，插件通过反向隧道以 CDP 接管：

```sh
# 1. 在你本机：复制真实 profile，用 9222 启动有头 Chrome
dsh-web-fetch-launch --dry-run              # 只打印命令（含代理参数），不启动
dsh-web-fetch-launch                        # 或直接执行：复制 profile 并启动浏览器
dsh-web-fetch-launch --headful --profile "$HOME/.config/google-chrome"

# 2. 把该回环端口送到插件所在的服务器
autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>

# 3. 在插件宿主机：设置卡片 → 后端选「远端 CDP 地址」，cdpEndpoint 填 127.0.0.1:9222
```

启动器即 `bin/launch-browser.mjs`，对外命令名 `dsh-web-fetch-launch`；它读取卡片写入的同一个 `web-fetch-playwright` 设置段（`$DSH_HOME/settings.yaml`），所以你在 UI 里配的代理、`headless`、`userDataDir`、`launchArgs` 就是它用的值。命令行参数优先于设置（`--proxy`、`--profile`、`--user-data-dir`、`--headless`/`--headful`、`--launch-args`、`--port`、`--settings`），`--no-copy` 跳过 profile 复制，`--force` 覆盖已存在的复制目标（不传时，若目标目录已存在会明确拒绝），`--dry-run` 只打印。

两点必须在信任该浏览器之前知道：

- **这里不会下发 `proxyUsername`/`proxyPassword`。** Chromium 命令行无处承载代理凭据，启动器也绝不会把它们拼进 `--proxy-server`——检测到设置卡片里填了它们时会打印明确警告。若代理要求鉴权，请在它前面放一跳免鉴权入口（`ssh -D 1080 user@host`，再用 `--proxy socks5://127.0.0.1:1080`，或在代理侧做 IP 白名单），或先以有头方式启动并手动应答一次鉴权。CDP 后端整体也是同一限制：对不是本插件启动的浏览器，插件既无法注入也无法校验代理。
- **DevTools 端口只留在回环。** `--address` 只接受 `127.0.0.1`、`127.0.0.0/8` 其余地址、`::1`、`localhost`，其他值直接报错并说明原因（该端口等于浏览器的完全控制权 **加上** profile 里的登录凭据）。带方括号的 IPv6 写法（`[::1]`）会被接受并归一化为 Chromium 需要的裸 `::1`——绝不会把方括号形式传下去。远程访问交给反向隧道。

报错与用法回显的是你的参数，而不是你的凭据：任何内容进入 stdout/stderr 之前，启动器都会把每个 token 里的 `user:pass@` userinfo 剥离（未知 flag、`--port`、`--address` 以及规划失败路径一律如此），所以把 `--proxyy=http://user:secret@proxy:1080` 拼错时只会打印 `--proxyy=http://proxy:1080`。

profile 复制是**刻意不完整**的：`SingletonLock`/`SingletonCookie`/`SingletonSocket`（在运行浏览器的锁）、大缓存（`Cache`、`Code Cache`、`GPUCache`、`Service Worker`、`Media Cache`、各类 shader cache）与崩溃/遥测残留都会被排除；cookie、`Login Data`、`Local Storage`、`Preferences`、扩展会保留。目标目录上存在 `SingletonLock`（说明有浏览器正在用它）时会拒绝复制；目标目录**已存在**时除非显式传 `--force`，否则一律拒绝——复制目标是真实 profile 数据的快照，静默合并进去从来不是本意。在源码检出中使用需先 `pnpm build`（`bin/` 要 import 构建产物）；npm 安装包自带 `lib/`。

`autossh -R 9222:127.0.0.1:9222` 把远端端口绑到客户端回环——请保持这样（启动器已把 DevTools 绑在 `127.0.0.1`），并把该隧道视为「对你已登录浏览器的访问权限」。插件的安全立场不变：不做 SSRF 防护，因此能调用 `web_fetch` 的一方就能访问那个浏览器能访问的一切。

### CDP 上下文模式（是否共享浏览器 profile）

「共享浏览器上下文」**勾选**（默认，profile 模式）时，每次抓取是远端浏览器默认 context——真实 profile——里的一个标签页：cookie 与 localStorage 双向互通，浏览器里已登录的站点会以登录态被抓取，和你手动开标签页一样。共享 context 永不关闭；资源过滤与弹窗守卫只挂在本次抓取自己的标签页上，不会干扰你人工打开的其他标签页。**取消勾选**（隔离模式）时，每次抓取使用全新隐身式 context——匿名读取，什么都不保留。

**profile 模式风险须知** —— 它把 `web_fetch` 从"匿名读网页"升级为"以浏览器登录身份行动"：

- 被抓取的恶意页面若诱导 agent 请求 GET 型状态变更 URL（登出、改设置、API 操作），请求会自动携带会话 cookie。
- 同一站点的并发抓取共享一个 cookie jar，一方的登出 / `Set-Cookie` 会影响另一方。
- 输出开始依赖浏览器历史（A/B 分桶、语言偏好）；远端 profile 的站点数据只增不减，插件不做清理。

登录态持久的前提是 user-data-dir 持久化。有头（推荐，手动登录一次）：

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/chrome-dsh-profile"
```

无头服务器（先在有头环境预置登录态）：`chromium --headless=new --remote-debugging-port=9222 --user-data-dir=/data/chrome-dsh-profile`。**不要**叠加 `--incognito` 或一次性 user-data-dir——都会让 profile 模式失效。设计依据与已核实的 playwright-core 源码事实见 [`docs/context-mode-profile.md`](./docs/context-mode-profile.md)。

### 抓包记录（XHR / Fetch / WebSocket）

打开 `recordNetwork` 后，每次抓取都在**它自己刚打开的那个标签页**上挂一条 CDP 会话，静默记录该标签页的流量：请求 URL、Method、Headers、请求载荷，响应状态/Headers/正文，以及 WebSocket 建连、帧与关闭。除此之外什么都不看——不做 `Target.setAutoAttach`、不碰共享浏览器里的其它标签页（profile 模式也一样）：抓取开了哪个标签页，就只记录哪个。

每次抓包产出两个文件，位于 `<recordDir>/<sessionId>/`（默认 `<工作目录>/net-dumps/<sessionId>`）：

| 文件 | 内容 |
| --- | --- |
| `network.jsonl` | 每行一个 JSON 对象，**抓取进行中持续追加**——先是 `session` 头行，然后每个请求依次 `request` / `response` / `responseBody` / `finished`（失败则 `failed`）、承载权威 header+cookie 集、并按「跳」的**身份**配对（请求侧用 `:path` + `:authority`，响应侧用状态码）的 `requestExtra` / `responseExtra` 行（重定向跳会单独定稿为一对 `response`/`finished`，因此 301→200 产出两条记录；即使某一跳**根本没有自己的 ExtraInfo 事件**（缓存命中的 301，CDP 明确允许），或 ExtraInfo 早于它那一跳的基础事件到达，每跳也各自保有本跳的 cookie/header。配对范围与例外见下文），以及 `websocketCreated` / `websocketFrame` / `websocketClosed`。可边跑边读、中断也不丢，也是离线流水线的输入格式。单个坏 URL 或坏记录只会降级为那一条：导出绝不会丢掉整份文档。 |
| `har.json` | 抓取结束时导出的 HAR 1.2——正常结束、抛错、被 abort 三条路径都会写（插件卸载也会 flush）。WebSocket 流量按 Chrome 的 `_webSocketMessages` 扩展挂在 entry 上。 |

> **抓包产物含明文凭据。** `Cookie`、`Set-Cookie`、`Authorization`、token 与请求/响应正文都按原样保存——这是刻意设计，因为「复现已登录会话」正是它的用途——所以请把 dump 目录当作密码文件对待。默认值做了防护：目录 `0700`、文件 `0600`，且 `net-dumps/` 已在本仓库 `.gitignore` 中。但一旦你把目录复制出去或提交，这些防护就失效了：切勿外发、发布或作为附件分享。

配置项：`recordNetwork`（默认关闭——因为抓包会把凭据写到磁盘，所以是显式开关）、`recordDir`（基目录；每次抓包用**非递归 mkdir** 在其下独占一个 `<sessionId>` 子目录，两次抓包绝不可能共用一份 dump）、`captureBodies`（通过 `getResponseBody` 读取响应正文）、`maxBodyBytes`（单条正文/帧上限，0–16 MiB，**0 = 不限制（no cap）**；被截断的会标记 `bodyTruncated` 并保留原始 `bodyBytes`）、`recordAllResources`（同时记录 image/font/media/stylesheet，默认丢弃：对提取业务 API 是噪音且量最大；注意抓取自身的资源过滤会**提前 abort** image/font/media 子请求，打开该开关只能看到它们的 URL 与取消事件，而 stylesheet 不会被拦截、可完整记录）。设置卡片就在开关旁给出明文凭据警告。

**按跳配对的范围说明**（与 `src/recorder.ts` 中的说明一致）。以下顺序全部由测试套件用合成 CDP 事件流覆盖，**不是**真机验证（本环境没有可启动的 Chromium）：

- 每跳都有自己的 ExtraInfo 事件，且与它自己 base 事件的到达顺序任意；
- 某一跳**完全没有** ExtraInfo 事件（缓存命中的 301）——下一跳的凭据仍然落在下一跳；
- 响应侧 ExtraInfo 早于该跳的 `responseReceived` 到达（先挂起，等该跳状态已知后再归位）。

回退规则及其局限：当某条 extra 没有可用的身份（缺 `:path`/`:authority`，或缺状态码——例如最小实现或合成事件），或有多跳同样匹配时，回退到「到达序号」（该 requestId 的第 N 条 extra 属于第 N 跳，即 Playwright 自身使用的规则）。这只在「该 requestId 之前每一跳都产出了同类 extra」时成立。

显式例外（未覆盖）：某跳的 extra **晚于更后一跳的 extra** 到达、且两者都没有可用身份时——事件层面本地无法区分；状态码始终匹配不上任何一跳的响应 extra，它会保持未认领并在短暂保持窗口后以 `unclaimed: true` 落盘；以及响应侧只有状态码这一个身份，因此**连续多跳状态码相同**（如 `http→https→www` 连续 301）时会错配：当较早的那一跳没有自己的 responseExtra 时，较晚跳的 responseExtra——以及它携带的 `Set-Cookie`——会被归到较早跳。让响应侧可靠的是状态码彼此不同，而不是跳的顺序。上述范围内的所有情形，`har.json` 与 `network.jsonl` 两个产物结论一致（项目检查里会把两者都喂给 `tools/netdump`）。

录制全程 **best-effort**：CDP 抖动、正文已被回收、目录不可写、事件格式异常——一律吞掉（记录在 recorder report 里），**绝不会让 `web_fetch` 失败**，也不会让页面内容被吞。

### 从抓包到爬虫（离线、无 AI）

`tools/netdump/`（仅依赖 Python 3.11 标准库）把抓包转成业务 API 清单与可直接运行的 `httpx` 爬虫——内嵌抓到的 Headers 与 Cookie、过滤静态资源、列出 WebSocket 通道：

```sh
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<session>/network.jsonl -o netdump-out
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<session>/har.json        -o netdump-out   # HAR 同样支持
PYTHONPATH=tools/netdump python3 -m netdump summary net-dumps/<session>/network.jsonl                   # 看抓到了什么
```

### Cloudflare 挑战处理（有界自然等待）

部分严格站点会在返回真实页面前先给一个 Cloudflare 验证中间页。真实浏览器通常几秒内就能**自行**通过验证；但只看第一次响应的抓取会把中间页当成正文返回（0.2.5 之前的旧行为；把 `challengeWaitMs` 设为 `0` 可随时复现，或在仓库检出、执行 `pnpm build` 后运行 `node scripts/challenge-demo.mjs` 看本地模拟站点的前后对比、`node scripts/challenge-online.mjs <url>` 对真实站点做在线对比）。

开启等待（默认）后的流程：

1. **识别** —— 响应带 `cf-mitigated: challenge`（Cloudflare 官方文档注明所有挑战页类型都带此头），或 403/503 且 `server: cloudflare` 的 HTML 文档，或本地化的中间页本身（"Just a moment…" / "请稍候…" / "Минутку…" 等 title 家族，以及结构性标记：`/cdn-cgi/challenge-platform/` 脚本、`#challenge-*` 元素、`cf-chl-widget-` 框架、`window._cf_chl_opt`）。内容级标记只是**兜底层**，且仅对"挑战兼容"的响应（403/429/503 或来自 Cloudflare 边缘——`server: cloudflare` / `cf-ray`）运行——因为中间页从不会以普通 200 返回，所以正文里引用了挑战文案的普通文章绝不可能被误判。Cloudflare Bot Management 的被动 JavaScript-Detections 遥测（`/cdn-cgi/challenge-platform/scripts/jsd/`，会注入受保护站点的每一个**正常**页面——如 openrouter.ai）在前缀扫描前被显式中和，因此带真实内容的 200 正常页绝不会被误判。硬封锁页（"Sorry, you have been blocked"）单独分类并立即失败——等待无法解除。
2. **同标签页、同上下文的有界等待** —— 每 500ms 轮询活 DOM，等浏览器跑完自己的验证；同时跟踪**最后一次主 frame 导航响应**，所以重载进来的真实文档的状态码和响应头才是最终上报的。SPA 式清除（无导航、纯内容替换）由同一个 DOM 探测捕获。
3. **有界重试** —— 窗口耗尽后，同一标签页默认再导航一次（`challengeRetries`），上下文里已有的通关 cookie 继续生效。
4. **明确失败** —— 返回独立的 `WEB_FETCH_CHALLENGE` 错误码（web seam 的 `code` 是开放字符串，允许 provider 专属码），消息中写明站点、等待预算与最后一次挑战响应的状态。

安全边界（刻意为之）：不点击 Turnstile、不解验证码、不注入 token、不伪装指纹/UA、不做代理**轮换**（配置的代理是单一的静态出口，绝不会按请求切换以绕过挑战）、不导出 cookie——隔离模式下本次抓取挣到的通关态随其 context 一起销毁；profile 模式下它留在远端浏览器自己的 profile 里，插件从不复制或清理。等待始终受 `challengeWaitMs` 与 45s 单次抓取预算双重约束，永不无限阻塞。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run（无浏览器时浏览器集成用例自动跳过）
pnpm build       # tsc 声明 + tsdown（宿主 ESM + 客户端 module-registration bundle）
```

仓库结构：

```
src/
├── index.ts               # 宿主入口：注册 provider 与设置段
├── config.ts              # schemastery schema、CDP/代理归一化、托管启动描述符
├── provider.ts            # WebFetchProvider：导航、超时、信号量、截断
├── browser-pool.ts        # 共享浏览器池（租约/存活/替换），两个共享型后端共用
├── cdp-pool.ts            # 该池的 CDP 实例化
├── recorder.ts            # P2 抓包：每 fetch 一条 CDP 会话 → JSONL + HAR（best-effort）
├── har.ts                 # 抓包结果的 HAR 1.2 组装（纯函数）
├── launcher.ts            # 本地启动器逻辑：设置段读取、命令拼装、profile 复制
├── launch-args.ts         # 无依赖的参数拼装（宿主 + 卡片预览 + 启动器共用）
├── markdown.ts            # 降噪管线（Readability + DOMPurify + Turndown/GFM）
├── playwright-resolve.ts  # 本地后端发现（路径 / $PATH / 内置 core）
├── types.ts               # Playwright 结构化类型（运行时模块动态发现）
└── client/                # 浏览器半端：设置卡片、表单模型、多语言、命令预览
bin/
└── launch-browser.mjs     # dsh-web-fetch-launch（见上方拓扑手册）
tests/                     # 单元 + provider + 浏览器集成（可自跳过）
```

开发与发布流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)，安全模型与漏洞报告见 [SECURITY.md](./SECURITY.md)。

## 安全边界

与内置 HTTP provider 同立场：**未实现 SSRF/私网防护**——浏览器能访问的目标，本 provider 就能抓。CDP 地址与本地启动器都由设置页配置，不做回环限制，请在可信环境暴露设置页。抓取仅在本地渲染，除目标页面自身外不会向任何地方发送数据——但有两点例外：

- **配置的代理是第二个目的地。** 一旦设置 `proxyServer`，浏览器的请求（含目标 URL 与请求头）都会经过该跳，该代理的运营者能看到它们；`PROXY_LOOPBACK_BYPASS` 只让回环流量不走代理，其余不做过滤。
- **带 profile 的后端会以你的登录身份行动。** DSH 托管后端用其 `userDataDir` 里的登录态抓取，CDP profile 模式（默认）用远端浏览器的真实 profile；被诱导的状态变更请求会带上这些 cookie，同一 jar 下某次抓取的登出/`Set-Cookie` 也会影响其他抓取。按后端区分的威胁模型见 [SECURITY.md](./SECURITY.md)。

## 许可证

[MIT](./LICENSE) © 2026 chendefine
