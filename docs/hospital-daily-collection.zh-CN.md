# 实战：病例系统每日采集（挂号 → 就诊/体检/检验 → 异常值）

本文回答的是一个具体需求：**"每天抓出当天挂号的人，再取这些人的就诊、体检、检查历史，提取异常值"**，
用 dsh-web-fetch-playwright 该怎么落地。

它是一份**操作手册**，不是设计文档：每一步都写清"谁做、在哪做、跑什么、看到什么算成功、卡住了怎么办"。
按场景选路的简版见 [`usage-scenarios.zh-CN.md`](./usage-scenarios.zh-CN.md)，字段全表见
[`deployment-guide.zh-CN.md`](./deployment-guide.zh-CN.md)。

> **一句话结论**：这个插件负责**一次性的侦察**（看清病例系统背后有哪些接口）和**把人的操作固化成可重放的配方**；
> 每天真正常跑的那部分**不该由插件跑**，而是服务器上一个**无浏览器、无 AI** 的 httpx 作业，加上你自己写的
> 扇出与异常值规则。插件在流程里的位置是"原料生产线"，不是"生产线本身"。

---

## 0. 先看这张表：谁做什么

三类工作，边界是硬的：

| 类别 | 内容 | 为什么是这样 |
| --- | --- | --- |
| 🟢 **AI 能独立做完** | 读抓包、跑 `netdump summary/build` 认接口；写配方；判断"URL 能否直达 / 数据是否在 iframe / 要不要点击"；写 `collect.py`、`rules.py`、调度文件、文档；起 mock 服务端到端自测；发起抓取本身（`web_fetch`）；读 `Set-Cookie` 判断会话寿命 | 这些都是"读、写文件、跑命令"，不需要你的凭据 |
| 🔵 **只有你能做** | ① 确认合规与授权（信息科/伦理审批）② 在浏览器里登录、应答短信/扫码/人脸 ③ 给出 URL 与业务口径（哪页是"今日挂号"、"异常"怎么定义、参考区间从哪来）④ 确认患者数据落在哪台机器 ⑤ 在生产服务器上执行部署与挂定时器 ⑥ 最终临床判断 | 法律主体、凭据、机器权限都在你那边；插件对验证码的红线是**只检测、不破解** |
| 🟡 **AI 能做，但要你先给一样东西** | 直接抓你的病例系统（需要已登录的浏览器 + CDP 通路）；写进仓库（需要写权限）；会话保鲜（需要你偶尔点一次登录） | 登录态在浏览器里、令牌在你手里 |

### 逐步分工（共 18 步）

| 阶段 | 步骤 | 谁 | 备注 |
| --- | --- | --- | --- |
| 准备 | 1 确认有没有官方只读接口/视图 | 🔵 | **可能直接终结整个项目，先问** |
| | 2 准备 DSH、python3 与 httpx | 🟡 | 需要装包权限 |
| | 3 开专用 Chrome 并登录病例系统 | 🔵 | 一次性，约 5 分钟 |
| | 4 在设置卡片里点开关 | 🟡 | 有写权限时可以直接改 `settings.yaml` |
| 侦察 | 5 验证插件确实带着登录态 | 🟢 | 抓一次登录后才可见的页面 |
| | 6 抓"列表 / 就诊 / 体检 / 检验"四个 URL | 🟢 | 6b：必须点击才有数据时，**由 AI 反复改配方 + 反复抓**（见 §3），你无需操作 |
| | 7 找到这次抓包 | 🟢 | `ls -t <recordDir>` |
| | 8 `netdump summary` 认接口 | 🟢 | 输出不含凭据 |
| | 9 `netdump build` 出清单与爬虫骨架 | 🟢 | `endpoints.json` + `crawler.py` |
| 判据 | 10 接口是否对参数签名 | 🟢 | 让插件去抓改过参数的接口 URL 即可判断 |
| | 11 会话能活多久 | 🟢 读 `Set-Cookie` / 🔵 确认"是否记住我" | 决定要不要每天保鲜 |
| | 12 前端形态（iframe / 滚动 / 加密 ID） | 🟢 | 用 `observe` 模式判断 |
| 日常 | 13 生成并保管会话头文件 | 🟢 | `0600`，不进 git |
| | 14 写 `collect.py`（名单 → 扇出 → 幂等） | 🟡 | 需要写权限 |
| | 15 先用昨天跑通并与页面对账 | 🟢 | 条数必须对得上 |
| | 16 写 `rules.py`（异常值提取） | 🟡 | 口径由 🔵 你定 |
| 上线 | 17 挂定时器与告警 | 🔵 | 部署必须由你确认 |
| | 18 每周对账；接口改版就回到第 6 步 | 🟢 出脚本 / 🔵 临床复核 | 配方在这里第二次发挥作用 |

