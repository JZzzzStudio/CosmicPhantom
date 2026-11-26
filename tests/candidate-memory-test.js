// candidate-memory-test.js — ticket 00 public lifecycle contract.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-candidate-"));
const ROOT = path.join(SB, "root");
fs.mkdirSync(path.join(ROOT, "memories"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "daily"), { recursive: true });
for (const file of ["memory-cli.js", "memory-retrieval.js", "validate.js", "candidates.js", "package.json", "link-graph.js", "skills-sync.js"]) {
  fs.copyFileSync(path.join(REAL, file), path.join(ROOT, file));
}
fs.mkdirSync(path.join(ROOT, "lib"), { recursive: true });
fs.copyFileSync(path.join(REAL, "lib", "failopen.js"), path.join(ROOT, "lib", "failopen.js"));
function run(args) {
  const r = spawnSync(NODE, [path.join(ROOT, "memory-cli.js"), ...args, "--root", ROOT], { encoding: "utf8", timeout: 30000 });
  let out = null;
  try { out = JSON.parse((r.stdout || "").trim() || "{}"); } catch {}
  return { status: r.status, out, text: r.stdout || r.stderr || "" };
}
function check(name, ok, detail) { if (!ok) { console.error(`[FAIL] ${name}: ${detail || ""}`); process.exitCode = 1; } else console.log(`[PASS] ${name}`); }

const add = run(["candidate", "add", "用户确认默认上下文只读提纯层", "--kind", "decision", "--source-kind", "user_said", "--source-ref", "events.db:manual:7", "--confidence", "1", "--scope", "global"]);
check("candidate add succeeds", add.status === 0 && add.out?.added === true, `status=${add.status} out=${JSON.stringify(add.out)} text=${add.text.slice(0, 300)}`);
const id = add.out?.candidate_id;
check("candidate is stored outside memories", Boolean(id) && fs.existsSync(path.join(ROOT, "candidates", `${id}.json`)) && fs.readdirSync(path.join(ROOT, "memories")).length === 0, `id=${id} files=${fs.existsSync(path.join(ROOT, "candidates")) ? fs.readdirSync(path.join(ROOT, "candidates")) : []}`);
const listed = run(["candidate", "list"]);
check("candidate list exposes pending candidate", listed.out?.count === 1 && listed.out.items?.[0]?.state === "candidate", JSON.stringify(listed.out));
const searchBefore = run(["search", "默认上下文只读提纯层"]);
check("candidate is absent from ordinary search", searchBefore.out?.count === 0, JSON.stringify(searchBefore.out));
const edited = run(["candidate", "edit", id, "用户确认默认检索和注入只读已确认提纯层"]);
check("edit keeps candidate pending and source pointer", edited.out?.updated === true && edited.out.candidate?.state === "candidate" && edited.out.candidate?.source_ref === "events.db:manual:7" && edited.out.candidate?.history?.length === 2, JSON.stringify(edited.out));
const editSource = run(["candidate", "edit", id, "再次修改但不覆盖证据", "--source-ref", "events.db:manual:8"]);
check("edit cannot overwrite source pointer", editSource.out?.updated === false && /source_ref/.test(editSource.text), editSource.text);
const confirmed = run(["candidate", "confirm", id, "--actor", "user"]);
check("confirm materializes active memory", confirmed.out?.confirmed === 1 && confirmed.out.items?.[0]?.active_memory_id, JSON.stringify(confirmed.out));
const searchAfter = run(["search", "默认检索和注入只读已确认提纯层"]);
check("confirmed memory is searchable", (searchAfter.out?.count || 0) > 0, JSON.stringify(searchAfter.out));
const repeat = run(["candidate", "confirm", id, "--actor", "user"]);
check("repeat confirm is idempotent", repeat.out?.confirmed === 0 && repeat.out?.already_confirmed === 1, JSON.stringify(repeat.out));
const rejected = run(["candidate", "add", "这条候选稍后不应成为活跃事实", "--kind", "preference", "--source-kind", "assistant_said", "--source-ref", "session:test:2", "--confidence", "0.4", "--scope", "workspace"]);
const rid = rejected.out?.candidate_id;
const reject = run(["candidate", "reject", rid, "--actor", "user"]);
check("reject preserves audit record", reject.out?.rejected === 1 && fs.existsSync(path.join(ROOT, "candidates", `${rid}.json`)), JSON.stringify(reject.out));
const invalid = run(["candidate", "add", "缺来源的候选", "--kind", "decision", "--confidence", "1", "--scope", "global"]);
check("missing source is rejected", invalid.out?.added === false && /source_ref/.test(invalid.text), invalid.text);
fs.rmSync(SB, { recursive: true, force: true });
if (process.exitCode) process.exit(1);
console.log("candidate-memory-test: all passed");
