/*!
 * transport：走后端服务的取数方式（配合 `portal.py`）。
 *
 * 页面对后端只有三个请求：搜索 / 提交采集任务（轮询进度）/ 拉单项历史。
 * 判定与聚合在后端做（`portal.py` 用的是 `rules.py`，与 `portal-core.js` 有对照测试），
 * 这里只负责把结果搬进界面。
 *
 * 同步 `portal-app.js` 的 transport 契约：
 *   status()                                   → {label, detail, warnings}
 *   search(name, telephone)                    → [候选…]
 *   collect(candidate, {refresh, onProgress})  → 视图
 *   itemHistory(candidate, itemName)           → 趋势卡数据
 */
(function (root) {
  "use strict";

  async function api(path, options) {
    const response = await fetch(path, options);
    let doc = null;
    try { doc = await response.json(); } catch (error) { doc = null; }
    if (!response.ok) throw new Error((doc && doc.error) || `HTTP ${response.status}`);
    return doc;
  }

  function create(options) {
    const config = options || {};
    const pollMs = config.pollMs || 700;

    return {
      label: "后端取数",

      async status() {
        const health = await api("/api/health");
        return {
          label: `后端 · ${health.session || ""}`,
          detail: `${health.day || ""}　事实落盘 ${health.outdir || ""}`,
          warnings: [],
        };
      },

      async search(name, telephone) {
        const query = new URLSearchParams({ name, telephone: telephone || "" });
        const doc = await api(`/api/search?${query}`);
        return doc.candidates || [];
      },

      async collect(candidate, run) {
        const settings = run || {};
        const { jobId } = await api("/api/collect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...candidate, refresh: Boolean(settings.refresh) }),
        });
        // 采集在后端是异步的（一个人要拉几十个接口），所以这里轮询进度。
        // 后端把"新采到多少"和"读了多少缓存"都放在同一个 job 里。
        for (;;) {
          const job = await api(`/api/job?id=${encodeURIComponent(jobId)}`);
          if (settings.onProgress) settings.onProgress(job.phase || "处理中", job.done || 0, job.total || 1);
          if (job.state === "done") return job.result;
          if (job.state === "failed") throw new Error(job.error || "采集失败");
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      },

      async itemHistory(candidate, itemName) {
        const query = new URLSearchParams({
          itemName,
          hisUserId: candidate.hisUserId || "",
          hmsUserId: candidate.hmsUserId || "",
          name: candidate.name || "",
          telephone: candidate.telephone || "",
        });
        const doc = await api(`/api/item-history?${query}`);
        return doc.series;
      },
    };
  }

  root.HisHttpTransport = { create };
})(typeof globalThis !== "undefined" ? globalThis : this);
