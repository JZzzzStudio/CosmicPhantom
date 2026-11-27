// host-checks-test.js — explicit host paths only; no undeclared home probing.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const CLI = path.join(REAL, "memory-cli.js");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-host-checks-"));
const ROOT = path.join(SB, "instance");
const HOST = path.join(SB, "host");
const ENV = [
  "CP_HOST_CHECKS",
  "CP_HOOK_LOG_DIR",
  "CP_HOOK_CONFIG",
  "CP_CC_PROJECTS",
  "CP_SKILL_HOME",
  "CP_REPLY_POLICY_FILE",
  "CP_REPLY_POLICY_NAME",
  "CP_INJECTION_USER_FILE",
];

function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function write(file, value) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, value, "utf8");
}
function json(file, value) { write(file, JSON.stringify(value, null, 2) + "\n"); }
function readJson(file) {
  const value = JSON.parse(file);
  if (value && typeof value === "object") return value;
  throw new Error(`invalid JSON output: ${file}`);
}
function localDateTag(timestamp = Date.now()) {
  return new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of ENV) delete env[name];
  return { ...env, ...overrides };
}
function run(command, extraEnv = {}) {
  const result = spawnSync(NODE, [CLI, command, "--root", ROOT], {
    cwd: REAL,
    encoding: "utf8",
    timeout: 60000,
    env: cleanEnv(extraEnv),
  });
  if (result.error) throw result.error;
  let output;
  try { output = readJson(result.stdout.trim()); }
  catch (error) { throw new Error(`${command} output is not JSON: ${result.stdout}\n${result.stderr}\n${error.message}`); }
  return { ...result, output };
}
function check(name, condition, detail = "") {
  if (!condition) throw new Error(`[FAIL] ${name}${detail ? `: ${detail}` : ""}`);
  console.log(`[PASS] ${name}`);
}
function staleContains(output, text) {
  return Array.isArray(output.stale) && output.stale.some((item) => String(item).includes(text));
}
function baseInstance() {
  mkdir(path.join(ROOT, "memories"));
  mkdir(path.join(ROOT, "daily"));
  mkdir(path.join(ROOT, ".context"));
  mkdir(path.join(ROOT, "core"));
  mkdir(path.join(ROOT, "backup"));
  json(path.join(ROOT, "current-state.json"), {
    schemaVersion: 1,
    revision: 1,
    updatedAt: "2099-01-01T00:00:00.000Z",
    status: "active",
    objective: "synthetic host-check test",
    summary: "isolated fixture",
    completed: [],
    nextActions: [],
    blockers: [],
    decisions: [],
    workingFiles: [],
    verification: [],
  });
  json(path.join(ROOT, "inject.config.json"), {
    identityCardBytes: 1800,
    recoveryBytes: 1800,
    memoryTop: 2,
    memoryBytes: 1200,
    warnAt: 0.9,
  });
  json(path.join(ROOT, "reply-policy.json"), {
    schemaVersion: 1,
    revision: 1,
    rules: ["keep output concise"],
    forbidden: ["synthetic-forbidden"],
    opening: "synthetic policy",
  });
  write(path.join(ROOT, "MEMORY.md"), "# Synthetic memory\n");
  write(path.join(ROOT, ".context", "CONTEXT.md"), "# Synthetic context\n");
  write(path.join(ROOT, "core", "rules.md"), "# Rules\n");
  write(path.join(ROOT, "core", "reply-style.md"), "# Style\n");
  write(path.join(ROOT, "daily", `${localDateTag()}.md`), "# Synthetic daily\n");
}
function createExplicitConfiguration() {
  const hookLogDir = path.join(HOST, "hooks");
  const hookConfig = path.join(HOST, "hook-config.json");
  const projectsDir = path.join(HOST, "projects");
  const skillHome = path.join(HOST, "skill-home");
  const userInjection = path.join(HOST, "user-injection.md");
  const replyTarget = path.join(HOST, "reply-target.md");
  mkdir(hookLogDir);
  mkdir(projectsDir);
  mkdir(skillHome);
  write(hookConfig, "{}\n");
  write(userInjection, "explicit user injection\n");
  write(path.join(ROOT, "skills", "example", "SKILL.md"), "synthetic skill\n");
  write(path.join(skillHome, ".agent", "skills", "example", "SKILL.md"), "synthetic skill\n");
  json(path.join(ROOT, "skill-mounts.json"), { mounts: [{ name: "agent", path: ".agent/skills" }] });

  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, "reply-policy.json"), "utf8"));
  write(replyTarget, [
    "<!-- reply-policy:start -->",
    `**禁用词（出现即违规）**：${policy.forbidden.join(" / ")}`,
    ...policy.rules,
    "<!-- reply-policy:end -->",
    "",
  ].join("\n"));

  const now = Date.now();
  const tag = localDateTag(now);
  const hookTs = Math.max(now, fs.statSync(hookConfig).mtimeMs + 1000);
  const hookEvent = JSON.stringify({ event: "hook.run.failed", timestamp: new Date(hookTs).toISOString() }) + "\n";
  write(path.join(hookLogDir, `hook-${tag}.jsonl`), hookEvent);
  const transcript = path.join(projectsDir, "project", "session.jsonl");
  write(transcript, "{}\n");
  const transcriptTime = new Date(now - 2 * 60 * 60 * 1000);
  fs.utimesSync(transcript, transcriptTime, transcriptTime);
  const daily = path.join(ROOT, "daily", `${tag}.md`);
  const dailyTime = new Date(now - 3 * 60 * 60 * 1000);
  fs.utimesSync(daily, dailyTime, dailyTime);
  const config = {
    hook: { logDir: path.relative(ROOT, hookLogDir), configPath: path.relative(ROOT, hookConfig) },
    transcript: { projectsDir: path.relative(ROOT, projectsDir) },
    skillMounts: { home: path.relative(ROOT, skillHome) },
    replyPolicyTargets: [{ name: "synthetic", path: path.relative(ROOT, replyTarget) }],
    injection: { userFile: path.relative(ROOT, userInjection) },
  };
  json(path.join(ROOT, "host-checks.json"), config);
  return { hookLogDir, hookConfig, projectsDir, skillHome, userInjection, replyTarget };
}