**你最少只需做 5 件事**：

1. 确认合规、拿到授权（半天，可能省掉整个项目）；
2. 开一个专用 Chrome、登录病例系统，**保持窗口开着**（5 分钟）；
3. 在卡片里点开关（或把写权限交出来，让 AI 替你改）；
4. 给出两个 URL：**今日挂号列表页**、**从列表点进某个人后的页面**，外加一句"异常"的口径；
5. 在 AI 把代码与命令交给你时，在你的生产机器上执行。

---

## 1. 先判断这条路该不该走（第 1 步）

| 优先级 | 路径 | 稳定性 | 说明 |
| --- | --- | --- | --- |
| 1 | **官方接口 / 只读视图**（HL7 v2、FHIR、厂商 WebService、数据中台、只读从库账号） | 高 | 病例系统几乎都有对接接口，只是要走信息科/厂商流程 |
| 2 | 页面背后的 HTTP 接口重放（**本插件 + netdump**） | 中 | 接口会无声改版，而医疗数据错一天没人知道 |
| 3 | 浏览器自动化点页面 | 低 | 脆、慢、易触发风控，只当侦察与兜底 |

走第 2 条路时，真正的风险不是"抓不到"，而是**静默失败**：接口改版后返回 `200` + 空数组，
"今天没人挂号"和"接口挂了"长得一模一样。所以第 15、17 步的对账与告警不是可选项。

---

## 2. 准备（第 2–4 步）

### 第 3 步：开一个"专门给抓取用"的 Chrome

不要用日常那个 Chrome 窗口——Chrome 不允许遥控日常用户目录。用独立 profile：

```sh
# macOS / Linux
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/chrome-dsh-his" \
  --proxy-server="http://127.0.0.1:7890"      # 不需要代理就删掉这一行
```

```bat
:: Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-dsh-his"
```

**在这个新窗口里手动登录病例系统，然后别关它。**

浏览器在别的机器上时，用仓库自带启动器复制真实 profile 并带上代理参数，再把回环端口送到插件所在主机：

```sh
# 在浏览器那台机器上
dsh-web-fetch-launch --dry-run          # 只打印将要执行的命令，不启动
dsh-web-fetch-launch                    # 复制 profile 并启动（默认有头）
autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>
```

启动器只把 DevTools 端口绑在回环（`--address` 拒绝非回环值）：该端口等于浏览器完全控制权**加上** profile
里的登录凭据。代理凭据不会通过命令行下发——需要鉴权时用免鉴权的本地代理（`ssh -D 1080`）或在有头窗口里手动应答一次。

### 第 4 步：设置卡片

位置：设置 → 插件 → 插件配置 → *Playwright 网页爬取*。侦察期建议：

| 卡片字段 | 填什么 | 为什么 |
| --- | --- | --- |
| Playwright 后端 | 远端 CDP 地址 | 接管第 3 步那个已登录的 Chrome |
| CDP 地址 | `127.0.0.1:9222` | 同上（同机时也是它） |
| 共享浏览器上下文（复用登录态） | ✅ | 不勾 = 每次全新匿名上下文，只会拿到登录墙 |
| 无头运行 | ⬜ | 侦察期你要能看见浏览器 |
| 抓包记录网络流量（XHR/Fetch/WebSocket） | ✅ | 整个方案的原料 |
| 抓取响应正文 | ✅ | 要读接口返回的 JSON |
| 正文字节上限 | `262144`，或 `0`（不限制） | 检验/体检明细可能很长 |
| 落盘目录 | **显式绝对路径**，如 `/data/his-dumps` | 见下方警告 |
| 目标文件（JSON） | 先留空，第 6b 步再填 | 配方是绝对路径 |
| 观察模式 | 先不勾 | 第 6b / 第 12 步临时打开 |

> ⚠️ **落盘目录务必写绝对值。** 留空时默认是"**工作目录**/net-dumps"，而这个"工作目录"是 **DSH 进程的
> cwd**，不是你会话的工作区。实测：从会话工作区 `…/web_fetch_playwright` 发起抓取，dump 落在了
> `/workspace/net-dumps/<sessionId>/`（DSH 进程的 cwd），仓库目录下什么都没有。配方文件 `targetsFile`
> 同理，必须给显式绝对路径。

---

## 3. 侦察（第 5–9 步，一次性 1~2 小时）

> 关键认知：**录制只挂在插件自己打开的那个标签页上**，你在别的标签页里点的东西不会被录。
> 所以流程是"抓一次 → 看一次 dump"，而不是"我手动点一遍它全录下来"。

### 第 5 步：验证插件确实带着登录态

让 AI 抓一个**只有登录后才看得见**的病例系统页面（例如今日挂号列表）。
成功 = 返回内容里有真实业务数据；拿到登录墙 = "共享浏览器上下文"没勾，或那个窗口没登录成功。

