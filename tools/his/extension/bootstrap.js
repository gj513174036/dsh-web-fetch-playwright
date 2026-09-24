/*!
 * 页面环境里的引导脚本（**必须是外部文件**，不能用内联脚本）。
 *
 * 为什么不能用内联：实测在真浏览器里，内容脚本注入的 `script.textContent = "…"` 会被
 * Content-Security-Policy 拦下来 ——
 *   `Executing inline script violates the following CSP directive 'script-src …'`
 * 而 `script.src = chrome-extension://…` 是允许的（清单里已把这几份文件声明成
 * web_accessible_resources）。所以配置改用 `postMessage` 递过来，不落进 DOM、也不内联。
 *
 * 这一段只做"接配置 → 建 transport → 挂界面"，判定仍在 portal-core.js。
 */
(function () {
  "use strict";

  function alreadyMounted() {
    const root = document.getElementById("his-portal-root");
    return Boolean(root && root.dataset.hisPortalMounted === "1");
  }

  window.addEventListener("message", function (event) {
    // 只认同一个窗口发来的配置（内容脚本在隔离世界，`event.source` 仍是本窗口）
    if (event.source !== window) return;
    const site = event.data && event.data.__hisPortalSite;
    if (!site || alreadyMounted()) return;
    const root = document.getElementById("his-portal-root");
    if (!root) return;
    root.dataset.hisPortalMounted = "1";
    const transport = globalThis.HisDirectTransport.create({
      endpoints: site.endpoints,
      hospitalId: site.hospitalId || "",
    });
    globalThis.__hisPortal = globalThis.HisPortalApp.mount(root, transport);
  });

  // 告诉内容脚本"我准备好了，把配置发过来"
  window.postMessage({ __hisPortalReady: true }, window.location.origin);
})();
