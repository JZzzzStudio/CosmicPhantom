// tests/session-adapter-test.js - 无 transcript 宿主会话落盘 + recovery loop.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.join(os.homedir(), ".cosmic-phantom");
const NODE = path.join(REAL, "tools", "node", "node.exe");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-session-"));
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
for (const file of ["events.js", "package.json", "inject.js", "memory-retrieval.js", "identity-card.js", "inject-config.js", "inject.config.json", "current-state.js", "current-state.json", "reply-policy.json", "resume-context.js", "MEMORY.md", "session-adapter.js", "lib/failopen.js"]) copy(file);
fs.mkdirSync(path.join(SB, "daily"), { recursive: true });
fs.mkdirSync(path.join(SB, "memories"), { recursive: true });

const payload = path.join(SB, "payload.json");
fs.writeFileSync(payload, JSON.stringify({
  entries: [
    { role: "user", text: "把回复偏好合并进 preferences.md，单一规则源" },
    { role: "user", text: "先解决新会话忘记我是谁的设计" },
  ],
  summary: "统一门禁实装 + 恢复闭环设计",
}));

console.log("=== session adapter persistence ===");
let r = spawnSync(NODE, ["--experimental-sqlite", path.join(SB, "session-adapter.js"), "--session", "test01", "--root", SB, "--file", payload], { encoding: "utf8", timeout: 30000 });
let out = JSON.parse(r.stdout);
check("BZ1 adapter persists entries", r.status === 0 && out.logged === 2, JSON.stringify(out));
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const dailyPath = path.join(SB, "daily", `${localToday()}.md`);
check("BZ2 daily projected", fs.existsSync(dailyPath) && fs.readFileSync(dailyPath, "utf8").includes("把回复偏好合并进 preferences.md"), "daily missing content");

console.log("=== New session recovery (identity card) ===");
r = spawnSync(NODE, [path.join(SB, "inject.js"), "--lens", "会话恢复", "--root", SB], { encoding: "utf8", timeout: 30000 });
const text = r.stdout || "";
check("BZ3 identity card does not replay daily raw text", !text.includes("把回复偏好合并进 preferences.md") && !text.includes("先解决新会话"), "daily raw text leaked into default context");
check("BZ4 order: identity-card → task-lens → recovery → memory", text.indexOf("<identity-card") < text.indexOf("<task-lens") && text.indexOf("<task-lens") < text.indexOf("<context-recovery") && text.indexOf("<context-recovery") < text.indexOf("<memory-injected"), "block order broken");

fs.rmSync(SB, { recursive: true, force: true });
check("BZ5 sandbox cleaned", !fs.existsSync(SB));
console.log(`\n===== session-adapter-test: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
