/*!
 * 病例查询端口的判定与聚合核心 —— `rules.py` v5 与 `portal.py` 的逐行移植。
 *
 * 为什么要有这一份：浏览器里没有 Python，而片内页面（同源直查）必须在浏览器里
 * 判定"这项凭什么算异常"。但判定规则**只能有一个行为定义**，所以这份 JS 是被
 * 「Python↔JS 一致性对照测试」盯着的（`tests/test_core_conformance.py`）：
 * 同一批事实喂给两边，verdict/severity/ruleId/参考区间/why 必须逐条相同，
 * 不一致以 Python 为准。
 *
 * 移植时必须小心的三件事：
 *   1. Python 的 `_truthy` 用的是 `value or ""`，0 和 False 都算空 → 这里用 `!v` 对齐；
 *   2. Python 的 `str(float)` 会给整数补 `.0`（`str(419.0) === "419.0"`），
 *      而 JS 的 `String(419) === "419"` —— why 文案要一致就得补（见 `pyNum`）；
 *   3. Python 的 `repr()` 用单引号、`None` 也是大写 —— 见 `pyRepr`。
 *
 * 站点相关的路径**不在这个文件里**：它只认事实行（fact）与明细项（item），
 * 由调用方（后端或片内直查）去取数。这样这一份可以公开，内网路径留在仓库之外。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HisCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const RULE_VERSION = "5";

  /** 严重度排序：数字越小越重。过滤异常用 severity，不用 verdict —— 见 rules.py 注释。 */
  const SEVERITY_ORDER = { crisis: 0, abnormal: 1, review: 2, info: 3 };

  /** 事实种类的中文名（页面与 why 文案共用）。 */
  const KIND_LABEL = {
    visit: "就诊病历",
    prescription: "处方/医嘱",
    lab: "检验",
    exam: "检查",
    checkup: "体检",
    crisis: "危急值",
    trend: "单项历史",
  };

  // ------------------------------------------------------------------ #
  // 与 Python 对齐的小工具
  // ------------------------------------------------------------------ #

  /** Python `str(float)`：整数补 `.0`；`None` → `"None"`。 */
  function pyNum(value) {
    if (value === null || value === undefined) return "None";
    const number = Number(value);
    if (Number.isInteger(number)) return `${number}.0`;
    return String(number);
  }

  /** Python `repr()`（只覆盖我们文案里用到的：字符串 / None / 数字 / 布尔）。 */
  function pyRepr(value) {
    if (value === null || value === undefined) return "None";
    if (typeof value === "boolean") return value ? "True" : "False";
    if (typeof value === "number") return pyNum(value);
    return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }

  /** Python `str(x or "")`：None/0/"" 都变空串。 */
  function orEmpty(value) {
    return value ? String(value) : "";
  }

  /** Python `_truthy`：与 `str(value or "").strip().lower() not in (...)` 等价。 */
  function truthy(value) {
    const text = orEmpty(value).trim().toLowerCase();
    return !["", "0", "false", "none", "null", "no"].includes(text);
  }

  function stripText(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // ------------------------------------------------------------------ #
  // 识别模式（与 rules.py 顶部一一对应）
  // ------------------------------------------------------------------ #

  const NUMBER = /[-+]?\d+(?:\.\d+)?/;
  const HIGH_HINT = /(↑|↑↑|H|high|偏高|增高|升高)/i;
  const LOW_HINT = /(↓|↓↓|L|low|偏低|降低|减低)/i;
  //: 报告标志码。实测取值：M(正常) N(正常) H(高) L(低) P(阳性) ——
  //: "非空即异常"会把 1096 条 M 误判成异常，所以正常码必须显式列出。
  const NORMAL_CODES = ["", "M", "N", "NM", "正常", "阴性", "NEGATIVE", "NORMAL"];
  const POSITIVE_CODES = ["P", "POS", "阳性", "POSITIVE", "+"];
  const FLAG_HIGH = /(↑|H|high|偏高|增高|升高|\+)/i;
  const FLAG_LOW = /(↓|L|low|偏低|降低|减低|-)/i;
  const QUALITATIVE_NEGATIVE = /(阴性|negative|正常|未见异常|\(-\)|normal)/i;
  //: 定性结果里的"阳性"线索。**只在参考文本明说是阴性时**才用它判方向。
  const POSITIVE_HINT = /(阳性|弱阳|positive|reactive|检出|\+)/i;
  const RANGE = /^\s*([-+]?\d+(?:\.\d+)?)\s*(?:--|-|~|—|–|～|至|到)\s*([-+]?\d+(?:\.\d+)?)\s*$/;
  const UPPER = /^\s*(?:<|≤|＜|不高于|低于)\s*([-+]?\d+(?:\.\d+)?)\s*$/;
  const LOWER = /^\s*(?:>|≥|＞|不低于|高于)\s*([-+]?\d+(?:\.\d+)?)\s*$/;
  const UNIT_PARENS = /[（(][A-Za-z0-9%/\s]*[)）]/g;
  const QUAL_PARENS = /[（(][^）)]*[）)]/g;
  const DIAGNOSIS_CRISIS = /(危急|危机|critical)/i;

  /** 定性文本归一：去掉括号补充（`黄色(-)` → `黄色`）、去空白、统一大小写。 */
  function normalizeQual(text) {
    return orEmpty(text).replace(QUAL_PARENS, "").replace(/\s+/g, "").trim().toLowerCase();
  }

  /** 结果与参考逐字相同（归一后）且非空 —— 定性项目的"正常"证据。 */
  function sameQualitative(result, reference) {
    const left = normalizeQual(result);
    const right = normalizeQual(reference);
    return Boolean(left) && left === right;
  }

  /** 从结果文本里取出数值；取不到返回 null。 */
  function parseNumber(text) {
    if (text === null || text === undefined) return null;
    if (typeof text === "number") return Number.isFinite(text) ? text : null;
    let stripped = String(text).trim();
    stripped = stripped.replace(new RegExp(HIGH_HINT.source, "gi"), "");
    stripped = stripped.replace(new RegExp(LOW_HINT.source, "gi"), "");
    const match = NUMBER.exec(stripped);
    if (!match) return null;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  }

  /** 参考区间文本 → `{low, high, kind}`；`kind` ∈ numeric/qualitative/segmented/unknown。 */
  function parseReference(text) {
    if (text === null || text === undefined || String(text).trim() === "") {
      return { low: null, high: null, kind: "unknown" };
    }
    let raw = String(text).trim();
    // 定性要先判：中文化验单里 "(-)" 就是阴性，而去括号那一步会把它整段吃掉。
    if (QUALITATIVE_NEGATIVE.test(raw)) return { low: null, high: null, kind: "qualitative" };
    if (raw.includes("|") && raw.includes(":")) {
      const labels = raw.split("|").filter((seg) => seg.includes(":"));
      if (labels.length) return { low: null, high: null, kind: "segmented" };
    }
    raw = raw.replace(UNIT_PARENS, "").trim(); // 只去掉 "(mmol/L)" 这类单位括号
    let match = RANGE.exec(raw);
    if (match) {
      const low = Number(match[1]);
      const high = Number(match[2]);
      return low <= high ? { low, high, kind: "numeric" } : { low: high, high: low, kind: "numeric" };
    }
    match = UPPER.exec(raw);
    if (match) return { low: null, high: Number(match[1]), kind: "numeric" };
    match = LOWER.exec(raw);
    if (match) return { low: Number(match[1]), high: null, kind: "numeric" };
    return { low: null, high: null, kind: "unknown" };
  }

  /** 分段参考区间 → `[verdict, 命中的段名]`（缺乏/不充足/充足/过量 这类）。 */
  function segmentVerdict(reference, value) {
    for (const segment of String(reference).split("|")) {
      if (!segment.includes(":")) continue;
      const index = segment.indexOf(":");
      const label = segment.slice(0, index);
      const boundText = segment.slice(index + 1);
      const bound = parseReference(boundText.trim());
      if (bound.high !== null && value > bound.high) continue;
      if (bound.low !== null && value < bound.low) continue;
      const name = label.trim();
      if (HIGH_HINT.test(name) || /(过量|过高|偏高|上限)/.test(name)) return ["high", name];
      if (LOW_HINT.test(name) || /(缺乏|不足|偏低|低下|下限)/.test(name)) return ["low", name];
      if (QUALITATIVE_NEGATIVE.test(name) || /(充足|正常|适宜|理想)/.test(name)) return ["normal", name];
      return ["abnormal", name];
    }
    return ["unknown", ""];
  }

  /** 从报告自带的标志文本里读方向；这里才允许把裸 "+" / "-" 当方向。 */
  function flagDirection(text) {
    const raw = orEmpty(text);
    if (FLAG_HIGH.test(raw)) return "high";
    if (FLAG_LOW.test(raw)) return "low";
    return "";
  }

  // ------------------------------------------------------------------ #
  // 判定
  // ------------------------------------------------------------------ #

  /**
   * 一条明细项的判定，带审计字段（ruleId / ruleVersion / why / 参考区间）。
   *
   * 优先级（本文件唯一的业务判断，刻意做得窄而硬）：
   * 处方 → 体检结论 → 危急值 → 报告标志/箭头 → 参考区间（分段优先）→
   * 定性逐字一致 → haveCrisis 线索 → 判不了就明说。
   */
  function verdictOf(item, itemExtra) {
    const extra = isPlainObject(itemExtra) ? itemExtra : {};
    const resultText = item.result;
    const referenceText = item.reference;
    const flagText = item.flagText;
    const arrowText = item.arrow;

    const parsed = parseReference(referenceText);
    let low = parsed.low;
    let high = parsed.high;
    let kind = parsed.kind;
    // 区间还有两种给法：事实级的 extra（检查报告）与明细自带的 minValue/maxValue
    // （单项历史的时间序列点就只给这两个，referenceRange 可能是空的）。
    const lowSource = extra.minValue !== null && extra.minValue !== undefined ? extra.minValue : item.minValue;
    const highSource = extra.maxValue !== null && extra.maxValue !== undefined ? extra.maxValue : item.maxValue;
    if (low === null && lowSource !== null && lowSource !== undefined) low = parseNumber(lowSource);
    if (high === null && highSource !== null && highSource !== undefined) high = parseNumber(highSource);
    if ((low !== null || high !== null) && kind === "unknown") kind = "numeric";

    const verdict = {
      verdict: "normal",
      severity: "info",
      ruleId: "none",
      ruleVersion: RULE_VERSION,
      why: "",
      result: resultText === undefined ? null : resultText,
      flagText: flagText === undefined ? null : flagText,
      arrow: arrowText === undefined ? null : arrowText,
      reference: referenceText === undefined ? null : referenceText,
      refLow: low,
      refHigh: high,
      refKind: kind,
    };

    // 0a) 处方/医嘱：它是"开过什么药"，不是化验值，永远不进异常清单
    if (stripText(item.orderType) || item.frequency || item.itemKind) {
      verdict.verdict = "recorded";
      verdict.severity = "info";
      verdict.ruleId = "prescription";
      verdict.why = `处方/医嘱：${resultText || ""}`.replace(/：$/, "");
      return verdict;
    }

    // 0) 体检小结里的疾病/建议条目：没有数值，只有分级
    if ((item.level !== null && item.level !== undefined) ||
        (item.disease && (resultText === null || resultText === undefined || resultText === ""))) {
      const level = stripText(item.level);
      const levelName = stripText(flagText);
      // 体检小结列的是"这个人有哪些诊断"，每条都带严重度分级；整体算异常会把
      // 数百条既往诊断刷成异常（实测 949 条）。只有名字本身指向危急时才升级。
      if (DIAGNOSIS_CRISIS.test(levelName)) {
        verdict.verdict = "abnormal";
        verdict.severity = "abnormal";
        verdict.ruleId = "diagnosis-crisis";
        verdict.why = `体检结论分级 ${levelName}`;
      } else {
        verdict.verdict = "recorded";
        verdict.severity = "info";
        verdict.ruleId = "diagnosis";
        verdict.why = `体检结论条目（分级 ${levelName || level || "无"}）`;
      }
      return verdict;
    }

    // 1) 危急值（只认危急值模块）
    if (truthy(item.crisis)) {
      verdict.verdict = "crisis";
      verdict.severity = "crisis";
      verdict.ruleId = "crisis";
      verdict.why = `危急值模块标记（${item.crisisValue || "未给级别"}）`;
      return verdict;
    }

    // 2) 报告自带的异常标志 / 方向箭头
    const code = stripText(flagText).toUpperCase();
    const arrow = stripText(arrowText);
    if (code || arrow) {
      const direction = flagDirection(arrow) || flagDirection(code);
      if (direction) {
        verdict.verdict = direction;
        verdict.severity = "abnormal";
        verdict.ruleId = "report-flag";
        verdict.why = `报告标志 ${code ? pyRepr(code) : pyRepr(arrow)} 指向${direction === "high" ? "偏高" : "偏低"}`;
      } else if (POSITIVE_CODES.includes(code)) {
        verdict.verdict = "positive";
        verdict.severity = "abnormal";
        verdict.ruleId = "report-positive";
        verdict.why = `报告标志 ${pyRepr(code)} 为阳性`;
      } else if (NORMAL_CODES.includes(code)) {
        verdict.verdict = "normal";
        verdict.severity = "info";
        verdict.ruleId = "report-normal";
        verdict.why = `报告标志 ${pyRepr(code || "(无)")} 表示正常`;
      } else {
        verdict.verdict = "abnormal";
        verdict.severity = "abnormal";
        verdict.ruleId = "report-flag";
        verdict.why = `报告标志 ${pyRepr(code)} 无法归类，按异常保守处理`;
      }
      return verdict;
    }
    if (truthy(item.isYang) || truthy(extra.isYang)) {
      verdict.verdict = "positive";
      verdict.severity = "abnormal";
      verdict.ruleId = "report-positive";
      verdict.why = "报告标记阳性";
      return verdict;
    }

    // 3) 参考区间比对：分段式优先（段名即结论），其次简单区间
    const value = parseNumber(resultText);
    if (value !== null && kind === "segmented") {
      const [segVerdict, segName] = segmentVerdict(String(referenceText), value);
      verdict.verdict = segVerdict;
      verdict.severity = segVerdict === "normal" || segVerdict === "unknown" ? "info" : "abnormal";
      verdict.ruleId = "ref-segment";
      verdict.why = `${pyNum(value)} 落在分段 ${pyRepr(segName)}`;
      return verdict;
    }
    if (value !== null && (low !== null || high !== null)) {
      if (high !== null && value > high) {
        verdict.verdict = "high";
        verdict.severity = "abnormal";
        verdict.ruleId = "ref-range";
        verdict.why = `${pyNum(value)} > 上限 ${pyNum(high)}`;
      } else if (low !== null && value < low) {
        verdict.verdict = "low";
        verdict.severity = "abnormal";
        verdict.ruleId = "ref-range";
        verdict.why = `${pyNum(value)} < 下限 ${pyNum(low)}`;
      } else {
        verdict.verdict = "normal";
        verdict.severity = "info";
        verdict.ruleId = "ref-range";
        verdict.why = `${pyNum(value)} 落在 [${pyNum(low)}, ${pyNum(high)}] 内`;
      }
      return verdict;
    }

    // 3.5) 结果本身是定性阴性（如 "阴性(-)"）→ 正常
    if (value === null && kind !== "qualitative" && resultText !== null && resultText !== undefined &&
        QUALITATIVE_NEGATIVE.test(String(resultText))) {
      verdict.verdict = "negative";
      verdict.severity = "info";
      verdict.ruleId = "qualitative-result";
      verdict.why = `定性结果 ${pyRepr(stripText(resultText))} 本身为阴性`;
      return verdict;
    }

    // 3.6) 定性结果与参考文本逐字一致 → 正常（粪便常规整张单子都是这个形状）
    if (value === null && kind !== "qualitative" && sameQualitative(resultText, referenceText)) {
      verdict.verdict = "negative";
      verdict.severity = "info";
      verdict.ruleId = "qualitative-match";
      verdict.why = `定性结果 ${pyRepr(stripText(resultText))} 与参考 ${pyRepr(stripText(referenceText))} 一致`;
      return verdict;
    }

    // 4) 只有 haveCrisis 线索：降级为"请人看一眼"
    if (truthy(item.crisisHint)) {
      verdict.verdict = "unknown";
      verdict.severity = "review";
      verdict.ruleId = "crisis-hint";
      verdict.why = "明细带 haveCrisis 标记但无其他异常证据（该字段在本系统里近乎常态，需人工确认）";
      return verdict;
    }

    // 5) 判不了就明说
    if (value === null && stripText(resultText)) {
      if (kind === "qualitative" || QUALITATIVE_NEGATIVE.test(str_(referenceText))) {
        const text = stripText(resultText);
        if (QUALITATIVE_NEGATIVE.test(text)) {
          verdict.verdict = "negative";
          verdict.severity = "info";
          verdict.ruleId = "qualitative";
          verdict.why = `定性结果 ${pyRepr(text)} 对参考 ${pyRepr(referenceText)}：阴性`;
        } else if (POSITIVE_HINT.test(text)) {
          verdict.verdict = "positive";
          verdict.severity = "abnormal";
          verdict.ruleId = "qualitative";
          verdict.why = `定性结果 ${pyRepr(text)} 对参考 ${pyRepr(referenceText)}：阳性`;
        } else {
          // 参考说是阴性，结果既不是阴性也不像阳性（"未查"、"见描述"…）。
          // 这类不能算异常，更不能算正常 —— 先前写死 severity=info 会把
          // "阳性(+)"对"阴性(-)"这种真异常静默丢掉。
          verdict.verdict = "unknown";
          verdict.severity = "review";
          verdict.ruleId = "qualitative";
          verdict.why = `定性结果 ${pyRepr(text)} 对参考 ${pyRepr(referenceText)}：既非阴性也非阳性`;
        }
      } else {
        verdict.verdict = "unknown";
        verdict.severity = "review";
        verdict.ruleId = "unparsed";
        verdict.why = `既无异常标志、也无法解析数值（result=${pyRepr(resultText)} reference=${pyRepr(referenceText)}）`;
      }
      return verdict;
    }

    verdict.verdict = "unknown";
    verdict.severity = "review";
    verdict.ruleId = "no-result";
    verdict.why = "没有结果值";
    return verdict;
  }

  /** Python `str(reference_text)`：None → "None"（用于正则匹配，不用于文案）。 */
  function str_(value) {
    return value === null || value === undefined ? "None" : String(value);
  }

  /** 一条事实 → 带审计字段的判定行（与 `rules.evaluate_fact` 等价）。 */
  function evaluateFact(fact) {
    const patient = fact.patient || {};
    const source = fact.source || {};
    const extra = isPlainObject(fact.extra) ? fact.extra : null;
    const rows = [];
    for (const item of fact.items || []) {
      if (!isPlainObject(item)) continue;
      const verdict = verdictOf(item, extra);
      rows.push({
        date: fact.date === undefined ? null : fact.date,
        kind: fact.kind === undefined ? null : fact.kind,
        patientKey: patient.hisUserId || patient.hmsUserId,
        hisUserId: patient.hisUserId === undefined ? null : patient.hisUserId,
        hmsUserId: patient.hmsUserId === undefined ? null : patient.hmsUserId,
        patientName: patient.name === undefined ? null : patient.name,
        itemCode: item.itemCode === undefined ? null : item.itemCode,
        itemName: item.itemName === undefined ? null : item.itemName,
        unit: item.unit === undefined ? null : item.unit,
        checkTime: item.checkTime === undefined ? null : item.checkTime,
        sourceEndpoint: source.endpoint === undefined ? null : source.endpoint,
        sourceId: source.sourceId === undefined ? null : source.sourceId,
        ...verdict,
      });
    }
    return rows;
  }

  // ------------------------------------------------------------------ #
  // 时间、脱敏、项目身份
  // ------------------------------------------------------------------ #

  /**
   * 各种形状的"时间" → `YYYY-MM-DD`。
   *
   * 真机实测：`checkTime` / `clinicTime` / `medicalDate` 有的是**毫秒时间戳**
   * （`1790215175465`，int 而不是字符串），有的是 `YYYY-MM-DD HH:MM:SS`。
   * 先按字符串取前缀会得到 "1790215175" 这种假日期，所以必须分开处理。
   */
  function toDate(value) {
    if (value === null || value === undefined || typeof value === "boolean") return "";
    if (typeof value === "number") {
      if (value >= 1e12) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : localDate(date);
      }
      if (value >= 1e9) {
        const date = new Date(value * 1000);
        return Number.isNaN(date.getTime()) ? "" : localDate(date);
      }
      if (value >= 19000101 && value <= 29991231) {
        const text = String(value);
        return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
      }
      return "";
    }
    const text = String(value).trim();
    if (!text) return "";
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (match) return match[0];
    if (/^\d+$/.test(text)) return toDate(Number(text));
    // 不是日期形状的文字（"见描述"这种）一律当"没有日期"，与 Python 对齐
    return text.length >= 10 ? text.slice(0, 10) : "";
  }

  function localDate(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function maskPhone(value) {
    const text = stripText(value);
    if (text.length < 7) return text;
    return `${text.slice(0, 3)}****${text.slice(-4)}`;
  }

  function maskCard(value) {
    const text = stripText(value);
    if (text.length < 8) return text;
    return `${text.slice(0, 4)}**********${text.slice(-4)}`;
  }

  /** 项目名归一：`尿酸(UA)` / `尿酸（UA）` / `尿酸` → `尿酸`。 */
  function itemKey(name) {
    const raw = stripText(name);
    const stripped = raw.replace(QUAL_PARENS, "").replace(/\s+/g, "");
    return (stripped || raw).toLowerCase();
  }

  /**
   * 一个指标点的身份。
   *
   * **优先用 `itemCode`**（主数据项目编码），它是稳定身份：`尿酸(UA)` 在不同组套里
   * （"肾功3项" / "尿酸(尿酸酶法)"）编码都是 `JYS00021`，该并成一条趋势；
   * 而"白细胞"在真机上是**三个不同项目** —— 尿白细胞 `JYL00009`(Leu/ul)、
   * 尿沉渣白细胞 `JYL00019`(个/ul)、大便白细胞 `JYL00085`(/HP)。
   * 只按名字归并会把它们画成一条线（实测踩到），那是错的临床画面。
   */
  function seriesKey(row) {
    const code = stripText(row.itemCode);
    if (code) return `code:${code}`;
    return `name:${itemKey(row.itemName)}`;
  }

  // ------------------------------------------------------------------ #
  // 事实 → 页面视图
  // ------------------------------------------------------------------ #

  function factLabel(fact) {
    const kind = String(fact.kind || "");
    const extra = fact.extra || {};
    let label = KIND_LABEL[kind] || kind || "记录";
    let group = extra.groupItemName || extra.medicalType;
    if (kind === "checkup" && extra.medicalNo) group = `体检号 ${extra.medicalNo}`;
    return group ? `${label} · ${group}` : label;
  }

  /**
   * 把"事实里的明细项"与"判定行"一一对上。
   *
   * `evaluateFact` 会跳过非对象项，直接 zip 会错位；这里按下标配。
   */
  function rowsByItem(fact, rows) {
    const paired = [];
    let index = 0;
    for (const item of fact.items || []) {
      if (!isPlainObject(item)) {
        paired.push([item, null]);
        continue;
      }
      paired.push([item, index < rows.length ? rows[index] : null]);
      index += 1;
    }
    return paired;
  }

  function pointOf(row, label) {
    return {
      date: toDate(row.checkTime) || String(row.date || ""),
      time: row.checkTime === null || row.checkTime === undefined ? "" : String(row.checkTime),
      value: parseNumber(row.result),
      text: row.result === null || row.result === undefined ? "" : String(row.result),
      unit: stripText(row.unit),
      reference: stripText(row.reference),
      refLow: row.refLow === undefined ? null : row.refLow,
      refHigh: row.refHigh === undefined ? null : row.refHigh,
      refKind: row.refKind === undefined ? null : row.refKind,
      verdict: row.verdict,
      severity: row.severity,
      flagText: row.flagText === undefined ? null : row.flagText,
      arrow: row.arrow === undefined ? null : row.arrow,
      why: row.why,
      ruleId: row.ruleId,
      itemName: row.itemName === undefined ? null : row.itemName,
      itemCode: row.itemCode === undefined ? null : row.itemCode,
      kind: row.kind === undefined ? null : row.kind,
      source: label,
      sourceId: row.sourceId === undefined ? null : row.sourceId,
    };
  }

  function countBy(values) {
    const counts = {};
    for (const value of values) counts[value] = (counts[value] || 0) + 1;
    return counts;
  }

  /** 一组同项目的点 → 一张趋势卡的数据。 */
  function finalizeSeries(key, points) {
    const ordered = points.slice().sort((a, b) => {
      const left = `${a.date || "9999-99-99"}\u0000${a.time || ""}`;
      const right = `${b.date || "9999-99-99"}\u0000${b.time || ""}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const units = ordered.map((point) => point.unit).filter(Boolean);
    const unitCounts = countBy(units);
    const unit = units.length
      ? Object.keys(unitCounts).sort().reduce((best, candidate) =>
          unitCounts[candidate] > unitCounts[best] ||
          (unitCounts[candidate] === unitCounts[best] && candidate > best) ? candidate : best)
      : "";
    const names = ordered.map((point) => String(point.itemName || "")).filter(Boolean);
    const nameCounts = countBy(names);
    // 显示名取"出现最多、其次最长"的那个：同一项目在不同报告里可能带或不带括号缩写，
    // 排序后再取保证同样输入永远得到同一个名字（不依赖遍历顺序）。
    const name = names.length
      ? Object.keys(nameCounts).sort().reduce((best, candidate) => {
          if (nameCounts[candidate] > nameCounts[best]) return candidate;
          if (nameCounts[candidate] === nameCounts[best] && candidate.length > best.length) return candidate;
          return best;
        })
      : key;
    const numeric = ordered.filter((point) => point.value !== null && point.value !== undefined);
    const severities = ordered.map((point) => String(point.severity || "info"));
    const worst = severities.length
      ? severities.reduce((best, candidate) =>
          (SEVERITY_ORDER[candidate] === undefined ? 3 : SEVERITY_ORDER[candidate]) <
          (SEVERITY_ORDER[best] === undefined ? 3 : SEVERITY_ORDER[best]) ? candidate : best)
      : "info";
    const latest = ordered.length ? ordered[ordered.length - 1] : {};
    let delta = null;
    if (numeric.length >= 2) {
      delta = Math.round((Number(numeric[numeric.length - 1].value) - Number(numeric[numeric.length - 2].value)) * 1e6) / 1e6;
    }
    return {
      key,
      name,
      unit,
      unitConflict: new Set(ordered.map((point) => point.unit).filter(Boolean)).size > 1,
      points: ordered,
      numeric,
      worst,
      latest,
      latestSeverity: String(latest.severity || "info"),
      delta,
      dates: new Set(ordered.map((point) => point.date).filter(Boolean)).size,
      abnormalCount: ordered.filter((point) => String(point.severity) !== "info").length,
      refLow: latest.refLow === undefined ? null : latest.refLow,
      refHigh: latest.refHigh === undefined ? null : latest.refHigh,
      reference: latest.reference || "",
      sources: [...new Set(ordered.map((point) => point.source))].sort(),
    };
  }

  /** 事实行 + 判定 → 页面要的那一份视图（唯一的数据来源）。 */
  function buildView(patient, facts, meta) {
    const perFact = facts.map((fact) => [fact, evaluateFact(fact)]);
    const allRows = perFact.flatMap(([, rows]) => rows);

    // ① 指标序列：收"有数值语义的明细"（检验 + 单项历史 + 危急值），
    //    处方和体检结论不进来 —— 那是"开过什么药 / 诊断过什么"，不是化验值。
    const buckets = new Map();
    const crisisPoints = [];
    for (const [fact, rows] of perFact) {
      const kind = String(fact.kind);
      if (!["lab", "trend", "crisis"].includes(kind)) continue;
      const label = factLabel(fact);
      for (const [, row] of rowsByItem(fact, rows)) {
        if (!row) continue;
        if (!stripText(row.itemName) && !stripText(row.itemCode)) continue;
        const point = pointOf(row, label);
        // 危急值模块给的是"危急值类型码"，不是项目编码，不能当身份；
        // 它的点先攒着，下面尽量并进同名的检验序列。
        if (kind === "crisis") crisisPoints.push(point);
        else {
          const key = seriesKey(row);
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(point);
        }
      }
    }

    // 危急值点并进同名的检验序列（**只有同名序列唯一时才并**，否则自成一张卡）。
    const nameIndex = new Map();
    for (const [key, points] of buckets) {
      for (const point of points) {
        const key2 = itemKey(point.itemName);
        if (!nameIndex.has(key2)) nameIndex.set(key2, new Set());
        nameIndex.get(key2).add(key);
      }
    }
    for (const point of crisisPoints) {
      const candidates = nameIndex.get(itemKey(point.itemName)) || new Set();
      const target = candidates.size === 1
        ? [...candidates][0]
        : `crisis:${itemKey(point.itemName)}`;
      if (!buckets.has(target)) buckets.set(target, []);
      buckets.get(target).push(point);
    }

    const series = {};
    for (const [key, points] of buckets) {
      const entry = finalizeSeries(key, points);
      entry.points = entry.points.slice(-200);
      series[key] = entry;
    }
    const entries = Object.values(series);
    const abnormal = entries
      .filter((entry) => entry.worst !== "info")
      .sort((a, b) => (SEVERITY_ORDER[a.worst] ?? 3) - (SEVERITY_ORDER[b.worst] ?? 3) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const trends = entries
      .filter((entry) => entry.numeric.length >= 2)
      .sort((a, b) => b.dates - a.dates || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // ② 就诊 + 处方
    const visits = [];
    const prescriptions = [];
    const byVisit = new Map();
    for (const [fact] of perFact) {
      if (fact.kind !== "visit") continue;
      const extra = fact.extra || {};
      const visit = {
        id: fact.source.sourceId,
        date: toDate(extra.clinicTime) || fact.date,
        deptName: extra.deptName === undefined ? null : extra.deptName,
        recordsNo: extra.recordsNo === undefined ? null : extra.recordsNo,
        mainSuit: extra.mainSuit === undefined ? null : extra.mainSuit,
        diagnoses: (extra.diagnosisList || [])
          .filter((row) => isPlainObject(row) && row.diagnosisName)
          .map((row) => String(row.diagnosisName)),
        prescriptions: [],
      };
      visits.push(visit);
      byVisit.set(String(visit.id), visit);
    }
    for (const [fact, rows] of perFact) {
      if (fact.kind !== "prescription") continue;
      const visit = byVisit.get(String(fact.source.sourceId));
      for (const [item, row] of rowsByItem(fact, rows)) {
        if (!isPlainObject(item)) continue;
        const entry = {
          date: toDate(item.checkTime) || (visit ? visit.date : "") || fact.date,
          itemName: item.itemName === undefined ? null : item.itemName,
          spec: item.reference === undefined ? null : item.reference,
          usage: item.usage === undefined ? null : item.usage,
          frequency: item.frequency === undefined ? null : item.frequency,
          orderType: item.orderType === undefined ? null : item.orderType,
          status: item.flagText === undefined ? null : item.flagText,
          price: item.price === undefined ? null : item.price,
          itemKind: item.itemKind === undefined ? null : item.itemKind,
          summary: item.result === undefined ? null : item.result,
          verdict: row ? row.verdict : null,
          visitId: fact.source.sourceId,
        };
        prescriptions.push(entry);
        if (visit) visit.prescriptions.push(entry);
      }
    }
    visits.sort((a, b) => (String(b.date || "") < String(a.date || "") ? -1 : String(b.date || "") > String(a.date || "") ? 1 : 0));
    prescriptions.sort((a, b) => (String(b.date || "") < String(a.date || "") ? -1 : String(b.date || "") > String(a.date || "") ? 1 : 0));

    // ③ 检验 / 检查 / 体检 / 危急值
    const labs = [];
    const exams = [];
    const checkups = [];
    const crises = [];
    for (const [fact, rows] of perFact) {
      const kind = fact.kind;
      const extra = fact.extra || {};
      const label = factLabel(fact);
      if (kind === "lab") {
        const items = [];
        let date = "";
        for (const [, row] of rowsByItem(fact, rows)) {
          if (!row) continue;
          date = date || toDate(row.checkTime);
          items.push({
            itemName: row.itemName,
            result: row.result,
            unit: row.unit,
            reference: row.reference,
            flagText: row.flagText,
            arrow: row.arrow,
            verdict: row.verdict,
            severity: row.severity,
            why: row.why,
            ruleId: row.ruleId,
            refLow: row.refLow,
            refHigh: row.refHigh,
          });
        }
        labs.push({
          id: fact.source.sourceId,
          date: date || toDate(extra.checkTime) || fact.date,
          group: extra.groupItemName === undefined ? null : extra.groupItemName,
          items,
          abnormal: items.filter((item) => item.severity !== "info").length,
        });
      } else if (kind === "exam") {
        exams.push({
          id: fact.source.sourceId,
          date: toDate(extra.checkTime) || fact.date,
          group: extra.groupItemName === undefined ? null : extra.groupItemName,
          doctor: extra.checkDoctorName === undefined ? null : extra.checkDoctorName,
          conclusion: extra.checkResult || extra.reportResult || "",
        });
      } else if (kind === "checkup") {
        const diagnoses = [];
        for (const [item, row] of rowsByItem(fact, rows)) {
          if (!isPlainObject(item)) continue;
          diagnoses.push({
            name: item.disease || item.itemName,
            level: item.level === undefined ? null : item.level,
            levelName: item.flagText === undefined ? null : item.flagText,
            severity: row ? row.severity : "info",
            verdict: row ? row.verdict : null,
            why: row ? row.why : "",
          });
        }
        checkups.push({
          id: fact.source.sourceId,
          date: toDate(extra.medicalDate) || fact.date,
          medicalNo: extra.medicalNo === undefined ? null : extra.medicalNo,
          medicalType: extra.medicalType === undefined ? null : extra.medicalType,
          medicalGroup: extra.medicalGroup === undefined ? null : extra.medicalGroup,
          grade: extra.grade === undefined ? null : extra.grade,
          diagnoses,
        });
      } else if (kind === "crisis") {
        for (const [item, row] of rowsByItem(fact, rows)) {
          if (!isPlainObject(item)) continue;
          crises.push({
            date: toDate(item.checkTime) || fact.date,
            itemName: item.itemName,
            result: item.result === undefined ? null : item.result,
            unit: item.unit === undefined ? null : item.unit,
            level: item.crisisValue === undefined ? null : item.crisisValue,
            status: item.flagText === undefined ? null : item.flagText,
            disease: item.disease === undefined ? null : item.disease,
            severity: row ? row.severity : "info",
            why: row ? row.why : "",
            source: label,
          });
        }
      }
    }
    const desc = (key) => (a, b) => {
      const left = String(a[key] || "");
      const right = String(b[key] || "");
      return left < right ? 1 : left > right ? -1 : 0;
    };
    labs.sort(desc("date"));
    exams.sort(desc("date"));
    checkups.sort(desc("date"));
    crises.sort(desc("date"));

    // ④ 待人工复核：这一档是**故意**留给人看的，不是失败
    const review = allRows
      .filter((row) => row.severity === "review")
      .map((row) => ({
        itemName: row.itemName,
        result: row.result,
        reference: row.reference,
        date: toDate(row.checkTime) || row.date,
        why: row.why,
        ruleId: row.ruleId,
        source: KIND_LABEL[String(row.kind)] || String(row.kind),
      }));

    const abnormalItems = abnormal;
    const counts = {
      visits: visits.length,
      prescriptions: prescriptions.length,
      labs: labs.length,
      exams: exams.length,
      checkups: checkups.length,
      crises: crises.length,
      items: allRows.length,
      abnormalItems: abnormalItems.length,
      crisis: abnormalItems.filter((entry) => entry.worst === "crisis").length,
      abnormal: abnormalItems.filter((entry) => entry.worst === "abnormal").length,
      reviewItems: abnormalItems.filter((entry) => !["crisis", "abnormal"].includes(entry.worst)).length,
      reviewRows: review.length,
      trends: trends.length,
    };

    return {
      patient: {
        name: patient.name === undefined ? null : patient.name,
        sex: patient.sex === undefined ? null : patient.sex,
        age: patient.age === undefined ? null : patient.age,
        telephone: patient.telephone === undefined ? null : patient.telephone,
        telephoneMasked: patient.telephoneMasked || maskPhone(patient.telephone),
        identityCardMasked: patient.identityCardMasked || maskCard(patient.identityCard),
        hisUserId: patient.hisUserId === undefined ? null : patient.hisUserId,
        hmsUserId: patient.hmsUserId === undefined ? null : patient.hmsUserId,
      },
      meta: meta || {},
      counts,
      abnormal,
      trends,
      visits,
      prescriptions,
      labs,
      exams,
      checkups,
      crises,
      review,
      audit: {
        byVerdict: countBy(allRows.map((row) => String(row.verdict))),
        byRule: countBy(allRows.map((row) => String(row.ruleId))),
        byKind: countBy(facts.map((fact) => String(fact.kind))),
      },
    };
  }

  return {
    RULE_VERSION,
    SEVERITY_ORDER,
    KIND_LABEL,
    parseNumber,
    parseReference,
    segmentVerdict,
    flagDirection,
    verdictOf,
    evaluateFact,
    toDate,
    maskPhone,
    maskCard,
    itemKey,
    seriesKey,
    factLabel,
    rowsByItem,
    pointOf,
    finalizeSeries,
    buildView,
    truthy,
    pyNum,
    pyRepr,
  };
});
