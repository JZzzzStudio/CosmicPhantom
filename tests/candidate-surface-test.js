// candidate-surface-test.js — ticket 02 default-context isolation contract.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-candidate-surface-"));
const ROOT = path.join(SB, "root");
for (const dir of ["memories", "candidates", "daily", "backup", "lib"]) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
for (const file of [
  "memory-cli.js", "memory-retrieval.js", "validate.js", "candidates.js", "package.json",
  "link-graph.js", "skills-sync.js", "inject.js", "identity-card.js", "inject-config.js",
  "inject.config.json", "current-state.js", "current-state.json", "reply-policy.json",
  "resume-context.js", "MEMORY.md",
]) fs.copyFileSync(path.join(REAL, file), path.join(ROOT, file));
fs.copyFileSync(path.join(REAL, "lib", "failopen.js"), path.join(ROOT, "lib", "failopen.js"));

const PENDING = "SURFACE_PENDING_candidate_must_not_appear";
const RAW = "SURFACE_RAW_daily_must_not_appear";
const ACTIVE = "SURFACE_ACTIVE_confirmed_memory_should_appear";
fs.writeFileSync(path.join(ROOT, "daily", "2099-01-01.md"), `# 2099-01-01\n\n## 会话 raw-surface\n- 👤 用户：${RAW}\n- 候选摘要：${PENDING}\n`, "utf8");
function run(script, args) {
  const r = spawnSync(NODE, [path.join(ROOT, script), ...args, "--root", ROOT], { encoding: "utf8", timeout: 30000 });
  return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
}
function json(result) { try { return JSON.parse(result.out.trim() || "{}"); } catch { return {}; } }
function check(name, ok, detail = "") {
  if (!ok) { console.error(`[FAIL] ${name}: ${detail}`); process.exitCode = 1; }
  else console.log(`[PASS] ${name}`);
}

const added = run("memory-cli.js", ["candidate", "add", PENDING, "--kind", "decision", "--source-kind", "user_said", "--source-ref", "events.db:surface:1", "--confidence", "1", "--scope", "workspace"]);
const candidate = json(added);
const candidateId = candidate.candidate_id;
check("candidate is created before any active card", added.status === 0 && candidate.added === true && fs.readdirSync(path.join(ROOT, "memories")).length === 0, added.out);

const searchPending = run("memory-cli.js", ["search", PENDING]);
check("search excludes pending candidate", json(searchPending).count === 0 && !searchPending.out.includes(PENDING), searchPending.out);
const recallPending = run("memory-cli.js", ["recall", PENDING]);
check("recall excludes pending candidate and daily raw text", !recallPending.out.includes(PENDING) && !recallPending.out.includes(RAW), recallPending.out);
const injectPending = run("inject.js", ["--hint", PENDING]);
check("inject excludes pending candidate and daily raw text", !injectPending.out.includes(PENDING) && !injectPending.out.includes(RAW), injectPending.out);
const resume = run("resume-context.js", ["render"]);
check("recovery capsule excludes daily raw text", !resume.out.includes(PENDING) && !resume.out.includes(RAW), resume.out);

const confirmed = run("memory-cli.js", ["candidate", "confirm", candidateId, "--actor", "user"]);
check("explicit confirmation creates active memory", json(confirmed).confirmed === 1, confirmed.out);
const searchActive = run("memory-cli.js", ["search", PENDING]);
check("confirmed active memory is searchable", json(searchActive).count > 0 && searchActive.out.includes(PENDING), searchActive.out);
const injectActive = run("inject.js", ["--hint", PENDING]);
check("confirmed active memory reaches inject", injectActive.out.includes(PENDING) && !injectActive.out.includes(RAW), injectActive.out);
const recallActive = run("memory-cli.js", ["recall", PENDING]);
check("confirmed active memory reaches recall", recallActive.out.includes(PENDING) && !recallActive.out.includes(RAW), recallActive.out);

fs.rmSync(SB, { recursive: true, force: true });
check("surface sandbox cleaned", !fs.existsSync(SB));
if (process.exitCode) process.exit(1);
console.log("candidate-surface-test: all passed");