### 第 6 步：先试"URL 直达"，很可能省掉一切配方

在病例系统里观察地址栏：打开列表页、点开一个人、再依次进"就诊/体检/检验"，
**每换一个视图就把地址栏 URL 抄下来**，然后让 AI 一次一个 URL 抓过去（一次抓取 = 一个 dump 目录）。

| 结果 | 含义 | 下一步 |
| --- | --- | --- |
| 有真实内容，且地址栏 URL 直达 | 前端路由可达，**不需要配方** | 跳到第 7 步 |
| 空壳/转圈，或 URL 根本不变 | 靠点击或内存态才出数据 | 第 6b 步 |

### 第 6b 步：用观察模式写配方（仅当 URL 不可达）

勾上**观察模式**抓一次该页面：返回的是"页面上有哪些可触及控件、它们的标签与状态、各类计数"，
而不是正文。照着它写 `targets/his.json`：

```jsonc
{
  "targets": [
    {
      "name": "his-patient-detail",
      "match": { "kind": "prefix", "url": "https://his.example.org/patient/" },
      "actions": [
        { "verb": "waitFor", "condition": { "kind": "text", "text": "就诊记录" } },
        { "verb": "click",   "candidates": [{ "text": "检验" }], "opensPage": true },
        { "verb": "waitFor", "condition": { "kind": "response",
            "match": { "kind": "prefix", "url": "https://his.example.org/api/lab/list" } } }
      ]
    }
  ]
}
```

> 文件顶层**必须是 `{"targets": [ … ]}`**：解析器只认这一个键，多一个未知键、少一层包裹都会直接报错
> （`src/targets.ts` 的 `parseTargets()`）。`match` 里的 URL **不含 query 与 hash**，所以带一次性 ticket
> 的地址照样能匹配——这也意味着**配方里不需要、也不应该写 ticket 之类的凭据**。

把路径填进卡片的**目标文件（JSON）**，关掉观察模式，反复抓 → 逐步补齐。**最后一次成功的抓取就是你要的那份 dump。**
下面把"反复抓"讲清楚，因为这一步最容易卡住。

#### "反复抓"是谁在抓

**执行者不是人。** 插件只有一个入口：AI 调用的 `web_fetch`
（包里唯一的命令行是浏览器启动器 `dsh-web-fetch-launch`，**没有**"抓取 CLI"）。
所以"反复抓" = 让 AI 反复调这个工具：你不需要自己点浏览器、也不需要自己翻日志，
只要给它 URL 和一句话授权，剩下的轮次由它自己跑。

一轮（约 10–30 秒）里发生 5 件事，前 4 件都是 AI 的：

| # | 谁 | 动作 | 这一轮的证据 |
| --- | --- | --- | --- |
| 1 | AI | 改配方文件（每轮只加或改一步） | 文件 diff |
| 2 | AI | 对**同一个 URL** 再调一次 `web_fetch` | 返回正文首行的 `> actions: …` |
| 3 | AI | 读那段摘要：哪步 `met` / `clicked`，哪步失败、失败句说了什么 | 摘要逐字 |
| 4 | AI | 看这一轮新落的 dump 里多了哪些接口 | `<recordDir>/<sessionId>/` + `netdump summary` 一行 |
| 5 | 你 | **什么都不用做** | —— |

摘要长这样（本仓库的真实执行记录）：

```
> actions: 1. waitFor text "Example Domain" — met · 2. click role link "Learn more" -> link — clicked · 3. waitFor url https://www.iana.org/ — met → final document https://www.iana.org/help/example-domains (HTTP 200)
```

失败长这样（NMPA 的负向对照）。注意它会把"页面最后一次响应是谁"直接告诉你——
**那正是找回正确端点的线索**：

```
WEB_FETCH_ACTION … the last response was …/config/ff80808183cad75001840881f848179f.json?date=… (HTTP 200) (not met within 10000ms)
```

#### 典型 4 轮：配方是长出来的，不是一次写对的

| 轮 | 配方里加什么 | 你在摘要里该看什么 |
| --- | --- | --- |
| 0 | **不写配方**，先把 `observe: true` 打开抓一次 | 页面到底有哪些可点控件、它们叫什么名字 |
| 1 | 只写第一步：`waitFor` 一个页面锚点文本 | `met` = 页面进得去；失败 = 锚点文本抄错了 |
| 2 | 加 `click`（会开新页就加 `opensPage: true`），**紧跟**一个 `waitFor` | `clicked` + `met` = 点对了；`not met` = 点了但没等到 |
| 3 | 补完剩余步骤 | 这轮 dump 里应该开始出现目标接口 |
| 4 | 关掉 `observe`，正式抓一次存档 | 全 `met`，且与第 3 轮摘要一致（说明它是确定性的） |

