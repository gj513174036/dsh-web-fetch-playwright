# Observation: NMPA 数据查询 — 境内生产药品 (domestic drugs)

Ticket #10. Produced with observe mode (`observe: true`, or `observePage` from the source) against
`https://datasearch.nmpa.gov.cn/datasearch/home-index.html` — the page the target
`nmpa-datasearch-domestic-drugs` starts on — and against the result page its submit opens.

To reproduce the query-page dump: fetch that URL with `observe: true` and **no target matching it**
(running the recipe navigates away from it). The result-page dump: run the recipe and observe the page
it adopts. `targetsFile` takes an absolute path — the plugin resolves it against the host process's
working directory, not this repository.

## What the page asks for

- A dataset tile per register (`<a title="境内生产药品">`), then one keyword field
  (`<input type="text" data-step="4" placeholder="请输入批准文号 / 产品名称 / …">`) and one icon-only
  submit (`<button data-step="5">`). Neither has an id worth freezing, and the submit has **no
  accessible name at all** — which is why the observation below cannot show it.
- The submit does not navigate: it calls the site's own endpoint
  (`…/data/nmpadata/countNums?itemIds=…&searchValue=…`, HTTP 200) and opens the result table **in a new
  tab** (`…/datasearch/search-result.html`). The endpoint is signed — a hand-made call answers
  `{"code":500,"message":"sign or timestamp is empty"}` — so there is no clean API to replay, which is
  why this site needs actions at all.
