// skills-sync-test.js — declared mounts only; never probe host defaults.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REAL = path.resolve(__dirname, "..");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-skills-sync-"));
const ROOT = path.join(SB, "instance");
const HOME = path.join(SB, "home");
const source = path.join(ROOT, "skills", "example", "SKILL.md");
const mounted = path.join(HOME, ".agent", "skills", "example", "SKILL.md");
fs.mkdirSync(path.dirname(source), { recursive: true });
fs.mkdirSync(path.dirname(mounted), { recursive: true });
fs.writeFileSync(source, "source skill\n", "utf8");
fs.writeFileSync(mounted, "stale skill\n", "utf8");

function check(name, ok, detail) {
  if (!ok) {
    console.error(`[FAIL] ${name}: ${detail || ""}`);
    process.exitCode = 1;
  } else {
    console.log(`[PASS] ${name}`);
  }
}

(async () => {
  const { checkSkillSync } = await import(pathToFileURL(path.join(REAL, "skills-sync.js")).href);
  fs.mkdirSync(path.join(HOME, ".claude", "skills", "example"), { recursive: true });
  fs.writeFileSync(path.join(HOME, ".claude", "skills", "example", "SKILL.md"), "unconfigured host copy\n", "utf8");

  check("missing skill-mounts.json performs no host-home checks", checkSkillSync(ROOT, HOME).length === 0);

  fs.writeFileSync(path.join(ROOT, "skill-mounts.json"), JSON.stringify({ mounts: [{ name: "agent", path: ".agent/skills" }] }), "utf8");
  let result = checkSkillSync(ROOT, HOME);
  check("declared stale mount is reported", result.length === 1 && result[0].mount === "agent" && result[0].ok === false, JSON.stringify(result));

  fs.writeFileSync(mounted, "source skill\n", "utf8");
  result = checkSkillSync(ROOT, HOME);
  check("declared matching mount passes", result.length === 1 && result[0].mount === "agent" && result[0].ok === true, JSON.stringify(result));

  fs.writeFileSync(path.join(ROOT, "skill-mounts.json"), "{broken", "utf8");
  result = checkSkillSync(ROOT, HOME);
  check("invalid explicit configuration fails visibly", result.length === 1 && result[0].ok === false && result[0].mount === "configuration", JSON.stringify(result));

  fs.rmSync(SB, { recursive: true, force: true });
  if (process.exitCode) process.exit(1);
  console.log("skills-sync-test: all passed");
})();
