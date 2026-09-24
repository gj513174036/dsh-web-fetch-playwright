# 使用手册：按场景选路（dsh-web-fetch-playwright）

这份文档回答一个问题：**"我想干的那件事，到底该动哪个开关、跑哪条命令？"**
它按**场景**组织，不按代码模块。想读设计取舍、字段语义的完整清单，见文末的[文档地图](#11-文档地图)。

> 约定：下文里的 `web_fetch(...)` 指让 AI 调用的抓取工具；命令行一律假定你在**仓库根目录**。
> 本插件的一切能力最终都落在两个地方：**设置卡片**（设置 → 插件 → 插件配置 → *Playwright 网页爬取*）与**仓库里的文件**（配方、抓包、生成的爬虫）。

---

## 0. 先看这张表：你的目标 → 你该走哪条路

| 你的目标 | 走哪条路 | 关键设置 | 一句话理由 |
| --- | --- | --- | --- |
| 把某个页面的正文拿回来（含 SPA） | [场景 A](#2-场景-a把页面正文拿回来) | 默认即可 | 渲染 + 降噪就是默认行为 |
| 面对陌生站点，先判断"这站难在哪" | [场景 B](#3-场景-b先给站点分流) | 默认 + `node tools/probe/probe-site.mjs` | 判词只作分流线索，省得白写配方 |
| 要**长期批量**取数据，站点有干净接口 | [场景 C](#4-场景-c接口优先抓包--离线爬虫) | `recordNetwork: true` | 抓到接口就能生成**无浏览器、无 AI**的爬虫 |
| 数据必须**先在页面上操作几步**才出现（同意闸门、表单查询、结果在新标签页） | [场景 D](#5-场景-d页面要先操作才出数据) | `targetsFile`（+ 先 `observe: true` 看一眼） | 把"发现"固化成仓库里的配方，之后确定性重放 |
| 站点要登录 / 要你本机的网络环境 | [场景 E](#6-场景-e本地可视浏览器隧道) | `backend: cdp` + 启动器 | 复用你本机真实 profile 的登录态 |
| 服务器上长期跑、无人值守 | [场景 F](#7-场景-f服务器无头生产) | `backend: managed`（或 `local`） | 浏览器归 DSH 自己管，profile 长期保留 |
| 站点前面有 Cloudflare 挑战页 | [场景 G](#8-场景-gcloudflare-挑战页) | `challengeWaitMs`（默认已开） | 等浏览器自己过验证，而不是把中间页当正文 |

三条主线，一句话各说一遍：

1. **拿正文** —— 默认行为，什么都不用配。
2. **拿接口** —— 打开抓包，用 `netdump` 把抓包变成接口清单 + 离线爬虫（服务器上只跑 Python）。
3. **先操作** —— 用 `observe` 读页面 → 写配方（`targetsFile`）→ 确定性重放，每步回读验证，失败响亮。

**决策顺序**：先问"接口优先"（场景 C），因为能拿到干净接口的站点**根本不需要**动作模型；接口挖不到、页面又必须操作，才进场景 D。

---

## 1. 五分钟上手

```sh
# 1) 安装（三选一，详见 docs/deployment-guide.zh-CN.md §2.1）
dsh plugin --profile web add dsh-web-fetch-playwright

# 2) 重启 dsh web ——  包更新不会被热加载，这一步不能省
```

然后让 AI 抓一个普通页面：

```
web_fetch("https://example.com/")
```

成功即通。接下来按 §0 的表选路即可；卡住了直接跳[§9 排查表](#9-失败排查从症状到动作)。

> **首次必读的一个坑**：`local` / `managed` 的含义是**插件自己把浏览器进程拉起来**，所以浏览器必须和插件在**同一台机器**上。浏览器在别的机器/容器里 → 只能走 `cdp`（场景 E）。

---

## 2. 场景 A：把页面正文拿回来

**要做什么**：什么都不用配。默认 `denoise: true` 会走"剥非正文子树 → Readability → DOMPurify → Markdown"。

**你会拿到**：Markdown 正文，前面**可能**有一行动作摘要（只有配方跑过才有，见场景 D）。

**什么时候要动它**

| 情况 | 怎么调 |
| --- | --- |
| 要原始渲染 HTML（自己解析） | `denoise: false` |
| 页面是 SPA，正文晚到 | 默认会等 `networkidle` 再读；仍不够就上配方里的 `waitFor`（场景 D） |
| 页面内容被 cookie 横幅顶掉 | `dismissConsent: true`（在抓取所用 profile 里记录**你的**同意，见 README 的说明） |
| 想知道"这页能点什么、哪些控件已勾选" | `observe: true`（这是**模式**，不是每次调用的选项——抓取入口只带一个 URL） |
| 内容是 PDF / 二进制 | 不在本插件职责内（见[§10 边界](#10-边界与刻意不做的事)） |

**observe 长什么样**（面对陌生页面时的第一步）：

```sh
# 设置卡片把 observe 打开，然后
web_fetch("https://某站/某页")
```

返回的是"可操作状态"：最终 URL 与标题、可见可交互控件及其标签与状态（`checked`/`unchecked`/`disabled`/`covered`/以标签形式可见）、完整计数、可见文本开头。**没有任何标签会写出来的前置条件，往往就是一个计数**——这正是场景 D 写配方的依据。

---

## 3. 场景 B：先给站点分流

**目的**：在花时间写配方之前，先知道这个站"难在哪"。探针是只读的：不点击、不输入、不提交。

```sh
# 需要有一个带 --remote-debugging-port 的浏览器（插件在用的那个即可）
node tools/probe/probe-site.mjs 'https://某站/某页' 'https://另一站/页'
```

每个 URL 输出一行 JSON，`verdict` 是判词：

| 判词 | 含义 | 下一步 |
| --- | --- | --- |
| `ok-no-actions` | 服务端给的文档里已经有内容 | 场景 A 就够了 |
| `api-replayable` | 正文很少，但有可重放的 JSON 接口 | **场景 C**（最省：直接抓包生成爬虫） |
| `api-opaque` | 有接口，但签名/加密，无法直接重放 | 场景 D（驱动页面），或维持浏览器重放 |
| `needs-action` | 正文少、没有 JSON、但页面有可展开/加载更多 | **场景 D** |
| `login-gated` | 登录墙挡在内容前面 | 场景 E（复用真实 profile 的登录态） |
| `unclear` | 以上都不成立 | 用 `web_fetch` + `netdump` 正式走一遍再看 |

**判词只是分流线索，不是结论。** 一个真实的误判例子（本仓库当天实测）：

```
$ node tools/probe/probe-site.mjs 'https://datasearch.nmpa.gov.cn/datasearch/home-index.html'
{"status":412,"verdict":"login-gated","contentChars":691,"jsonEndpoints":2,"title":"国家药品监督管理局数据查询", …}
```

它说 `login-gated`，但真相是**前置 WAF 的 412 挑战页**（`web_fetch` 在真实浏览器里能过，探针的只读一跳过不去）。同一条记录在设计稿附录 B 里也写着：`contentChars ≥ 2000` 会把"外壳很厚的首页"误判成"已拿到内容"，探针也分不清"数据接口"与"防护信标"。**结论永远来自正式路径**：`web_fetch` 抓一次 + `netdump` 排一次接口。

---

## 4. 场景 C：接口优先（抓包 → 离线爬虫）

这是**长期批量取数最省的一条路**：一旦拿到接口，服务器上就不需要浏览器、不需要 AI，只需要 Python。

### 4.1 打开抓包，抓一次

| 设置 | 值 | 说明 |
| --- | --- | --- |
| `recordNetwork` | `true` | 每次抓取给**它自己开的那个标签页**挂一个 CDP 会话 |
| `recordDir` | 空 = `<工作目录>/net-dumps` | 每次抓包在下面新建独立 `<sessionId>` 子目录 |
| `captureBodies` | `true` | 连响应正文一起存（提取接口最需要） |
| `maxBodyBytes` | `262144` | 单条正文上限，避免大响应撑爆 |
| `recordAllResources` | `false` | 图片/字体/媒体/样式默认丢弃（对提取业务 API 是噪音） |

```
web_fetch("https://某站/要长期跑的那一页")
```

产物（目录 `0700`、文件 `0600`）：

```
net-dumps/<sessionId>/network.jsonl   # 一边抓一边追加，崩溃也不丢
net-dumps/<sessionId>/har.json        # 结束时导出的 HAR 1.2
```

> **抓包含明文凭据**（Cookie / Authorization / Token / 请求与响应正文），故意如此——重放登录会话正是目的。当成密码文件对待：`net-dumps/` 已在 `.gitignore` 里，别复制、别提交、别贴聊天。

### 4.2 看抓到了什么

```sh
PYTHONPATH=tools/netdump python3 -m netdump summary net-dumps/<sessionId>/network.jsonl
```

真实输出（本仓库对 NMPA 那次抓包的实测）：

```
[netdump] 输入：…/network.jsonl（jsonl，29 条记录）
[netdump] 过滤静态/噪音 22 条，保留 7 条 → HTTP 接口 6 个 / WS 通道 0 个
[netdump] 涉及域名：datasearch.nmpa.gov.cn
[netdump] 接口排名（method urlTemplate  calls  score）：
  - GET  https://datasearch.nmpa.gov.cn/datasearch/config/ff80808183cad75001840881f848179f.json  calls=2  score=75
  - GET  https://datasearch.nmpa.gov.cn/datasearch/config/DATE.json     calls=1  score=70
  - GET  https://datasearch.nmpa.gov.cn/datasearch/config/NMPA_DATA.json calls=1  score=70
  - GET  https://datasearch.nmpa.gov.cn/datasearch/data/nmpadata/countNums calls=1 score=70
  - GET  …/components/footer.vue  calls=1  score=45
  - GET  …/components/header.vue  calls=1  score=45
```

看到 `countNums` 这一条了吗——**它就是那个"数据到了"的信号**，也正是场景 D 里 `waitFor` 响应条件要等的端点。抓包与配方在这里接上了。

### 4.3 生成接口清单 + 离线爬虫

```sh
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<sessionId>/network.jsonl -o netdump-out
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/<sessionId>/har.json        -o netdump-out   # HAR 同样支持
```

产物（实测）：

```
netdump-out/endpoints.json   # 每个接口：method、urlTemplate、sampleUrl(s)、requestHeaders、
                             # query、bodyShape、sampleBody、callCount、score、scoreFactors、rankReason
                             # 被过滤的进 filtered（带原因）；WS 单独一组；顶层有评分权重表 scoreModel
netdump-out/crawler.py       # 可直接运行的 httpx 异步爬虫，内嵌抓到的 Headers 与 Cookie
```

### 4.4 在服务器上裸跑（无浏览器、无 AI）

```sh
pip install "httpx[http2,socks]"

python3 crawler.py --dry-run          # 先空跑，看目标与代理配置
python3 crawler.py                    # 直连试跑
python3 crawler.py --help             # 并发、超时、重试、代理轮换、断点续跑等参数
```

生成器只依赖 Python 3.11 标准库；爬虫本身是普通 `httpx.AsyncClient(http2=True)`，带并发上限、指数退避 + 抖动、`Retry-After`、代理轮换（`--proxy` / `--proxies-file`）与可续跑的 JSONL 输出。**凭据会过期**：失败了先看是不是 Cookie/Token 过期，重新登录抓一次即可。

---

## 5. 场景 D：页面要先操作才出数据

这是本插件最"重"的一条能力，也是**唯一需要你写文件**的一条：在仓库里写一份**配方（target）**，抓取按 URL 自动选中它并确定性重放。

### 5.1 三步走：发现 → 固化 → 重放

```
① 发现   observe: true 抓一次，把页面的可操作状态读回来
          （看不明白就让 AI 读，它读的是"能做什么"而不是"长什么样"）
② 固化   把观察到的顺序写进 targets/<站名>.json，与观察记录一起提交
          （配方的理由要写在 <站名>.observation.md 里，否则无法评审）
③ 重放   targetsFile 指向这份文件，抓取按 URL 命中并执行；每步回读验证
```

### 5.2 配方的样子

```json
{
  "targets": [
    {
      "name": "nmpa-datasearch-domestic-drugs",
      "match": { "kind": "prefix", "url": "https://datasearch.nmpa.gov.cn/datasearch/home-index.html" },
      "actions": [
        { "verb": "waitFor", "condition": { "kind": "text", "text": "使用提示" } },
        { "verb": "click", "candidates": [{ "selector": "a[title=\"境内生产药品\"]" }] },
        { "verb": "type", "candidates": [{ "selector": "input[data-step=\"4\"]" }], "value": "阿司匹林" },
        { "verb": "click", "candidates": [{ "selector": "button[data-step=\"5\"]" }], "opensPage": true },
        { "verb": "waitFor", "condition": { "kind": "response", "match": { "kind": "prefix", "url": "https://datasearch.nmpa.gov.cn/datasearch/data/nmpadata/countNums" } } },
        { "verb": "waitFor", "condition": { "kind": "text", "text": "阿司匹林肠溶片" } }
      ]
    }
  ]
}
```

- `match`：`exact`（整串相等）或 `prefix`（前缀，只在 `/`、`?`、`#` 或串尾处命中；**忽略查询串与 hash**）。多条命中时**最长者胜**；两条一样长 → 报配置错误；零命中 → 照常抓取、不报错。
- 设置里 `targetsFile` 填**显式路径**（插件拿到的是进程工作目录，不是本会话工作区）。配方放仓库里评审、diff、版本管理；**不要写任何凭据**（cookie 走抓取所用的 profile）。

### 5.3 四个动词 + 五种等待条件

| 动词 | 它保证什么 | 参数 |
| --- | --- | --- |
| `waitFor` | 一个条件成立 | `condition`，见下表 |
| `click` | 某个控件被点击 | `candidates`（有序）；`opensPage: true` 表示预期它开新标签页并接管 |
| `check` | 某控件被置为勾选/未勾选，**并回读确认** | `candidates`、`state`（省略即 `checked`） |
| `type` | 值被写进输入框，**并让页面真的收到** | `candidates`、`value` |

| 条件 | 写法 | 什么时候用 |
| --- | --- | --- |
| 可见文本 | `{ "kind": "text", "text": "结果" }`（`"absent": true` 表示"等到它消失"） | 结果区出现、加载态消失 |
| URL | `{ "kind": "url", "url": "https://…/results" }`（`absent` 表示"等到离开"） | 跳转完成、离开闸门页 |
| 固定时长 | `{ "kind": "time", "ms": 500 }` | 明知在等某个异步，但没有更可靠的信号 |
| 状态 | `{ "kind": "state", "state": "checked"｜"unchecked"｜"enabled"｜"disabled", "candidates": [ … ] }` | **闸门的前置条件住在状态里**，任何标签都读不出来 |
| **响应** | `{ "kind": "response", "match": { "kind": "prefix", "url": "https://…/api/search" } }` | **"数据已经到了"的直接信号**，比等 DOM 稳得多（场景 C 抓到的那条接口就是它） |

**候选（candidates）**有三种，**有序**，第一个"存在且可见"的生效：`{ "selector": "…" }`、`{ "text": "查询" }`、`{ "role": "button", "name": "查询" }`。改版后补一条候选即可，不必重写配方。

### 5.4 三个已固化的真实配方（照抄就能改）

| 配方 | 站点形态 | 关键动作 |
| --- | --- | --- |
| [`targets/verify-check.json`](../targets/verify-check.json) · [`verify-state.json`](../targets/verify-state.json) | **逐项同意闸门**（booking.com 的 `pipl_consent`）：5 个隐藏 checkbox + 一个"全选"，不勾齐不放行 | `check`（经 `<label>` 点人能点到的控件）→ `waitFor state all checked` → `click 同意` → `waitFor` 离开闸门 |
| [`targets/tga-artg.json`](../targets/tga-artg.json) | **表单查询**（TGA 的 ARTG 公开登记册） | `waitFor` 查询区 → `type` 关键词 → `click` 提交 → `waitFor` 结果计数 |
| [`targets/nmpa-datasearch.json`](../targets/nmpa-datasearch.json) | **结果在新标签页 + 数据由 XHR 送达**（NMPA 数据查询） | 数据集磁贴 → `type` 关键词 → `click … "opensPage": true` → `waitFor response`（接口）→ `waitFor text`（表格渲染） |

每个生产配方旁边都有一份 `<名字>.observation.md`：它是从哪次 observe 写出来的、每一步为什么这么写、有哪些页面事实踩过坑。**没有理由记录的配方不算配方。**

### 5.5 读动作摘要（正文首行）

真实返回（NMPA，0.2.26）：

```
> actions: 1. waitFor text "使用提示" — met
  · 2. click selector "a[title=\"境内生产药品\"]" -> a — clicked (unverified)
  · 3. type selector "input[data-step=\"4\"]" -> textbox (now "阿司匹林") — met
  · 4. click selector "button[data-step=\"5\"]" -> button (it opened a page; the rest of the target runs there) — clicked
  · 5. waitFor response under …/data/nmpadata/countNums — met
  · 6. waitFor text "阿司匹林肠溶片" — met
  → final document https://datasearch.nmpa.gov.cn/datasearch/search-result.html (HTTP 200)
```

怎么读：

- `— met`：条件当时成立；`— skipped`：这一步标了 `"optional": true` 且没成（唯一逃生口，其余步骤仍严格）。
- `— clicked`：点击**被后面的等待证明**有作用；`— clicked (unverified)`：点击发出去了，但**没有后续等待能证明它做了什么**（上例第 2 步后面紧挨着 `type`，所以如实标注）。**宁可标出这个缺口，也不给它借来的功劳。**
- `→ final document …`：**正文是这一页**，`url` / `statusCode` 描述的也是它（不是最初请求的那个响应）。

### 5.6 失败长什么样（以及为什么好）

任何非 `optional` 的步骤没达成就**整次抓取失败**，绝不返回半成品页面：

```
WEB_FETCH_ACTION
target "nmpa-response-negative" step 5 (waitFor) did not hold:
  response under …/datasearch/data/nmpadata/never-this-endpoint:
  the last response was …/datasearch/config/ff80808183cad75001840881f848179f.json?date=… (HTTP 200)
  (not met within 10000ms) — at https://datasearch.nmpa.gov.cn/datasearch/search-result.html
```

一句话里给全了：**第几步、哪个动词、等的是什么、当时看到的最后一条响应、卡了多久、当时在哪一页**。写配方时最常走的路就是"让它失败一次，照着这句话改候选"。

### 5.7 关于"新标签页"和"响应条件"的两条硬规矩

- **`"opensPage": true` 是预期，不是开关**：写了它而没开出页面 → 这一步失败并点名（`the step expects a page to open, and none did`），而不是停在原地继续读——那就是静默错答。接管的那一页从**弹出那一刻**起被监听，之后所有步骤、以及抓取读取与描述的文档都属于它，并且它随抓取一起关闭（不留野标签页）。
- **响应条件是"事件"不是"状态"**：从动作开始就在听（页面加载时取到的响应不算答案）；只看**当前所在的那一页**；一次等待把手里**所有**匹配到达一起消费（双请求留下的重复不能应付下一次等待）；**主文档与 4xx/5xx 都不算"数据到了"**（但失败句里会点名，含状态码）；点击的功劳**按请求何时发出**算（派发前记水位），且一次等待只确认**紧挨着它前面**的那个动作。

---

## 6. 场景 E：本地可视浏览器 + 隧道

**什么时候用**：站点要登录（复用你本机真实 profile 的登录态）、要走你本机的代理、或者你就是想**看着它点**。

```sh
# ① 在你本机：复制真实 profile 到临时目录，用调试端口启动一个有头浏览器
dsh-web-fetch-launch --headful                 # 或 node bin/launch-browser.mjs --headful
#    它会打印两样东西：浏览器命令本身 + 下面这条隧道命令
# ② 把本机回环端口送到插件所在的服务器
autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>
# ③ 在插件宿主机：设置卡片 → 后端选「远端 CDP 地址」，cdpEndpoint 填 127.0.0.1:9222
```

要点：

- **只绑回环**：`--address` 只接受 `127.0.0.1` / `::1` / `localhost`。调试端口等于浏览器的完全控制权 **加上** profile 里的凭据，所以绝不绑到别处。
- **profile 是复制品**：启动器复制你真实的 Chrome profile 到一次性目录（排除锁/缓存/崩溃残留），你手动登录一次，那份登录态就在这次会话里可用；`--force` 才允许覆盖已有副本。
- **代理**：本地/托管后端由插件注入代理；**CDP 后端不注入也不校验**（浏览器是别人启动的），启动器会把设置卡片里的代理翻译成 `--proxy-server=… --proxy-bypass-list=…`。代理的**用户名密码不会下发**（Chromium 命令行无处承载）——启动器会警告，用免鉴权落地代理（如 `ssh -D 1080` + `--proxy socks5://127.0.0.1:1080`）或手动登录一次。
- **共享登录态**：`shareBrowserContext: true`（默认）= 每次抓取是远端浏览器**真实 profile** 里的一个标签页，cookie/localStorage 互通；取消勾选 = 每次一个全新隐身式 context。

---

## 7. 场景 F：服务器无头生产

| 后端 | 浏览器是谁启动的 | 什么时候选它 |
| --- | --- | --- |
| `managed`（**推荐**） | 插件在 `userDataDir` 上启动**一个持久浏览器**并长期保留 | 服务器自给自足；要登录态跨抓取、跨重启保留 |
| `local` | 每次抓取启一个一次性浏览器 | 一次性、无状态、要严格隔离 |
| `cdp` | 别人（你本机、另一个容器） | 复用外部浏览器的 profile（场景 E） |

生产上值得动的开关：

| 设置 | 建议 | 为什么 |
| --- | --- | --- |
| `headless` | 保持勾选 | 服务器没有显示器 |
| `maxConcurrency` | `managed`/`cdp` 默认 50 个标签页；`local` 默认 4 个浏览器 | 浏览器已在运行时，一个名额就是一个标签页，别按"浏览器"估 |
| `challengeWaitMs` | 默认 15000 | 挑战页自然等待；`0` 可复现旧行为 |
| `launchArgs` | 例如 `--disable-dev-shm-usage` | 容器 `/dev/shm` 太小会让浏览器随机崩 |
| `recordNetwork` | 只在需要排查/挖接口时开 | 产物含明文凭据 |
| `targetsFile` | 指向仓库里那份配方 | 生产配方应该被评审、被 diff |

**并发与预算**：一次抓取 45s 上限；超出的请求短暂排队，20s 内等不到空位会以 `WEB_FETCH_TIMEOUT` 尽快失败并提示调大并发，而不是一直挂起。动作只是让**单次**抓取更久，不改变并发与重试语义。

容器里怎么让浏览器跑起来（含无 root 时只下载浏览器、`/dev/shm`、持久卷、`local` vs `cdp` 的选择）见 [`deployment-guide.zh-CN.md` §5](./deployment-guide.zh-CN.md)。

---

## 8. 场景 G：Cloudflare 挑战页

默认已经处理：导航落到挑战中间页时，**同一个标签页、同一个上下文**里等浏览器自己过验证（跟踪最后一次主 frame 导航响应，同时轮询活 DOM，所以 SPA 式清除也接得住），有界（`challengeWaitMs`，默认 15s）+ 同标签页重试（`challengeRetries`，默认 1）。等不到就**明确失败** `WEB_FETCH_CHALLENGE`，而不是把中间页当正文返回。

想复现旧行为（把中间页当正文）就设 `challengeWaitMs: 0`；想在本地看前后对比：`node scripts/challenge-demo.mjs`（本地模拟），`node scripts/challenge-online.mjs <url>`（真实站点）。

**安全边界（刻意为之）**：不点击 Turnstile、不解验证码、不注入 token、不伪装指纹/UA、不做代理轮换以绕过挑战、不导出 cookie。等待永远受 `challengeWaitMs` 与 45s 预算双重约束。

> 注意区分：**Cloudflare 挑战**（有专门的中间页与 `cf-mitigated` 头）与**站点的前置 WAF**（如 NMPA 的 412 + 清空文档）不是一回事。后者如果浏览器自己能过，配方第一条 `waitFor`（例如 `使用提示`）就是等它过去；过不去就只能在浏览器 profile 已经过关的环境里跑（场景 E）。

---

## 9. 失败排查：从症状到动作

**先看错误码**（`web_fetch` 报错里的 `code`）：

| 错误码 | 含义 | 你该做什么 |
| --- | --- | --- |
| `WEB_FETCH_TARGET` | 配方文件读不到 / 不是合法 JSON / 结构非法 / 两条一样具体 | 报错里带**JSON 路径**（如 `targets[0].actions[1].condition.kind: …`），照着改 |
| `WEB_FETCH_ACTION` | 某一步没达成后置条件 | 读那句"第几步/哪个动词/哪条条件/最后看到的响应/当时 URL"，改候选或条件 |
| `WEB_FETCH_CHALLENGE` | Cloudflare 挑战在预算内没清除 | 调大 `challengeWaitMs`；或在浏览器已过关的环境跑（场景 E） |
| `WEB_FETCH_CONSENT` | 同意闸门在 dismiss 之后仍在 | 用**配方**接管这个站点（场景 D），并在配方的站点上关掉 `dismissConsent` |
| `WEB_FETCH_PROXY` | 代理不可达 / 配置非法 | 消息里有代理地址与来源设置项（密码永远不打印） |
| `WEB_FETCH_TIMEOUT` | 排队等空位超时或整次预算耗尽 | 调大 `maxConcurrency`，或把批量拆小 |
| `WEB_PROVIDER_ERROR` | 其它 provider 级失败 | 看消息里的 `source`（浏览器从哪儿解析到的） |
| `WEB_ABORTED` | 调用方中止 | 无需处理 |

**常见症状**

| 症状 | 多半是 | 怎么确认 / 怎么修 |
| --- | --- | --- |
| 拿回的是 cookie 横幅或同意页 | 内容被横幅顶掉，或整页同意插页 | `observe: true` 看页面到底在要求什么；横幅 → `dismissConsent: true`；插页 → 场景 D 写配方 |
| 拿回的是"数据还没到"的空壳 | 读得太早 | 配方里加 `waitFor`：优先等**响应条件**（最稳），其次文本，再次状态 |
| 配方第一步就失败（等不到某个文本） | 站点前面有 WAF 前置页 / 这一步的条件写错了 | 先不带配方抓一次看正文是什么；WAF 页就改等它的特征文本，或换环境（场景 E） |
| `waitFor state` 从来不成立 | 状态条件问的是"控件是否 checked/enabled"，不是"文本是否存在" | 用 `observe` 读回真实状态与计数再写 |
| 点了但摘要写 `clicked (unverified)` | 后面没有等待能证明它，或等待被证明为"点击前就已成立" | 在点击后面加一个真正会因为这次点击而改变的 `waitFor` |
| 摘要说 `clicked`，但正文还是旧页面 | 目标其实开在新标签页 | 给这个 `click` 加 `"opensPage": true` |
| 抓包里没有 XHR / 接口清单是空的 | 这次抓取确实没有 XHR（首屏是服务端渲染），或者记录没开 | 确认 `recordNetwork: true`；用 `--include-static` / `--include-documents` 复核一次 |
| `python3 -m netdump` 找不到模块 | 没设 `PYTHONPATH` | `PYTHONPATH=tools/netdump python3 -m netdump …`，或 `cd tools/netdump` 后再跑 |
| 生成的爬虫 403 / 401 | 凭据过期或与来源 IP/UA 绑定 | 重新登录抓一次；或换 `--proxy` 出口 |
| 改了 npm 包版本但行为没变 | bundle 插件不会被热加载 | **重启 `dsh web`** |

---

## 10. 边界与刻意不做的事

| 不做 | 理由 |
| --- | --- |
| `goto` / `evaluate`（任意脚本）/ `screenshot` / 写文件 | 把"可评审的配方"变成"不可评审的代码"；抓取本身就是导航 |
| `press` / `scroll` / `hover` / `select` | 目前没有真实站点逼出来；等有了再单独提 |
| iframe / 跨帧 | 只处理主文档；结果在 iframe 里的站点（如 Drugs@FDA）暂不支持 |
| 正则匹配 | 前缀/精确两种足够，避免配方变成隐式代码 |
| 验证码、反爬对抗、指纹伪装 | 不做对抗；挑战页只在"浏览器自己过"的前提下等待 |
| 二进制内容（PDF） | 不是本插件职责（走下载路径） |
| 动作录制、会话型规划者模式 | 前者未做；后者是独立特性（本插件的动作模型只做**确定性重放**） |

**"理解页面"这件事的边界**：插件不做猜测式的启发。它提供的是**观察**（读回页面状态）与**确定性重放**（把一次理解固化成可验证的步骤）。理解发生在人或模型那一侧，而且只需要发生一次。

---

## 11. 文档地图

| 想知道什么 | 读哪份 |
| --- | --- |
| **按场景怎么用**（本文） | `docs/usage-scenarios.zh-CN.md` |
| 装在哪、怎么部署、容器里浏览器放哪儿、字段全表 | [`docs/deployment-guide.zh-CN.md`](./deployment-guide.zh-CN.md) |
| 真机验收怎么做（P0 代理 → P1 启动器/隧道 → P2 抓包 → P3 离线爬虫 → P4 动作模型） | [`docs/end-to-end-acceptance-manual.md`](./end-to-end-acceptance-manual.md) |
| 特性清单、配置项语义、抓包细节、挑战处理 | [`README.zh-CN.md`](../README.zh-CN.md) / [`README.md`](../README.md) |
| 动作模型的设计与取舍（动词表、失败语义、结果契约、逐版修订记录） | [`docs/action-model-design.zh-CN.md`](./action-model-design.zh-CN.md) |
| 配方资产清单与每份配方的用途 | [`targets/README.md`](../targets/README.md) |
| 抓包 → 接口清单 → 爬虫的生成器细节 | [`tools/netdump/README.md`](../tools/netdump/README.md) |
| 站点分流探针 | [`tools/probe/README.md`](../tools/probe/README.md) |
| 领域词汇（目标/动作/意图/候选/发现/固化/重放/观察/接管页…） | [`CONTEXT.md`](../CONTEXT.md) |
| 三条架构决策 | [`docs/adr/`](./adr/) |
| 安全与凭据处理 | [`SECURITY.md`](../SECURITY.md) |