- The recipe therefore marks the submit `"opensPage": true`: the run waits for the tab, continues on it,
  and the fetch reads *that* document (ticket #10).

## The live replay, measured

```
web_fetch https://datasearch.nmpa.gov.cn/datasearch/home-index.html
actions: 1. waitFor text "使用提示" — met · 2. click selector "a[title=\"境内生产药品\"]" -> a — clicked · 3. type selector "input[data-step=\"4\"]" -> textbox (now "阿司匹林") — met · 4. click selector "button[data-step=\"5\"]" -> button (it opened a page; the rest of the target runs there) — clicked · 5. waitFor text "阿司匹林肠溶片" — met → final document https://datasearch.nmpa.gov.cn/datasearch/search-result.html (HTTP 200)
```

The rows read from the adopted page:

```
1 | 国药准字H23022137 | 阿司匹林肠溶片 | 黑龙江鼎恒升药业有限公司 | 86903728000027 | 详情
2 | 国药准字H14022774 | 阿酚咖敏片 | 山西国润制药有限公司 | 86902839000018 | 详情
3 | 国药准字H10950261 | 阿司匹林散 | 浙江普洛巨泰药业有限公司 | 86904667000055 | 详情
pager: 12345693 共 924 条 前往页
```

## The query page, as observe mode reported it

```
# Page state: 国家药品监督管理局数据查询

URL: https://datasearch.nmpa.gov.cn/datasearch/home-index.html
Counts: controls 24 (reachable 12), buttons 3, links 18, checkboxes 0 (unchecked 0), selects 0, forms 0, iframes 0

Visible text (head):
> 首页 政务服务门户 使用提示 药品 Drugs 医疗器械 Medical Devices 化妆品 Cosmetics 其它 Other 境内生产药品 境外生产药品 境内生产药品备案信息公示 境外生产药品备案信息公示 药品生产企业 药品经营企业 全国药品抽检 GMP认证 GSP认证 中药保护品种 执业药师注册人员 中药提取物备案公示 中药配方颗粒备案信息公示 非处方药中药目录 非处方药化学药品目录 药品出口销售证明 麻醉药品和精神药品品种目录 国家基本药物（2018年版） 疫苗说明书和标签数据库 互联网药品信息服务 GLP认证（2023年7月1日后认证信息） 兴奋剂目录 药品补充检验方法链接 新批准上市以及通过仿制药质量...链接 药物非临床安全性评价研究机构信...链接 药包材标准链接 生物制品批签发产品公示情况汇总链接 药物和医疗器械临床试验机构备案...链接 出口欧盟原料药证明文件申请链接 药品 温馨提示：如对基础数据信息有疑问，可点击“常见问题”进行查阅，企业用户可通过基础数据详情页面的“数据反馈”按钮在线反馈。 本站由国家药品监督管理局主办 版权所有：国家药品监督管理局 Copyright © NMPA All Rights Reserved 网站标识码bm35000001 备案序号:京ICP备13027807号 京公网安备11010202008311号 地址：北京市西城区

## Controls (17 of 17; reachable first)
1. [link] "首页"
2. [link] "政务服务门户"
3. [link] "使用提示"
4. [link] "药品 Drugs"
5. [link] "医疗器械 Medical Devices"
6. [link] "化妆品 Cosmetics"
7. [link] "其它 Other"
8. [text] "请选择"
9. [text] "请输入批准文号 / 产品名称 / 英文名称 / 商品名 / 剂型 / 规格 / 上市许可持有人 / 生产单位 / 产品类"
10. [link] "“常见问题”"
11. [link] "备案序号:京ICP备13027807号"
12. [link] "京公网安备11010202008311号"
13. [link] "首页" (not visible)
14. [link] "政务服务门户" (not visible)
15. [text] "请输入批准文号 / 产品名称 / 英文名称 / 商品名 / 剂型 / 规格 / 上市许可持有人 / 生产单位 / 产品类" (not visible)
16. [button] "展开" (not visible)
17. [link] "备案序号:京ICP备13027807号" (not visible)
```

## The result page the submit opened, as observe mode reported it

```
# Page state: 国家药品监督管理局数据查询

URL: https://datasearch.nmpa.gov.cn/datasearch/search-result.html
Counts: controls 63 (reachable 18), buttons 17, links 15, checkboxes 27 (unchecked 25), selects 0, forms 0, iframes 0

Visible text (head):
> 首页 政务服务门户 使用提示 境内生产药品 高级搜索 搜索结果： 境内生产药品 序号 批准文号 产品名称 生产单位 药品本位码 详情 1 国药准字H23022137 阿司匹林肠溶片 黑龙江鼎恒升药业有限公司 86903728000027 详情 2 国药准字H14022774 阿酚咖敏片 山西国润制药有限公司 86902839000018 详情 3 国药准字H10950261 阿司匹林散 浙江普洛巨泰药业有限公司 86904667000055 详情 4 国药准字H14022013 复方乙酰水杨酸片 山西津华晖星制药有限公司 86902897000517 详情 5 国药准字H12020916 复方乙酰水杨酸片 天津华津制药有限公司 86900867000116 详情 6 国药准字H37024011 阿司匹林片 山东绿因药业有限公司 86904140000039 详情 7 国药准字H13023363 阿司匹林肠溶片 邯郸滏荣制药有限公司 86902583000029 详情 8 国药准字H32023680 阿司匹林肠溶片 金陵药业股份有限公司南京金陵制... 86901529000048 详情 9 国药准字H23023496 阿司匹林维C肠溶片 哈尔滨市龙生北药生物工程股份有... 86903803000010 详情 10 国药准字H11022422 阿司匹林维C肠溶片 北京太洋药业股份有

## Controls (25 of 25; reachable first)
1. [link] "首页"
2. [link] "政务服务门户"
3. [link] "使用提示"
4. [text] "请输入批准文号 / 产品名称 / 英文名称 / 商品名 / 剂型 / 规格 / 上市许可持有人 / 生产单位 / 产品类"
5. [button] "详情"
6. [button] "详情"
7. [button] "详情"
8. [button] "详情"
9. [button] "详情"
10. [button] "详情"
11. [button] "详情"
12. [button] "详情"
13. [button] "详情"
14. [button] "详情"
15. [link] "说明"
16. [text] "请选择"
17. [link] "备案序号:京ICP备13027807号"
18. [link] "京公网安备11010202008311号"
19. [link] "首页" (not visible)
20. [link] "政务服务门户" (not visible)
21. [text] "请选择" - covered (not visible)
22. [link] "说明" (not visible)
23. [button] "close 高级搜索" (not visible)
24. [button] "Close" (not visible)
25. [link] "备案序号:京ICP备13027807号" (not visible)
```

## What the recipe is, and why

- `waitFor` the query page's own words (`使用提示`, a nav item) so the recipe acts on the register's home
  and not on whatever else that URL may serve.
- `click` the dataset tile by **selector** (`a[title="境内生产药品"]`): the tiles are `<a>` elements with
  **no `href`**, so neither a text nor a role candidate can reach them (an anchor without `href` has no
  link role, and the candidate control set is `a[href]`).
- `type` the keyword by selector (`input[data-step="4"]`) — the field has no id and its placeholder is a
  paragraph of field names, so the attribute is the only stable identity.
- `click` the submit by selector (`button[data-step="5"]`) with `"opensPage": true`. It is icon-only and
  unnamed, so no text or role candidate can name it either.
- `waitFor` a product name the query returns (`阿司匹林肠溶片`): the adopted tab is still loading when it is
  handed over, and a row of the searched listing is what proves the query ran with *this* keyword rather
  than showing a default listing.

**A gotcha worth writing down**: the text conditions compare against the page's raw visible text, while
`observe` renders its text head with whitespace collapsed. `药品 Drugs` is one control in the observation
and two words with a newline between them in the DOM, so a needle copied from the observation can fail on
whitespace alone. Pick a needle with no internal whitespace (`使用提示`, `阿司匹林肠溶片`).
