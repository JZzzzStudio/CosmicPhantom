// legacy-memory-compat-test.js - read-only compatibility report contract.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-legacy-compat-"));
const ROOT = path.join(SB, "root");
for (const dir of ["memories", "candidates", "lib"]) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
for (const file of ["memory-cli.js", "legacy-memory-compat.js", "memory-retrieval.js", "candidates.js", "package.json", "link-graph.js", "skills-sync.js"]) {
  fs.copyFileSync(path.join(REAL, file), path.join(ROOT, file));
}
fs.copyFileSync(path.join(REAL, "lib", "failopen.js"), path.join(ROOT, "lib", "failopen.js"));

function writeMemory(file, frontmatter, body) {
  fs.writeFileSync(path.join(ROOT, "memories", file), `---\n${frontmatter}\n---\n${body}\n`, "utf8");
}
writeMemory("active.md", "id: 20261125-0001\ncreated: 2026-11-25T08:00:00+08:00\nsource: daily/2026-11-25.md\nstatus: 🟢当前\ntype: 偏好\nscope: global", "legacy active card");
writeMemory("past.md", "id: 20261125-0002\ncreated: 2026-11-25T08:01:00+08:00\nsource: daily/2026-11-25.md\nstatus: 🕰️过去\ntype: 事件\nscope: workspace", "legacy historical card");
writeMemory("pending.md", "id: 20261125-0003\ncreated: 2026-11-25T08:02:00+08:00\nstatus: ⏳待验证\ntype: 决策\nscope: workspace", "legacy pending card");
writeMemory("classified.md", "id: 20261125-0004\ncreated: 2026-11-25T08:03:00+08:00\nsource: events.db:cp-evt-v2:1234567890abcdef1234567890abcdef\nstatus: 🟢当前\nprimary_domain: knowledge\ndomains: [knowledge, project]\nscope: workspace", "already classified card");
fs.writeFileSync(path.join(ROOT, "candidates", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"), JSON.stringify({
  candidate_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  state: "candidate",
  scope: "workspace",
  source_ref: "events.db:cp-evt-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  content: "legacy candidate without a primary domain",
}, null, 2) + "\n", "utf8");
fs.writeFileSync(path.join(ROOT, "candidates", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json"), JSON.stringify({
  candidate_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  state: "confirmed",
  scope: "global",
  source_ref: "events.db:cp-evt-v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  primary_domain: "preference",
  domains: ["preference"],
  content: "legacy candidate with an explicit domain",
}, null, 2) + "\n", "utf8");
fs.writeFileSync(path.join(ROOT, "candidates", "cccccccc-cccc-4ccc-8ccc-cccccccccccc.json"), "{broken\n", "utf8");

function snapshot(dir) {
  const out = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push([path.relative(dir, full), fs.readFileSync(full, "utf8")]);
    }
  }
  visit(dir);
  return JSON.stringify(out.sort((a, b) => a[0].localeCompare(b[0])));
}
function run(args) {
  const result = spawnSync(NODE, [path.join(ROOT, "memory-cli.js"), ...args, "--root", ROOT], { encoding: "utf8", timeout: 30000 });
  let out = null;
  try { out = JSON.parse((result.stdout || "").trim() || "{}"); } catch {}
  return { status: result.status, out, text: result.stdout || result.stderr || "" };
}
function check(name, ok, detail = "") {
  if (!ok) { console.error(`[FAIL] ${name}: ${detail}`); process.exitCode = 1; }
  else console.log(`[PASS] ${name}`);
}

const before = snapshot(ROOT);
const report = run(["compatibility", "report"]);
check("compatibility report succeeds", report.status === 0 && report.out?.read_only === true, JSON.stringify(report.out));
check("report counts legacy lifecycle without rewriting it", report.out?.summary?.legacy_memory_cards === 4 && report.out?.summary?.memory_by_lifecycle?.active === 2 && report.out?.summary?.memory_by_lifecycle?.historical === 1 && report.out?.summary?.memory_by_lifecycle?.pending === 1, JSON.stringify(report.out?.summary));
check("report does not guess domains", report.out?.summary?.memory_by_classification?.unclassified === 3 && report.out?.summary?.memory_by_classification?.classified === 1 && report.out?.summary?.candidate_without_primary_domain === 2, JSON.stringify(report.out?.summary));
check("report detects classified and malformed candidates", report.out?.summary?.candidate_by_classification?.classified === 1 && report.out?.summary?.candidate_by_classification?.unclassified === 1 && report.out?.summary?.candidate_by_classification?.invalid === 1, JSON.stringify(report.out?.summary));
check("migration remains gated", report.out?.migration_gate?.apply_supported === false && report.out?.migration_gate?.requires_backup_manifest === true && report.out?.migration_gate?.requires_same_set_validation === true, JSON.stringify(report.out?.migration_gate));
check("report declares no writes", Array.isArray(report.out?.writes) && report.out.writes.length === 0 && report.out?.instance_data_changed === false, JSON.stringify(report.out));
check("report leaves the complete legacy tree unchanged", snapshot(ROOT) === before, "fixture changed");

const details = run(["compatibility", "report", "--details"]);
check("details expose blockers without content", details.out?.details?.memories?.some(item => item.blockers.includes("MISSING_SOURCE")) && details.out?.details?.candidates?.some(item => item.blockers.includes("INVALID_CANDIDATE_JSON")) && !JSON.stringify(details.out).includes("legacy active card"), JSON.stringify(details.out));

fs.rmSync(SB, { recursive: true, force: true });
check("compatibility sandbox cleaned", !fs.existsSync(SB));
if (process.exitCode) process.exit(1);
console.log("legacy-memory-compat-test: all passed");
