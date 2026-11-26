#!/usr/bin/env node
/**
 * event-index-test.js — E-1 证据目录（2026-10-28）
 *
 * 覆盖：index 生成 / find --term / --path / --error / --decision
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const REAL = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cp-event-index-"));
const NODE = process.execPath;
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function run(args) {
  const r = spawnSync(NODE, ["--experimental-sqlite", path.join(TMP, "events.js"), ...args, "--root", TMP], { encoding: "utf8", timeout: 60000 });
  try { return JSON.parse((r.stdout || "").trim()); } catch { return { parseError: r.stdout, stderr: r.stderr }; }
}
function insert(mid, content, sensitive = 0) {
  fs.writeFileSync(path.join(TMP, "payload.txt"), content, "utf8");
  const r = spawnSync(NODE, ["--experimental-sqlite", path.join(TMP, "insert.cjs"), path.join(TMP, "events.db"), String(mid), String(sensitive)], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
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
  .run("manual", Number(mid), "s1", "user", content, new Date().toISOString(), Number(sensitive || 0));
db.close();
`;

try {
  fs.mkdirSync(path.join(TMP, ".context"), { recursive: true });
  fs.writeFileSync(path.join(TMP, ".context", "CONTEXT.md"), "## 术语\n\n- 术语：索引\n  定义：测试用。\n", "utf8");
  fs.copyFileSync(path.join(REAL, "events.js"), path.join(TMP, "events.js"));
  fs.writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "cp-event-index", type: "module", private: true }), "utf8");
  fs.writeFileSync(path.join(TMP, "insert.cjs"), INSERT, "utf8");

  insert(1, "修复 /tmp/cp-public-fixture/events.js 的 E1234 报错，决定：加索引");
  insert(2, "普通内容，没有任何标签");
  insert(3, "HTTP 500 at /tmp/cp-public-fixture/file.js");
  insert(4, "SECRET_INDEX_PATH /tmp/cp-public-fixture/secret.js E9999", 1);

  const idx = run(["index"]);
  check("T1 index 生成", idx.ok === true && idx.indexed >= 2, JSON.stringify(idx));
  check("T2 目录文件存在", fs.existsSync(path.join(TMP, "event-index.json")));

  const byTerm = run(["find", "--term", "索引"]);
  check("T3 find --term 命中 id 1", byTerm.count >= 1 && byTerm.hits.some(h => h.id === 1), JSON.stringify(byTerm).slice(0, 200));
  const byPath = run(["find", "--path", "events.js"]);
  check("T4 find --path 命中 id 1", byPath.count >= 1 && byPath.hits.some(h => h.id === 1), JSON.stringify(byPath).slice(0, 200));
  const byErr = run(["find", "--error", "E1234"]);
  check("T5 find --error 命中 id 1", byErr.count >= 1 && byErr.hits.some(h => h.id === 1), JSON.stringify(byErr).slice(0, 200));
  const byDec = run(["find", "--decision"]);
  check("T6 find --decision 命中 id 1", byDec.count >= 1 && byDec.hits.some(h => h.id === 1), JSON.stringify(byDec).slice(0, 200));
  const rel = run(["find", "--related", "1"]);
  check("T8 find --related 有因果边", rel.causal?.length >= 1 && rel.related?.some(x => x.id === 3), JSON.stringify(rel).slice(0, 240));
  const byFile = run(["find", "--path", "file.js"]);
  check("T7 find --path 命中 id 3", byFile.count >= 1 && byFile.hits.some(h => h.id === 3), JSON.stringify(byFile).slice(0, 200));
  const secret = run(["find", "--path", "secret.js"]);
  check("T9 sensitive event is excluded from the default index", secret.count === 0, JSON.stringify(secret));

  console.log(`\n${failures.length ? "❌" : "✅"} event-index-test: ${passed} passed / ${failures.length} failed`);
  if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
} catch (e) {
  console.error(`❌ event-index-test 异常：${e.stack || e.message}`);
  process.exit(1);
} finally {
  try { if (!process.env.CP_KEEP_TEST_TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
