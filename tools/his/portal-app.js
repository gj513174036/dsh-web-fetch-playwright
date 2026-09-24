/*!
 * 查询面板的界面层 —— 只认 `transport` 这个抽象，不认数据从哪来。
 *
 * 两种数据源共用这一份界面：
 *   * `portal-transport-http.js` —— 后端服务（Python）取数，页面只管展示；
 *   * `portal-direct.js`        —— 浏览器里同源直查（片内页面/扩展），无后端。
 *
 * 界面的判定逻辑**一行都没有**：判定与聚合全在 `portal-core.js`（有 Python 对照测试），
 * 这里只做"把结论画出来"。所以换载体不会换结论。
 *
 * 用 `mount(el, transport)` 挂载；`el` 里的查询全部走 `q()` 作用域查询，
 * 不用 `document.getElementById` —— 因为要注入到别人的页面里，id 会撞车。
 */
(function (root) {
  "use strict";

  if (!root.HisCore) {
    throw new Error("portal-app.js 需要先加载 portal-core.js（它提供 window.HisCore）");
  }

  const SKELETON = `
  <header>
    <div class="brand">
      <h1>病例查询端口</h1>
      <span class="tag" id="health">正在连接…</span>
    </div>
  </header>
  <main>
    <div class="card" id="setup" style="display:none"></div>
    <div class="card">
      <h2>① 查人</h2>
      <div class="row">
        <input id="name" placeholder="姓名（必填）" autocomplete="off">
        <input id="phone" placeholder="手机号（可选，用来区分同名）" autocomplete="off">
        <button class="primary" id="btn-search">查询</button>
        <button class="ghost" id="btn-clear">清空</button>
      </div>
      <div class="hint">只输姓名会列出<strong>全部</strong>同名的人 —— 由你点选决定是谁，程序不会替你猜。</div>
      <div id="search-msg" style="margin-top:12px"></div>
      <div id="cands" style="margin-top:12px"></div>
    </div>
    <div id="progress" class="card" style="display:none">
      <h2>② 正在取这个人的全部记录</h2>
      <div class="row" style="justify-content:space-between">
        <div><b id="pg-phase">准备中</b> <span class="muted" id="pg-count"></span></div>
        <div class="dim" id="pg-time"></div>
      </div>
      <div class="bar"><i id="pg-bar" style="width:2%"></i></div>
      <div class="hint">首次查询要把这个人的就诊、处方、检验、检查、体检全部拉一遍；取回的数据落在这个浏览器里，不经过任何第三方。</div>
    </div>
    <div id="err" class="card" style="display:none"></div>
    <div id="detail"></div>
  </main>`;

  /**
   * 挂载面板。
   *
   * `transport` 需要提供：
   *   status()                        → {label, detail, warnings?, setup?}
   *   search(name, telephone)         → [候选…]
   *   collect(candidate, {refresh, onProgress}) → 视图
   *   itemHistory(candidate, itemName)          → 趋势卡数据
   */
  function mount(el, transport) {
    const q = (selector) => el.querySelector(selector);
    const qa = (selector) => Array.from(el.querySelectorAll(selector));
    let view = null;
    let current = null;
    let pollTimer = null;
    let tickTimer = null;

    el.classList.add("his-portal");
    el.innerHTML = SKELETON;

    /* ================= 渲染（两种数据源共用） ================= */

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const SEV = {crisis:0, abnormal:1, review:2, info:3};
const SEV_TEXT = {crisis:"危急值", abnormal:"异常", review:"待复核", info:"正常"};

function verdictChip(point){
  const sev = point.severity || "info";
  if (sev === "crisis") return '<span class="chip crisis">危急值</span>';
  if (sev === "abnormal"){
    const v = point.verdict;
    if (v === "high") return '<span class="chip abnormal">偏高</span>';
    if (v === "low") return '<span class="chip low">偏低</span>';
    if (v === "positive") return '<span class="chip abnormal">阳性</span>';
    return '<span class="chip abnormal">异常</span>';
  }
  if (sev === "review") return '<span class="chip review">待复核</span>';
  if (point.verdict === "negative") return '<span class="chip normal">阴性</span>';
  if (point.verdict === "recorded") return '<span class="chip info">已记录</span>';
  return '<span class="chip normal">正常</span>';
}
function sevChip(sev, text){
  return `<span class="chip ${esc(sev)}">${esc(text ?? SEV_TEXT[sev] ?? sev)}</span>`;
}

/* ---------- 迷你趋势图：把参考区间画成带，点按判定着色 ---------- */
function dateMs(text){
  const t = Date.parse(String(text || "") + "T00:00:00");
  return Number.isNaN(t) ? null : t;
}
function sparkline(series, height){
  const pts = (series.numeric || []);
  if (pts.length === 0) return '<div class="dim">这一项没有数值（结论型条目），因此画不出趋势。</div>';
  if (pts.length === 1) return '<div class="dim">只有一个数值点，画不出趋势。</div>';
  const H = height || 170, W = 660, PL = 58, PR = 18, PT = 16, PB = 30;
  let times = pts.map((p) => dateMs(p.date));
  if (times.some((t) => t === null)) times = pts.map((_, i) => i);
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const vals = pts.map((p) => Number(p.value));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const refLow = (series.refLow === null || series.refLow === undefined) ? null : Number(series.refLow);
  const refHigh = (series.refHigh === null || series.refHigh === undefined) ? null : Number(series.refHigh);
  if (refLow !== null) lo = Math.min(lo, refLow);
  if (refHigh !== null) hi = Math.max(hi, refHigh);
  if (hi === lo){ hi = lo + Math.abs(lo || 1) * 0.2 + 1; lo = lo - Math.abs(lo || 1) * 0.2 - 1; }
  const pad = (hi - lo) * 0.18; lo -= pad; hi += pad;
  const X = (t) => t1 === t0 ? PL + (W - PL - PR) / 2 : PL + (t - t0) / (t1 - t0) * (W - PL - PR);
  const Y = (v) => PT + (hi - v) / (hi - lo) * (H - PT - PB);
  const parts = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`);
  // 参考区间带
  if (refLow !== null && refHigh !== null){
    const y1 = Y(refHigh), y2 = Y(refLow);
    parts.push(`<rect x="${PL}" y="${Math.min(y1,y2).toFixed(1)}" width="${W-PL-PR}" ` +
      `height="${Math.abs(y2-y1).toFixed(1)}" fill="#3fb950" opacity="0.13"/>`);
    parts.push(`<line x1="${PL}" x2="${W-PR}" y1="${y1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#3fb950" stroke-dasharray="4 4" opacity="0.5"/>`);
    parts.push(`<line x1="${PL}" x2="${W-PR}" y1="${y2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#3fb950" stroke-dasharray="4 4" opacity="0.5"/>`);
  } else if (refHigh !== null){
    parts.push(`<line x1="${PL}" x2="${W-PR}" y1="${Y(refHigh).toFixed(1)}" y2="${Y(refHigh).toFixed(1)}" stroke="#3fb950" stroke-dasharray="4 4" opacity="0.5"/>`);
  } else if (refLow !== null){
    parts.push(`<line x1="${PL}" x2="${W-PR}" y1="${Y(refLow).toFixed(1)}" y2="${Y(refLow).toFixed(1)}" stroke="#3fb950" stroke-dasharray="4 4" opacity="0.5"/>`);
  }
  // 刻度
  for (let i = 0; i <= 3; i++){
    const v = lo + (hi - lo) * i / 3, y = Y(v);
    parts.push(`<line x1="${PL}" x2="${W-PR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2a323d"/>`);
    parts.push(`<text x="${PL-8}" y="${(y+4).toFixed(1)}" fill="#6b7681" font-size="11" text-anchor="end">${v.toFixed(2)}</text>`);
  }
  // 折线
  const path = pts.map((p, i) => `${i ? "L" : "M"}${X(times[i]).toFixed(1)},${Y(Number(p.value)).toFixed(1)}`).join(" ");
  parts.push(`<path d="${path}" fill="none" stroke="#58a6ff" stroke-width="2" opacity="0.85"/>`);
  // 点 + 数值
  pts.forEach((p, i) => {
    const sev = p.severity || "info";
    const color = sev === "crisis" ? "#ff4d4f" : sev === "abnormal"
      ? (p.verdict === "low" ? "#4db8ff" : "#ff9a4d")
      : sev === "review" ? "#e3b341" : "#3fb950";
    const x = X(times[i]), y = Y(Number(p.value));
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${sev === "info" ? 3.5 : 5}" ` +
      `fill="${color}" stroke="#0f1216" stroke-width="1.5">` +
      `<title>${esc(p.date)}　${esc(p.text)}${esc(series.unit || "")}　${esc(SEV_TEXT[sev] || sev)}` +
      `${p.reference ? "　参考 " + esc(p.reference) : ""}${p.why ? "　" + esc(p.why) : ""}</title></circle>`);
    if (pts.length <= 8){
      parts.push(`<text x="${x.toFixed(1)}" y="${(y-10).toFixed(1)}" fill="${color}" font-size="11" text-anchor="middle">${esc(p.text)}</text>`);
    }
  });
  // 时间轴
  const marks = pts.length <= 8 ? pts.map((_, i) => i) : [0, Math.floor((pts.length-1)/2), pts.length-1];
  [...new Set(marks)].forEach((i) => {
    parts.push(`<text x="${X(times[i]).toFixed(1)}" y="${H-10}" fill="#6b7681" font-size="11" text-anchor="middle">${esc(pts[i].date)}</text>`);
  });
  parts.push("</svg>");
  return parts.join("");
}

