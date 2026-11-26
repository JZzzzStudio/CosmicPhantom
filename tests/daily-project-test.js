#!/usr/bin/env node
/**
 * daily-project-test.js — D-05 行内 🛠️ 成果行投影（2026-10-28）
 *
 * 覆盖：
 *   T1 assistant 大段文本中的行首 🛠️ 行 → 投影为 daily 成果行
 *   T2 无 🛠️ 行的普通 assistant 文本 → 不进 daily
 * 用临时根，不碰生产。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const REAL = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cp-daily-project-"));
const NODE = process.execPath;
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function localToday() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function insert(mid, content) {
  fs.writeFileSync(path.join(TMP, "payload.txt"), content, "utf8");
  const r = spawnSync(NODE, ["--experimental-sqlite", path.join(TMP, "insert.cjs"), path.join(TMP, "events.db"), TMP, String(mid)], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}
function project() {
  const r = spawnSync(NODE, ["--experimental-sqlite", path.join(TMP, "events.js"), "project", "--root", TMP], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}

const INSERT_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const [dbPath, dir, mid] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec(\`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL, mid INTEGER NOT NULL,
  session TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_name TEXT, tool_calls TEXT,
  ts TEXT NOT NULL, sensitive INTEGER DEFAULT 0, src_host TEXT, UNIQUE(instance, mid)
);
CREATE TABLE IF NOT EXISTS projection (event_id INTEGER PRIMARY KEY);
\`);
const content = fs.readFileSync(path.join(dir, "payload.txt"), "utf8");
db.prepare("INSERT OR IGNORE INTO events(instance,mid,session,role,content,ts,sensitive) VALUES(?,?,?,?,?,?,0)")
  .run("manual", Number(mid), "d5", "assistant", content, new Date().toISOString());
db.close();
`;

try {
  fs.mkdirSync(path.join(TMP, "daily"), { recursive: true });
  fs.copyFileSync(path.join(REAL, "events.js"), path.join(TMP, "events.js"));
  fs.writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "cp-daily-project", type: "module", private: true }), "utf8");
  fs.writeFileSync(path.join(TMP, "insert.cjs"), INSERT_SCRIPT, "utf8");

  insert(1, "普通回复开头。\n\n🛠️ 测试成果：D-05 行内成果行被投影（这是一段超过三十二个字符的示例文本）。\n\n更多说明。");
  project();
  const daily = path.join(TMP, "daily", `${localToday()}.md`);
  const text = fs.existsSync(daily) ? fs.readFileSync(daily, "utf8") : "";
  check("T1 行内 🛠️ 投影为成果行", text.includes("🛠️ Agent（成果）") && text.includes("D-05 行内成果行被投影"), text.slice(0, 200));

  insert(2, "纯说明，没有成果行，不应该进 daily。");
  project();
  const text2 = fs.existsSync(daily) ? fs.readFileSync(daily, "utf8") : "";
  check("T2 无 🛠️ 不进 daily", !text2.includes("纯说明，没有成果行"), text2.slice(-200));

  console.log(`\n${failures.length ? "❌" : "✅"} daily-project-test: ${passed} passed / ${failures.length} failed`);
  if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
} catch (e) {
  console.error(`❌ daily-project-test 异常：${e.stack || e.message}`);
  process.exit(1);
} finally {
  try { if (!process.env.CP_KEEP_TEST_TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
