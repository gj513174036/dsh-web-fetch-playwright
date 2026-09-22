# netdump —— 抓包 → 业务 API 清单 → httpx 异步爬虫

`tools/netdump/` 是本仓库的 **P3 离线流水线**：把 dsh-web-fetch-playwright 录制下来的
流量（或任意标准 HAR 1.2）转成两份可直接使用的产物：

1. `endpoints.json`：过滤掉 js/css/图片/字体/媒体之后的**核心业务 API 清单**
   （method / urlTemplate / sampleUrl / requestHeaders / query / bodyShape /
   调用次数 / 评分与排序依据）；
2. `crawler.py`：**可直接丢到服务器上裸跑的 httpx 异步爬虫**，内嵌抓到的
   Headers 与 Cookie（含明文凭据），支持代理轮换、并发、指数退避重试与
   JSONL 断点续跑。

流水线只依赖 **Python 3.11 标准库**；只有「生成出来的 `crawler.py`」在运行时才需要
httpx。完全没有 AI、浏览器或网络参与生成过程，所以可以在服务器/CI 上离线重跑。

```
JSONL 抓包 / HAR 1.2 ──▶ har.py（解析统一为 Entry） ──▶ classify.py（静态过滤 + API 判定）
                                                   └▶ endpoints.py（模板化/去重合并/评分排序）
                                                                    └▶ emit.py ─▶ endpoints.json + crawler.py
```

## 1. 快速开始

```bash
# 从插件录制的 JSONL 抓包生成（推荐）
PYTHONPATH=tools/netdump python3 -m netdump build net-dumps/2024-03-01.jsonl -o netdump-out

# 从标准 HAR 1.2 生成
PYTHONPATH=tools/netdump python3 -m netdump build capture.har -o netdump-out

# 只看抓包里有什么（不落盘、不打印凭据）
PYTHONPATH=tools/netdump python3 -m netdump summary capture.har

# 只要 JSON 清单、不要爬虫
PYTHONPATH=tools/netdump python3 -m netdump build capture.jsonl -o out --no-crawler

# 生成时就把默认代理池/并发写进爬虫
PYTHONPATH=tools/netdump python3 -m netdump build capture.jsonl -o out \
    --concurrency 32 --timeout 20 --proxy socks5://user:pass@127.0.0.1:1080 \
    --proxies-file proxies.txt
```

也可以进入目录直接跑（无需 `PYTHONPATH`）：

```bash
cd tools/netdump && python3 -m netdump build /path/to/capture.jsonl -o /path/to/out
```

`build` 的常用参数：

| 参数 | 说明 |
| --- | --- |
| `capture` | 抓包文件（JSONL 事件流或 HAR 1.2），格式自动嗅探 |
| `--format auto\|har\|jsonl` | 强制输入格式 |
| `-o/--output-dir` | 输出目录（0700），默认 `netdump-out` |
| `--include-static` | 不过滤 js/css/图片/字体/媒体（仍然打分排序） |
| `--include-documents` | 保留 HTML 文档请求（默认过滤） |
| `--no-websockets` | 不保留 WebSocket 通道 |
| `--top N` | 只保留评分最高的 N 个接口 |
| `--no-crawler` / `--crawler-name` / `--endpoints-name` | 产物裁剪与命名 |
| `--concurrency/--timeout/--retries/--proxy/--proxies-file` | 写进生成爬虫的默认值 |

## 2. 输入格式

`har.py` 把两种来源统一成同一个 `Entry`：
`method, url, status, requestHeaders, responseHeaders, postData,
responseMimeType, resourceType, durationMs, wsFrames`（另有 `responseBody`、
`startedDateTime`、`error`、`source` 等辅助字段）。

### 2.1 标准 HAR 1.2

接受 `{"log": {"entries": [...]}}`、`{"entries": [...]}`、裸 entry 数组，
以及单行就是一个 HAR entry 的 JSONL。

### 2.2 本插件的 JSONL 抓包事件流

逐行 JSON，每行可以是下列任意一种（可混排）：

* **CDP 事件直通**：`{"method": "Network.requestWillBeSent", "params": {...}}`，
  支持 `requestWillBeSent`（含 `postData`）、`requestWillBeSentExtraInfo`
  （合并 Cookie 等真实请求头）、`responseReceived`、`responseReceivedExtraInfo`
  （合并 Set-Cookie）、`getResponseBody`（在 `loadingFinished` 之后到达也会
  写回同一条记录）、`loadingFinished`（据此计算 `durationMs`）、
  `loadingFailed`、`webSocketCreated/FrameSent/FrameReceived/Closed`；
  重定向（`redirectResponse`）会切分成两条记录。
* **简化记录**：`{"kind"|"type"|"event": "request"|"response"|"responseBody"|
  "wsFrame"|"wsCreated"|"wsClosed", "requestId": "...", ...}`，字段名兼容
  `headers`/`requestHeaders`/`responseHeaders`、`postData`/`body`、
  `mimeType`/`responseMimeType`、`resourceType`、`durationMs`。