**什么时候算完成**：① 每一步都 `met`/`clicked`，没有 `not met`；② 同一 URL 连抓两次摘要一致；
③ dump 里四类接口（名单 / 就诊 / 体检 / 检验）齐了。

**每轮你实际要说的话**，三种粒度随你挑：

* 全自动：「列表页是 A，患者页是 B，你来」——AI 一次把轮次跑完，只在需要你时才停下来问；
* 半自动：「先抓一次给我看」/「再来一轮」——你逐轮放行；
* 自己盯：让 AI 每轮把 `> actions: …` 摘要和 `netdump summary` 一行贴给你。

#### 只有这三件事需要你出手

1. 需要重新登录 / 弹出短信验证码 / 风控拦住了 → 你去浏览器里处理一次；
2. 页面入口的名字与预期不符（你以为叫"检验"，界面写的是"检查检验"）→ 你告诉 AI 一次；
3. AI 列出候选接口后，你确认"哪个才是数据接口"——内部命名常是 `/getListByType?t=3` 这种，只有业务上认得出来。

#### 如果你不想让 AI 来抓

插件没有抓取 CLI，所以"自己动手"的路子是**绕过插件**：浏览器里 F12 → Network →
手动操作到数据出现 → 右键 **Save all as HAR**，然后：

```sh
PYTHONPATH=tools/netdump python3 -m netdump build capture.har -o netdump-out
```

`netdump` 原生支持 HAR 1.2，这条路完全不需要 AI。代价是：**发现过程留在你的浏览器里、不进仓库**——
下次接口改版，你得自己重来一遍；而配方可以重放，这正是第 6b 步值得花那 1~2 小时的原因。

#### 三条没有时间上限的采集路线

插件的一次抓取有一串硬上限（工具层超时 → 插件预算 `fetchBudgetMs` → 单步 10 秒），
而"人工把陌生系统从头点一遍"经常比这更久。下面三条都没有上限，产出也都能直接喂 `netdump`：

| 路线 | 命令 | 什么时候用 |
| --- | --- | --- |
| **本仓库脚本** | `node tools/his/capture.mjs --url <url> --out out.jsonl --minutes 20 --new-tab` | 想让人点、又要让 AI 接着分析：脚本连 CDP 录制那个标签页，写 netdump 能直接读的 JSONL |
| Playwright CLI | `npx playwright codegen --save-har=a.har --save-storage=s.json <url>` | 顺手想要一份可重放的脚本 |
| Chrome DevTools | Network → **Save all as HAR (with content)** | 零安装，最快 |

三者的产物都含**明文 Cookie / Authorization / 正文**：按密码文件对待（`capture.mjs` 写出的文件固定 `0600`）。

> 一个实测过的坑：插件的录制**只覆盖它自己打开的那个标签页**。让某人在他**自己**的标签页里点，
> 什么都不会被录到——要录人工操作，要么用上面的三条路线，要么让他去插件刚打开的那个标签页里点。

两条硬规矩（细节见 [`action-model-design.zh-CN.md`](./action-model-design.zh-CN.md) §18）：

* `click` 后面紧跟的 `waitFor` 才认这次点击的功劳；中间插了别的动作，就**不认**了——所以"点开 → 等接口"要写成相邻两步；
* 响应条件只在**同一个页面**上有效：`opensPage: true` 之后页面已经走了，旧页面上的应答不算数。

> **配方里不要写密码。** 配方中 `type` 的 `value` 只能是字面量（`src/targets.ts` 里没有变量或 env 间接），
> 所以登录要么靠 profile 里已有的登录态，要么把含密码的那份配方放在 **`.gitignore` 掉**的本地路径并把
> `targetsFile` 指过去，配一个**专用只读账号**。

#### 什么时候**必须**写配方，而不是"让它自己等"

插件的默认等待是固定的，知道这几个数，你就能判断"这条 URL 到底要不要配方"：

| 环节 | 默认行为 | 源码 |
| --- | --- | --- |
| 导航 | `goto(url, { waitUntil: 'domcontentloaded' })` | `src/provider.ts` |
| 页面安顿 | `waitForLoadState('networkidle')`，**上限 5 秒** | `SETTLE_MS = 5_000` |
| 之后 | 读正文 → **关掉这个标签页** | `BrowserPool.release()` → `page.close()` |
| 单个等待步骤 | 上限 **10 秒**；预算不够就"当作这一步没发生" | `STEP_CEILING_MS = 10_000` |
| 整次抓取 | **默认 45 秒**（`fetchBudgetMs` 可配，5000–600000） | `src/config.ts` → `DEFAULT_FETCH_BUDGET_MS` / `effectiveFetchBudgetMs()` |

