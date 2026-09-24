/*!
 * transport：浏览器里**同源直查**的取数方式 —— 不需要任何后端服务。
 *
 * 前提（都是实测出来的，不是假设）：
 *   1. 这段代码要跑在**病例系统自己的页面里**（扩展注入 / 书签小工具 / DevTools 片段）。
 *      医院接口的 Cookie 是 `SameSite=Lax`，从别的源（包括本地 HTML 文件）打过去会被浏览器
 *      丢掉 Cookie，服务端只会回 `401 登录超时`；同源就没这个问题。
 *   2. 除了 Cookie，还要一个**院区请求头**（真机上是 `x-current-hospital`），否则服务端回
 *      `4000001 未选择院区`。这个值从页面自己的 localStorage 里认（见 `detectHospital()`），
 *      认不出来就让用户在界面上填一次。
 *   3. 接口的**业务状态**在 body 里（`status`），HTTP 可能仍是 200 —— 只看 HTTP 码会把
 *      "登录超时"当成成功。
 *
 * 取数顺序与折行逻辑是 `collect.py` 的移植：就诊病历 + 医嘱/处方 → 检验 → 检查 →
 * 体检 + 危急值。折出来的事实行交给 `portal-core.js`，与 Python 侧同一套判定。
 *
 * **站点路径不写在这个文件里**：由调用方（扩展的 `site.js` / 页面配置）通过
 * `options.endpoints` 注入，这样这一份可以公开，内网路径留在仓库之外。
 */