* **扁平单行**：一行同时带请求与响应，
  如 `{"method": "POST", "url": "...", "status": 200, "requestHeaders": {...},
  "responseMimeType": "application/json", "durationMs": 12.3}`。

容错：空行、`#` 注释行、被 kill 时留下的半行 JSON 都会被跳过，不会中断解析。
HTTP/2 伪头（`:authority` 等）在解析阶段丢弃。

## 3. 过滤与保留规则（`classify.py`）

**默认过滤**（`--include-static` 可关闭）：

* 资源类型 `image` / `font` / `media` / `stylesheet` / `script`；
* 路径扩展名 `.js .css .png .jpg .jpeg .gif .svg .ico .woff .woff2 .ttf`
  （另含 `.webp .avif .bmp .map .eot .otf .mp4 .webm .mp3 .m4a .mov .wav`）；
* HTML 文档请求（`document` / `text/html`，用 `--include-documents` 打开）。

**保留为业务 API 候选**，命中任意一条即保留：

1. 资源类型是 `xhr` / `fetch`；
2. 响应是 JSON（`application/json`、`*+json`、`text/json`，或响应体本身能解析为 JSON）；
3. 请求头带 `Authorization` 或 `Cookie`；
4. 非 GET/HEAD 且带请求体。

唯一的例外：**后缀像静态文件但确实返回 JSON** 的 URL（例如 `/api/report.png`
返回 `application/json`）会被保留，`rankReason` 记为 `api-over-static-extension`，
避免把被静态后缀伪装的接口丢掉。这个例外覆盖两类「弱证据」的静态判定：

* URL 后缀（`static-extension:.js`）；
* 抓包**没有**给出资源类型、由 `har.py` 按后缀/mimeType 兜底推断出来的静态类型
  （`Entry.resourceTypeInferred=True`，例如不带 `_resourceType` 的 HAR 里的
  `/v2/export/report.js` + `content-type: application/json`）。

反过来，抓包**明确给出**的类型是强证据：Chrome HAR 的 `_resourceType`、CDP 事件的
`type`、插件 JSONL 的 `resourceType` 只要是 `script`/`image` 等静态类型，即使响应
头写着 JSON 也照样被过滤，静态资源过滤不会因此放宽。回归用例见
`fixtures/static-extension-json.har`（1 条伪装接口保留 + 4 条真静态资源过滤）。

WebSocket（`ws`/`wss`）默认保留，但只出现在 `endpoints.json` 的 `websockets`
分组里，不会混进 HTTP 接口清单。

## 4. `endpoints.json`

```jsonc
{
  "schemaVersion": "netdump/1",
  "generatedAt": "...",
  "source": { "path": "...", "format": "jsonl", "entries": 42 },
  "options": { "includeStatic": false, "includeDocuments": false, ... },
  "summary": { "totalEntries": 42, "kept": 18, "filtered": 24,
               "endpoints": 11, "websockets": 1, "hosts": ["api.example.com"] },
  "scoreModel": { "weights": {...}, "repeatCalls": {...},
                  "sortKey": "score desc, callCount desc, method asc, urlTemplate asc",
                  "dedupeKey": "method+host+pathTemplate" },
  "endpoints": [
    {
      "method": "GET",
      "urlTemplate": "https://api.example.com/v1/users/{id}/profile",
      "sampleUrl": "https://api.example.com/v1/users/12345/profile",
      "sampleUrls": [".../users/12345/profile", ".../users/67890/profile"],
      "requestHeaders": { "Authorization": "Bearer ...", "Cookie": "..." },
      "headerVariants": { "x-request-id": ["r-0001", "r-0002"] },
      "cookies": { "session": "abc123" },
      "setCookies": { "theme": "dark" },
      "query": { "page": "2" },
      "pathParams": { "id": ["12345"] },
      "bodyShape": { "kind": "json", "fields": { "qty": "integer" } },
      "sampleBody": "{\"qty\":2}",
      "statuses": { "200": 2 },
      "callCount": 2,
      "score": 85,
      "scoreFactors": [{ "factor": "resource-type:xhr", "points": 30 }],
      "rankReason": "score=85: resource-type:xhr(+30), ..."
    }
  ],
  "websockets": [ { "urlTemplate": "wss://.../{id}", "frameCount": 2, "sampleFrames": [...] } ],
  "filtered": [ { "url": "https://cdn.example.com/a.png", "reason": "static-resource-type:image" } ]
}
```

模板化规则：路径段为**纯数字** → `{id}`、**UUID** → `{uuid}`、**长度 ≥ 16 的十六进制**
→ `{hash}`；同一模板中重复出现时按 `{id}`、`{id2}` 编号。去重键是
`(method, host, pathTemplate)`，命中同一条目时合并 headers（冲突值进
`headerVariants`）、cookies、query、路径参数与 payload 样本。

