// memory-feedback-test.js — explicit-mark feedback contract (spec: work/cp-memory-feedback/spec.md).
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-memory-feedback-"));
const ROOT = path.join(SB, "root");
for (const dir of ["memories", "candidates", "daily", "backup", "lib"]) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
const engineFiles = [
  "memory-cli.js", "memory-domains.js", "memory-retrieval.js", "validate.js", "candidates.js", "package.json",
  "link-graph.js", "skills-sync.js", "inject.js", "identity-card.js", "inject-config.js", "inject.config.json",
  "current-state.js", "reply-policy.json", "resume-context.js",
];
for (const file of engineFiles) fs.copyFileSync(path.join(REAL, file), path.join(ROOT, file));
for (const lib of ["failopen.js", "memory-feedback.js"]) {
  if (fs.existsSync(path.join(REAL, "lib", lib))) fs.copyFileSync(path.join(REAL, "lib", lib), path.join(ROOT, "lib", lib));
}
fs.writeFileSync(path.join(ROOT, "current-state.json"), JSON.stringify({
  schemaVersion: 1, revision: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "public-test",
  source: "synthetic fixture", status: "active", objective: "verify feedback", summary: "public synthetic state",
  completed: [], nextActions: [], blockers: [], decisions: [], workingFiles: [], verification: [],
}, null, 2) + "\n", "utf8");
fs.writeFileSync(path.join(ROOT, "memories", "legacy.md"), "---\nid: legacy-1\nscope: workspace\nstatus: 🟢当前\n---\n\nLegacy memory for feedback.\n", "utf8");

function run(args, extraEnv = {}) {
  const result = spawnSync(NODE, ["--experimental-sqlite", path.join(ROOT, "memory-cli.js"), ...args, "--root", ROOT], { encoding: "utf8", timeout: 30000, env: { ...process.env, CP_ROOT: ROOT, ...extraEnv } });
  let out = null;
  try { out = JSON.parse((result.stdout || "").trim() || "{}"); } catch {}
  return { status: result.status, out, stdout: result.stdout || "", stderr: result.stderr || "" };
}
function check(name, condition, detail = "") {
  if (!condition) { console.error("[FAIL] " + name + ": " + detail); process.exitCode = 1; }
  else console.log("[PASS] " + name);
}
function code(result) { return result.out?.code || ""; }
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const created = run(["domains", "candidate", "create", "--content", "Feedback target decision", "--source-ref", "manual:fb:1", "--user-confirmed", "--actor", "user"]);
const candidateId = created.out?.candidate?.candidate_id;
check("fixture candidate created", created.status === 0 && Boolean(candidateId), JSON.stringify(created.out));
run(["domains", "candidate", "classify", "--id", candidateId, "--domain", "project", "--user-confirmed", "--actor", "user"]);
const confirmed = run(["domains", "candidate", "confirm", "--id", candidateId, "--user-confirmed", "--actor", "user"]);
const memoryId = confirmed.out?.candidate?.confirmed_memory_id;
check("fixture entity confirmed", confirmed.status === 0 && Boolean(memoryId), JSON.stringify(confirmed.out));
const entityFile = path.join(ROOT, "domains", "project", "memories", String(memoryId || "").replace(/-v\d+$/, "") + ".json");
const entityBefore = fs.existsSync(entityFile) ? digest(entityFile) : "";

const added = run(["feedback", "add", "--memory", memoryId, "--verdict", "helped", "--task", "t1"]);
check("add helped ok", added.status === 0 && added.out?.ok === true && added.out?.idempotent === false, JSON.stringify(added.out));
const stats1 = run(["feedback", "stats", "--memory", memoryId]);
check("stats helped_user 1", stats1.out?.memories?.[memoryId]?.helped_user === 1, JSON.stringify(stats1.out));
const dup = run(["feedback", "add", "--memory", memoryId, "--verdict", "helped", "--task", "t1"]);
check("duplicate idempotent", dup.status === 0 && dup.out?.idempotent === true, JSON.stringify(dup.out));
const stats2 = run(["feedback", "stats", "--memory", memoryId]);
check("stats unchanged after dup", stats2.out?.memories?.[memoryId]?.helped_user === 1, JSON.stringify(stats2.out));
let rows = -1;
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(ROOT, "events.db"));
  rows = db.prepare("SELECT COUNT(*) c FROM memory_feedback").get().c;
  db.close();
} catch {}
check("events.db has exactly 1 mark row", rows === 1, String(rows));

const badMem = run(["feedback", "add", "--memory", "no-such-memory", "--verdict", "helped"]);
check("unknown memory rejected", badMem.status === 1 && code(badMem) === "MEMORY_NOT_FOUND", JSON.stringify(badMem.out));
const badVerdict = run(["feedback", "add", "--memory", memoryId, "--verdict", "maybe"]);
check("invalid verdict rejected", badVerdict.status === 1 && Boolean(code(badVerdict)), JSON.stringify(badVerdict.out));
const legacyAdd = run(["feedback", "add", "--memory", "legacy-1", "--verdict", "helped", "--task", "t2"]);
check("legacy memory id accepted", legacyAdd.status === 0 && legacyAdd.out?.ok === true, JSON.stringify(legacyAdd.out));

const misled = run(["feedback", "add", "--memory", memoryId, "--verdict", "misled", "--task", "t3"]);
check("misled mark ok", misled.status === 0 && misled.out?.ok === true, JSON.stringify(misled.out));
check("entity byte-stable after marks", fs.existsSync(entityFile) && digest(entityFile) === entityBefore, "entity changed");
const search = run(["domains", "search", "--query", "Feedback", "--cross-domain"]);
check("memory still retrievable", search.status === 0 && JSON.stringify(search.out).includes(memoryId), JSON.stringify(search.out).slice(0, 200));

