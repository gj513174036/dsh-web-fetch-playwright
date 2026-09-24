// 后端版页面的端到端驱动：打开 portal.py 发出的薄壳页，走一遍搜索 → 点选 → 看结果。
// 与扩展那条路的区别：这里数据由后端取（页面只是展示），用来验证"两种载体共用同一份界面"。
//
// 用法: node backend-page-e2e.mjs <页面URL> <姓名> <手机号>
import { chromium } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [pageUrl, name, phone] = process.argv.slice(2);
const report = { ok: false, steps: [], errors: [] };

async function dumpState(page) {
  try {
    report.state = await page.evaluate(() => ({
      root: Boolean(document.getElementById("his-portal-root")),
      searchButton: Boolean(document.querySelector("#his-portal-root #btn-search")),
      globals: [typeof window.HisCore, typeof window.HisHttpTransport,
                typeof window.HisPortalApp].join(","),
      health: (document.querySelector("#his-portal-root #health") || {}).textContent || "",
      error: (document.querySelector("#his-portal-root #err") || {}).textContent || "",
      candidates: document.querySelectorAll("#his-portal-root .cand").length,
    }));
  } catch (error) { report.state = { dumpFailed: String(error.message).slice(0, 160) }; }
}

const profile = mkdtempSync(join(tmpdir(), "backend-e2e-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"],
  });
  const page = context.pages()[0] || await context.newPage();
  page.on("pageerror", (error) => report.errors.push("pageerror: " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push("console: " + message.text().slice(0, 200));
  });
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector("#his-portal-root #btn-search", { timeout: 15000 });
  } catch (error) { await dumpState(page); throw error; }
  report.steps.push("薄壳页与三份脚本都加载了");
  await page.waitForTimeout(500);
  report.status = ((await page.textContent("#his-portal-root #health")) || "").trim();

  await page.fill("#his-portal-root #name", name);
  if (phone) await page.fill("#his-portal-root #phone", phone);
  await page.click("#his-portal-root #btn-search");
  try {
    await page.waitForSelector("#his-portal-root .cand", { timeout: 30000 });
  } catch (error) { await dumpState(page); throw error; }
  report.candidates = await page.$$eval("#his-portal-root .cand",
    (nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, " ").trim()));

  await page.click("#his-portal-root .cand");
  try {
    await page.waitForSelector("#his-portal-root #detail .kpi", { timeout: 120000 });
  } catch (error) { await dumpState(page); throw error; }
  await page.waitForTimeout(400);
  report.kpis = await page.$$eval("#his-portal-root .kpi",
    (nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, " ").trim()));
  report.metrics = await page.$$eval("#his-portal-root .metric .name",
    (nodes) => nodes.map((node) => node.innerText.trim()));
  report.charts = await page.$$eval("#his-portal-root .metric svg", (nodes) => nodes.length);
  report.ok = report.errors.length === 0 && report.kpis.length > 0;
  report.steps.push(`后端取数出结果：${report.kpis.length} 个 KPI / ${report.metrics.length} 张异常卡`);
} catch (error) {
  report.errors.push("driver: " + String(error && error.message).split("\n")[0]);
} finally {
  if (context) await context.close();
}

process.stdout.write(JSON.stringify(report, null, 1));
process.exit(report.ok ? 0 : 1);
