// quota-failure-test.js — required measurements must fail visibly, never become zero.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-quota-failure-"));
const ENV_NAMES = ["CP_HOST_CHECKS", "CP_HOOK_LOG_DIR", "CP_HOOK_CONFIG", "CP_CC_PROJECTS", "CP_SKILL_HOME", "CP_REPLY_POLICY_FILE", "CP_REPLY_POLICY_NAME", "CP_INJECTION_USER_FILE"];

function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function write(file, value) { mkdir(path.dirname(file)); fs.writeFileSync(file, value, "utf8"); }
function json(file, value) { write(file, JSON.stringify(value, null, 2) + "\n"); }
function cleanEnv() {
  const env = { ...process.env };
  for (const name of ENV_NAMES) delete env[name];
  return env;
}
function check(name, condition, detail = "") {
  if (!condition) throw new Error(`[FAIL] ${name}${detail ? `: ${detail}` : ""}`);
  console.log(`[PASS] ${name}`);
}
function createInstance(root) {
  mkdir(path.join(root, "memories"));
  mkdir(path.join(root, ".context"));
  json(path.join(root, "current-state.json"), { revision: 1, status: "active", objective: "quota failure fixture" });
  json(path.join(root, "inject.config.json"), { identityCardBytes: 1800, recoveryBytes: 1800, memoryTop: 2, memoryBytes: 1200, warnAt: 0.9 });
  json(path.join(root, "reply-policy.json"), { schemaVersion: 1, revision: 1, rules: ["keep output concise"], forbidden: ["synthetic-forbidden"], opening: "fixture" });
  write(path.join(root, ".context", "CONTEXT.md"), "# fixture\n");
}
function copyEngine(name) {
  const engine = path.join(SB, name);
  fs.cpSync(REAL, engine, {
    recursive: true,
    filter(source) {
      const relative = path.relative(REAL, source);
      return !relative.startsWith(".git") && !relative.startsWith("node_modules") && !relative.startsWith("tests") && !relative.startsWith("plugin") && !relative.startsWith("work");
    },
  });
  return engine;
}
function runQuota(engine, root) {
  const result = spawnSync(NODE, [path.join(engine, "memory-cli.js"), "quota", "--root", root], { cwd: engine, encoding: "utf8", timeout: 60000, env: cleanEnv() });
  let output;
  try { output = JSON.parse((result.stdout || "").trim()); }
  catch (error) { throw new Error(`quota output is not JSON: ${result.stdout}\n${result.stderr}\n${error.message}`); }
  return { result, output };
}
function runCase(name, configure, expected) {
  const engine = copyEngine(name);
  const root = path.join(engine, "instance");
  createInstance(root);
  configure(engine, root);
  const { result, output } = runQuota(engine, root);
  check(`${name} exits with JSON output`, result.status === 0, `${result.status}: ${result.stderr}`);
  check(`${name} reports unhealthy quota`, output.ok === false, JSON.stringify(output));
  check(`${name} reports measurement errors`, Array.isArray(output.measurementErrors) && output.measurementErrors.some((item) => item.includes(expected)), JSON.stringify(output.measurementErrors));
  return output;
}

try {
  const injectFailure = runCase("inject-failure", (engine) => {
    write(path.join(engine, "inject.js"), "process.stderr.write('synthetic inject failure\\n'); process.exit(7);\n");
  }, "inject --report");
  check("inject failure keeps identity measurement nullable", injectFailure.identityCard.bytes === null && injectFailure.identityCard.budget === null, JSON.stringify(injectFailure.identityCard));

  const hookFailure = runCase("hook-failure", (engine) => {
    write(path.join(engine, "resume-context.js"), "process.stderr.write('synthetic hook failure\\n'); process.exit(8);\n");
  }, "resume-context render");
  check("hook failure keeps recovery measurement nullable", hookFailure.recoveryHook.bytes === null, JSON.stringify(hookFailure.recoveryHook));

  const recallFailure = runCase("recall-failure", (engine) => {
    const file = path.join(engine, "memory-cli.js");
    const original = fs.readFileSync(file, "utf8");
    const newline = original.indexOf("\n") + 1;
    write(file, `${original.slice(0, newline)}if (process.argv[2] === "recall") { process.stdout.write("{broken\\n"); process.exit(0); }\n${original.slice(newline)}`);
  }, "memory-cli recall");
  check("malformed recall keeps recall measurement nullable", recallFailure.recall.bytes === null && recallFailure.recall.budget === null, JSON.stringify(recallFailure.recall));

  const successEngine = copyEngine("success");
  const successRoot = path.join(successEngine, "instance");
  createInstance(successRoot);
  const success = runQuota(successEngine, successRoot);
  check("successful quota keeps measurements numeric", success.result.status === 0 && success.output.ok === true && Number.isFinite(success.output.identityCard.bytes) && Number.isFinite(success.output.recoveryHook.bytes) && Number.isFinite(success.output.recall.bytes), JSON.stringify(success.output));
  check("successful quota has no measurement errors", success.output.measurementErrors?.length === 0, JSON.stringify(success.output.measurementErrors));

  console.log("quota-failure-test: all passed");
} finally {
  fs.rmSync(SB, { recursive: true, force: true });
}
