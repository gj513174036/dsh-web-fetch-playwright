# tools/his —— 采集 + 异常判定（离线、可续跑、可审计）

这一层解决的是**日常**问题：把"今天谁来了 → 每个人的就诊 / 检验 / 检查 / 体检 → 异常清单"
跑成一条不用浏览器、不用 AI 的流水线。侦察（搞清有哪些接口）用插件或
`tools/his/capture.mjs`，日常跑用这里。

```
collect.py  ① 名单 → ② 就诊病历（并拿到档案侧 id）→ ④ 检验/检查报告与明细
            → ⑤ 体检报告与小结 → ⑦ 单项历史 → ⑧ 危急值         → facts-<日期>.jsonl
rules.py    逐项判定（危急值 / 报告标志 / 参考区间 / 判不了）      → abnormal-<日期>.jsonl
mock_his.py 假病例系统：端到端测试用，离线、无患者数据
```

## 1. 快速开始

```sh
# 0) 端点表：仓库里的这份是**占位示例**（路径是编的），真实路径放仓库外
cp tools/his/endpoints.example.json /opt/his/endpoints.json   # 然后按你的系统改

# 1) 会话：从抓包里导出的一份 curl 配置（含 Cookie 与可选 proxy，0600）
#    抓包 → endpoints.json 的这条路见 tools/netdump/README.md 与 docs/hospital-daily-collection.zh-CN.md

# 2) 采集（顺序请求、无并发；中断后重跑自动续跑）
python3 tools/his/collect.py --mode daily \
    --curlrc /opt/his/session.curlrc --base https://his.example.org \
    --endpoints /opt/his/endpoints.json --out /opt/his/out \
    --doctor "张医生" --date 2026-09-24 --with-trends

# 3) 判定
python3 tools/his/rules.py --facts /opt/his/out/facts-2026-09-24.jsonl --out /opt/his/out --tag 2026-09-24

# 按人拉全量：姓名+手机号 → 就诊病历 + 处方医嘱 + 检验 + 检查 + 体检 + 危急值
python3 tools/his/collect.py --mode person --name "张三" --telephone "13800000000" \
    --with-trends ...
```

退出码：`0` 正常；`1` 有接口失败（默认不中止，逐条记在 `errors` 里）；`2` 配置错；
**`3` 名单为 0** —— 这是刻意的：接口改版后返回空列表和"今天没人"长得一模一样。

依赖：只用 Python 标准库。要过 SOCKS5/HTTP 代理时加 `--via-curl`（走系统 curl，实测可用）；
直接可达或已装 `httpx[socks]` 时用默认传输。

## 2. 端点表为什么在代码之外

`--endpoints` 指向的 JSON 把"哪些路径、什么参数"从代码里抽走：

```jsonc
{
  "roster":        { "path": "/api/…/list",        "params": ["doctorName","startDate","endDate","pageNum","pageSize"] },
  "reports":       { "path": "/api/…/reports",     "params": ["userId","itemType","pageNum","pageSize"],
                     "itemTypes": { "lab": "JY", "exam": "JC" } },
  "reportDetail":  { "path": "/api/…/report/{id}", "params": ["id"] }
}
```

好处有二：工具本身可以公开（仓库里只有占位示例），而**你系统的真实路径**留在自己的机器上；
换一家同类系统只改这份 JSON。响应形状（`data.list` / `pagination.total` / `detailList` /
`diagnoseItems` 等）仍按约定俗成的中国 HIS 形状读取，若你的系统不同，改
`rows_of` / `total_of` 与各 `*_items()` 映射函数。

## 3. 判定优先级（`rules.py`，当前 `ruleVersion = 3`）