`networkidle` 的判据只是"**500 毫秒内没有网络活动**"。**分波加载**的单页应用
（先鉴权 → 再组织/菜单/字典 → **最后才请求业务数据**）会在两波之间的空隙里被判定为"页面安静了"，
于是抓取在数据请求发出**之前**就收工。

一次真实实测（同一个 SPA，两次抓取）：

| | 不带配方 | 带一条 `waitFor time 8000` |
| --- | --- | --- |
| 抓取窗口 | 11.4 秒 | 15.7 秒 |
| 框架类请求最后一条 | +9.8 秒 | +9.7 秒 |
| **业务数据请求** | **没有发出**（窗口已关） | **+10.6 秒，抓到** ✅ |

只差约 1 秒。所以判据很简单：**数据是异步出现（SPA、表单查询、点开才加载）就必须写 `waitFor`**；
诊断特征同样明确——`netdump summary` 里全是鉴权/菜单/字典这类框架接口，**一条业务数据接口都没有**。

写法上先用最笨的 `{ "kind": "time", "ms": 8000 }` 探路（≤10 秒上限），
确认"多等就能出数据"之后，再换成确定性的 `text` 或 `response` 条件收紧：
**`time` 是拐杖，`response`/`text` 才是成品。**

> 顺带一个反直觉点：标签页在抓取结束时**一定会被关掉**（profile 模式下只留 context 与 cookie）。
> 所以"抓完让它在旁边挂着、我手工点两下把数据点出来"行不通——**要点的动作必须写进配方**。

### 第 7–9 步：把抓包变成接口清单

```sh
ls -t /data/his-dumps/ | head              # 最新那次（形如 20260924T021027Z-0c96-002）
ls -l /data/his-dumps/<sessionId>/         # network.jsonl（边抓边写）+ har.json，0600

PYTHONPATH=tools/netdump python3 -m netdump summary /data/his-dumps/<sessionId>/network.jsonl
PYTHONPATH=tools/netdump python3 -m netdump build   /data/his-dumps/<sessionId>/network.jsonl -o netdump-out
python3 netdump-out/crawler.py --dry-run   # 空跑看计划，不需要 httpx
```

`summary` 输出形如 `[netdump] 过滤静态/噪音 8 条，保留 0 条 → HTTP 接口 0 个 / WS 通道 0 个`，
并按评分列出接口，**不打印任何凭据**。你要在这里认出四类接口：

| 要的数据 | 接口长相（示例） |
| --- | --- |
| 今日挂号名单 | `GET /api/outpatient/registrations?date=…` |
| 就诊记录 | `GET /api/patient/{id}/visits` |
| 体检记录 | `GET /api/patient/{id}/examinations` |
| 检验/检查明细 | `GET /api/patient/{id}/lab-reports` |

`{id}` 是 netdump 对"纯数字路径段"的模板化——**那正是扇出时要替换的位置**，患者 ID 就藏在
`pathParams` 里。

> `netdump` 生成的 `crawler.py` 只是"把抓到的那几个 URL 原样重放"（`emit.py` 的 `build_targets`
> 只用 `sampleUrl`/`sampleUrls`，`--expand-templates` 也只回填**抓到的**路径参数首值，不做枚举）。
> 所以它能验证会话可用，但**不会**替你换日期、换患者 ID —— 日常扇出要自己写（第 14 步）。

---

## 4. 三个判据（第 10–12 步，约 30 分钟）★ 唯一的分叉口

### 第 10 步：判据 A —— 接口是否对参数签名？

这是"能不能在服务器上离线跑"的总开关。先取出会话头：

```python
# pick-headers.py —— 从 endpoints.json 提出可复用的会话头
import json, os
doc = json.load(open("netdump-out/endpoints.json"))
ep  = next(e for e in doc["endpoints"] if "registrations" in e["urlTemplate"])
KEEP = {"cookie", "authorization", "token", "x-token", "user-agent",
        "accept", "accept-language", "content-type", "referer"}
hdrs = {k: v for k, v in ep["requestHeaders"].items() if k.lower() in KEEP}
json.dump(hdrs, open("/opt/his/session-headers.json", "w"), ensure_ascii=False, indent=2)
os.chmod("/opt/his/session-headers.json", 0o600)
print("kept:", sorted(hdrs))
```

再**把参数改掉打一次**。最小验证是**四连测试**，按顺序做，每一步排除一种可能：

| # | 测试 | 它在回答什么 |
| --- | --- | --- |
| T1 | **原样重放**（原参数 + 原会话头） | 不通就别谈后面：凭证不全 / 出口 IP 被绑 / 会话已失效 |
| T2 | 原参数 + **改一个业务参数**（如把日期改成昨天） | 通 → **不签名**，日常可以完全离线 ✅ |
| T3 | 改业务参数 + **换一个新 `timestamp`**（接口带这个参数时） | 不通 → 参数与时间戳绑在一起，需要浏览器重放 |
| T4 | 去掉 `Cookie`（只留自定义 token 头） | 定位"到底哪个凭证是必需的" |

