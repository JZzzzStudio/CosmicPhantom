// tests/flush-reminder-test.js - 落盘提醒 hook 阈值行为（2026-08-13 实装）
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-flush-reminder-"));
const ROOT = path.join(SB, "root");
const SCRIPT = path.join(ROOT, "flush-reminder.cjs");
let pass = 0, fail = 0;

function check(name, condition, detail = "") {
  if (condition) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name} -- ${detail}`); }
}

function seedDb(rows) {
  const dbPath = path.join(ROOT, "events.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE events(id INTEGER PRIMARY KEY, instance TEXT, mid INTEGER, session TEXT, role TEXT, content TEXT, tool_name TEXT, tool_calls TEXT, ts TEXT, sensitive INTEGER)");
  const ins = db.prepare("INSERT INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive) VALUES(?,?,?,?,?,?,?,?,?)");
  for (const r of rows) ins.run(r.instance || "manual", r.mid || 0, r.session || "session-x", r.role, r.content, null, null, r.ts, 0);
  db.close();
  return dbPath;
}

function runReminder(root, extra = []) {
  const r = spawnSync(NODE, ["--experimental-sqlite", SCRIPT, "--root", root, ...extra], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)).additionalContext || "";
}

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

try {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.copyFileSync(path.join(REAL, "flush-reminder.cjs"), SCRIPT);

  // 场景1：30 分钟内刚落过 🛠️ → 不提醒
  seedDb([
    { role: "assistant", content: "🛠️ 刚做完的成果", ts: ago(2) },
    { role: "user", content: "刚说的话", ts: ago(1) },
  ]);
  check("FR1 30 分钟内有成果行不提醒", runReminder(ROOT) === "", "应输出空 additionalContext");
  fs.rmSync(path.join(ROOT, "events.db"));

  // 场景2：31 分钟前落过 🛠️ → 提醒（含分钟数）
  seedDb([{ role: "assistant", content: "🛠️ 很久前的成果", ts: ago(31) }]);
  const r2 = runReminder(ROOT);
  check("FR2 超 30 分钟提醒", r2.includes("落盘提醒") && r2.includes("31"), r2.slice(0, 80));
  fs.rmSync(path.join(ROOT, "events.db"));

  // 场景3：只有用户消息、无 🛠️ 成果行 → 提醒（无记录口径）
  seedDb([{ role: "user", content: "普通对话", ts: ago(1) }]);
  const r3 = runReminder(ROOT);
  check("FR3 无成果行记录时提醒", r3.includes("落盘提醒"), r3.slice(0, 80));
  fs.rmSync(path.join(ROOT, "events.db"));

  // 场景4：--minutes 自定义阈值（2 分钟阈、3 分钟前的成果 → 提醒）
  seedDb([{ role: "assistant", content: "🛠️ 阈值测试", ts: ago(3) }]);
  const r4 = runReminder(ROOT, ["--minutes", "2"]);
  check("FR4 --minutes 阈值可配置", r4.includes("落盘提醒"), r4.slice(0, 80));
  fs.rmSync(path.join(ROOT, "events.db"));

  // 场景5：events.db 不存在 → 提醒（fail-open 但给出信息）
  const r5 = runReminder(ROOT);
  check("FR5 events.db 缺失时提醒", r5.includes("落盘提醒"), r5.slice(0, 80));
} finally {
  fs.rmSync(SB, { recursive: true, force: true });
  check("FR6 沙箱已清理", !fs.existsSync(SB), SB);
}

console.log(`\n===== flush-reminder-test: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