| 顺序 | 证据 | verdict | 说明 |
| --- | --- | --- | --- |
| 1 | **危急值模块**来的行 | `crisis` | 只有专门模块算数；见下 |
| 2 | 报告标志 `abnormalTips` / 箭头 `resultRemark` | `high` / `low` / `positive` / `normal` | 码表：`H`=高 `L`=低 `P`=阳性 **`M`/`N`=正常**；未知码保守判异常 |
| 3 | 参考区间比对 | `high` / `low` / `normal` | **分段式优先**（`缺乏:0--19.9\|不充足:20--29.9\|充足:30--100\|过量:>100` → 命中的段名就是结论） |
| 4 | 只有 `haveCrisis` 线索 | `unknown` + `review` | 降级为"请人看一眼" |
| 5 | 判不了 | `unknown` + `review` | 保留，绝不静默丢弃 |
| — | 体检小结的结论条目 | `recorded` | 那是"既往诊断列表"，不是异常值 |

每条输出都带 `ruleId` / `ruleVersion` / `why` / `sourceEndpoint` / `sourceId` / `checkTime`，
所以任何时候都能回答"凭什么把这一项标成异常"。

### 身份定位（`--mode person` 的第一步）

`identity` 接口按姓名查，一行同时给出**两套 id**（HIS 侧与档案侧），所以一次调用就能把
"病例/检验/检查"和"体检/档案"两条线都接上。但：

* **它的 `telephone` 过滤参数被服务端忽略**（实测给不给都返回同名全部行）→ 精确匹配必须在**客户端**做；
* 匹配不唯一时脚本**直接失败**（退出码 1，提示"身份定位不唯一"），而不是随便挑一个 ——
  同名患者是常态，挑错人等于把别人的病历写进你的库。

### 从真机上换来的字段语义（很反直觉，别照直觉写）

1. **`haveCrisis` 不是危急值标志**：实测 1664 个检验明细里 1609 个是 `"1"`。真正的危急值在
   独立模块（`crisis` 端点）。把它当异常会一次刷出上千条假危急值。
2. **`abnormalTips` 的 `M`/`N` 是正常**：实测分布 `M`×1096、空×324、`H`×77、`L`×37、`N`×37、`P`×17。
   "非空即异常"会把 1096 条正常项判成异常。
3. **参考区间常常是分段的**，且方向写在 `resultRemark`（`↑`/`↓`）里，不是写在结果字符串里。
4. **剂量单位与包装单位是两个字段**：单次量用 `adultUnit`（如 `24`=mg），总量用 `unit`（如 `20`=片）。
   混用会写出"共 7mg"这种看着对、其实是 7 片数的用量 —— 处方串里最容易犯的错。
5. **定性结果自身就是结论**：`阴性(-)` 这类没有参考区间时也应当判为正常，否则会掉进"判不了"里刷噪声。

## 3.5 字典与主数据：哪些码要翻译、项目名称从哪来

两类完全不同的东西，别混：

| | 字典（`dictionary_item_ref`） | 主数据（`master_data/*`） |
| --- | --- | --- |
| 给什么 | **枚举码 → 人话**（状态/类型/单位/部位） | **项目本身**：编码、名称、价格、执行科室 |
| 响应形状 | `{data: {"<字典码>": [ {code, name, itemValue, …} ]}}` —— **按码分组的对象，不是数组** | `{data: {list: [...], pagination: {total}}}` |
| 数量级 | 每个码几条到几十条 | 千级（示例系统：组合项目 3053、药品 3826） |
| 过滤参数 | `dictionaryTypeCode`（可逗号叠多个） | 实测**只有 `nameOrCode=` 生效**；`groupItemName=`/`keyword=` 被静默忽略（不报错，返回全量） |

值得先取的两类码：**项目分类**（在示例系统里 `MD_ITEM_GROUP_TYPE` 的 `JC`=检查 / `JY`=检验，
正是报告列表 `itemType` 的取值来源）与**状态/分级**（报告执行状态、危急值类型与指标分层）。
取到之后，异常清单里的"级别/状态/类型"才有意义。

**但项目名称不必从字典来**：报告明细自带 `itemCode` / `itemName`，趋势接口也按项目名组织；
字典给的是分类与翻译，主数据给的是目录与价格。做"某一个项目的历次结果"用报告里的编码即可。

