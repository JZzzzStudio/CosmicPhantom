// candidate-distill-events-test.mjs — events.db -> candidates/ public contract.
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REAL = resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const ROOT = join(tmpdir(), `cp-event-distill-${process.pid}-${Date.now()}`);
mkdirSync(join(ROOT, "memories"), { recursive: true });
mkdirSync(join(ROOT, "daily"), { recursive: true });
for (const file of ["candidate-distill.js", "candidates.js"]) copyFileSync(join(REAL, file), join(ROOT, file));

function check(name, ok, detail = "") {
  if (!ok) { console.error(`[FAIL] ${name}: ${detail}`); process.exitCode = 1; }
  else console.log(`[PASS] ${name}`);
}
function run(args) {
  const result = spawnSync(NODE, [join(REAL, "memory-cli.js"), ...args, "--root", ROOT], { encoding: "utf8", timeout: 120000 });
  let json = null;
  try { json = JSON.parse((result.stdout || "").trim()); } catch {}
  return { ...result, json };
}
function sql(code) {
  const db = new DatabaseSync(join(ROOT, "events.db"));
  db.exec(code);
  db.close();
}

try {
  sql(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance TEXT NOT NULL,
      mid INTEGER NOT NULL,
      session TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      ts TEXT NOT NULL,
      sensitive INTEGER DEFAULT 0,
      source_id TEXT,
      source_revision INTEGER DEFAULT 1,
      source_kind TEXT,
      source_ref TEXT,
      scope TEXT DEFAULT 'workspace',
      UNIQUE(instance, mid)
    );
    CREATE TABLE event_tombstones (
      instance TEXT NOT NULL,
      mid TEXT NOT NULL,
      action TEXT NOT NULL,
      UNIQUE(instance, mid, action)
    );
  `);
  sql(`
    INSERT INTO events(instance, mid, session, role, content, ts, source_id, source_revision, source_kind, source_ref, scope) VALUES
      ('source-a', 1, 'session-a', 'user', '请记住：我偏好简洁的中文回复', '2026-11-25T01:00:00.000Z', 'msg-1', 1, 'user', 'adapter://source-a/1', 'workspace'),
      ('source-a', 2, 'session-a', 'user', '普通聊天，不应成为记忆', '2026-11-25T01:01:00.000Z', 'msg-2', 1, 'user', 'adapter://source-a/2', 'workspace'),
      ('source-a', 3, 'session-a', 'assistant', '请记住：助手内容不应被当成用户记忆', '2026-11-25T01:02:00.000Z', 'msg-3', 1, 'assistant', 'adapter://source-a/3', 'workspace'),
      ('source-a', 4, 'session-a', 'user', '请记住 token: secret-value', '2026-11-25T01:03:00.000Z', 'msg-4', 1, 'user', 'adapter://source-a/4', 'workspace'),
      ('source-a', 5, 'session-a', 'user', '禁止：把未确认候选注入默认上下文', '2026-11-25T01:04:00.000Z', 'msg-5', 1, 'user', 'adapter://source-a/5', 'workspace'),
      ('source-a', 9, 'session-a', 'user', '请记住：我的密码是 example-only', '2026-11-25T01:04:30.000Z', 'msg-9', 1, 'user', 'adapter://source-a/9', 'workspace'),
      ('source-a', 6, 'session-a', 'user', '请记住：这条已被用户清除', '2026-11-25T01:05:00.000Z', 'msg-6', 1, 'user', 'adapter://source-a/6', 'workspace'),
      ('source-a', 7, 'session-a', 'user', '请记住：私有范围也不应越权', '2026-11-25T01:06:00.000Z', 'msg-7', 1, 'user', 'adapter://source-a/7', 'private'),
      ('source-a', 8, 'session-a', 'user', '请记住：我偏好简洁的中文回复（修订）', '2026-11-25T01:07:00.000Z', 'msg-1', 2, 'user', 'adapter://source-a/8', 'workspace');
    INSERT INTO event_tombstones(instance, mid, action) VALUES ('source-a', '6', 'purge');
  `);

  let result = run(["candidate", "distill-events"]);
  check("dry-run succeeds", result.status === 0 && result.json?.dryRun === true, result.stdout || result.stderr);
  check("dry-run finds two ordinary candidates", result.json?.wouldCreate === 3, JSON.stringify(result.json));
  check("dry-run does not write candidates", !existsSync(join(ROOT, "candidates")), readdirSync(ROOT).join(","));
  check("sensitive and unsupported-scope events are skipped", result.json?.skipped === 4, JSON.stringify(result.json));

  result = run(["candidate", "distill-events", "--apply"]);
  check("apply creates candidates", result.status === 0 && result.json?.created === 3, JSON.stringify(result.json));
  check("candidate files are physically separate", existsSync(join(ROOT, "candidates")) && readdirSync(join(ROOT, "candidates")).filter((name) => name.endsWith(".json")).length === 3, readdirSync(join(ROOT, "candidates")));
  const candidateFiles = readdirSync(join(ROOT, "candidates")).filter((name) => name.endsWith(".json"));
  const candidates = candidateFiles.map((name) => JSON.parse(readFileSync(join(ROOT, "candidates", name), "utf8")));
  check("candidates remain pending", candidates.every((candidate) => candidate.state === "candidate"), JSON.stringify(candidates));
  check("candidate stores source pointer without source payload", candidates.every((candidate) => /^events\.db:/.test(candidate.source_ref) && !JSON.stringify(candidate).includes("secret-value")), JSON.stringify(candidates));
  const sourceRefs = candidates.map((candidate) => candidate.source_ref);
  check("revision creates a separate opaque source candidate", new Set(sourceRefs).size === 3 && sourceRefs.every((value) => /^events\.db:cp-evt-v2:[a-f0-9]{32}$/.test(value)), JSON.stringify(sourceRefs));
  check("candidate source refs do not expose adapter identifiers", candidates.every((candidate) => !JSON.stringify(candidate).includes("source-a") && !JSON.stringify(candidate).includes("msg-")), JSON.stringify(candidates));
  check("candidate content is derived from explicit user intent", candidates.some((candidate) => candidate.content === "我偏好简洁的中文回复") && candidates.some((candidate) => candidate.content === "把未确认候选注入默认上下文"), JSON.stringify(candidates));

  result = run(["candidate", "distill-events", "--apply"]);
  check("repeat apply is idempotent", result.status === 0 && result.json?.created === 0 && result.json?.alreadyExists === 3, JSON.stringify(result.json));

  result = run(["candidate", "distill-events", "--limit", "2"]);
  check("small scans expose a continuation cursor", result.status === 0 && result.json?.truncated === true && Number.isSafeInteger(result.json?.nextAfterId), JSON.stringify(result.json));
  let cursor = result.json?.nextAfterId;
  let pages = 1;
  let pageResult;
  while (cursor && pages < 10) {
    pageResult = run(["candidate", "distill-events", "--limit", "2", "--after-id", String(cursor)]);
    cursor = pageResult.json?.truncated ? pageResult.json.nextAfterId : null;
    pages += 1;
  }
  check("continuation cursor advances until the scan is complete", pageResult?.status === 0 && pageResult.json?.truncated === false && pages > 1, JSON.stringify(pageResult?.json));
  check("distillation does not materialize active memory", readdirSync(join(ROOT, "memories")).length === 0, readdirSync(join(ROOT, "memories")));

  result = run(["candidate", "list"]);
  check("public candidate list sees all pending records", result.status === 0 && result.json?.count === 3 && result.json.items.every((item) => item.state === "candidate"), JSON.stringify(result.json));
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
if (process.exitCode) process.exit(1);
console.log("candidate-distill-events-test: all passed");
