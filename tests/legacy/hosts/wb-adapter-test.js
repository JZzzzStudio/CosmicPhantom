// tests/wb-adapter-test.js - WorkBuddy adapter idempotency and line-safety contract.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.join(os.homedir(), ".cosmic-phantom");
const NODE = path.join(REAL, "tools", "node", "node.exe");
const ADAPTER = path.join(REAL, "scripts", "legacy", "hosts", "workbuddy", "wb-adapter.js");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-wb-"));
const SESSIONS = path.join(SB, "sessions");
fs.mkdirSync(SESSIONS, { recursive: true });
const ROOT = path.join(SB, "root");
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(path.join(ROOT, "package.json"), JSON.stringify({ type: "module" }));
let pass = 0, fail = 0;
function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail}`); }
}
function run(args) {
  const result = spawnSync(NODE, ["--experimental-sqlite", ADAPTER, ...args], { encoding: "utf8", timeout: 30000 });
  return { status: result.status, out: JSON.parse(result.stdout) };
}
function sessionFile(name, lines) {
  fs.writeFileSync(path.join(SESSIONS, name), lines.join("\n") + "\n");
}
function eventCount() {
  const probe = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(path.join(ROOT, "events.db"))}, { readOnly: true });
console.log(db.prepare("SELECT COUNT(*) AS c FROM events").get().c);
`;
  const script = path.join(SB, "count.mjs");
  fs.writeFileSync(script, probe);
  const result = spawnSync(NODE, ["--experimental-sqlite", script], { encoding: "utf8", timeout: 30000 });
  return Number(result.stdout.trim());
}

console.log("=== WB adapter first ingest ===");
sessionFile("session-a.jsonl", [
  JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "你好，帮我看看这个项目" }], sessionId: "abc12345-0000", cwd: "C:/x" }),
  JSON.stringify({ type: "message", role: "assistant", content: [{ type: "output_text", text: "好的，我先读代码。" }], sessionId: "abc12345-0000", cwd: "C:/x" }),
  JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "继续" }], sessionId: "abc12345-0000", cwd: "C:/x" }),
]);
let result = run(["--sessions-dir", SESSIONS, "--root", ROOT]);
check("AD1 first ingest adds rows", result.status === 0 && result.out.added === 3 && result.out.scanned === 3, JSON.stringify(result.out));
check("AD2 events table created in sandbox root", eventCount() === 3, String(eventCount()));

console.log("=== Idempotent rerun ===");
result = run(["--sessions-dir", SESSIONS, "--root", ROOT]);
check("AD3 cursor rerun adds zero", result.out.added === 0 && result.out.scanned === 0, JSON.stringify(result.out));

console.log("=== Cursor loss deduplication ===");
fs.rmSync(path.join(ROOT, ".wb-cursor.json"), { force: true });
result = run(["--sessions-dir", SESSIONS, "--root", ROOT]);
check("AD4 cursor-loss rerun adds zero", result.out.added === 0 && result.out.scanned === 3, JSON.stringify(result.out));
check("AD5 event count stays at three", eventCount() === 3, String(eventCount()));

console.log("=== Trailing partial line safety ===");
sessionFile("session-b.jsonl", [JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "新会话" }], sessionId: "def67890-1111", cwd: "C:/y" })]);
const partialPath = path.join(SESSIONS, "session-a.jsonl");
fs.appendFileSync(partialPath, '{"type":"message","role":"user","content":[{"type":"input_text","text":"未完成");\n');
result = run(["--sessions-dir", SESSIONS, "--root", ROOT]);
check("AD6 partial line does not break ingest", result.status === 0 && result.out.added === 1, JSON.stringify(result.out));
result = run(["--sessions-dir", SESSIONS, "--root", ROOT]);
const cursor = JSON.parse(fs.readFileSync(path.join(ROOT, ".wb-cursor.json"), "utf8"));
check("AD7 cursor stays before partial line", cursor[path.join(SESSIONS, "session-a.jsonl")] === 3, JSON.stringify(cursor));

fs.rmSync(SB, { recursive: true, force: true });
check("AD8 temporary sandbox is cleaned", !fs.existsSync(SB));
console.log(`\n===== wb-adapter-test: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
