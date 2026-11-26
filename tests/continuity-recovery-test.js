// tests/continuity-recovery-test.js - Memorix Compact Continuity matrix.
// 新会话与上下文压缩后的身份恢复必须可证明：偏好/最近工作/状态/透镜全部恢复。
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.join(os.homedir(), ".cosmic-phantom");
const NODE = path.join(REAL, "tools", "node", "node.exe");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-continuity-r-"));
let pass = 0, fail = 0;
function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail}`); }
}
function copy(relative) {
  const target = path.join(SB, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REAL, relative), target);
}
for (const file of ["identity-card.js", "inject-config.js", "inject.config.json", "current-state.js", "current-state.json", "reply-policy.json", "MEMORY.md", "resume-context.js", "inject.js", "memory-retrieval.js", "lib/failopen.js", "package.json"]) copy(file);
fs.mkdirSync(path.join(SB, "daily"), { recursive: true });
fs.mkdirSync(path.join(SB, "memories"), { recursive: true });
const dailyDir = path.join(REAL, "daily");
if (fs.existsSync(dailyDir)) {
  const latest = fs.readdirSync(dailyDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().at(-1);
  if (latest) fs.copyFileSync(path.join(dailyDir, latest), path.join(SB, "daily", latest));
}
const DAILY_RAW_SENTINEL = "CONTINUITY_DAILY_RAW_MUST_STAY_HIDDEN";
const copiedDaily = fs.readdirSync(path.join(SB, "daily")).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().at(-1);
if (copiedDaily) fs.appendFileSync(path.join(SB, "daily", copiedDaily), `\n${DAILY_RAW_SENTINEL}\n`, "utf8");
// 记忆样本（供透镜检索）
fs.writeFileSync(path.join(SB, "memories", "20260810-0001.md"), "title: 记忆系统恢复\nstatus: 🟢当前\n用户要求基于现有资产继续推进记忆系统。\n");
const prodState = path.join(REAL, "current-state.json");
const before = require("node:crypto").createHash("sha256").update(fs.readFileSync(prodState)).digest("hex");

function run(args) {
  const result = spawnSync(NODE, [path.join(SB, "inject.js"), ...args, "--root", SB], { encoding: "utf8", timeout: 30000 });
  return { status: result.status, out: result.stdout || "" };
}

console.log("=== CT1 new-session inject order ===");
let r = run(["--lens", "记忆系统恢复"]);
const idxCard = r.out.indexOf("<identity-card");
const idxLens = r.out.indexOf("<task-lens");
const idxRecovery = r.out.indexOf("<context-recovery");
const idxMemory = r.out.indexOf("<memory-injected");
check("CT1 identity-card → task-lens → recovery → memory", r.status === 0 && idxCard >= 0 && idxCard < idxLens && idxLens < idxRecovery && idxRecovery < idxMemory, `card=${idxCard} lens=${idxLens} rec=${idxRecovery} mem=${idxMemory}`);
check("CT2 task-lens carries the task", idxLens >= 0 && r.out.includes('task="记忆系统恢复"'), r.out.slice(idxLens, idxLens + 120));

console.log("=== CT3 compact recovery restores identity ===");
check("CT3 full reply policy after recovery", r.out.includes("1.中文为主") && r.out.includes("9.实质性技术成果落盘") && r.out.includes("禁用词"), "policy incomplete");
check("CT4 daily raw text stays out of default recovery", !r.out.includes(DAILY_RAW_SENTINEL), "daily raw text leaked into default recovery");
check("CT5 state and obligation restored", r.out.includes("接力状态") && r.out.includes("update_current_state") && r.out.includes("expectedRevision"), "state block");
check("CT6 lens-focused memory retrieval", r.out.includes("记忆系统恢复"), "memory hit missing");
check("CT7 bounded output", r.out.includes("</identity-card>"), "card unclosed");

const after = require("node:crypto").createHash("sha256").update(fs.readFileSync(prodState)).digest("hex");
check("CT8 production current state unchanged", before === after, `${before} -> ${after}`);

fs.rmSync(SB, { recursive: true, force: true });
check("CT9 temporary sandbox cleaned", !fs.existsSync(SB));
console.log(`\n===== continuity-recovery-test: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