评分（`score` + 可读的 `rankReason`）：`xhr/fetch +30`、JSON 响应 `+25`、
非 GET 带 body `+20`、`Authorization +15`、`Cookie +10`、query 参数 `+5`、
WebSocket `+10`（有帧再 `+10`）、每多一次调用 `+5`（上限 `+15`），
`--include-static` 下静态资源 `-20`。

## 5. `crawler.py`（生成物）

生成脚本的要点：

* `httpx.AsyncClient(http2=True, proxy=..., timeout=..., follow_redirects=True)`，
  每个代理一个 client；`asyncio.Semaphore(--concurrency)` 控制并发；
* 指数退避重试（`backoffBase * 2**(n-1)` + 抖动，尊重 `Retry-After`），
  默认重试 429/5xx 与网络异常；
* 结果按行追加写 JSONL，逐行 `flush + fsync`，并在启动时读取已有结果实现
  **断点续跑**（顺带修复中断留下的半行；`--no-resume` 可强制重跑）；
* 请求头原样使用抓到的值（含 Cookie / Authorization / CSRF Token），
  只剔除 `content-length`、`host`、`connection` 等 httpx 自行管理或 HTTP/2
  禁止手工设置的头；
* 目标默认是抓包里的**真实 URL**（`sampleUrls`），`--expand-templates` 才会用
  `pathParams` 回填 `{id}` 之类的占位符；
* WebSocket 通道只写进 `endpoints.json`，不生成重放代码。

运行（服务器上只需 httpx）：

```bash
pip install "httpx[http2,socks]"
python3 crawler.py --dry-run                                   # 空跑，看计划（不需要 httpx）
python3 crawler.py --concurrency 32 --timeout 30               # 直连
python3 crawler.py --concurrency 32 --proxies-file proxies.txt # 代理轮换
python3 crawler.py --help
```

| 参数 | 说明 |
| --- | --- |
| `--endpoints PATH` | 改用外部 `endpoints.json`（默认用脚本内嵌的抓包结果） |
| `-o/--out PATH` | 结果 JSONL 路径，也是断点续跑的凭据 |
| `--concurrency` / `--timeout` / `--retries` | 并发、超时、重试次数 |
| `--proxy URL`（可重复） / `--proxies-file PATH` | 代理与代理池（每行一个，`#` 注释） |
| `--dry-run` | 只打印计划：目标数、待抓数、代理模式、输出路径 |
| `--no-resume` | 忽略已有结果从头重跑 |
| `--expand-templates` | 用抓到的路径参数回填 `{id}/{uuid}/{hash}` |
| `--limit N` / `--body-bytes N` / `--insecure` | 限量、响应体保留长度、跳过 TLS 校验 |

退出码：`0` 全部成功（或缺省为空跑）、`1` 有目标在重试后仍失败、
`2` 配置/输入错误（例如代理列表文件不存在、缺少 httpx）、`130` 被 Ctrl-C 中断
（已写入的结果保留，重跑自动续跑）。

## 6. 安全与权限

抓包结果里带着**明文 Cookie / Bearer Token / 会话凭据**，netdump 按「原样保留、
靠权限保护」处理（与 P2 录制端一致）：

* 输出目录 `0700`，`endpoints.json` 与 `crawler.py` 均为 `0600`（已存在时会被收紧）；
* 结果 JSONL 同样以 `0600` 追加写入；
* `crawler.py` 顶部有显式的**凭据敏感性警告**（中文 + 英文）；
* CLI 的 `summary`/`build` 输出只打印接口模板、评分与域名，**不会打印任何凭据**；
* `--dry-run` 的 JSON 计划里只有目标 URL 与代理条数，不含请求头。

也就是说：`netdump-out/` 属于敏感目录，不要提交、不要贴图、不要上传制品库；
凭据泄露后应立即轮换（重新登录/重置 Token）。

## 7. 自测

```bash
# 只依赖标准库；没有任何第三方测试框架
python3 -m unittest discover -s tools/netdump/tests -t tools/netdump
```

测试覆盖：HAR/JSONL 解析与容错、静态过滤与保留规则（含 F3 回归：
`fixtures/static-extension-json.har` 里伪装成 `.js` 的 JSON 接口保留、真脚本仍过滤）、
模板化/合并/评分、生成脚本的语法编译与 CLI 行为（含断点续跑、代理轮换、
缺 httpx 时的提示）、权限位与凭据保留、以及 `fixtures/sample.har` →
`endpoints.json` + `crawler.py` 的端到端断言。

## 8. 已知限制

* `netdump` 只做**离线重放与轻量改参**：`{id}` 占位符不会自动枚举，需要
  `--expand-templates` 或自行改 `ENDPOINTS` 常量来拼新参数；
* WebSocket 只做清单与帧样本，不生成 WS 客户端；
* 生成脚本运行需要 `httpx`（可选 `httpx[socks]` 走 socks 代理）；
  `--dry-run` 在没有 httpx 的机器上也能用；
* 生成的脚本不处理验证码/签名类风控，只复用抓到的会话头；请自行确认目标站点的
  使用条款与合规要求。