发这些请求有两条路，优先第一条：

1. **让插件去抓这个接口 URL**：`https://his.example.org/api/outpatient/registrations?date=昨天`。
   插件走那台已登录的浏览器，一定能到内网。
2. **任何能到内网的主机 + 代理**：内网若有 SOCKS5/HTTP 代理，离线脚本可以走它
   （`httpx[socks]`，或先用 `curl --socks5-hostname <proxy-host:port>` 手工验一次）。
   注意**出口 IP 变了可能触发会话校验**——这正是 T1 存在的意义。

```python
import httpx, json
h = json.load(open("/opt/his/session-headers.json"))
r = httpx.get("https://his.example.org/api/outpatient/registrations",
              params={"date": "2026-07-01"}, headers=h, timeout=20)
body = r.json()
print(r.status_code, body.get("status"), len((body.get("data") or {}).get("list") or []))
```

> ⚠️ **两个会让你误判的坑（都实测踩过）**
>
> 1. **复放要用抓包里的"权威头集"，不是基础头集。**
>    `network.jsonl` 里同一个请求有两行头：`request`（CDP 基础头）与 **`requestExtra`（浏览器实际发出的
>    完整头，含 `Cookie`）**。只抄 `request` 那一份 → 服务端回"登录超时"。
> 2. **HTTP 200 不代表成功。** 上面那次失败返回的是
>    `HTTP 200` + `{"status":401,"message":"登录超时"}` —— 业务状态码在 **body 里**。
>    判断成败要看 `body.status`（或你系统里对应的字段），**只看 HTTP 状态码必然误判**。

| 结果 | 含义 | 架构 |
| --- | --- | --- |
| T1、T2 都通 | 不签名，只有会话做身份 | ✅ **理想**：日常完全离线，浏览器只在会话失效时用一次 |
| T1 通、T2 不通 | 业务参数被签名 | ⚠️ 每天用浏览器把"名单"这步重放一次（插件配方），明细能离线就离线 |
| T1 不通 | 凭证不全 / 出口 IP 被绑 / 会话失效 | 按 T4 定位缺哪个凭证；会话失效走第 13 步保鲜 |
| 登录页 / 302 | 会话彻底失效 | 先解决第 11 步 |

**顺带**：`requestHeaders` 里出现 `sign`、`signature`、`nonce`、`x-encrypted-*` 这类头，是"签名型"的
强烈嫌疑（实测样本里有一条带 `sign` + `timestamp` + `token` 的 GET，其日期参数也是签名材料的一部分）——
但**要按上面的四连测试下结论，不要凭头名猜**：另一个实测系统同样带着 `crypt-key` 与 `timestamp`，
四连测试却证明它**并不签名**。

### 第 11 步：判据 B —— 会话能活多久

看 dump 里 `Set-Cookie` 的 `Max-Age`/`Expires`（AI 可以替你读），并确认浏览器里是否有"记住我"。

| 情况 | 结论 |
| --- | --- |
| 有效期 ≥ 1 天且有"记住我" | ✅ 可无人值守：会话头缓存在 `session-headers.json`，到期前人工重登一次 |
| 几小时就过期 | ⚠️ 每天开跑前先"保鲜"：抓一次列表页 → 重跑 `pick-headers.py` |
| 每次登录要**短信验证码/扫码/人脸** | ⛔ **停在这里**。无人值守自动化在合规与技术上都该停（插件对验证码的立场是只检测、不破解），去要服务账号或只读接口 |

**两种"不过期"要分清。** `Set-Cookie` 写成 `expires=Fri, 14 Jun 22013 …` 这种夸张年份，意思是 cookie
**不会按时过期**（实测的一个系统正是如此）；但**服务端仍会失效**，而且失效信号不一定是 HTTP 401——
同一系统回的是 `HTTP 200` + `{"status":401,"message":"登录超时"}`。所以日常作业的告警条件写成
"**业务状态码 ≠ 成功**"，而不是"HTTP 状态码 ≠ 200"。

### 第 12 步：判据 C —— 前端形态

| 现象 | 结论 |
| --- | --- |
| 地址栏直达就出数据 | 最省事，无配方 |
| 必须点击、且 URL 不变 | 要配方（第 6b 步），只在保鲜那一步用它 |
| 数据在 iframe 里 / 要滚动加载 / ID 是加密串 | 配方做不了（`scroll`/`press`/`select`/`evaluate`/iframe 都是刻意没做的）→ 回到直接打接口，或去要官方接口 |

分叉结束后你会得到一句话结论，例如：
**"名单必须每天用浏览器重放，明细与体检可以离线扇出；会话 8 小时过期，所以每天早上先抓一次列表页保鲜，再跑离线作业。"**

