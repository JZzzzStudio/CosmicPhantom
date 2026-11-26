// tests/verify-handoff-test.js - A/B/C reconciliation contract for handoff deliveries.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.join(os.homedir(), ".cosmic-phantom");
const NODE = path.join(REAL, "tools", "node", "node.exe");
const VERIFY = path.join(REAL, "scripts", "legacy", "diagnostics", "verify-handoff.js");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-verify-"));
const ROOT = path.join(SB, "root");
const SESSIONS = path.join(SB, "sessions");
fs.mkdirSync(path.join(ROOT, "daily"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "memories"), { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });
let pass = 0, fail = 0;
function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail}`); }
}
function run(args) {
  const result = spawnSync(NODE, ["--experimental-sqlite", VERIFY, ...args, "--root", ROOT], { encoding: "utf8", timeout: 30000 });
  return { status: result.status, out: JSON.parse(result.stdout) };
}

const date = "2026-08-10";
const userLine = "帮我看看今天的交接状态";
const userLine2 = "把质检结果保存到 delivery";
const assistantLine = "已保存，A/B/C 全部通过";
const sessionRows = [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: userLine }] }, _createdAt: "2026-08-10T02:00:00.000Z" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: assistantLine }] }, _createdAt: "2026-08-10T02:01:00.000Z" }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: userLine2 }] }, _createdAt: "2026-08-10T02:02:00.000Z" }),
];
fs.writeFileSync(path.join(SESSIONS, "test-session.jsonl"), sessionRows.join("\n") + "\n");

// Build events.db exactly matching the session rows (proma-<short> + lineNo)
const seed = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(path.join(ROOT, "events.db"))});
db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL, mid INTEGER NOT NULL, session TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_name TEXT, tool_calls TEXT, ts TEXT NOT NULL, sensitive INTEGER DEFAULT 0, UNIQUE(instance, mid)); CREATE TABLE projection (event_id INTEGER PRIMARY KEY);");
const insert = db.prepare("INSERT INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive) VALUES(?,?,?,?,?,?,?,?,?)");
const rows = ${JSON.stringify([
  ["proma-test-ses", 1, "proma-test-ses", "user", userLine, null, null, "2026-08-10T02:00:00.000Z", 0],
  ["proma-test-ses", 2, "proma-test-ses", "assistant", assistantLine, null, null, "2026-08-10T02:01:00.000Z", 0],
  ["proma-test-ses", 3, "proma-test-ses", "user", userLine2, null, null, "2026-08-10T02:02:00.000Z", 0],
])};
for (const r of rows) insert.run(...r);
`;
fs.writeFileSync(path.join(SB, "seed.mjs"), seed);
let result = spawnSync(NODE, ["--experimental-sqlite", path.join(SB, "seed.mjs")], { encoding: "utf8", timeout: 30000 });
if (result.status !== 0) { console.error(result.stderr); process.exit(1); }

// daily projection
fs.writeFileSync(path.join(ROOT, "daily", `${date}.md`), `# ${date} 工作日志\n\n## 会话 testsess（2026-08-10T02:00:00.000Z）\n<!-- cp-evt: proma-testsess:1 proma-testsess:2 proma-testsess:3 -->\n- 👤 用户：${userLine}\n- [摘要] ${assistantLine}\n- ⭐👤 用户（决策）：${userLine2}\n\n`);

// current-state.json via current-state.js
fs.copyFileSync(path.join(REAL, "current-state.js"), path.join(ROOT, "current-state.js"));
const patch = JSON.stringify({ status: "active", objective: "verify handoff", summary: "contract test", completed: ["seeded"], nextActions: ["run checks"], blockers: [], decisions: [], workingFiles: [], verification: [] });
result = spawnSync(NODE, [path.join(ROOT, "current-state.js"), "update", "--expected-revision", "0", "--actor", "verify-test", "--source", "test", "--root", ROOT], { encoding: "utf8", timeout: 30000, input: patch });
if (result.status !== 0) { console.error("current-state update failed:", result.stderr, result.stdout); process.exit(1); }

console.log("=== A/B/C reconciliation ===");
result = run(["--sessions-dir", SESSIONS, "--date", date, "--json"]);
const report = result.out;
check("VH1 completeness passes with zero missing", result.status === 0 && report.checks.A_completeness.pass && report.checks.A_completeness.expectedRows === 3 && report.checks.A_completeness.missingRows.length === 0, JSON.stringify(report.checks.A_completeness));
check("VH2 fidelity passes with verbatim 100%", report.checks.B_fidelity.pass && report.checks.B_fidelity.verbatimRate === 100, JSON.stringify(report.checks.B_fidelity));
check("VH3 fidelity sees decision flags", report.checks.B_fidelity.decisionFlags >= 1 && report.checks.B_fidelity.dailyCoverage === true, JSON.stringify(report.checks.B_fidelity));
check("VH4 quality reports revision growth", report.checks.C_quality.pass && report.checks.C_quality.state.revision === 1, JSON.stringify(report.checks.C_quality.state));

fs.rmSync(SB, { recursive: true, force: true });
check("VH5 temporary sandbox is cleaned", !fs.existsSync(SB));
console.log(`\n===== verify-handoff-test: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
