#!/usr/bin/env node
/**
 * export-redact-test.js — E-4 导出脱敏 + E-5 索引（2026-10-28）
 *
 * 覆盖：
 *   T1 默认导出：sensitive 原文被打码，标记保留
 *   T2 --include-sensitive：原文保留
 *   T3 events 表有 ts/role/session 索引
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const REAL = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cp-export-redact-"));
const NODE = process.execPath;
const KEY = ["sk", "live", "abcdef1234567890"].join("-");
const PLAIN_SENSITIVE = "token is secret-value-123";
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function run(args) {
  return spawnSync(NODE, ["--experimental-sqlite", path.join(TMP, "events.js"), ...args, "--root", TMP], { encoding: "utf8", timeout: 60000 });
}
function insert(mid, content, sensitive) {
  fs.writeFileSync(path.join(TMP, "payload.txt"), content, "utf8");
  const r = spawnSync(NODE, ["--experimental-sqlite", path.join(TMP, "insert.cjs"), path.join(TMP, "events.db"), String(mid), String(sensitive)], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
}
function latestJsonl(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();
  return fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8");
}

const INSERT = `
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const [dbPath, mid, sensitive] = process.argv.slice(2);
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
const content = fs.readFileSync(process.argv[2].replace(/events\\.db$/, "payload.txt"), "utf8");
db.prepare("INSERT OR IGNORE INTO events(instance,mid,session,role,content,ts,sensitive) VALUES(?,?,?,?,?,?,?)")
  .run("manual", Number(mid), "s1", "user", content, new Date().toISOString(), Number(sensitive));
db.close();
`;

try {
  fs.copyFileSync(path.join(REAL, "events.js"), path.join(TMP, "events.js"));
  fs.writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "cp-export-redact", type: "module", private: true }), "utf8");
  fs.writeFileSync(path.join(TMP, "insert.cjs"), INSERT.replace("process.argv.slice(2)", "process.argv.slice(2)"), "utf8");

  insert(1, `API_KEY=${KEY}`, 1);
  insert(2, "普通内容没有密钥", 0);
  insert(3, PLAIN_SENSITIVE, 1);

  const out1 = path.join(TMP, "out1");
  let r = run(["export", "--out", out1]);
  check("T1a export 默认成功", r.status === 0, r.stderr || r.stdout);
  const text1 = latestJsonl(out1);
  check("T1b 默认导出不含真实密钥", !text1.includes(KEY), text1.slice(0, 200));
  check("T1c 默认导出含打码标记", text1.includes("****"), text1.slice(0, 200));
  check("T1d sensitive 标记保留", text1.includes('"sensitive":1'), text1.slice(0, 200));
  check("T1e 未匹配具体模式的敏感正文也不外泄", !text1.includes(PLAIN_SENSITIVE) && text1.includes("SENSITIVE REDACTED"), text1.slice(0, 400));

  const out2 = path.join(TMP, "out2");
  r = run(["export", "--out", out2, "--include-sensitive"]);
  const text2 = latestJsonl(out2);
  check("T2 --include-sensitive 保留原文", r.status === 0 && text2.includes(KEY), text2.slice(0, 200));

  fs.writeFileSync(path.join(TMP, "idx.cjs"), `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], { readOnly: true });
console.log(JSON.stringify(db.prepare("PRAGMA index_list(events)").all().map(x => x.name)));
db.close();
`, "utf8");
  const idx = spawnSync(NODE, ["--experimental-sqlite", path.join(TMP, "idx.cjs"), path.join(TMP, "events.db")], { encoding: "utf8", timeout: 30000 });
  const names = JSON.parse(idx.stdout || "[]");
  check("T3 ts/role/session 索引存在", ["idx_events_ts", "idx_events_role_ts", "idx_events_session"].every(n => names.includes(n)), JSON.stringify(names));

  console.log(`\n${failures.length ? "❌" : "✅"} export-redact-test: ${passed} passed / ${failures.length} failed`);
  if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
} catch (e) {
  console.error(`❌ export-redact-test 异常：${e.stack || e.message}`);
  process.exit(1);
} finally {
  try { if (!process.env.CP_KEEP_TEST_TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