---

## 5. 日常作业（第 13–16 步）

### 第 13 步：会话头保鲜

* 长期有效：跳过，手工更新 `session-headers.json` 即可。
* 短期有效：每天早上抓一次列表页 → 跑 `pick-headers.py` 覆盖该文件。

### 第 14 步：`collect.py` —— 名单 → 扇出

复用生成爬虫里的并发/退避/断点续跑思路，换成"名单 → 扇出"：

```python
import asyncio, datetime, json, os, httpx

BASE = os.environ["HIS_BASE"]                          # https://his.example.org
SESSION = json.load(open(os.environ["HIS_SESSION"]))   # 0600，不进 git

async def get(c, path, **params):
    r = await c.get(BASE + path, params=params)
    r.raise_for_status()
    return r.json()

async def main():
    today = datetime.date.today().isoformat()
    async with httpx.AsyncClient(http2=True, timeout=30, headers=SESSION) as c:
        regs = await get(c, "/api/outpatient/registrations", date=today)
        items = regs.get("items") or []
        if not items:                                  # ★ 静默失败防线
            raise SystemExit("ZERO_REGISTRATIONS: 需人工核对页面人数")
        sem = asyncio.Semaphore(6)                     # ★ 生产 HIS，别开大
        async def one(p):
            async with sem:
                pid = p["patientId"]
                return {"pid": pid, "reg": p,
                        "visits": await get(c, f"/api/patient/{pid}/visits"),
                        "exams":  await get(c, f"/api/patient/{pid}/examinations"),
                        "labs":   await get(c, f"/api/patient/{pid}/lab-reports")}
        rows = await asyncio.gather(*(one(p) for p in items))
    # 追加写 JSONL + fsync；以 (日期, 患者ID) 为幂等键，中断后重跑自动跳过
```

### 第 15 步：先拿昨天跑通一遍，并对账

```sh
HIS_BASE=https://his.example.org HIS_SESSION=/opt/his/session-headers.json \
  python3 /opt/his/collect.py --date 2026-06-30
```

**成功标志**：名单条数**等于页面上显示的人数**——这是唯一能抓出"静默失败"的办法。
条数偏少 → 分页参数没跟（看 dump 里有没有 `page`/`pageSize`）；有数据却返回 0 条 → 参数名不对（对比 dump 里的 query）。

### 第 16 步：`rules.py` —— 异常值提取

原则：**优先采信报告自带的标志，其次才用参考区间比**。

```python
def verdict(value, ref_text, flag):
    if flag in {"H", "↑", "偏高"}: return "high", "report-flag"
    if flag in {"L", "↓", "偏低"}: return "low",  "report-flag"
    lo, hi = parse_range(ref_text)        # "3.5-9.5" / "<5.0" / ">1.0" / "阴性"
    if hi is not None and value > hi: return "high", "ref-range"
    if lo is not None and value < lo: return "low",  "ref-range"
    return "normal", "ref-range"
```

每条结果都必须落这些字段，否则半年后没人说得清判定依据：

`patientId · itemCode · itemName · value · unit · refText · flag(报告自带) · verdict(规则判定) · ruleId+ruleVersion · sourceRecordId · collectedAt`

三条硬要求：**参考区间要区分年龄/性别**；**"超出参考区间"≠"临床显著"**，输出要带原区间与偏离幅度给人判断；
**规则要版本化**（可重跑、可复盘）。日常流水线里**不要放 LLM 做医学判定**——患者数据出网、判定不可复现；
"理解"只发生一次，就是你写规则这一侧。

---

## 6. 上线（第 17–18 步）

```ini
# /etc/systemd/system/his-collect.service
[Unit]
Description=HIS daily collection
[Service]
Type=oneshot
User=hisrobot
EnvironmentFile=/etc/his-collect.env      # HIS_BASE / HIS_SESSION
ExecStart=/usr/bin/python3 /opt/his/collect.py
ExecStartPost=/usr/bin/python3 /opt/his/rules.py
```

```ini
# /etc/systemd/system/his-collect.timer
[Timer]
OnCalendar=*-*-* 06:30:00
Persistent=true
[Install]
WantedBy=timers.target
```

**三条必须挂的告警**（否则你会在某天悄悄丢数据）：

1. 名单 **0 条**；
2. 条数比昨天偏离超过 **±30%**（人数按天存表，一比就知道）；
3. 任何**非 200 / 解析失败**。

**每周对账**（5 分钟）：接口条数 vs 页面显示条数。对不上就回到第 6 步重录——配方在这里第二次发挥作用：
你能靠重放**重新把接口发现一遍**，而不是重新猜。

---

## 7. 如果你只想先验证思路（不写任何代码）

最小手动版，约 15 分钟：