> 解析这个接口时最常见的错：把 `data` 当数组去数条目，于是永远得到 0 —— 它是按字典码分组的对象。

## 4. 产出

| 文件 | 内容 |
| --- | --- |
| `raw-<日期>.jsonl` | 接口原文（含端点、参数、完整响应），用于回放与复盘 |
| `facts-<日期>.jsonl` | 规范化事实：一行 = 一次接口结果 + 展平后的明细项（`rules.py` 的输入） |
| `evaluated-<日期>.jsonl` | 每一条明细 + 判定（全量） |
| `abnormal-<日期>.jsonl` | 只含 `severity ∈ {crisis, abnormal, review}` |

事实的 `kind`：`visit`（就诊）· `prescription`（处方/医嘱，含药品名·规格·用量·频次·天数）·
`lab`（检验明细）· `exam`（检查结论）· `checkup`（体检结论）· `crisis`（危急值）· `trend`（单项历史）。
处方与体检结论在判定里都是 `recorded`（已记录），**不会进异常清单**。

目录 `0700`、文件 `0600`：里面是**明文 Cookie 与患者数据**。

**续跑**靠 `facts` 里已有的 `(日期, 患者, 类别, 来源 id)` 键；拉不到的接口**不落事实**，
所以下一轮会重试（空事实会进 done 集合、永远补不回来——这个坑踩过）。

## 5. 运维

* **对账**：每天把 `rosterTotal`、页面显示人数与采集到的报告数比一遍；`0` 条必须告警。
* **会话失效**：服务端可能回 `HTTP 200` + `{"status":401,"message":"登录超时"}`。
  判断成败要看 **body 里的业务状态码**，不能只看 HTTP 码。
* **告警条件**：退出码 `3`、`errors` 非空、当日条数较昨日偏离过大。
* 定时任务建议串起来：`collect.py` → `rules.py` → 通知。

## 6. 自测

```sh
python3 -m unittest discover -s tools/his/tests -t tools/his     # 82 个用例
python3 tools/his/mock_his.py --port 8099                        # 手工起假系统
```

两条**真浏览器**用例需要 `node` + 仓库里的 `playwright-core` + 一个 Chromium；
缺任一样会明确跳过（不会假装通过）。它们验的是只有真浏览器能回答的事：
扩展能不能装、内容脚本能不能注入、同源直查的 Cookie 与院区头有没有生效。

覆盖：参考区间（区间 / 单边 / 定性 / 分段 / 反序）、判定优先级（危急值 > 标志 > 区间 > 判不了）、
`M/N` 正常码、`haveCrisis` 降级、体检结论分级、处方归 `recorded`，以及端到端（起 mock → 采集 → 判定）、
`--mode person` 全量（两套 id / 处方 / 码值翻成人话 / 同名拒绝）、`--via-curl` 传输、续跑不重复、
缺 Cookie 必须失败、名单 0 条必须退出码 3。

## 7. 已知限制

* 体检小结里只有"结论条目"，其**数值明细**走单项历史（`itemHistory`）那条线；
* 检查报告多为描述型（无 `result`），结论在报告级字段里，本工具放进 `extra` 而不进异常清单；
* 参考区间的单位换算、年龄/性别分组区间尚未实现；
* 规则是"提示"而非诊断：`review` 那些条目就是刻意留给人的。

---

## 8. 三种用法，同一份判定

界面只有一份（`portal-app.js`），判定与聚合也只有一份（`portal-core.js`，是 `rules.py` v5
的移植，被 `tests/test_core_conformance.py` 逐条对照着）。换载体只换"数据怎么来"：

| 载体 | 数据来源 | 要不要后端 | 刷新后 | 装法 |
| --- | --- | --- | --- | --- |
| **后端页** `portal.py` | 服务端代取（Cookie 在服务端） | 要 | 不丢 | 打开一个网址 |
| **扩展**（本目录 `extension/`） | 浏览器**同源直查** | 不要 | 不丢（内容脚本重新挂载） | 加载已解压的扩展程序 |
| 书签小工具 / DevTools 片段 | 同上 | 不要 | 会丢，重跑一次 | 拖一个书签 / 粘一段代码 |

