/*!
 * 扩展的内容脚本：在病例系统的页面里放一个入口，点开就是查询面板。
 *
 * 为什么用扩展而不是书签小工具：
 *   * **刷新不丢**：内容脚本在每次页面加载时重新挂载，而书签注入的浮层一按 F5 就没了；
 *   * **SPA 切页不丢**：工作台换菜单是前端路由，不会重新加载页面；
 *   * 一键即开，不用开 F12、不用翻收藏夹。
 *
 * 它不做任何取数与判定：把 `portal-core.js` / `portal-direct.js` / `portal-app.js` 注入到
 * **页面自己的执行环境**（同源，Cookie 与院区头才有效），再把站点配置交给它们。
 * 页面里没有 CSP（实测），所以注入内联引导脚本不会被拦。
 *
 * 站点相关的路径不在这里：`site.js` 由 `build_extension.py` 从仓库外的端点表生成。
 */
(function () {
  "use strict";

  const SITE = globalThis.HIS_SITE || {};
  const BUTTON_ID = "his-portal-launcher";
  const ROOT_ID = "his-portal-overlay";

  function files() {
    const base = chrome.runtime.getURL("");
    return {
      // 顺序有讲究：core → direct → app → bootstrap（最后这份收到配置才挂界面）
      scripts: [`${base}portal-core.js`, `${base}portal-direct.js`,
                `${base}portal-app.js`, `${base}bootstrap.js`],
      css: `${base}portal-app.css`,
    };
  }

  function ensureLauncher() {
    if (document.getElementById(BUTTON_ID)) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "病例查询";
    button.title = "打开病例查询面板（同源直查，不需要后端）";
    button.style.cssText = [
      "position:fixed", "right:18px", "bottom:18px", "z-index:2147483000",
      "padding:10px 14px", "border-radius:999px", "border:1px solid #2a323d",
      "background:#58a6ff", "color:#08121f", "font:600 13px/1 system-ui,sans-serif",
      "cursor:pointer", "box-shadow:0 6px 20px rgba(0,0,0,.28)",
    ].join(";");
    button.addEventListener("click", openPanel);
    document.body.appendChild(button);
  }

  function openPanel() {
    if (document.getElementById(ROOT_ID)) {
      document.getElementById(ROOT_ID).scrollIntoView({ block: "start" });
      return;
    }
    const paths = files();
    const overlay = document.createElement("div");
    overlay.id = ROOT_ID;
    overlay.className = "his-portal-overlay";
    overlay.innerHTML = `
      <div class="his-portal-overlay-bar">
        <span>病例查询 · 同源直查（数据不离开这个页面）</span>
        <button type="button" id="his-portal-close">关闭</button>
      </div>
      <div id="his-portal-root" class="his-portal-scroll"></div>`;
    document.body.appendChild(overlay);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = paths.css;
    document.head.appendChild(link);
    overlay.querySelector("#his-portal-close").addEventListener("click", () => {
      overlay.remove();
      link.remove();
    });

    // 依次注入到**页面自己的执行环境**（同源，Cookie 与院区头才有效）。
    // 配置不用内联脚本传 —— 实测内联会被 CSP 拦，改用 postMessage（见 bootstrap.js）。
    let index = 0;
    const loadNext = () => {
      if (index >= paths.scripts.length) return;
      const isLast = index === paths.scripts.length - 1;
      const script = document.createElement("script");
      script.src = paths.scripts[index];
      script.addEventListener("load", () => {
        index += 1;
        if (isLast) {
          // 引导脚本已就绪 → 把站点配置递进去（目标源写死为自己的源）
          window.postMessage({ __hisPortalSite: SITE }, window.location.origin);
          return;
        }
        loadNext();
      });
      script.addEventListener("error", () => {
        console.error("[his-portal] 注入失败（web_accessible_resources 里有没有它？）:", script.src);
      });
      document.head.appendChild(script);
    };
    loadNext();
  }

  if (document.body) ensureLauncher();
  else document.addEventListener("DOMContentLoaded", ensureLauncher);
})();