1. 卡片里开 **抓包记录网络流量** + **抓取响应正文**；
2. 让 AI 依次抓 4 个 URL（列表 / 就诊 / 体检 / 检验）；
3. `netdump summary` 看接口，`netdump build` 出 `endpoints.json`；
4. `python3 netdump-out/crawler.py` 直接跑一遍——**能拿到与浏览器里一样的 JSON，就证明这条路成立**；
5. 剩下的事（换日期、换患者 ID、提取异常值）就是第 14–16 步的代码量。

---

## 8. 红线

* 只用在你**被授权管理**的系统上；抓取范围按业务必需字段最小化；患者数据不出生产网、不进第三方 AI、不进日志；
* `net-dumps/` 与 `netdump-out/` 含**明文 Cookie / Token / 请求与响应正文**（刻意如此，供离线复现会话）：
  目录 `0700`、文件 `0600`、不入 git、不外发；一旦泄露立即改密/重置 Token；
* 专用只读账号 + 审计留痕（谁在什么时候抓了谁的数据）；
* 插件对验证码/挑战页的立场是**只检测、不破解**（不点 Turnstile、不解验证码、不注入 token、不伪装指纹）；
* 异常清单只是**给人看的提示**，须临床复核；不做自动诊断。

---

## 9. 本页依据的事实（Grounding）

写进本页的命令与结论都来自实测或源码，不是转述：

| 事实 | 来源 |
| --- | --- |
| `web_fetch` 就是这个插件，会经过你配置的 CDP 浏览器，并按 `targetsFile` 里的配方执行动作 | 实测：抓 `example.com` 返回 `> actions: 1. waitFor text "Example Domain" — met · 2. click role link "Learn more" — clicked · 3. waitFor url https://www.iana.org/ — met` |
| dump 默认落在 **DSH 进程 cwd** 下的 `net-dumps/<sessionId>/`，而不是会话工作区 | 实测：该次抓包落在 `/workspace/net-dumps/20260924T021027Z-0c96-002/`（`network.jsonl` + `har.json`，权限 `0600`） |
| `netdump summary` 可离线判读抓包且不打印凭据 | 实测：同一份 dump → `输入：…（jsonl，8 条记录）` / `过滤静态/噪音 8 条，保留 0 条 → HTTP 接口 0 个` |
| 生成的爬虫只重放抓到的 URL，不做参数枚举 | `tools/netdump/netdump/emit.py` → `build_targets()` / `render_template()` |
| 生成的爬虫没有 env 注入请求头的口子 | `emit.py` 中无 `os.environ`；请求头原样取自 `endpoints.json`（仅剔除 httpx 自行管理的头） |
| 会话头里可能出现 `sign`/`timestamp`/`token`（签名型接口的现实样本） | 实测：NMPA 抓包生成的 `endpoints.json` 里 `GET …/data/nmpadata/countNums` 带 `token`/`timestamp`/`sign` |
| 配方里 `type` 的 `value` 只能是字面量，因此凭据不能进配方 | `src/targets.ts` → `parseStep()` 的 `verb === 'type'` 分支 |
| 插件对验证码只检测、不破解 | `src/challenge.ts` 模块头注释（"Solving, spoofing, CAPTCHA answering, and cookie lifting live outside the plugin entirely"） |
| 录制只覆盖插件自己打开的那个标签页 | `src/client/locales.ts` → `recordNetworkHint`；`README.zh-CN.md` §抓包记录 |
| 分波加载的 SPA 会早于业务请求被判定"安静"：实测窗口 11.4 秒（业务请求没发出）vs 带 8 秒等待的 15.7 秒（业务请求 +10.6 秒抓到） | 本次会话对某个内网门诊 HIS 的两次真实抓取（同一 SPA；域名与接口路径不记录在公开仓库） |
| 复放必须用 `requestExtra` 的权威头集（含 `Cookie`）；缺 `Cookie` 时得到 `HTTP 200` + `{"status":401,"message":"登录超时"}` | 实测：同一名单接口的 T1（原样）与 T4（去掉 Cookie）对比 |
| `Set-Cookie … expires=Fri, 14 Jun 22013` 型 cookie 不会按时过期，但服务端仍会失效（业务码 401，HTTP 仍 200） | 实测：同一系统的响应头与会话失效响应 |
| 带 `crypt-key` + `timestamp` 的接口**未必**签名：四连测试里改业务参数照样返回数据 | 实测：同一名单接口的 T1/T2 |
| 单步等待上限 10 秒、整次抓取 45 秒、页面安顿上限 5 秒、标签页结束时被关 | `src/actions.ts` → `STEP_CEILING_MS`；`src/config.ts` → `DEFAULT_FETCH_BUDGET_MS`；`src/provider.ts` → `SETTLE_MS`；`src/browser-pool.ts` → `release()` |
