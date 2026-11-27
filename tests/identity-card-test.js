// tests/identity-card-test.js - identity card budget, revision and G1 obligation contract.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writePublicState, writePublicMemory, writePublicDaily } = require("./fixtures/public-fixtures.cjs");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-identity-"));
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
for (const file of ["identity-card.js", "inject-config.js", "inject.config.json", "current-state.js", "reply-policy.json", "package.json"]) copy(file);
fs.mkdirSync(path.join(SB, "daily"), { recursive: true });
fs.mkdirSync(path.join(SB, "memories"), { recursive: true });
writePublicState(SB);
writePublicMemory(SB, "# Public synthetic profile\n\n已确认活跃记忆：IDENTITY_ACTIVE_MEMORY_VISIBLE\n");
writePublicDaily(SB, "2099-01-01.md", "IDENTITY_DAILY_RAW_MUST_STAY_HIDDEN");
fs.writeFileSync(path.join(SB, "memories", "20990101-0001.md"), "---\nid: 20990101-0001\ncreated: 2099-01-01T00:00:00+08:00\nstatus: 🟢当前\nscope: global\ntype: 偏好\n---\nIDENTITY_ACTIVE_MEMORY_VISIBLE\n", "utf8");

const probe = path.join(SB, "probe.mjs");
fs.writeFileSync(probe, `
const root = ${JSON.stringify(SB)};
const { buildIdentityCard } = await import("file:///" + root.replace(/\\\\/g, "/") + "/identity-card.js");
const card = buildIdentityCard(root);
console.log(JSON.stringify({ bytes: card.bytes, budget: card.budget, stateRevision: card.stateRevision, truncated: card.truncated, errors: card.errors, text: card.text }));
`);

console.log("=== Identity card contract ===");
const result = spawnSync(NODE, [probe], { encoding: "utf8", timeout: 30000 });
const payload = JSON.parse(result.stdout);
check("IC1 card fits the configured budget", result.status === 0 && payload.bytes <= payload.budget, `${payload.bytes} > ${payload.budget}`);
check("IC2 card carries current state revision", payload.stateRevision > 0 && payload.text.includes(`state-revision="${payload.stateRevision}"`), payload.text.slice(0, 120));
check("IC3 G1 obligation line present with expected revision", payload.text.includes("update_current_state") && payload.text.includes(`expectedRevision=${payload.stateRevision}`), payload.text.slice(0, 200));
check("IC4 profile and policy sections present", payload.text.includes("用户画像") && payload.text.includes("回复门禁"), "missing section");
check("IC5 nextActions retained before blockers/decisions", payload.text.includes("下一步"), "nextActions missing");
check("IC6 identity-card opens with marker", payload.text.startsWith("<identity-card"), payload.text.slice(0, 60));
check("IC8 full reply policy (13 rules + forbidden words)", payload.text.includes("1.中文为主") && payload.text.includes("13.大白话双层回复") && payload.text.includes("禁用词") && payload.text.includes("你说得对") && payload.text.includes("言之有理"), payload.text);
check("IC9 daily raw text stays out of identity card", !payload.text.includes("IDENTITY_DAILY_RAW_MUST_STAY_HIDDEN"), payload.text);
check("IC10 confirmed active memory is visible", payload.text.includes("已确认活跃记忆") && payload.text.includes("IDENTITY_ACTIVE_MEMORY_VISIBLE"), payload.text);

fs.rmSync(SB, { recursive: true, force: true });
check("IC7 temporary sandbox is cleaned", !fs.existsSync(SB));
console.log(`\n===== identity-card-test: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
