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

# 按姓名进（姓名+手机号 → 档案 id → 体检侧记录）
python3 tools/his/collect.py --mode person --name "张三" --telephone "13800000000" ...
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

### 从真机上换来的三条字段语义（很反直觉，别照直觉写）

1. **`haveCrisis` 不是危急值标志**：实测 1664 个检验明细里 1609 个是 `"1"`。真正的危急值在
   独立模块（`crisis` 端点）。把它当异常会一次刷出上千条假危急值。
2. **`abnormalTips` 的 `M`/`N` 是正常**：实测分布 `M`×1096、空×324、`H`×77、`L`×37、`N`×37、`P`×17。
   "非空即异常"会把 1096 条正常项判成异常。
3. **参考区间常常是分段的**，且方向写在 `resultRemark`（`↑`/`↓`）里，不是写在结果字符串里。

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
python3 -m unittest discover -s tools/his/tests -t tools/his     # 19 个用例，只用标准库
python3 tools/his/mock_his.py --port 8099                        # 手工起假系统
```

覆盖：参考区间（区间 / 单边 / 定性 / 分段 / 反序）、判定优先级（危急值 > 标志 > 区间 > 判不了）、
`M/N` 正常码、`haveCrisis` 降级、体检结论分级，以及端到端（起 mock → 采集 → 判定 → 断言五类判定
各就各位）、`--via-curl` 传输、续跑不重复、缺 Cookie 必须失败、名单 0 条必须退出码 3。

## 7. 已知限制

* 体检小结里只有"结论条目"，其**数值明细**走单项历史（`itemHistory`）那条线；
* 检查报告多为描述型（无 `result`），结论在报告级字段里，本工具放进 `extra` 而不进异常清单；
* 参考区间的单位换算、年龄/性别分组区间尚未实现；
* 规则是"提示"而非诊断：`review` 那 92 条就是刻意留给人的。