try {
  baseInstance();

  let result = run("verify");
  check("absent host-checks.json does not probe host directories", !staleContains(result.output, "宿主检查配置错误"));
  check("absent host-checks.json disables F7/F8/F20 host probes",
    !["hook.run.failed", "Stop hook", "挂载位", "[F20]"].some((text) => staleContains(result.output, text)),
    JSON.stringify(result.output.stale));
  check("absent host-checks.json leaves user injection uncounted", result.output.injections?.agentsUser === 0);

  const paths = createExplicitConfiguration();
  json(path.join(ROOT, "host-checks.json"), {});
  result = run("verify");
  check("configured F20 with no targets is visible", staleContains(result.output, "未配置门禁派生目标"), JSON.stringify(result.output.stale));

  createExplicitConfiguration();
  result = run("verify");
  check("explicit hook log is checked", staleContains(result.output, "hook.run.failed"));
  check("explicit transcript path is checked", staleContains(result.output, "Stop hook 可能静默失败"));
  check("matching explicit skill mount passes", !staleContains(result.output, "挂载位 agent"), JSON.stringify(result.output.stale));
  check("matching explicit F20 target passes", !staleContains(result.output, "[F20]"), JSON.stringify(result.output.stale));

  const quota = run("quota").output;
  check("quota uses explicit injection path", quota.injections?.agentsUser === fs.statSync(paths.userInjection).size);
  check("quota has no explicit-config errors", !(quota.configErrors || []).some((item) => String(item).includes("host-checks")), JSON.stringify(quota.configErrors));

  const badConfig = {
    hook: { logDir: "missing-hooks", configPath: "missing-hook-config.json" },
    transcript: { projectsDir: "missing-projects" },
    skillMounts: { home: "missing-skill-home" },
    replyPolicyTargets: [{ name: "missing", path: "missing-reply.md" }],
    injection: { userFile: "missing-user.md" },
  };
  json(path.join(ROOT, "host-checks.json"), badConfig);
  result = run("verify");
  const badQuota = run("quota").output;
  for (const label of ["hook.logDir", "hook.configPath", "transcript.projectsDir", "skillMounts.home", "replyPolicyTargets[0].path", "injection.userFile"]) {
    check(`missing declared ${label} is visible in verify`, staleContains(result.output, label));
    check(`missing declared ${label} is visible in quota`, (badQuota.configErrors || []).some((item) => String(item).includes(label)));
  }
  check("verify and quota expose the same declared-path error set",
    (badQuota.configErrors || []).every((item) => staleContains(result.output, item)),
    JSON.stringify({ stale: result.output.stale, configErrors: badQuota.configErrors }));

  write(path.join(ROOT, "host-checks.json"), "{broken\n");
  result = run("verify");
  const malformedQuota = run("quota").output;
  check("malformed host-checks.json is visible in verify", staleContains(result.output, "host-checks.json 无法解析"));
  check("malformed host-checks.json is visible in quota", (malformedQuota.configErrors || []).some((item) => String(item).includes("host-checks.json")));

  const missingOverride = path.join(HOST, "missing-policy.md");
  result = run("verify", { CP_REPLY_POLICY_FILE: missingOverride, CP_REPLY_POLICY_NAME: "override" });
  check("CP_REPLY_POLICY_FILE overrides configured F20 targets", staleContains(result.output, "override 门禁文件不存在"));
  check("missing CP_REPLY_POLICY_FILE is visible as configuration error", staleContains(result.output, "CP_REPLY_POLICY_FILE"));

  console.log("host-checks-test: all passed");
} finally {
  fs.rmSync(SB, { recursive: true, force: true });
}