/* ---------- 表格 ---------- */
function pointTable(series){
  const rows = [...series.points].reverse().map((p) => {
    const delta = "";
    return `<tr>
      <td class="num">${esc(p.date)}</td>
      <td class="num"><b>${esc(p.text || "—")}</b> <span class="dim">${esc(p.unit || "")}</span></td>
      <td class="mono">${esc(p.reference || "—")}</td>
      <td>${verdictChip(p)}</td>
      <td class="mono">${esc(p.flagText || p.arrow || "—")}</td>
      <td class="dim">${esc(p.why || "")}<br>${esc(p.source || "")} <span class="mono">${esc(p.ruleId || "")}</span></td>
    </tr>`;
  }).join("");
  return `<table><thead><tr><th>日期</th><th>结果</th><th>参考区间</th><th>判定</th><th>标志</th>
    <th>依据 / 出处</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function metricCard(series){
  const sev = series.worst;
  const latest = series.latest || {};
  const cls = latest.verdict === "high" ? "up" : latest.verdict === "low" ? "down"
    : sev === "crisis" ? "crisis" : (latest.severity === "info" ? "normal" : "");
  let deltaText = "";
  if (series.delta !== null && series.delta !== undefined && series.numeric.length >= 2){
    const sign = series.delta > 0 ? "↑ +" : series.delta < 0 ? "↓ " : "→ ";
    deltaText = `　较上次 <b>${sign}${Math.abs(series.delta)}</b>`;
  }
  const stale = (latest.severity === "info" && sev !== "info")
    ? ` <span class="chip review">历史异常，最近一次正常</span>` : "";
  const unitConflict = series.unitConflict
    ? ` <span class="chip review">单位不一致，请核对</span>` : "";
  // 结论型条目（危急值模块里的"肺结节"这种）没有数值，把"凭什么"直接摆在卡片上
  const noValue = !latest.text;
  const sub = noValue
    ? `${esc(latest.why || "")}　<span class="dim">${esc(latest.date || "")}　${esc(latest.source || "")}</span>`
    : `最近 ${esc(latest.date || "")}　参考 <span class="mono">${esc(series.reference || "—")}</span>${deltaText}　
       <span class="dim">${series.numeric.length} 个数值点 / ${series.dates} 个日期</span>`;
  // 单项历史只对检验侧的项目有意义（危急值模块给的不是项目编码）
  const canHistory = series.points.some((p) => p.kind === "lab" || p.kind === "trend");
  return `<div class="metric ${esc(sev)}">
    <div class="head">
      <div>
        <div class="name">${esc(series.name)}${unitConflict}</div>
        <div class="val ${cls}">${esc(latest.text || "—")}<small>${esc(series.unit || "")}</small></div>
        <div class="sub">${sub}</div>
      </div>
      <div class="nowrap">${verdictChip(latest)}${sevChip(sev)}${stale}</div>
    </div>
    <div class="chart">${sparkline(series)}</div>
    <details><summary>逐次明细（${series.points.length} 条）</summary>${pointTable(series)}</details>
    ${canHistory ? `<div class="row" style="margin-top:8px">
      <button class="ghost" data-history="${esc(series.name)}" data-key="${esc(series.key)}">拉更长的历史（单项历史接口）</button>
      <span class="dim" id="hist-${esc(series.key)}"></span>
    </div>` : ""}
  </div>`;
}

/* ---------- 各标签页 ---------- */
function panelAbnormal(){
  if (!view.abnormal.length) return `<div class="card">没有判定为异常/待复核的指标。${view.counts.items ? "" : "（没有取到任何明细）"}</div>`;
  const head = `<div class="hint" style="margin-bottom:12px">同一个指标的多次检查已经合并成一张卡：
    严重度取**历史上最重**的那次，数值取**最近一次**。绿带是参考区间，点按判定着色，鼠标停在点上可看当时的依据。</div>`;
  return head + view.abnormal.map(metricCard).join("");
}
function panelTrends(){
  if (!view.trends.length) return `<div class="card">没有跨两次以上检查的指标。</div>`;
  return `<div class="card"><div class="row"><input id="trend-filter" placeholder="过滤指标名…" style="min-width:260px">
    <span class="dim">共 ${view.trends.length} 个指标有 ≥2 次数值结果</span></div></div>` +
    `<div id="trend-list">` + view.trends.map((s) =>
      `<div class="trend-item" data-name="${esc(s.name)}">
        <div class="row" style="justify-content:space-between">
          <b>${esc(s.name)}</b>
          <span>${verdictChip(s.latest)} <span class="dim">${s.numeric.length} 点</span></span>
        </div>
        <div class="dim">最近 ${esc(s.latest.date || "")}：${esc(s.latest.text || "")}${esc(s.unit || "")}
          　参考 ${esc(s.reference || "—")}</div>
        <details><summary>展开趋势</summary><div class="chart">${sparkline(s, 140)}</div></details>
      </div>`).join("") + `</div>`;
}
function panelVisits(){
  if (!view.visits.length) return `<div class="card">没有就诊记录。</div>`;
  return view.visits.map((v) => `<div class="card">
    <div class="row" style="justify-content:space-between">
      <div><b>${esc(v.date)}</b> ${v.deptName ? "· " + esc(v.deptName) : ""}
        ${v.recordsNo ? `<span class="dim mono">病历号 ${esc(v.recordsNo)}</span>` : ""}</div>
      <span class="dim">${v.prescriptions.length} 条处方/医嘱</span>
    </div>
    ${v.diagnoses.length ? `<div class="row" style="margin-top:8px">${v.diagnoses.map((d) => `<span class="chip info">${esc(d)}</span>`).join("")}</div>` : ""}
    ${v.mainSuit ? `<div class="sub muted" style="margin-top:8px">主诉：${esc(v.mainSuit)}</div>` : ""}
    ${v.prescriptions.length ? `<table><thead><tr><th>药品/项目</th><th>规格</th><th>用量</th><th>类别</th><th>状态</th><th>金额</th></tr></thead><tbody>
      ${v.prescriptions.map((p) => `<tr><td>${esc(p.itemName)}</td><td class="mono">${esc(p.spec || "—")}</td>
        <td>${esc(p.summary || "—")}</td><td>${esc(p.orderType || "—")}</td>
        <td>${esc(p.status || "—")}</td><td class="num">${p.price === null || p.price === undefined ? "—" : esc(p.price)}</td></tr>`).join("")}
      </tbody></table>` : `<div class="dim" style="margin-top:6px">这次就诊没有取到处方/医嘱明细。</div>`}
  </div>`).join("");
}
function panelLabs(){
  if (!view.labs.length) return `<div class="card">没有检验报告。</div>`;
  return view.labs.map((r) => `<div class="card">
    <div class="row" style="justify-content:space-between">
      <div><b>${esc(r.date)}</b> · ${esc(r.group || "检验")}</div>
      <span>${r.abnormal ? `<span class="chip abnormal">${r.abnormal} 项异常</span>` : `<span class="chip normal">全部正常</span>`}
        <span class="dim">${r.items.length} 项</span></span>
    </div>
    <details${r.abnormal ? " open" : ""}><summary>逐项结果</summary>
      <table><thead><tr><th>项目</th><th>结果</th><th>单位</th><th>参考</th><th>判定</th><th>依据</th></tr></thead><tbody>
      ${r.items.map((it) => `<tr><td>${esc(it.itemName)}</td><td class="num"><b>${esc(it.result ?? "—")}</b></td>
        <td class="dim">${esc(it.unit || "")}</td><td class="mono">${esc(it.reference || "—")}</td>
        <td>${verdictChip(it)}</td><td class="dim">${esc(it.why || "")} <span class="mono">${esc(it.ruleId || "")}</span></td></tr>`).join("")}
      </tbody></table></details>
  </div>`).join("");
}
function panelExams(){
  if (!view.exams.length) return `<div class="card">没有检查报告。</div>`;
  return view.exams.map((r) => `<div class="card">
    <div class="row" style="justify-content:space-between">
      <div><b>${esc(r.date)}</b> · ${esc(r.group || "检查")}</div>
      <span class="dim">${esc(r.doctor || "")}</span>
    </div>
    <div class="conclusion">${esc(r.conclusion || "（这份报告没有结论文本）")}</div>
  </div>`).join("");
}
function panelCheckups(){
  if (!view.checkups.length) return `<div class="card">没有体检记录${view.patient.hmsUserId ? "" : "（这个人没有档案侧 id）"}。</div>`;
  return view.checkups.map((c) => `<div class="card">
    <div class="row" style="justify-content:space-between">
      <div><b>${esc(c.date)}</b> · ${esc(c.medicalType || "体检")}${c.medicalGroup ? " / " + esc(c.medicalGroup) : ""}</div>
      <span class="dim mono">体检号 ${esc(c.medicalNo || "—")}${c.grade ? " · 分级 " + esc(c.grade) : ""}</span>
    </div>
    <div class="row" style="margin-top:10px">
      ${c.diagnoses.length ? c.diagnoses.map((d) => `<span class="chip ${d.severity === "abnormal" ? "abnormal" : "info"}"
        title="${esc(d.why || "")}">${esc(d.name)}${d.levelName ? " · " + esc(d.levelName) : ""}</span>`).join("")
        : '<span class="dim">没有结论条目</span>'}
    </div>
    <div class="hint">这些是体检**结论/既往诊断**（带分级），不是化验数值，所以不进异常清单；
      数值项在「异常指标」「全部趋势」里看。</div>
  </div>`).join("");
}
function panelCrises(){
  if (!view.crises.length) return `<div class="card">没有危急值事件。</div>`;
  return `<div class="card"><table><thead><tr><th>日期</th><th>项目</th><th>结果</th><th>级别</th>
    <th>处理状态</th><th>相关诊断</th><th>出处</th></tr></thead><tbody>
    ${view.crises.map((c) => `<tr><td class="num">${esc(c.date || "—")}</td><td>${esc(c.itemName || "—")}</td>
      <td class="num">${esc(c.result ?? "—")} <span class="dim">${esc(c.unit || "")}</span></td>
      <td>${esc(c.level ?? "—")}</td><td>${esc(c.status || "—")}</td>
      <td>${esc(c.disease || "—")}</td><td class="dim">${esc(c.source || "")}</td></tr>`).join("")}
    </tbody></table></div>`;
}
function panelReview(){
  if (!view.review.length) return `<div class="card">没有需要人工复核的条目。</div>`;
  return `<div class="card"><div class="hint" style="margin-bottom:10px">这一档是**故意**留给人看的：
    规则判不了（既无异常标志、又无法解析成数值），所以既不说是异常，也不假装正常。</div>
    <table><thead><tr><th>日期</th><th>项目</th><th>结果</th><th>参考</th><th>为什么判不了</th><th>出处</th></tr></thead><tbody>
    ${view.review.map((r) => `<tr><td class="num">${esc(r.date || "—")}</td><td>${esc(r.itemName)}</td>
      <td>${esc(r.result ?? "—")}</td><td class="mono">${esc(r.reference || "—")}</td>
      <td class="dim">${esc(r.why || "")}<br><span class="mono">${esc(r.ruleId || "")}</span></td>
      <td class="dim">${esc(r.source || "")}</td></tr>`).join("")}
    </tbody></table></div>`;
}
function panelAudit(){
  const kv = (obj) => Object.entries(obj).sort((a,b) => b[1]-a[1])
    .map(([k,v]) => `<tr><td class="mono">${esc(k)}</td><td class="num">${v}</td></tr>`).join("");
  const m = view.meta || {};
  const errs = (m.errors || []);
  return `<div class="card">
    <h3>采集口径</h3>
    <table><tbody>
      <tr><td>采集时间</td><td class="mono">${esc(m.collectedAt || "")}</td></tr>
      <tr><td>事实日期标签</td><td class="mono">${esc(m.day || "")}</td></tr>
      <tr><td>会话</td><td class="mono">${esc(m.session || "")}</td></tr>
      <tr><td>事实文件</td><td class="mono">${esc(m.factsPath || "")}</td></tr>
      <tr><td>原文文件</td><td class="mono">${esc(m.rawPath || "")}</td></tr>
      <tr><td>字典</td><td class="mono">${esc(JSON.stringify(m.dictionaries || {}))}</td></tr>
      <tr><td>本次新采事实</td><td class="num">${esc((m.summary || {}).facts ?? "—")}</td></tr>
    </tbody></table>
    ${errs.length ? `<div class="warn" style="margin-top:12px"><b>${errs.length} 个接口调用失败</b>
      <div class="mono" style="margin-top:6px">${errs.map(esc).join("<br>")}</div></div>`
      : `<div class="chip ok" style="margin-top:12px">没有接口报错</div>`}
  </div>
  <div class="flex">
    <div class="card grow"><h3>判定分布（verdict）</h3><table><tbody>${kv(view.audit.byVerdict)}</tbody></table></div>
    <div class="card grow"><h3>依据分布（ruleId）</h3><table><tbody>${kv(view.audit.byRule)}</tbody></table></div>
    <div class="card grow"><h3>事实条数（kind）</h3><table><tbody>${kv(view.audit.byKind)}</tbody></table></div>
  </div>`;
}

/* ---------- 渲染整页 ---------- */
const TABS = [
  ["abnormal", "异常指标", panelAbnormal],
  ["trends",   "全部趋势", panelTrends],
  ["visits",   "就诊与处方", panelVisits],
  ["labs",     "检验报告", panelLabs],
  ["exams",    "检查报告", panelExams],
  ["checkups", "体检", panelCheckups],
  ["crises",   "危急值", panelCrises],
  ["review",   "待人工复核", panelReview],
  ["audit",    "审计", panelAudit],
];

function render(){
  if (!view) return;
  const p = view.patient, c = view.counts;
  const kpi = (n, label, cls) => `<div class="kpi ${cls || ""}"><b>${n}</b><span>${label}</span></div>`;
  const tabsHtml = TABS.map(([id, label], i) =>
    `<button data-tab="${id}" class="${i === 0 ? "on" : ""}">${label}${
      id === "abnormal" && c.abnormalItems ? ` (${c.abnormalItems})` : ""}${
      id === "review" && c.reviewRows ? ` (${c.reviewRows})` : ""}${
      id === "crises" && c.crises ? ` (${c.crises})` : ""}</button>`).join("");
  q("#detail").innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2 style="margin:0">${esc(p.name)}
            <span class="dim">${esc(p.sex || "")}${p.age ? " · " + esc(p.age) + " 岁" : ""}</span></h2>
          <div class="dim" style="margin-top:4px">
            ${esc(p.telephoneMasked || "")}　身份证 ${esc(p.identityCardMasked || "—")}　
            <span class="mono">HIS ${esc((p.hisUserId || "").slice(-8) || "—")} / 档案 ${esc((p.hmsUserId || "").slice(-8) || "—")}</span>
          </div>
        </div>
        <div class="row">
          <button class="ghost" id="btn-refresh">重新采集（忽略缓存）</button>
          <button class="ghost" id="btn-json">导出 JSON</button>
          <button class="ghost" id="btn-csv">导出异常 CSV</button>
        </div>
      </div>
      <div class="kpis">
        ${kpi(c.abnormalItems, "异常指标", c.abnormalItems ? "warm" : "")}
        ${kpi(c.crisis, "其中危急值", c.crisis ? "hot" : "")}
        ${kpi(c.reviewItems, "其中待复核", c.reviewItems ? "ask" : "")}
        ${kpi(c.visits, "就诊次数")}
        ${kpi(c.prescriptions, "处方/医嘱")}
        ${kpi(c.labs, "检验报告")}
        ${kpi(c.exams, "检查报告")}
        ${kpi(c.checkups, "体检次数")}
        ${kpi(c.items, "判定条目")}
      </div>
      ${view.meta.errors && view.meta.errors.length
        ? `<div class="warn" style="margin-top:12px">有 ${view.meta.errors.length} 个接口调用失败，
           结果可能不完整 —— 详情见「审计」页。</div>` : ""}
      ${!p.hmsUserId ? `<div class="warn" style="margin-top:12px">这个人没有档案侧 id（hmsUserId）：
        体检、单项历史、危急值都取不到。</div>` : ""}
    </div>
    <div class="tabs">${tabsHtml}</div>
    ${TABS.map(([id, , fn], i) => `<div class="panel ${i === 0 ? "on" : ""}" data-panel="${id}">${fn()}</div>`).join("")}`;

  q("#detail").querySelectorAll(".tabs button").forEach((btn) => {
    btn.onclick = () => {
      q("#detail").querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b === btn));
      q("#detail").querySelectorAll(".panel").forEach((panel) =>
        panel.classList.toggle("on", panel.dataset.panel === btn.dataset.tab));
    };
  });
  q("#detail").querySelectorAll("[data-history]").forEach((btn) => {
    btn.onclick = () => pullHistory(btn);
  });
  const refresh = q("#btn-refresh");
  if (refresh) refresh.onclick = () => current && pick(current, true);
  const jsonBtn = q("#btn-json");
  if (jsonBtn) jsonBtn.onclick = () => download(`patient-${p.name}-${view.meta.day}.json`,
    JSON.stringify(view, null, 2), "application/json");
  const csvBtn = q("#btn-csv");
  if (csvBtn) csvBtn.onclick = () => download(`abnormal-${p.name}-${view.meta.day}.csv`,
    abnormalCsv(), "text/csv");
  const filter = q("#trend-filter");
  if (filter) filter.oninput = () => {
    const q = filter.value.trim().toLowerCase();
    q("#trend-list").querySelectorAll(".trend-item").forEach((node) => {
      node.style.display = (!q || node.dataset.name.toLowerCase().includes(q)) ? "" : "none";
    });
  };
}

