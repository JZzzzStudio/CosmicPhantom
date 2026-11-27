import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REAL = resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const ROOT = join(tmpdir(), `cp-events-generic-${process.pid}-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
copyFileSync(join(REAL, "events.js"), join(ROOT, "events.js"));

function run(args) {
  const result = spawnSync(NODE, ["--experimental-sqlite", join(ROOT, "events.js"), ...args, "--root", ROOT], { encoding: "utf8", timeout: 120000 });
  let json = null;
  try { json = JSON.parse((result.stdout || "").trim()); } catch {}
  return { ...result, json };
}
function check(name, ok, detail = "") {
  if (!ok) { console.error(`[FAIL] ${name}: ${detail}`); process.exitCode = 1; }
  else console.log(`[PASS] ${name}`);
}

try {
  const input = join(ROOT, "normalized.jsonl");
  const rows = [
    { source_instance: "custom-source", source_id: "custom-1", revision: 1, session_id: "custom-session", role: "user", content: "显式来源应展示", ts: "2026-11-26T01:00:00.000Z", source_kind: "custom-channel", source_ref: "custom://1", scope: "workspace" },
  ];
  writeFileSync(input, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
  const imported = run(["ingest-normalized", "--input", input]);
  check("generic normalized input projects", imported.status === 0 && imported.json?.logged === 1, imported.stdout || imported.stderr);

  const legacy = new DatabaseSync(join(ROOT, "events.db"));
  legacy.prepare("INSERT INTO events(instance, mid, session, role, content, ts) VALUES(?,?,?,?,?,?)").run("mystery-source", 1, "mystery-session", "user", "未知来源保留原始 instance", "2026-11-26T01:02:00.000Z");
  legacy.prepare("INSERT INTO events(instance, mid, session, role, content, ts) VALUES(?,?,?,?,?,?)").run("zcode-legacy", 1, "legacy-session", "user", "旧前缀兼容", "2026-11-26T01:03:00.000Z");
  legacy.prepare("INSERT INTO events(instance, mid, session, role, content, ts) VALUES(?,?,?,?,?,?)").run("manual", 2, "session-legacy", "user", "SessionAdapter 前缀兼容", "2026-11-26T01:03:30.000Z");
  legacy.prepare("INSERT INTO events(instance, mid, session, role, content, ts) VALUES(?,?,?,?,?,?)").run("proma-legacy", 1, "proma-session", "user", "Proma 前缀兼容", "2026-11-26T01:03:40.000Z");
  legacy.prepare("INSERT INTO events(instance, mid, session, role, content, ts) VALUES(?,?,?,?,?,?)").run("workbuddy-legacy", 1, "wb-session", "user", "WorkBuddy 前缀兼容", "2026-11-26T01:03:50.000Z");
  legacy.prepare("INSERT INTO events(instance, mid, session, role, content, ts) VALUES(?,?,?,?,?,?)").run("filtered-source", 1, "filtered-session", "user", "Base directory for this skill: /tmp/skill", "2026-11-26T01:04:00.000Z");
  legacy.close();
  const projected = run(["project"]);
  check("legacy and filtered events are projected", projected.status === 0 && projected.json?.projected === 5, projected.stdout || projected.stderr);

  const daily = readFileSync(join(ROOT, "daily", "2026-11-26.md"), "utf8");
  check("explicit source_kind is displayed", daily.includes("通道：custom-channel"), daily);
  check("missing source_kind still displays raw instance", daily.includes("通道：mystery-source"), daily);
  check("legacy zcode prefix remains compatible", daily.includes("通道：Legacy JSONL"), daily);
  check("legacy session prefix remains compatible", daily.includes("通道：SessionAdapter"), daily);
  check("legacy proma prefix remains compatible", daily.includes("通道：Legacy JSONL"), daily);
  check("legacy workbuddy prefix remains compatible", daily.includes("通道：Legacy JSONL"), daily);
  check("filtered raw text is absent from projection", !daily.includes("Base directory for this skill"), daily);
  check("filtered session has no empty session block", !daily.includes("会话 filtered-session") && !daily.includes("会话 filtered"), daily);

  const db = new DatabaseSync(join(ROOT, "events.db"));
  check("raw events remain in events.db", Number(db.prepare("SELECT COUNT(*) c FROM events WHERE content LIKE 'Base directory for this skill:%'").get().c) === 1);
  check("filtered event is marked projected", Number(db.prepare("SELECT COUNT(*) c FROM projection p JOIN events e ON e.id=p.event_id WHERE e.instance='filtered-source'").get().c) === 1);
  db.close();
  const usageFailure = run(["expand"]);
  check("expand usage failure exits non-zero", usageFailure.status !== 0 && !!usageFailure.json?.error, usageFailure.stdout);
  const missingIndex = run(["find", "--term", "probe"]);
  check("find without index exits non-zero", missingIndex.status !== 0 && !!missingIndex.json?.error, missingIndex.stdout);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
if (process.exitCode) process.exit(1);
console.log("events-genericization-test: all passed");
