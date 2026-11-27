// tests/zcode-flush-test.js - ZCode Stop auto-flush fidelity and idempotency.
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-zflush-test-"));
const ROOT = path.join(SB, "root");
const SOURCE_DB = path.join(SB, "zcode.sqlite");
let pass = 0, fail = 0;

function check(name, condition, detail = "") {
  if (condition) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name} -- ${detail}`); }
}
function copy(relative) {
  const target = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REAL, relative), target);
}
function localDate(value) {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function messageData({ turn, text, synthetic = false, source = null }) {
  const data = {
    role: "user",
    anchor: { turnId: turn, origin: "realUser" },
    semantics: { origin: "real_user", kind: "user_prompt" },
    metadata: { inputIntent: { text } },
  };
  if (synthetic) data.synthetic = true;
  if (source) data.source = source;
  return JSON.stringify(data);
}
function runFlush(root, dbPath, payload) {
  return spawnSync(NODE, ["--experimental-sqlite", path.join(root, "zcode-flush.cjs"), "--root", root, "--zcode-db", dbPath], {
    encoding: "utf8",
    timeout: 30000,
    input: JSON.stringify(payload),
    env: { ...process.env, CP_NODE: NODE, HOME: SB, USERPROFILE: SB, CP_SKIP_DECISION_CARDS: "1", CP_SKIP_STOP_CHECKS: "1" },
  });
}

try {
  fs.mkdirSync(ROOT, { recursive: true });
  for (const file of ["events.js", "zcode-flush.cjs", "package.json"]) copy(file);
  fs.mkdirSync(path.join(ROOT, "daily"), { recursive: true });

  const db = new DatabaseSync(SOURCE_DB);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, task_type TEXT NOT NULL);
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sequence INTEGER,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO session(id, task_type) VALUES(?,?)").run("sess-main", "interactive");
  db.prepare("INSERT INTO session(id, task_type) VALUES(?,?)").run("sess-other", "interactive");
  db.prepare("INSERT INTO session(id, task_type) VALUES(?,?)").run("sess-sub", "subagent_child");

  const exact = "  相同原话\n\n缩进  保留\n";
  const english = "The user really typed this sentence.  ";
  const sourceMs = Date.parse("2026-08-13T01:02:03.456Z");
  const ins = db.prepare("INSERT INTO message(id, session_id, sequence, time_created, data) VALUES(?,?,?,?,?)");
  ins.run("msg-a", "sess-main", 1, sourceMs, messageData({ turn: "turn-current", text: exact }));
  ins.run("msg-b", "sess-main", 2, sourceMs + 1000, messageData({ turn: "turn-current", text: exact }));
  ins.run("msg-c", "sess-main", 3, sourceMs + 2000, messageData({ turn: "turn-current", text: english }));
  ins.run("msg-old-turn", "sess-main", 4, sourceMs + 3000, messageData({ turn: "turn-old", text: "OLD-TURN-SHOULD-NOT-INGEST" }));
  ins.run("msg-synthetic", "sess-main", 5, sourceMs + 4000, messageData({ turn: "turn-current", text: "SYNTHETIC-SHOULD-NOT-INGEST", synthetic: true }));
  ins.run("msg-background", "sess-main", 6, sourceMs + 5000, messageData({ turn: "turn-current", text: "BACKGROUND-SHOULD-NOT-INGEST", source: "background_task" }));
  ins.run("msg-other", "sess-other", 1, sourceMs + 6000, messageData({ turn: "turn-current", text: "OTHER-SESSION-SHOULD-NOT-INGEST" }));
  ins.run("msg-sub", "sess-sub", 1, sourceMs + 7000, messageData({ turn: "turn-current", text: "SUBAGENT-SHOULD-NOT-INGEST" }));
  db.close();

  console.log("=== ZCode Stop fidelity ===");
  let result = runFlush(ROOT, SOURCE_DB, { hookEventName: "Stop", sessionId: "sess-main", turnId: "turn-current" });
  check("ZF1 hook exits successfully", result.status === 0 && result.stdout === "{}", `${result.status} ${result.stdout} ${result.stderr}`);

  if (!fs.existsSync(path.join(ROOT, "events.db"))) throw new Error(`auto-flush did not create events.db: ${result.stderr || result.stdout}`);
  const eventDb = new DatabaseSync(path.join(ROOT, "events.db"), { readOnly: true });
  let rows = eventDb.prepare("SELECT instance, mid, session, content, ts FROM events ORDER BY id").all();
  eventDb.close();
  check("ZF2 only current real-user turn ingested", rows.length === 3, JSON.stringify(rows));
  check("ZF3 original whitespace and blank lines preserved", rows[0]?.content === exact && rows[1]?.content === exact, JSON.stringify(rows.map(r => r.content)));
  check("ZF4 identical text with distinct message IDs stored twice", rows[0]?.instance === "zcode-msg:msg-a" && rows[1]?.instance === "zcode-msg:msg-b" && rows[0]?.mid === 0 && rows[1]?.mid === 0, JSON.stringify(rows));
  check("ZF5 real English starting with The is retained", rows[2]?.content === english, JSON.stringify(rows[2]));
  check("ZF6 source timestamps retained", rows[0]?.ts === new Date(sourceMs).toISOString() && rows[1]?.ts === new Date(sourceMs + 1000).toISOString(), JSON.stringify(rows.map(r => r.ts)));
  check("ZF7 source session retained", rows.every(r => r.session === "sess-main"), JSON.stringify(rows));
  check("ZF8 excluded messages absent", !rows.some(r => /SHOULD-NOT-INGEST/.test(r.content)), JSON.stringify(rows));

  const dailyPath = path.join(ROOT, "daily", `${localDate(sourceMs)}.md`);
  const dailyBefore = fs.readFileSync(dailyPath, "utf8");
  const markers = [...dailyBefore.matchAll(/cp-evt-v2:[0-9a-f]{32}/g)].map(m => m[0]);
  check("ZF9 projected to original local date", fs.existsSync(dailyPath), dailyPath);
  check("ZF10 v2 markers are exact and unique", markers.length === 3 && new Set(markers).size === 3, JSON.stringify(markers));
  check("ZF11 duplicate user utterance appears twice", dailyBefore.split(exact).length - 1 === 2, dailyBefore);

  console.log("=== Stable replay ===");
  result = runFlush(ROOT, SOURCE_DB, { hookEventName: "Stop", session_id: "sess-main", turn_id: "turn-current" });
  const replayDb = new DatabaseSync(path.join(ROOT, "events.db"), { readOnly: true });
  rows = replayDb.prepare("SELECT instance, mid, content, ts FROM events ORDER BY id").all();
  const projected = replayDb.prepare("SELECT COUNT(*) c FROM projection").get().c;
  replayDb.close();
  const dailyAfter = fs.readFileSync(dailyPath, "utf8");
  check("ZF12 replay exits successfully", result.status === 0 && result.stdout === "{}", `${result.status} ${result.stdout} ${result.stderr}`);
  check("ZF13 same source messages are idempotent", rows.length === 3, JSON.stringify(rows));
  check("ZF14 replay does not change daily bytes", dailyAfter === dailyBefore, `before=${dailyBefore.length} after=${dailyAfter.length}`);
  check("ZF15 every event remains projected", projected === 3, `projected=${projected}`);

  console.log("=== Fail-open boundary ===");
  const EMPTY_ROOT = path.join(SB, "empty-root");
  fs.mkdirSync(EMPTY_ROOT, { recursive: true });
  for (const file of ["events.js", "zcode-flush.cjs", "package.json"]) {
    const target = path.join(EMPTY_ROOT, file);
    fs.copyFileSync(path.join(ROOT, file), target);
  }
  result = runFlush(EMPTY_ROOT, path.join(SB, "missing.sqlite"), { sessionId: "sess-main", turnId: "turn-current" });
  check("ZF16 missing source DB fails open", result.status === 0 && result.stdout === "{}", `${result.status} ${result.stdout} ${result.stderr}`);
  check("ZF17 missing source DB creates no events.db", !fs.existsSync(path.join(EMPTY_ROOT, "events.db")), "events.db unexpectedly created");
  const undeclared = spawnSync(NODE, ["--experimental-sqlite", path.join(EMPTY_ROOT, "zcode-flush.cjs"), "--root", EMPTY_ROOT], {
    encoding: "utf8",
    timeout: 30000,
    input: JSON.stringify({ sessionId: "sess-main", turnId: "turn-current" }),
    env: { ...process.env, CP_NODE: NODE, HOME: SB, USERPROFILE: SB, CP_ZCODE_DB: "", CP_SKIP_DECISION_CARDS: "1", CP_SKIP_STOP_CHECKS: "1" },
  });
  const undeclaredJson = JSON.parse(undeclared.stdout);
  check("ZF19 undeclared source is visible", undeclared.status === 0 && undeclaredJson.skipped === true && /CP_ZCODE_DB/.test(undeclaredJson.error || ""), undeclared.stdout);
  check("ZF20 undeclared source creates no events.db", !fs.existsSync(path.join(EMPTY_ROOT, "events.db")));
} finally {
  fs.rmSync(SB, { recursive: true, force: true });
  check("ZF18 sandbox cleaned", !fs.existsSync(SB), SB);
}

console.log(`\n===== zcode-flush-test: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