(function (root) {
  "use strict";

  const CORE = root.HisCore;
  const PHASES = { visit: "就诊病历", lab: "检验报告", exam: "检查报告", checkup: "体检报告", crisis: "危急值" };
  const CACHE_PREFIX = "his.portal.facts.";
  const MAX_CACHED_PATIENTS = 6;

  function today() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /** 接口的业务状态：`status` 不是 0/success 就算失败（HTTP 码不作数）。 */
  function assertBusiness(path, doc) {
    const status = String((doc && doc.status) !== undefined && doc.status !== null ? doc.status : "0");
    if (["0", "success", ""].includes(status)) return doc;
    const message = (doc && doc.message) || "";
    if (status === "4000001" || /院区/.test(message)) {
      throw new Error(`${path}: ${message}（需要在设置里填院区 id）`);
    }
    if (status === "401" || /登录超时|未登录/.test(message)) {
      throw new Error(`${path}: 会话失效（${message}）—— 请在这个系统里重新登录一次`);
    }
    throw new Error(`${path}: 业务失败 status=${status} message=${message}`);
  }

  function rowsOf(doc) {
    const data = doc && doc.data;
    if (Array.isArray(data)) return data.filter((row) => row && typeof row === "object");
    if (data && typeof data === "object") {
      for (const key of ["list", "records", "rows"]) {
        if (Array.isArray(data[key])) return data[key].filter((row) => row && typeof row === "object");
      }
    }
    return [];
  }

  function dataOf(doc) {
    return doc ? doc.data : null;
  }

  /** 每页多少条：放进端点表里，因为不同站点的上限不一样。 */
  function pageSizeOf(endpoints, key, fallback) {
    const spec = endpoints[key] || {};
    const size = Number(spec.pageSize);
    return Number.isFinite(size) && size >= 1 ? Math.floor(size) : (fallback || 50);
  }

  /** 把端点表里的一条渲染成 URL + 参数（`path` 里的 `{name}` 用 values 替换）。 */
  function renderEndpoint(endpoints, key, values) {
    const spec = endpoints[key];
    if (!spec || !spec.path) throw new Error(`端点表缺少 ${key}`);
    let path = String(spec.path);
    const params = {};
    for (const [name, value] of Object.entries(values || {})) {
      if (value === undefined || value === null || value === "") continue;
      path = path.split(`{${name}}`).join(String(value));
      params[name] = value;
    }
    params.timestamp = Date.now();
    for (const name of spec.fixed ? Object.keys(spec.fixed) : []) params[name] = spec.fixed[name];
    return `${path}?${new URLSearchParams(params)}`;
  }

  /** 字典：码值 → 人话。响应是**按字典码分组的对象**，不是数组（用列表去数永远是 0）。 */
  function createDictionaries(endpoints, request, enabled) {
    const maps = {};
    const codes = (enabled && endpoints.dictionaries && endpoints.dictionaries.codes) || {};
    async function load() {
      if (!Object.keys(codes).length) return maps;
      const url = renderEndpoint(endpoints, "dictionaries",
        { dictionaryTypeCode: Object.values(codes).join(",") });
      let data = null;
      try {
        data = dataOf(assertBusiness("dictionaries", await request(url)));
      } catch (error) {
        return maps; // 字典拉不到不该让整次查询失败：翻不出来就保留原码
      }
      if (!data || typeof data !== "object") return maps;
      for (const [role, code] of Object.entries(codes)) {
        const table = {};
        for (const entry of data[code] || []) {
          if (entry && entry.itemValue !== undefined && entry.name) table[String(entry.itemValue)] = String(entry.name);
        }
        maps[role] = table;
      }
      return maps;
    }
    return {
      load,
      label(role, value) {
        if (value === null || value === undefined || String(value).trim() === "") return "";
        return (maps[role] || {})[String(value)] || String(value);
      },
      loaded() {
        return Object.fromEntries(Object.entries(maps).map(([role, table]) => [role, Object.keys(table).length]));
      },
    };
  }

  /**
   * 院区 id 的自动识别。
   *
   * 真机上这个值出现在 localStorage 的 `HIS_DOCTOR_DEPT_ID` 里 —— 它的**键**形如
   * `<院区id>_<别的东西>`，而请求头 `x-current-hospital` 要的正是前半段。认不出来就让用户填。
   */
  function detectHospital(storage) {
    try {
      for (const key of Object.keys(storage)) {
        if (!/HIS_DOCTOR_DEPT_ID/i.test(key)) continue;
        const parsed = JSON.parse(storage.getItem(key) || "{}");
        for (const inner of Object.keys(parsed || {})) {
          const match = /^([0-9a-f]{32})_/i.exec(inner);
          if (match) return match[1];
        }
      }
    } catch (error) { /* 存储不可用/内容变了：交给用户手填 */ }
    return "";
  }

  // ------------------------------------------------------------------ #
  // 折行：与 collect.py 的 lab_items / exam_conclusion / diagnosis_items /
  //       prescription_items / crisis_items / trend_points 一一对应
  // ------------------------------------------------------------------ #

  function labItems(detail) {
    const data = dataOf(detail) || {};
    const out = [];
    for (const item of (data.detailList || [])) {
      if (!item || typeof item !== "object") continue;
      out.push({
        itemCode: item.itemCode, itemName: item.itemName, result: item.result,
        unit: item.itemUnit, reference: item.reference,
        flagText: item.abnormalTips, arrow: item.resultRemark,
        crisis: false,
        // haveCrisis 在本系统里近乎常态（实测 1664 项里 1609 项为 "1"），只能当线索
        crisisHint: !["", "0", "false", "None", "null"].includes(String(item.haveCrisis === null || item.haveCrisis === undefined ? "" : item.haveCrisis).trim()),
        crisisValue: item.crisisValue,
        checkTime: item.crtTime,
      });
    }
    return out;
  }

  function examConclusion(detail) {
    const data = dataOf(detail);
    if (!data || typeof data !== "object") return {};
    return {
      checkResult: data.checkResult, reportResult: data.reportResult,
      checkDoctorName: data.checkDoctorName, checkTime: data.checkTime,
      groupItemName: data.groupItemName,
    };
  }

  function diagnosisItems(summary) {
    const data = dataOf(summary);
    if (!data || typeof data !== "object") return [];
    const out = [];
    for (const row of [...(data.medicalDataRelDiseases || []), ...(data.suggests || [])]) {
      if (!row || typeof row !== "object") continue;
      const disease = row.disease || row.diseaseNickName;
      if (!disease) continue;
      out.push({
        itemCode: row.diseaseId, itemName: disease, result: null, unit: null, reference: null,
        flagText: row.crisisLevelName, level: row.crisisLevel, disease, checkTime: row.crtTime,
      });
    }
    return out;
  }

  /**
   * 病历详情的 `itemList[]` → 处方/医嘱事实行。
   *
   * 剂量单位与包装单位是两码事：单次量用 `adultUnit`（如 mg），总量用 `unit`（如 片）。
   * 混用会写出"共 7mg"这种看着对、其实错的用量（7 是片数）—— 真机上踩过。
   */
  function prescriptionItems(detail, dictionaries) {
    const data = dataOf(detail);
    if (!data || typeof data !== "object") return [];
    const out = [];
    for (const row of (data.itemList || [])) {
      if (!row || typeof row !== "object") continue;
      const doseUnit = dictionaries.label("doseUnit", row.adultUnit || row.preparationUnit);
      const packUnit = dictionaries.label("doseUnit", row.unit);
      const usage = dictionaries.label("usage", row.usage);
      const orderType = dictionaries.label("orderType", row.itemType);
      const frequency = row.executeFrequencyName || row.executeFrequencyId || "";
      const dosage = row.dosage || row.adultDose || row.dose;
      const dayCount = row.dayCount || row.treatmentCourseCount;
      const total = row.totalCount;
      const pieces = [
        dosage ? `单次 ${dosage}${doseUnit}` : "",
        frequency ? `频次 ${frequency}` : "",
        total ? `共 ${total}${packUnit}` : "",
        dayCount ? `${dayCount} 天` : "",
        usage,
      ].filter(Boolean);
      const isMedicine = ["1", "2", "3"].includes(String(row.itemType || ""));
      out.push({
        itemCode: row.itemCode,
        itemName: row.name || row.medicineName || row.doctorServiceItemName,
        result: isMedicine ? pieces.join("，") : "", // 非药品是申请项目，没有用量
        unit: doseUnit, reference: row.specifications,
        flagText: dictionaries.label("executeStatus", row.executeStatus),
        orderType, usage, frequency, packUnit,
        price: row.totalPrice || row.unitPrice,
        checkTime: row.changeTime || row.updTime,
        itemKind: isMedicine ? "medicine" : "service",
      });
    }
    return out;
  }

  function crisisItems(rows) {
    const out = [];
    for (const row of rows || []) {
      if (!row || typeof row !== "object") continue;
      // 字段名要对：危急值列表的行用 crisisName / itemName / result / crisisLevel，
      // 而 signType / signMsg 属于**另一个**接口（异常体征），用错了项目名与结果都会是 null。
      out.push({
        itemCode: row.crisisType || row.indexType || row.id,
        itemName: row.itemName || row.crisisName,
        result: row.result || row.medicalValue,
        unit: row.unit, reference: row.reference,
        flagText: row.handleStatus || row.crisisLevel,
        crisis: true, crisisValue: row.crisisLevel || row.crisisLevelName,
        checkTime: row.checkDate || row.medicalDate,
        disease: row.diagnosisName || row.diagnose,
      });
    }
    return out;
  }

  function trendPoints(series) {
    const out = [];
    if (!series || typeof series !== "object") return out;
    for (const [group, points] of Object.entries(series)) {
      for (const point of points || []) {
        if (!point || typeof point !== "object") continue;
        out.push({
          itemCode: point.itemCode, itemName: point.itemName || group, result: point.result,
          unit: point.unit || point.resultUnit, reference: point.referenceRange,
          flagText: point.tipsContent, arrow: null, crisis: false, isYang: point.isYang,
          minValue: point.minValue, maxValue: point.maxValue,
          groupItemName: point.groupItemName || group, checkTime: point.checkTime,
        });
      }
    }
    return out;
  }

  function factKey(day, patient, kind, sourceId) {
    const who = patient.hisUserId || patient.hmsUserId || patient.name;
    return [day, String(who), kind, String(sourceId)].join("|");
  }

  /**
   * "同一份报告这次比上次少了几个明细项" → 告警文案。
   *
   * 为什么需要它：真机上实测到过一次**事实条数完全相同、只有某条明细的项数少了 9 项**
   * （而且零接口报错）。数值变少是最该被人看见的一类静默变化 —— 可能是报告被修订，
   * 也可能上游改版了。所以重新采集时逐条比一比，少一条就写进 `errors`，
   * 让页面顶上把它显出来，而不是安静地少显示几个值。
   */
  function shrinkWarnings(previousFacts, freshFacts) {
    const before = new Map();
    for (const fact of previousFacts || []) before.set(fact.key, (fact.items || []).length);
    const warnings = [];
    for (const fact of freshFacts || []) {
      const was = before.get(fact.key);
      if (was === undefined) continue;
      const now = (fact.items || []).length;
      if (now < was) {
        warnings.push(`${fact.kind}/${fact.source.sourceId}: 明细从 ${was} 项降到 ${now} 项`
                      + "（报告可能被修订，或上游改版了）");
      }
    }
    return warnings;
  }

  function factRow(day, patient, kind, sourceId, endpoint, items, extra) {
    return {
      key: factKey(day, patient, kind, sourceId),
      date: day, kind, patient,
      source: { endpoint, sourceId: String(sourceId), collectedAt: new Date().toISOString().slice(0, 19) },
      items: items || [], extra: extra || {},
    };
  }

  // ------------------------------------------------------------------ #
  // 事实的本地缓存（断点续跑 + 刷新后仍可看）
  // ------------------------------------------------------------------ #

  function createCache(storage) {
    const memory = new Map();
    function keyOf(patient) {
      return CACHE_PREFIX + (patient.hisUserId || patient.hmsUserId || patient.name);
    }
    return {
      load(patient) {
        const key = keyOf(patient);
        if (memory.has(key)) return memory.get(key);
        try {
          const raw = storage.getItem(key);
          const facts = raw ? JSON.parse(raw) : [];
          memory.set(key, facts);
          return facts;
        } catch (error) { return []; }
      },
      save(patient, facts) {
        const key = keyOf(patient);
        memory.set(key, facts);
        try {
          storage.setItem(key, JSON.stringify(facts));
          const keys = Object.keys(storage).filter((name) => name.startsWith(CACHE_PREFIX));
          if (keys.length > MAX_CACHED_PATIENTS) {
            // 一个人的事实可能几百 KB，存储有配额：留最近几个，其余丢掉（丢了只是要重采）
            keys.sort((a, b) => (storage.getItem(a) || "").length - (storage.getItem(b) || "").length);
            for (const name of keys.slice(0, keys.length - MAX_CACHED_PATIENTS)) storage.removeItem(name);
          }
        } catch (error) { /* 配额满/隐私模式：内存里还有一份，不影响本次查询 */ }
      },
      clear(patient) {
        memory.delete(keyOf(patient));
        try { storage.removeItem(keyOf(patient)); } catch (error) { /* 忽略 */ }
      },
    };
  }

  // ------------------------------------------------------------------ #
  // transport
  // ------------------------------------------------------------------ #

  /**
   * @param {object} options
   *   endpoints   端点表（站点相关，注入；形状同 `endpoints.example.json`）
   *   hospitalId  院区 id（可选，认不出来时用）
   *   storage     存储对象（默认 localStorage）
   *   dictionaries 是否加载字典（默认 true）
   */
  function create(options) {
    const config = options || {};
    const endpoints = config.endpoints || {};
    const storage = config.storage || root.localStorage;
    const cache = createCache(storage);
    let hospitalId = config.hospitalId || detectHospital(storage);
    let dictionaries = null;
    let dictionariesEnabled = config.dictionaries !== false;
    let lastErrors = [];
    let lastWarnings = [];

    function headers() {
      const head = { Accept: "*/*", "Content-Type": "application/json" };
      if (hospitalId) head["x-current-hospital"] = hospitalId;
      return head;
    }

    async function request(url) {
      // 同源请求：Cookie（会话）由浏览器自动带上；credential 必须显式声明，
      // 否则同源也可能不带（浏览器默认对 fetch 是 same-origin，这里写明意图）。
      const response = await fetch(url, { method: "GET", credentials: "include", headers: headers() });
      const text = await response.text();
      let doc = null;
      try { doc = JSON.parse(text); } catch (error) {
        throw new Error(`${url.split("?")[0]}: 响应不是 JSON（HTTP ${response.status}）: ${text.slice(0, 120)}`);
      }
      return doc;
    }

    async function soft(path, request_) {
      // 单个患者身上的偶发失败不该终止整次查询：记下来，继续
      try {
        return assertBusiness(path, await request_);
      } catch (error) {
        lastErrors.push(String(error.message || error));
        return null;
      }
    }

    async function get(key, values) {
      const url = renderEndpoint(endpoints, key, values);
      return { url, doc: assertBusiness(key, await request(url)) };
    }

    /**
     * 按 `total` 翻到底。
     *
     * **只取第一页会安静地少掉三成**：实测某患者检验报告共 71 份、一页只回 50 份；
     * 就诊病历共 175 条、一页只回 19 条。而且分页边界不稳定，"少几条"看起来像偶发抖动。
     * 所以这里一律翻到底，取不全就记一条警告（与 Python 侧同一套做法）。
     */
    async function fetchPages(key, values, fallbackSize) {
      const size = pageSizeOf(endpoints, key, fallbackSize);
      const rows = [];
      let total = null;
      let pages = null;
      let previous = null;
      for (let page = 1; page <= 500; page += 1) {
        const doc = assertBusiness(key, await request(renderEndpoint(endpoints, key,
          { ...values, pageNum: page, pageSize: size })));
        const batch = rowsOf(doc);
        // 服务端忽略 pageNum 时第二页会和第一页一模一样：必须停，否则既抄很多遍，
        // 又会因为"行数够了"误判成取全了。
        const signature = batch.map((row) => String(row && row.id)).join("|");
        if (signature && signature === previous) break;
        previous = signature;
        if (total === null) {
          const data = doc && doc.data;
          const pagination = data && data.pagination;
          const raw = (pagination && pagination.total) !== undefined ? pagination.total
            : (data && data.total);
          const parsed = Number(raw);
          total = Number.isFinite(parsed) ? parsed : null;
          const parsedPages = Number(pagination && pagination.pages);
          pages = Number.isFinite(parsedPages) ? parsedPages : null;
        }
        rows.push(...batch);
        if (!batch.length) break;
        if (total !== null && rows.length >= total) break;
        // **不能因为"这页不满 size"就停**：真机上 `clinic_record/page` 每页行数不定
        // （19/15/30/15），第一页就不满 50 —— 按老写法 175 条只拿到 19 条。
        // 只要服务端还说有下一页，就继续翻。
        if (pages !== null && page >= pages) break;
        if (total === null && pages === null && batch.length < size) break;
      }
      if (total !== null && rows.length < total) {
        lastWarnings.push(`${key}: 拿到 ${rows.length} 行 / 服务端声称共 ${total} 条`
                          + "（该接口每页行数不定或分页有重叠，对不上账；已把服务端愿意给的全部取回）");
      }
      return { rows, total };
    }

    async function getSoft(key, values) {
      const url = renderEndpoint(endpoints, key, values);
      return { url, doc: await soft(key, request(url)) };
    }

    function itemTypes() {
      return (endpoints.reports && endpoints.reports.itemTypes) || { lab: "LAB", exam: "EXAM" };
    }

    // ---- 搜索：姓名 → 全部同名候选 ---------------------------------- //
    async function search(name, telephone) {
      // 同名的人如果被分页截断，可能就看不到"真正的那个人" —— 这里必须翻全
      const { rows } = await fetchPages("identity", { name }, 50);
      const wanted = String(telephone || "").trim();
      return rows.map((row) => {
        const phone = String(row.telephone || "");
        return {
          name: row.name,
          // 真机 identity 行的性别是 M/F，字典码也可能是 1/2 —— 两种都认，认不出就原样显示
          sex: ({ M: "男", F: "女", "1": "男", "2": "女" })[String(row.gender)] || String(row.gender || ""),
          age: row.age,
          telephoneMasked: CORE.maskPhone(phone),
          identityCardMasked: CORE.maskCard(row.identityCard),
          phoneMatch: Boolean(wanted) && phone === wanted,
          hisUserId: row.id,
          hmsUserId: row.hmsArchivesUserId,
        };
      }).sort((a, b) => (a.phoneMatch === b.phoneMatch ? 0 : a.phoneMatch ? -1 : 1));
    }

    // ---- 采集一个人 -------------------------------------------------- //
    async function collect(candidate, run) {
      const settings = run || {};
      const report = settings.onProgress || (() => {});
      const day = today();
      lastErrors = [];
      lastWarnings = [];
      const patient = {
        hisUserId: candidate.hisUserId,
        hmsUserId: candidate.hmsUserId,
        name: candidate.name,
        sex: candidate.sex,
        age: candidate.age,
        telephoneMasked: candidate.telephoneMasked,
        identityCardMasked: candidate.identityCardMasked,
      };
      const hisUserId = patient.hisUserId;
      const hmsUserId = patient.hmsUserId;
      if (!hisUserId && !hmsUserId) throw new Error("这条候选没有可用的患者 id，无法采集");

      let facts = cache.load(patient);
      const previous = facts.slice();   // 重新采集会清缓存，先留一份用来比"明细有没有变少"
      if (settings.refresh) {
        cache.clear(patient);
        facts = [];
      }
      const done = new Set(facts.map((fact) => fact.key));
      const collected = [];

      if (settings.onProgress) report("字典", 0, 1);
      dictionaries = createDictionaries(endpoints, request, dictionariesEnabled);
      await dictionaries.load();

      // ② 就诊病历 + 医嘱/处方（病历详情里的 itemList）
      const withoutRegister = [];
      if (hisUserId) {
        const { rows: records } = await fetchPages("clinicRecords", { userId: hisUserId }, 50);
        report(PHASES.visit, 0, records.length);
        for (const [index, record] of records.entries()) {
          report(PHASES.visit, index + 1, records.length);
          const visitId = String(record.id);
          const registerId = record.registerId;
          const key = factKey(day, patient, "visit", visitId);
          if (!done.has(key)) {
            const fact = factRow(day, patient, "visit", visitId, String(endpoints.clinicRecords.path), [], {
              diagnosisList: record.diagnosisList, mainSuit: record.mainSuit,
              recordsNo: record.recordsNo, registerId: record.registerId,
              clinicTime: record.clinicTime, deptName: record.deptName,
            });
            collected.push(fact);
            done.add(key);
          }
          // 详情接口**硬要求** registerId，而实测有 11/76 条就诊记录没有这个字段
          // （用 recordsNo 或 id 顶上去都会被拒："not exist"）。这类别白费请求，
          // 也不要报成错误 —— 记一条警告，说明这次就诊的处方明细拿不到。
          if (!registerId) {
            withoutRegister.push(String(record.recordsNo || visitId));
            continue;
          }
          const { url: detailUrl, doc: detail } = await getSoft("visitDetail",
            { id: visitId, registerId });
          if (!detail) continue;
          const orders = prescriptionItems(detail, dictionaries);
          const orderKey = factKey(day, patient, "prescription", visitId);
          if (!done.has(orderKey)) {
            collected.push(factRow(day, patient, "prescription", visitId, detailUrl, orders, {
              diagnosisList: (dataOf(detail) || {}).diagnosisList,
            }));
            done.add(orderKey);
          }
        }
      }

      // ③④ 检验 / 检查报告 + 明细
      for (const kind of ["lab", "exam"]) {
        if (!hisUserId) break;
        const itemType = itemTypes()[kind] || kind.toUpperCase();
        const { rows: reports } = await fetchPages("reports", { userId: hisUserId, itemType }, 50);
        report(PHASES[kind], 0, reports.length);
        for (const [index, report_] of reports.entries()) {
          report(PHASES[kind], index + 1, reports.length);
          const reportId = String(report_.id);
          const key = factKey(day, patient, kind, reportId);
          if (done.has(key)) continue;
          const { url: detailUrl, doc: detail } = await getSoft("reportDetail", { id: reportId });
          if (!detail) continue; // 拉不到就不落事实，否则空事实进缓存，续跑永远补不回来
          const items = kind === "lab" ? labItems(detail) : [];
          const extra = { groupItemName: report_.groupItemName, checkTime: report_.checkTime };
          if (kind === "exam") Object.assign(extra, examConclusion(detail));
          collected.push(factRow(day, patient, kind, reportId, detailUrl, items, extra));
          done.add(key);
        }
      }

      // ⑤⑧ 体检 + 危急值（档案侧，用 hmsUserId）
      if (hmsUserId) {
        const { rows: reports } = await fetchPages("checkups", { userId: hmsUserId }, 50);
        report(PHASES.checkup, 0, reports.length);
        for (const [index, row] of reports.entries()) {
          report(PHASES.checkup, index + 1, reports.length);
          // 小结接口要的是体检数据 id，**不是**报告行本身的 id（用错会回"体检数据不存在"）
          const reportId = String(row.medicalDataId || row.id);
          const medicalNo = row.medicalNo;
          const key = factKey(day, patient, "checkup", reportId);
          if (!done.has(key)) {
            const { url: summaryUrl, doc: summary } = await getSoft("checkupSummary", { id: reportId });
            if (summary) {
              collected.push(factRow(day, patient, "checkup", reportId, summaryUrl,
                diagnosisItems(summary), {
                  medicalNo, medicalDate: row.medicalDate,
                  grade: (dataOf(summary) || {}).grade,
                  medicalType: dictionaries.label("medicalType", row.medicalType),
                  medicalGroup: dictionaries.label("medicalGroup", row.medicalGroup),
                }));
              done.add(key);
            }
          }
          if (medicalNo) {
            const crisisKey = factKey(day, patient, "crisis", String(medicalNo));
            if (!done.has(crisisKey)) {
              const crisisPath = renderEndpoint(endpoints, "crisis", { medicalNo: String(medicalNo) });
              const { rows: crisisRows } = await fetchPages("crisis",
                { medicalNo: String(medicalNo) }, 200);
              collected.push(factRow(day, patient, "crisis", String(medicalNo), crisisPath,
                crisisItems(crisisRows)));
              done.add(crisisKey);
            }
          }
        }
      }

      if (withoutRegister.length) {
        const shown = withoutRegister.slice(0, 8).join("、")
          + (withoutRegister.length > 8 ? "…" : "");
        lastWarnings.push(`就诊病历: ${withoutRegister.length} 次没有 registerId，`
          + `处方/医嘱明细取不到（病历号 ${shown}）；详情接口硬要求该参数`);
      }
      const all = facts.concat(collected);
      lastWarnings.push(...shrinkWarnings(previous, all));
      cache.save(patient, all);
      report("完成", 1, 1);
      return finish(patient, all, day, collected.length);
    }

    function finish(patient, facts, day, fresh) {
      const view = CORE.buildView(patient, facts, {
        collectedAt: new Date().toISOString().slice(0, 19),
        day,
        mode: "inline",
        freshFacts: fresh,
        totalFacts: facts.length,
        dictionaries: dictionaries ? dictionaries.loaded() : {},
        errors: lastErrors.slice(),
        warnings: lastWarnings.slice(),
      });
      view.meta.errors = lastErrors.slice();
      view.meta.warnings = lastWarnings.slice();
      view_ = view;
      return view;
    }

    /** 单项历史：按需再拉一次，用来把趋势补长。 */
    async function itemHistory(candidate, itemName) {
      const hmsUserId = candidate.hmsUserId || (view_ && view_.patient && view_.patient.hmsUserId);
      if (!hmsUserId) throw new Error("这个人没有档案侧 id（hmsUserId），拿不到单项历史");
      const { doc } = await get("itemHistory", { itemName, userId: hmsUserId });
      const items = trendPoints(dataOf(doc));
      if (!items.length) throw new Error(`${itemName}: 单项历史没有返回任何点`);
      const fact = factRow(today(), { hisUserId: candidate.hisUserId, hmsUserId, name: candidate.name },
        "trend", itemName, String(endpoints.itemHistory.path), items, { groupItemName: itemName });
      const rows = CORE.evaluateFact(fact);
      let index = 0;
      const points = [];
      for (const item of fact.items) {
        if (item && typeof item === "object") {
          if (rows[index]) points.push(CORE.pointOf(rows[index], CORE.factLabel(fact)));
          index += 1;
        }
      }
      return CORE.finalizeSeries(CORE.itemKey(itemName), points);
    }
    let view_ = null;

    async function status() {
      const warnings = [];
      if (!Object.keys(endpoints).length) warnings.push("没有注入端点表");
      if (!hospitalId) warnings.push("未识别院区");
      return {
        label: `同源直查 · ${hospitalId ? "院区已识别" : "待设置"}`,
        detail: lastErrors.length ? `${lastErrors.length} 个接口报错`
          : (lastWarnings.length ? `${lastWarnings.length} 条警告` : ""),
        warnings,
        setup: hospitalId ? null : {
          title: "还需要一个院区 id",
          value: "",
          placeholder: "例如 232768b6b30e465790f572733915f054",
          hint: "浏览器里直查时，服务端还要求一个院区请求头（x-current-hospital）。"
              + "正常情况下本工具会自动从页面的 localStorage 里认出它；认不出来时麻烦你从这里填一次。",
          onSave: async (value) => {
            hospitalId = value;
            try { storage.setItem("his.portal.hospital", value); } catch (error) { /* 忽略 */ }
          },
        },
      };
    }

    // 上次手填过的院区
    if (!hospitalId) {
      try { hospitalId = storage.getItem("his.portal.hospital") || ""; } catch (error) { /* 忽略 */ }
    }

    return {
      label: "同源直查",
      status, search, collect, itemHistory,
      get hospitalId() { return hospitalId; },
      set hospitalId(value) { hospitalId = value; },
      set dictionariesEnabled(value) { dictionariesEnabled = value; },
      /** 探测一次数据通路（拿一个人搜一下），供片内入口在展开前自检。 */
      async probe() {
        const { doc } = await get("identity", { name: "测试", pageNum: 1, pageSize: 1 });
        return rowsOf(doc).length >= 0;
      },
    };
  }

  root.HisDirectTransport = { create, detectHospital, renderEndpoint, pageSizeOf, rowsOf, dataOf, shrinkWarnings };
})(typeof globalThis !== "undefined" ? globalThis : this);