const unauth = run(["feedback", "suggest"]);
check("suggest requires authorization", code(unauth) === "USER_AUTHORIZATION_REQUIRED", JSON.stringify(unauth.out));
const sug = run(["feedback", "suggest", "--user-confirmed", "--actor", "user"]);
check("suggest creates review candidate", sug.status === 0 && sug.out?.created?.length === 1, JSON.stringify(sug.out));
const reviewId = sug.out?.created?.[0]?.candidate_id;
const review = run(["domains", "candidate", "show", "--id", reviewId]);
check("review candidate unclassified pending", review.out?.candidate?.state === "candidate" && review.out?.candidate?.primary_domain === null, JSON.stringify(review.out));
check("review content names memory", String(review.out?.candidate?.content || "").includes(memoryId), JSON.stringify(review.out?.candidate?.content || ""));
const sug2 = run(["feedback", "suggest", "--user-confirmed", "--actor", "user"]);
check("suggest idempotent", sug2.status === 0 && sug2.out?.created?.length === 0 && sug2.out?.existing?.length === 1, JSON.stringify(sug2.out));

run(["feedback", "add", "--memory", memoryId, "--verdict", "misled", "--marker", "agent", "--task", "t4"]);
run(["feedback", "add", "--memory", memoryId, "--verdict", "misled", "--marker", "agent", "--task", "t5"]);
const stats3 = run(["feedback", "stats", "--memory", memoryId]);
const m = stats3.out?.memories?.[memoryId] || {};
check("provenance separated", m.helped_user === 1 && m.misled_user === 1 && m.misled_agent === 2 && m.helped_agent === 0, JSON.stringify(m));
const expected = "历史标记：1 帮到 / 3 误导（user 2 / agent 2）";
check("annotation matches stats", m.annotation === expected, String(m.annotation));
run(["feedback", "add", "--memory", "legacy-1", "--verdict", "misled", "--marker", "agent", "--task", "t6"]);
run(["feedback", "add", "--memory", "legacy-1", "--verdict", "misled", "--marker", "agent", "--task", "t7"]);
const sug3 = run(["feedback", "suggest", "--user-confirmed", "--actor", "user"]);
check("agent threshold triggers", sug3.status === 0 && sug3.out?.created?.length === 2 && sug3.out?.created?.some((c) => c.memory_id === "legacy-1"), JSON.stringify(sug3.out));

const cachePath = path.join(ROOT, "feedback-stats.json");
check("cache exists", fs.existsSync(cachePath), "");
if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
const rebuilt = run(["feedback", "stats"]);
check("rebuild restores cache", rebuilt.status === 0 && fs.existsSync(cachePath), JSON.stringify(rebuilt.out));
const stats4 = run(["feedback", "stats", "--memory", memoryId]);
check("rebuilt counts identical", stats4.out?.memories?.[memoryId]?.misled_agent === 2, JSON.stringify(stats4.out));

const failed = run(["feedback", "add", "--memory", memoryId, "--verdict", "helped", "--task", "tfail"], { CP_TEST_FAIL_FEEDBACK_ADD: "1" });
check("injected failure exits nonzero", failed.status === 1 && Boolean(code(failed)), JSON.stringify(failed.out));
let fo = {};
try { fo = JSON.parse(fs.readFileSync(path.join(ROOT, "failopen-stats.json"), "utf8")); } catch {}
check("failopen counted", (fo["memory-feedback-add"]?.fallbacks || 0) >= 1, JSON.stringify(fo["memory-feedback-add"]));
const injectRun = spawnSync(NODE, [path.join(ROOT, "inject.js"), "--hint", "feedback", "--root", ROOT], { encoding: "utf8", timeout: 30000, env: { ...process.env, CP_ROOT: ROOT } });
check("inject task path unaffected", injectRun.status === 0, injectRun.stderr);

const ENGINE = path.join(SB, "engine");
fs.mkdirSync(path.join(ENGINE, "lib"), { recursive: true });
for (const file of engineFiles) fs.copyFileSync(path.join(REAL, file), path.join(ENGINE, file));
for (const lib of ["failopen.js", "memory-feedback.js"]) {
  if (fs.existsSync(path.join(REAL, "lib", lib))) fs.copyFileSync(path.join(REAL, "lib", lib), path.join(ENGINE, "lib", lib));
}
function engineRun(args) {
  const r = spawnSync(NODE, ["--experimental-sqlite", path.join(ENGINE, "memory-cli.js"), ...args, "--root", ENGINE], { encoding: "utf8", timeout: 30000, env: { ...process.env, CP_ROOT: ENGINE } });
  let o = null;
  try { o = JSON.parse((r.stdout || "").trim() || "{}"); } catch {}
  return { status: r.status, out: o };
}
const blocked = engineRun(["feedback", "add", "--memory", "x", "--verdict", "helped"]);
check("engine mode blocks feedback write", blocked.status === 1 && blocked.out?.blocked === "ENGINE_MODE_WRITE", JSON.stringify(blocked.out));
const ro = engineRun(["feedback", "stats"]);
check("engine mode allows read-only stats", ro.status === 0 && ro.out?.ok === true && !fs.existsSync(path.join(ENGINE, "events.db")), JSON.stringify(ro.out));

console.log(process.exitCode ? "FEEDBACK TEST FAILED" : "FEEDBACK TEST PASSED");


