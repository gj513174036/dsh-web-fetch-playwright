// 扩展的端到端驱动：把扩展真装进 Chromium，在"工作台页面"上点开面板、查人、看结果。
// 只打印结论（JSON），断言在 Python 侧（tests/test_extension_e2e.py）。
//
// 用法: node extension-e2e.mjs <扩展目录> <工作台URL> <姓名> <手机号>
// playwright-core 从仓库的 node_modules 解析（这个文件在 tools/his/tests/ 下，
// Node 会逐级往上找，最终命中仓库根的 node_modules）
import { chromium } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [extensionDir, pageUrl, name, phone] = process.argv.slice(2);
const report = { ok: false, steps: [], errors: [] };

function step(label, detail) {
  report.steps.push(detail === undefined ? label : `${label}: ${detail}`);
}

// 超时时把现场抓下来：只报"超时"是最难查的那种失败。
async function dumpState(page) {
  try {
    report.state = await page.evaluate(() => ({
      overlay: Boolean(document.getElementById("his-portal-overlay")),
      root: Boolean(document.getElementById("his-portal-root")),
      cards: document.querySelectorAll("#his-portal-root .card").length,
      injected: Array.from(document.head.querySelectorAll("script[src]")).map((s) => s.src.split("/").pop()),
      globals: [typeof window.HisCore, typeof window.HisDirectTransport,
                typeof window.HisPortalApp, typeof window.__hisPortal].join(","),
      health: (document.querySelector("#his-portal-root #health") || {}).textContent || "",
      error: (document.querySelector("#his-portal-root #err") || {}).textContent || "",
    }));
  } catch (error) { report.state = { dumpFailed: String(error.message).slice(0, 120) }; }
}

const profile = mkdtempSync(join(tmpdir(), "ext-e2e-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CHROME_PATH,
    args: [
      "--no-sandbox",
      "--disable-extensions-except=" + extensionDir,
      "--load-extension=" + extensionDir,
    ],
  });

  // 会话 Cookie：真实系统靠 Cookie 认证，假系统只检查它存在。
  // E2E_NO_COOKIE=1 时故意不放，用来验证"会话失效"有没有被吞掉。
  const origin = new URL(pageUrl).origin;
  if (process.env.E2E_NO_COOKIE !== "1") {
    await context.addCookies([{ name: "x-auth-token", value: "test-session", domain: new URL(pageUrl).hostname, path: "/" }]);
  }

  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  page.on("pageerror", (error) => report.errors.push("pageerror: " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push("console: " + message.text().slice(0, 200));
  });

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  // ① 扩展注入的入口按钮
  await page.waitForSelector("#his-portal-launcher", { timeout: 15000 });
  step("扩展入口已注入", origin);
  await page.click("#his-portal-launcher");

  // ② 面板挂载（需要 core/direct/app 三份脚本都从扩展里加载成功）
  // 注意：等的是**必然可见**的元素。`#his-portal-root .card` 的第一个匹配是 `#setup`，
  // 它默认 display:none —— Playwright 默认等"可见"，会在那儿白等到超时（踩过一次）。
  try {
    await page.waitForSelector("#his-portal-root #btn-search", { timeout: 20000 });
  } catch (error) {
    await dumpState(page);
    throw error;
  }
  step("面板已挂载");
  await page.waitForTimeout(600);
  report.status = (await page.textContent("#his-portal-root #health") || "").trim();
  step("状态栏", report.status);

  // ③ 搜索
  await page.fill("#his-portal-root #name", name);
  if (phone) await page.fill("#his-portal-root #phone", phone);
  await page.click("#his-portal-root #btn-search");
  try {
    await page.waitForSelector("#his-portal-root .cand", { timeout: 20000 });
  } catch (error) {
    // 取不到候选时，把界面上给出的错误原样带出来（断言看它，而不是看驱动超时）
    report.errorText = ((await page.textContent("#his-portal-root #err")) || "").trim();
    throw error;
  }
  report.candidates = await page.$$eval("#his-portal-root .cand",
    (nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, " ").trim()));
  step("候选", report.candidates.length + " 个");

  // ④ 点选 → 同源直查取数 → 出结果
  await page.click("#his-portal-root .cand");
  await page.waitForSelector("#his-portal-root #detail .kpi", { timeout: 90000 });
  await page.waitForTimeout(500);
  report.kpis = await page.$$eval("#his-portal-root .kpi",
    (nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, " ").trim()));
  report.metrics = await page.$$eval("#his-portal-root .metric",
    (nodes) => nodes.map((node) => ({
      name: (node.querySelector(".name") || {}).innerText || "",
      badges: Array.from(node.querySelectorAll(".chip")).map((chip) => chip.innerText.trim()),
    })));
  report.charts = await page.$$eval("#his-portal-root .metric svg", (nodes) => nodes.length);
  // 计数 / 告警 / 逐条明细数：断言"翻到底了"和"没有静默截断"要看这些
  report.counts = await page.evaluate(() => (globalThis.__hisPortal && globalThis.__hisPortal.view)
    ? globalThis.__hisPortal.view.counts : null);
  report.metaErrors = await page.evaluate(() => (globalThis.__hisPortal && globalThis.__hisPortal.view)
    ? (globalThis.__hisPortal.view.meta.errors || []).slice(0, 8) : null);
  report.metaWarnings = await page.evaluate(() => (globalThis.__hisPortal && globalThis.__hisPortal.view)
    ? (globalThis.__hisPortal.view.meta.warnings || []).slice(0, 8) : null);
  report.tabs = await page.$$eval("#his-portal-root .tabs button",
    (nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, " ").trim()));
  report.patient = (await page.textContent("#his-portal-root #detail h2") || "").trim();
  step("结果已渲染", `${report.kpis.length} 个 KPI / ${report.metrics.length} 张异常卡`);

  // ⑤ 切到"全部趋势"与"就诊与处方"，确认渲染没被容器作用域打坏
  for (const tab of ["trends", "visits", "review"]) {
    const button = await page.$(`#his-portal-root .tabs button[data-tab="${tab}"]`);
    if (!button) continue;
    await button.click();
    await page.waitForTimeout(300);
    const visible = await page.$eval(`#his-portal-root .panel[data-panel="${tab}"]`,
      (node) => node.classList.contains("on") && node.innerText.length > 0);
    step(`标签页 ${tab}`, visible ? "有内容" : "空的");
    if (!visible) report.errors.push(`标签页 ${tab} 没有内容`);
  }
  report.ok = report.errors.length === 0;
} catch (error) {
  report.errors.push("driver: " + String(error && error.message).split("\n")[0]);
} finally {
  if (context) await context.close();
}

process.stdout.write(JSON.stringify(report, null, 1));
process.exit(report.ok ? 0 : 1);
