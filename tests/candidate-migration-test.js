// candidate-migration-test.js — ticket 03 legacy pending-card migration and audit contract.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-candidate-migration-"));
const ROOT = path.join(SB, "root");
for (const dir of ["memories", "candidates", "daily", "lib"]) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
for (const file of ["memory-cli.js", "memory-retrieval.js", "validate.js", "candidates.js", "package.json", "link-graph.js", "skills-sync.js"]) {
  fs.copyFileSync(path.join(REAL, file), path.join(ROOT, file));
}
fs.copyFileSync(path.join(REAL, "lib", "failopen.js"), path.join(ROOT, "lib", "failopen.js"));

const legacyId = "20260810-0001";
const legacyBody = "LEGACY_PENDING_card_should_become_candidate_only";
const legacyFile = path.join(ROOT, "memories", `${legacyId}.md`);
fs.writeFileSync(legacyFile, `---\nid: ${legacyId}\ncreated: 2026-08-10T10:00:00+08:00\nsource: daily/2026-08-10.md\nstatus: ⏳待验证\ntype: 决策\ntags: [legacy]\nscope: workspace\n---\n${legacyBody}\n`, "utf8");

function run(args) {
  const r = spawnSync(NODE, [path.join(ROOT, "memory-cli.js"), ...args, "--root", ROOT], { encoding: "utf8", timeout: 60000 });
  let out = null;
  try { out = JSON.parse((r.stdout || "").trim() || "{}"); } catch {}
  return { status: r.status, out, text: r.stdout || r.stderr || "" };
}
function check(name, ok, detail = "") {
  if (!ok) { console.error(`[FAIL] ${name}: ${detail}`); process.exitCode = 1; }
  else console.log(`[PASS] ${name}`);
}

const dry = run(["candidate", "migrate"]);
check("migration defaults to dry-run", dry.out?.dryRun === true && dry.out?.wouldMigrate === 1 && fs.readdirSync(path.join(ROOT, "candidates")).length === 0, JSON.stringify(dry.out));
check("dry-run reports source and target", dry.out?.details?.[0]?.source_ref === "daily/2026-08-10.md" && /^[a-f0-9]{64}$/.test(dry.out?.details?.[0]?.target_candidate_id || ""), JSON.stringify(dry.out));
check("dry-run preserves legacy card", fs.existsSync(legacyFile) && fs.readFileSync(legacyFile, "utf8").includes("⏳待验证"), "legacy card changed");

const applied = run(["candidate", "migrate", "--apply"]);
check("explicit apply creates one candidate", applied.out?.dryRun === false && applied.out?.migrated === 1, JSON.stringify(applied.out));
const candidateId = applied.out?.details?.[0]?.target_candidate_id;
const listed = run(["candidate", "show", candidateId]);
check("migrated candidate preserves provenance and remains pending", listed.out?.items?.[0]?.state === "candidate" && listed.out?.items?.[0]?.source_ref === "daily/2026-08-10.md" && listed.out?.items?.[0]?.legacy_memory_id === legacyId, JSON.stringify(listed.out));
check("migration does not delete or activate legacy card", fs.existsSync(legacyFile) && fs.readFileSync(legacyFile, "utf8").includes("⏳待验证"), "legacy card changed");
const search = run(["search", legacyBody]);
check("migrated candidate is absent from default search", search.out?.count === 0, JSON.stringify(search.out));
const repeat = run(["candidate", "migrate", "--apply"]);
check("migration is idempotent", repeat.out?.migrated === 0 && repeat.out?.alreadyMigrated === 1, JSON.stringify(repeat.out));

// Construct audit counterexamples: one unconfirmed current card, one duplicate activation,
// and one active card whose candidate reference is broken.
const activeCard = (id, candidate) => `---\nid: ${id}\ncreated: 2026-11-21T10:00:00+08:00\nsource: candidate/${candidate}\nstatus: 🟢当前\ntype: 事件\ncandidate_id: ${candidate}\nscope: workspace\n---\nAUDIT_ACTIVE_${id}\n`;
fs.writeFileSync(path.join(ROOT, "memories", "20261121-0001.md"), activeCard("20261121-0001", candidateId), "utf8");
fs.writeFileSync(path.join(ROOT, "memories", "20261121-0002.md"), activeCard("20261121-0002", candidateId), "utf8");
fs.writeFileSync(path.join(ROOT, "memories", "20261121-0003.md"), activeCard("20261121-0003", "deadbeef"), "utf8");
const verify = run(["verify"]);
check("verify reports candidate audit counterexamples", verify.out?.candidates?.unconfirmedCurrent >= 1 && verify.out?.candidates?.duplicateActivations >= 1 && verify.out?.candidates?.brokenReferences >= 1, JSON.stringify(verify.out?.candidates));

fs.rmSync(SB, { recursive: true, force: true });
check("migration sandbox cleaned", !fs.existsSync(SB));
if (process.exitCode) process.exit(1);
console.log("candidate-migration-test: all passed");