function abnormalCsv(){
  const head = ["指标", "最近日期", "最近值", "单位", "参考区间", "严重度", "最近判定",
    "历史点数", "数值点数", "较上次", "全部值(日期:值)", "依据", "规则"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(",")];
  view.abnormal.forEach((s) => {
    const l = s.latest || {};
    lines.push([s.name, l.date, l.text, s.unit, s.reference, SEV_TEXT[s.worst] || s.worst,
      l.verdict, s.points.length, s.numeric.length, s.delta ?? "",
      s.points.map((p) => `${p.date}:${p.text}`).join(" | "), l.why, l.ruleId].map(q).join(","));
  });
  return "\ufeff" + lines.join("\r\n");
}
function download(filename, text, type){
  const url = URL.createObjectURL(new Blob([text], {type: type + ";charset=utf-8"}));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}


    /* ================= 交互 ================= */

    function showError(message) {
      q("#err").style.display = "";
      q("#err").innerHTML = `<div class="err"><b>出错了</b><div style="margin-top:6px">${esc(message)}</div>
        <div class="hint">若是"登录超时"，说明会话失效了：在医院系统里重新登录一次，再运行本工具。</div></div>`;
    }
    function clearError() { q("#err").style.display = "none"; }

    function showProgress(phase, done, total) {
      q("#progress").style.display = "";
      q("#pg-phase").textContent = phase || "处理中";
      q("#pg-count").textContent = total > 1 ? ` ${done}/${total}` : "";
      q("#pg-bar").style.width = Math.max(3, Math.min(100, total > 1 ? (done / total) * 100 : 40)) + "%";
    }
    function hideProgress() {
      q("#progress").style.display = "none";
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    async function search() {
      const name = q("#name").value.trim();
      const phone = q("#phone").value.trim();
      clearError();
      q("#detail").innerHTML = "";
      view = null;
      current = null;
      if (!name) {
        q("#search-msg").innerHTML = '<div class="warn">请至少输入姓名。</div>';
        return;
      }
      q("#btn-search").disabled = true;
      q("#search-msg").innerHTML = '<span class="muted">查询中…</span>';
      try {
        const list = await transport.search(name, phone);
        if (!list.length) {
          q("#search-msg").innerHTML = `<div class="warn">没有找到「${esc(name)}」。
            换个写法，或确认这个名字在档案库里存在。</div>`;
          q("#cands").innerHTML = "";
          return;
        }
        q("#search-msg").innerHTML = list.length > 1
          ? `<div class="warn">有 <b>${list.length}</b> 个「${esc(name)}」—— 同名。请按手机号/身份证尾号点选。</div>`
          : `<div class="chip ok">找到 1 个「${esc(name)}」</div>`;
        q("#cands").innerHTML = list.map((candidate, index) => `
          <div class="cand" data-i="${index}">
            <div>
              <div class="who">${esc(candidate.name)}
                <span class="dim">${esc(candidate.sex || "")}${candidate.age ? " · " + esc(candidate.age) + " 岁" : ""}</span>
                ${candidate.phoneMatch ? '<span class="chip ok">手机号一致</span>' : ""}</div>
              <div class="ids">${esc(candidate.telephoneMasked || "无手机号")}　身份证 ${esc(candidate.identityCardMasked || "—")}
                　<span class="mono">HIS ${esc((candidate.hisUserId || "—").slice(-8))} / 档案 ${esc((candidate.hmsUserId || "—").slice(-8))}</span></div>
            </div>
            <div class="go">查看全部记录 →</div>
          </div>`).join("");
        qa(".cand").forEach((node) => {
          node.onclick = () => pick(list[Number(node.dataset.i)]);
        });
      } catch (error) {
        q("#search-msg").innerHTML = "";
        showError(error.message);
      } finally {
        q("#btn-search").disabled = false;
      }
    }

    async function pick(candidate, refresh) {
      current = candidate;
      clearError();
      qa(".cand").forEach((node) => node.classList.remove("sel"));
      showProgress("提交任务…", 0, 1);
      const started = Date.now();
      tickTimer = setInterval(() => {
        q("#pg-time").textContent = `已用 ${Math.round((Date.now() - started) / 1000)} 秒`;
      }, 1000);
      try {
        const result = await transport.collect(candidate, {
          refresh: Boolean(refresh),
          onProgress: (phase, done, total) => showProgress(phase, done, total),
        });
        hideProgress();
        view = result;
        render();
        q("#health").textContent = transport.label || "";
        window.scrollTo({ top: q("#detail").offsetTop - 70, behavior: "smooth" });
      } catch (error) {
        hideProgress();
        showError(error.message);
      }
    }

    async function pullHistory(button) {
      const name = button.dataset.history;
      const key = button.dataset.key;
      const out = q(`#hist-${key}`);
      button.disabled = true;
      out.textContent = "正在拉取…";
      try {
        const series = await transport.itemHistory(current || view.patient, name);
        out.innerHTML = `拿到 ${series.points.length} 个历史点`;
        const holder = document.createElement("div");
        holder.innerHTML = `<div class="sep"></div>
          <h3>单项历史（${esc(series.name)}）—— 来自单项历史接口</h3>
          <div class="chart">${sparkline(series, 140)}</div>
          ${pointTable(series)}`;
        button.closest(".metric").appendChild(holder);
        button.remove();
      } catch (error) {
        out.innerHTML = `<span class="err" style="padding:2px 8px">${esc(error.message)}</span>`;
        button.disabled = false;
      }
    }

    async function showStatus() {
      try {
        const status = await transport.status();
        const warnings = (status.warnings || []).length
          ? `　<span class="chip review">${esc(status.warnings[0])}</span>` : "";
        q("#health").innerHTML = `${esc(status.label || "")}${status.detail ? "　" + esc(status.detail) : ""}${warnings}`;
        if (status.setup) {
          q("#setup").style.display = "";
          q("#setup").innerHTML = `<h2>${esc(status.setup.title || "需要设置")}</h2>
            <div class="row">
              <input id="setup-value" value="${esc(status.setup.value || "")}"
                     placeholder="${esc(status.setup.placeholder || "")}" style="min-width:320px">
              <button class="primary" id="setup-save">保存</button>
            </div>
            <div class="hint">${esc(status.setup.hint || "")}</div>`;
          q("#setup-save").onclick = async () => {
            await status.setup.onSave(q("#setup-value").value.trim());
            await showStatus();
          };
        } else {
          q("#setup").style.display = "none";
        }
      } catch (error) {
        q("#health").textContent = `连接不上：${error.message}`;
      }
    }

    q("#btn-search").onclick = search;
    q("#btn-clear").onclick = () => {
      q("#name").value = "";
      q("#phone").value = "";
      q("#cands").innerHTML = "";
      q("#search-msg").innerHTML = "";
      q("#detail").innerHTML = "";
      view = null;
      current = null;
      clearError();
    };
    ["name", "phone"].forEach((id) => {
      q(`#${id}`).addEventListener("keydown", (event) => { if (event.key === "Enter") search(); });
    });
    q("#name").focus();
    showStatus();

    return {
      refresh: () => current && pick(current, true),
      get view() { return view; },
      showStatus,
    };
  }

  root.HisPortalApp = { mount };
})(typeof globalThis !== "undefined" ? globalThis : this);
