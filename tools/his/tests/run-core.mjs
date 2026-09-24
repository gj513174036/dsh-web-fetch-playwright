// 一致性对照测试的 JS 侧：从 stdin 读输入，把核心的结论打到 stdout。
// 只做搬运，不含任何判断 —— 判断在 Python 测试里（不一致以 Python 为准）。
import { readFileSync } from "node:fs";

// 仓库的 package.json 是 `type: "module"`，所以 portal-core.js 会被当成 ESM 加载：
// 它没有 export（浏览器里靠 <script> 直接用），而是把 API 挂到 globalThis 上。
await import("../portal-core.js");
const core = globalThis.HisCore;

// 与 Python `evaluate_fact` 可比对的字段（Python 侧还有 collectedAt/evaluatedAt，
// 那两个是时间戳，不参与比对）。
const ROW_FIELDS = [
  "date", "kind", "patientKey", "hisUserId", "hmsUserId", "patientName",
  "itemCode", "itemName", "unit", "checkTime", "sourceEndpoint", "sourceId",
  "verdict", "severity", "ruleId", "ruleVersion", "why", "result",
  "flagText", "arrow", "reference", "refLow", "refHigh", "refKind",
];

const input = JSON.parse(readFileSync(0, "utf8"));

if (input.mode === "verdicts") {
  const out = input.facts.map((fact) => core.evaluateFact(fact).map((row) =>
    Object.fromEntries(ROW_FIELDS.map((field) => [field, row[field] === undefined ? null : row[field]]))));
  process.stdout.write(JSON.stringify(out));
} else if (input.mode === "view") {
  process.stdout.write(JSON.stringify(core.buildView(input.patient, input.facts, input.meta || {})));
} else if (input.mode === "date") {
  process.stdout.write(JSON.stringify(input.values.map((value) => core.toDate(value))));
} else {
  process.stderr.write(`unknown mode: ${input.mode}\n`);
  process.exit(2);
}
