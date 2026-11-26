// tests/continuity-test.js - structured cross-window handoff regression test.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const REAL = path.join(os.homedir(), ".cosmic-phantom");
const NODE = path.join(REAL, "tools", "node", "node.exe");
const SCRIPT = path.join(REAL, "current-state.js");
const MCP = path.join(REAL, "resources", "mcp-server", "index.js");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-continuity-"));
let pass = 0, fail = 0;
function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail}`); }
}
function run(args, options = {}) {
  const result = spawnSync(NODE, [SCRIPT, ...args, "--root", SB], { encoding: "utf8", timeout: 30000, ...options });
  return { status: result.status, out: result.stdout || "", err: result.stderr || "" };
}
function json(result) { return JSON.parse(result.out); }
function sha(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

const prodState = path.join(REAL, "current-state.json");
const prodBefore = fs.existsSync(prodState) ? sha(prodState) : null;

console.log("=== Continuity state owner ===");
let result = run(["show"]);
let state = json(result);
check("C1 missing file returns revision zero state", result.status === 0 && state.revision === 0 && state.status === "paused", result.out);

const patch = {
  status: "active",
  objective: "Continue the migration review",
  summary: "The next agent must start from the verified boundary.",
  completed: ["baseline captured"],
  nextActions: ["run isolated verification"],
  blockers: ["production migration not authorized"],
  decisions: ["do not infer user facts"],
  workingFiles: ["current-state.js"],
  verification: ["continuity contract pending"],
};
result = run(["update", "--expected-revision", "0", "--actor", "test-agent", "--source", "continuity-test"], { input: JSON.stringify(patch) });
state = json(result).state;
check("C2 explicit update commits revision one", result.status === 0 && state.revision === 1 && state.objective === patch.objective, result.out);
check("C3 atomic update leaves no lock or temp file", !fs.existsSync(path.join(SB, ".current-state.lock")) && fs.readdirSync(SB).every(name => !name.includes(".tmp-")), fs.readdirSync(SB).join(","));

result = run(["update", "--expected-revision", "0", "--actor", "stale-agent"], { input: JSON.stringify({ summary: "stale overwrite" }) });
const conflict = json(result);
check("C4 stale revision is rejected", result.status === 2 && conflict.code === "REVISION_CONFLICT", result.out);

result = run(["update", "--expected-revision", "1"], { input: JSON.stringify({ inventedField: "not allowed" }) });
const invalid = json(result);
check("C5 unknown fields are rejected", result.status === 1 && invalid.error.includes("unknown patch fields"), result.out);

result = run(["render", "--bytes", "900"]);
check("C6 rendered handoff is bounded and structured", result.status === 0 && Buffer.byteLength(result.out) <= 1000 && result.out.includes("<current-state") && result.out.includes("nextActions"), result.out.slice(0, 200));

console.log("=== Automatic injection ===");
const inject = spawnSync(NODE, [path.join(REAL, "inject.js"), "--hint", "anything", "--root", SB], { encoding: "utf8", timeout: 30000 });
check("C7 inject puts recovery/state before memory results", inject.status === 0 && inject.stdout.indexOf("<context-recovery") < inject.stdout.indexOf("<memory-injected") && inject.stdout.includes("<current-state") && inject.stdout.includes(patch.objective), inject.stdout.slice(0, 250));

console.log("=== MCP read contract ===");
const input = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_current_state", arguments: {} } }),
  JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_current_state", arguments: { expectedRevision: 1, actor: "mcp-test-agent", source: "continuity-test", patch: { summary: "MCP handoff update" } } } }),
].join("\n") + "\n";
const mcp = spawnSync(NODE, [MCP], {
  encoding: "utf8",
  timeout: 30000,
  input,
  env: { ...process.env, USERPROFILE: SB, CP_ROOT: SB, CP_CURRENT_ROOT: SB, CP_LOG_DIR: SB, CP_WATCH_DB: path.join(SB, "missing-state.db") },
});
check("C8 MCP exposes both continuity tools", mcp.status === 0 && mcp.stdout.includes("get_current_state") && mcp.stdout.includes("update_current_state"), mcp.stdout.slice(0, 300));
check("C9 MCP reads sandbox current state", mcp.stdout.includes(patch.objective) && !fs.existsSync(path.join(SB, "events.db")), mcp.stdout.slice(-300));
const mcpUpdated = JSON.parse(fs.readFileSync(path.join(SB, "current-state.json"), "utf8"));
check("C10 MCP revision-checked update commits", mcp.stdout.includes("MCP handoff update") && mcpUpdated.revision === 2 && mcpUpdated.updatedBy === "mcp-test-agent", mcp.stdout.slice(-400));

const prodAfter = fs.existsSync(prodState) ? sha(prodState) : null;
check("C11 production current state is unchanged", prodBefore === prodAfter, `${prodBefore} -> ${prodAfter}`);

fs.rmSync(SB, { recursive: true, force: true });
console.log(`\n===== continuity-test: ${pass} passed / ${fail} failed =====`);
console.log(`temporary sandbox cleaned: ${!fs.existsSync(SB)}`);
process.exit(fail ? 1 : 0);