### 翻页：只取第一页会**安静地少三成**（真机实测）

这是本工具最容易出错、也最容易被忽略的一处。真机上同一个患者：

| 接口 | 服务端声称 | 只取第一页拿到 | 翻到底拿到 |
| --- | --- | --- | --- |
| 检验报告 `report/list` | 71 份 | 50 份 | **71 份** |
| 就诊病历 `clinic_record/page` | 175 条 | 19 条 | **76 条**（服务端只肯给这么多） |
| 判定条目 / 异常指标 | — | 517 / 12 | **767 / 19** |

也就是说，只取第一页会**漏掉 7 个异常指标**——而且看起来一切正常。三条实测经验都写进了代码与测试：

* **不能因为"这页不满 pageSize 就停"**：`clinic_record/page` 每页行数不定（19/15/30/15），
  第一页就不满 50，按老写法直接停在第一页；
* **相邻页会重叠、`total` 对不上账**：四页共 79 行去重后 76 条，而 `total` 说 175。
  所以翻页要翻到服务端不再给为止，然后**把"对不上账"报出来**，不假装取全了；
* **服务端忽略 pageNum 时要能收手**：否则会把同一页抄很多遍，还会因为"行数够了"
  误判成取全了。做法是比对相邻两页的 id 序列，一样就停，并记一条警告。

每条经验都有一个假系统模式对应（`IGNORE_PAGINATION` / `SHORT_PAGES` / `INFLATED_TOTAL`），
所以这些故障在测试里能被复现，而不是只在真机上偶遇。

### 缺 `registerId` 的就诊：拿不到处方，但要说出来

真机上 76 条就诊记录里有 **11 条没有 `registerId`**，而病历详情接口**硬要求**这个参数
（用 `recordsNo` 或 `id` 顶上去都会被拒："not exist"）。这类就诊记录本工具照样收
（日期/科室/诊断都在），但**处方明细取不到**，并且会记一条警告说明原因与病历号 ——
既不白费 11 次请求，也不把"接口失败"和"这条数据本来就没有"混为一谈。

### 为什么直查必须跑在病例系统自己的页面里（实测，不是推测）

* 会话**只在 Cookie 里**：只带 `x-auth-token` 请求头、不带 Cookie → `401 登录超时`；
* 真实 Cookie 是 **`SameSite=Lax`**：从别的源（包括本地 HTML 文件）发请求，浏览器根本不带它
  → 还是 `401`。实测把 Cookie 改成 `SameSite=None` 才通 —— 而这个属性由服务端决定，不在我们手里；
* 响应确实带 `Access-Control-Allow-Origin: *`，但 `*` 与"带凭据"互斥，而且自定义头会触发预检；
* 还需要一个**院区请求头**（真机上是 `x-current-hospital`），否则 `4000001 未选择院区`。

结论：界面要跑在**病例站点自己的源**里（扩展注入 / 书签 / 片段），这些约束就全都不存在了。

### 生成扩展（真实站点信息不进仓库）

```sh
python3 tools/his/build_extension.py \
    --endpoints net-dumps/his/endpoints.json \
    --host https://his.example.org \
    --out net-dumps/his/extension-build
```

然后 `chrome://extensions` → 打开"开发者模式" → "加载已解压的扩展程序" → 选产物目录。
病例系统页面右下角会出现「病例查询」。**权限是零项**：同源请求本来就带着会话，
所以不申请 `cookies`、不申请 `<all_urls>`。

两个只有真浏览器才暴露得出来的坑，已经写进代码注释与测试：

* 内容脚本注入的**内联**脚本会被 CSP 拦（`Executing inline script violates …`），
  所以配置走 `postMessage`、代码走 web_accessible_resource 的外部文件（`extension/bootstrap.js`）；
* `waitForSelector` 默认等**可见**元素，而 `#his-portal-root .card` 第一个匹配是默认隐藏的
  `#setup` —— 等它会白等到超时。
