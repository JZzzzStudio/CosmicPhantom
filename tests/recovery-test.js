// tests/recovery-test.js - low-token policy recovery, no background processes.
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.join(os.homedir(), ".cosmic-phantom");
const NODE = path.join(REAL, "tools", "node", "node.exe");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-recovery-"));
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
// 2026-09-16 同步：resume-context.js 的 SOURCE_FILES 新增 `.context/CONTEXT.md`，
//   沙箱不同步拷贝它会让 refresh 报 `incomplete`（missing 非空）而非 `fresh` → P2/P3 假红。
for (const file of ["current-state.js", "current-state.json", "reply-policy.json", "resume-context.js", "reply-check.js", "inject.js", "memory-retrieval.js", "identity-card.js", "inject-config.js", "inject.config.json", "MEMORY.md", "package.json", "core/rules.md", "core/reply-style.md", ".context/CONTEXT.md", "lib/failopen.js"]) copy(file);
fs.mkdirSync(path.join(SB, "memories"), { recursive: true });
fs.writeFileSync(path.join(SB, "resume-manifest.json"), JSON.stringify({ schemaVersion: 1, policyRevision: 1, stateFile: "current-state.json", policyFile: "reply-policy.json", sources: {}, status: "provisional" }, null, 2));
const expectedRevision = JSON.parse(fs.readFileSync(path.join(SB, "current-state.json"), "utf8")).revision;
const expectedPolicyRevision = JSON.parse(fs.readFileSync(path.join(SB, "reply-policy.json"), "utf8")).revision;

console.log("=== Recovery manifest ===");
let result = spawnSync(NODE, [path.join(SB, "resume-context.js"), "check", "--root", SB], { encoding: "utf8", timeout: 30000 });
let payload = JSON.parse(result.stdout);
check("P1 provisional manifest is not trusted", result.status === 1 && payload.manifest !== "fresh", result.stdout);
result = spawnSync(NODE, [path.join(SB, "resume-context.js"), "refresh", "--root", SB, "--actor", "recovery-test"], { encoding: "utf8", timeout: 30000 });
check("P2 refresh writes a fresh source manifest", result.status === 0 && JSON.parse(result.stdout).status === "fresh", result.stdout);
result = spawnSync(NODE, [path.join(SB, "resume-context.js"), "check", "--root", SB], { encoding: "utf8", timeout: 30000 });
payload = JSON.parse(result.stdout);
check("P3 fresh manifest validates policy and state", result.status === 0 && payload.ok === true && payload.stateRevision === expectedRevision, result.stdout);

console.log("=== Bounded recovery injection ===");
result = spawnSync(NODE, [path.join(SB, "resume-context.js"), "render", "--root", SB, "--bytes", "1800"], { encoding: "utf8", timeout: 30000 });
check("P4 recovery block respects UTF-8 byte budget", result.status === 0 && Buffer.byteLength(result.stdout) <= 1800, String(Buffer.byteLength(result.stdout)));
check("P5 recovery contains policy and state revisions", result.stdout.includes(`policy-revision="${expectedPolicyRevision}"`) && result.stdout.includes(`state-revision="${expectedRevision}"`) && result.stdout.includes("回复门禁"), result.stdout.slice(0, 300));
result = spawnSync(NODE, [path.join(SB, "inject.js"), "--hint", "anything", "--root", SB], { encoding: "utf8", timeout: 30000 });
check("P6 inject orders recovery before memory search", result.status === 0 && result.stdout.indexOf("<context-recovery") < result.stdout.indexOf("<memory-injected"), result.stdout.slice(0, 200));

console.log("=== Local reply preflight ===");
result = spawnSync(NODE, [path.join(SB, "reply-check.js"), "--root", SB, "--corrected", "--technical"], { encoding: "utf8", timeout: 30000, input: "你说得对，稍后处理。" });
payload = JSON.parse(result.stdout);
check("P7 forbidden agreement and correction opening are rejected", payload.ok === false && payload.violations.some(v => v.code === "FORBIDDEN_AGREEMENT") && payload.violations.some(v => v.code === "CORRECTION_NOT_DIRECT"), result.stdout);
result = spawnSync(NODE, [path.join(SB, "reply-check.js"), "--root", SB, "--corrected", "--technical"], { encoding: "utf8", timeout: 30000, input: "📌 错误在规则没有进入固定注入链；现在改为恢复胶囊并增加本地预检。" });
payload = JSON.parse(result.stdout);
check("P8 direct Chinese technical reply passes preflight", payload.ok === true && payload.stateRevision === expectedRevision, result.stdout);

const prodState = path.join(REAL, "current-state.json");
const before = crypto.createHash("sha256").update(fs.readFileSync(prodState)).digest("hex");
const after = crypto.createHash("sha256").update(fs.readFileSync(prodState)).digest("hex");
check("P9 production current state is unchanged", before === after, `${before} -> ${after}`);
fs.rmSync(SB, { recursive: true, force: true });
check("P10 temporary sandbox is cleaned", !fs.existsSync(SB));
console.log(`\n===== recovery-test: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
