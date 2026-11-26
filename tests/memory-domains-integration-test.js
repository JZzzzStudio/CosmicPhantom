// memory-domains-integration-test.js — isolated three-domain API/CLI coexistence contract.
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-memory-domains-"));
const ROOT = path.join(SB, "root");
for (const dir of ["memories", "candidates", "daily", "backup", "lib"]) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
for (const file of [
  "memory-cli.js", "memory-domains.js", "memory-retrieval.js", "validate.js", "candidates.js", "package.json",
  "link-graph.js", "skills-sync.js", "inject.js", "identity-card.js", "inject-config.js", "inject.config.json",
  "current-state.js", "current-state.json", "reply-policy.json", "resume-context.js", "MEMORY.md",
]) fs.copyFileSync(path.join(REAL, file), path.join(ROOT, file));
fs.copyFileSync(path.join(REAL, "lib", "failopen.js"), path.join(ROOT, "lib", "failopen.js"));

const legacyMemory = path.join(ROOT, "memories", "legacy.md");
const legacyCandidate = path.join(ROOT, "candidates", "legacy.json");
fs.writeFileSync(legacyMemory, "---\nid: legacy-1\nscope: workspace\nstatus: 🟢当前\n---\n\nLegacy memory must remain byte-stable.\n", "utf8");
fs.writeFileSync(legacyCandidate, "{\"candidate_id\":\"legacy-candidate\",\"state\":\"candidate\"}\n", "utf8");
const tracked = [legacyMemory, legacyCandidate];
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const before = new Map(tracked.map(file => [file, digest(file)]));

function run(args, script = "memory-cli.js") {
  const result = spawnSync(NODE, [path.join(ROOT, script), ...args, "--root", ROOT], { encoding: "utf8", timeout: 30000 });
  let out = null;
  try { out = JSON.parse((result.stdout || "").trim() || "{}"); } catch {}
  return { status: result.status, out, stdout: result.stdout || "", stderr: result.stderr || "" };
}
function check(name, condition, detail = "") {
  if (!condition) { console.error(`[FAIL] ${name}: ${detail}`); process.exitCode = 1; }
  else console.log(`[PASS] ${name}`);
}
function code(result) { return result.out?.code || result.out?.error?.code || ""; }

const status = run(["domains", "status"]);
check("read-only status accepts --root and does not initialize domain directories", status.status === 0 && status.out?.ok === true && status.out?.counts?.entities === 0 && !fs.existsSync(path.join(ROOT, "domains")) && !fs.existsSync(path.join(ROOT, "data")), JSON.stringify(status.out));

const markerOld = "D3_DOMAIN_OLD_MARKER";
const markerNew = "D3_DOMAIN_NEW_MARKER";
const unauthCreate = run(["domains", "candidate", "create", "--content", markerOld, "--source-ref", "manual:d3:unauth"]);
check("new candidate creation requires explicit authorization", code(unauthCreate) === "USER_AUTHORIZATION_REQUIRED", JSON.stringify(unauthCreate.out));

const created = run(["domains", "candidate", "create", "--content", markerOld, "--source-ref", "manual:d3:1", "--user-confirmed", "--actor", "user"]);
const candidateId = created.out?.candidate?.candidate_id;
check("new candidate is created in the isolated product", created.status === 0 && created.out?.ok === true && Boolean(candidateId), JSON.stringify(created.out));
check("new candidate does not enter legacy memories", fs.readdirSync(path.join(ROOT, "memories")).length === 1, fs.readdirSync(path.join(ROOT, "memories")));
check("new candidate starts unclassified", created.out?.candidate?.state === "candidate" && created.out?.candidate?.primary_domain === null, JSON.stringify(created.out?.candidate));

for (const action of ["classify", "edit", "defer", "reject"]) {
  const args = ["domains", "candidate", action, "--id", candidateId];
  if (action === "classify") args.push("--domain", "project");
  if (action === "edit") args.push("--content", markerNew);
  const result = run(args);
  check(`${action} requires explicit authorization`, code(result) === "USER_AUTHORIZATION_REQUIRED", JSON.stringify(result.out));
}

const edited = run(["domains", "candidate", "edit", "--id", candidateId, "--content", markerNew, "--user-confirmed", "--actor", "user"]);
check("authorized edit clears prior classification", edited.out?.ok === true && edited.out?.candidate?.reconfirmation_required === true && edited.out?.candidate?.primary_domain === null, JSON.stringify(edited.out));
const classified = run(["domains", "candidate", "classify", "--id", candidateId, "--domain", "project", "--domains", "project,preference", "--user-confirmed", "--actor", "user"]);
check("authorized classification records one primary domain and explicit secondary domain", classified.out?.ok === true && classified.out?.candidate?.primary_domain === "project" && JSON.stringify(classified.out?.candidate?.domains) === JSON.stringify(["project", "preference"]), JSON.stringify(classified.out));
const deferred = run(["domains", "candidate", "defer", "--id", candidateId, "--user-confirmed", "--actor", "user"]);
check("authorized defer changes review status only", deferred.out?.ok === true && deferred.out?.candidate?.review_status === "deferred" && deferred.out?.candidate?.state === "candidate", JSON.stringify(deferred.out));
const resumed = run(["domains", "candidate", "resume", "--id", candidateId, "--user-confirmed", "--actor", "user"]);
check("authorized resume returns candidate to pending", resumed.out?.ok === true && resumed.out?.candidate?.review_status === "pending", JSON.stringify(resumed.out));
const confirmed = run(["domains", "candidate", "confirm", "--id", candidateId, "--user-confirmed", "--actor", "user"]);
const memoryId = confirmed.out?.memory?.memory_id;
check("authorized confirmation creates one active domain entity", confirmed.out?.ok === true && confirmed.out?.memory?.state === "active" && Boolean(memoryId), JSON.stringify(confirmed.out));
const confirmedAuditPath = path.join(ROOT, "data", "memory-audit", "candidates", `${candidateId}.json`);
const confirmedAudit = fs.readFileSync(confirmedAuditPath, "utf8");
check("confirmed candidate audit keeps hash and source but not body", confirmedAudit.includes("content_sha256") && confirmedAudit.includes("source_ref") && !confirmedAudit.includes(markerNew), confirmedAudit);
const projectMemoryFiles = fs.readdirSync(path.join(ROOT, "domains", "project", "memories")).filter(file => file.endsWith(".json"));
const preferenceMemoryFiles = fs.readdirSync(path.join(ROOT, "domains", "preference", "memories")).filter(file => file.endsWith(".json"));
check("cross-domain metadata does not duplicate the body", projectMemoryFiles.length === 1 && preferenceMemoryFiles.length === 0, "unexpected memory copies");

const domainSearch = run(["domains", "search", "--query", markerNew, "--domain", "preference"]);
check("explicit secondary-domain search returns the same entity", domainSearch.out?.results?.length === 1 && domainSearch.out.results[0].entity_id, JSON.stringify(domainSearch.out));
const missingMode = run(["domains", "search", "--query", markerNew]);
check("new search refuses implicit cross-domain mode", code(missingMode) === "DOMAIN_REQUIRED", JSON.stringify(missingMode.out));
const crossSearch = run(["domains", "search", "--query", markerNew, "--cross-domain"]);
check("explicit cross-domain search is labeled", crossSearch.out?.cross_domain === true && crossSearch.out?.results?.[0]?.primary_domain === "project" && crossSearch.out.results[0].scope === "workspace", JSON.stringify(crossSearch.out));

const unauthCorrect = run(["domains", "correct", "--id", memoryId, "--content", "D3_CORRECTED_UNAUTHORIZED"]);
check("correction requires explicit authorization", code(unauthCorrect) === "USER_AUTHORIZATION_REQUIRED", JSON.stringify(unauthCorrect.out));
const corrected = run(["domains", "correct", "--id", memoryId, "--content", "D3_CORRECTED_AUTHORIZED", "--user-confirmed", "--actor", "user"]);
check("authorized correction verifies old stop and new retrieval", corrected.out?.ok === true && corrected.out?.verification?.old_version_stopped === true && corrected.out?.verification?.new_version_retrievable === true, JSON.stringify(corrected.out));

const oldSearch = run(["search", markerNew]);
check("legacy default search does not read new domain data", !oldSearch.stdout.includes(markerNew), oldSearch.stdout);
const oldInject = run(["--hint", markerNew], "inject.js");
check("legacy default inject does not read new domain data", !oldInject.stdout.includes(markerNew), oldInject.stdout || oldInject.stderr);

const second = run(["domains", "candidate", "create", "--content", "D3_REJECTED_BODY", "--source-ref", "manual:d3:reject", "--user-confirmed", "--actor", "user"]);
const rejectedId = second.out?.candidate?.candidate_id;
const unauthReject = run(["domains", "candidate", "reject", "--id", rejectedId, "--reason", "not approved"]);
check("reject requires explicit authorization", code(unauthReject) === "USER_AUTHORIZATION_REQUIRED", JSON.stringify(unauthReject.out));
const rejected = run(["domains", "candidate", "reject", "--id", rejectedId, "--reason", "not approved", "--user-confirmed", "--actor", "user"]);
const rejectedFile = path.join(ROOT, "data", "memory-audit", "candidates", `${rejectedId}.json`);
const rejectedBody = fs.readFileSync(rejectedFile, "utf8");
check("authorized reject keeps minimum audit without body", rejected.out?.ok === true && fs.existsSync(rejectedFile) && !rejectedBody.includes("D3_REJECTED_BODY") && rejectedBody.includes("content_sha256"), rejectedBody);

const lockPath = path.join(ROOT, ".memory-domains.lock");
fs.writeFileSync(lockPath, "stale-owner-marker", "utf8");
const lockedWrite = run(["domains", "candidate", "create", "--content", "D3_LOCKED_WRITE", "--user-confirmed", "--actor", "user"]);
check("occupied write lock blocks writes without deleting lock", code(lockedWrite) === "MEMORY_BUSY" && fs.readFileSync(lockPath, "utf8") === "stale-owner-marker", JSON.stringify(lockedWrite.out));
fs.unlinkSync(lockPath);

check("legacy files remain byte-stable", tracked.every(file => before.get(file) === digest(file)), tracked.map(file => `${file}:${before.get(file)}:${digest(file)}`).join("\n"));
check("new data is isolated from legacy root paths", fs.existsSync(path.join(ROOT, "domains", "project", "memories")) && !fs.existsSync(path.join(ROOT, "memories", `${memoryId}.md`)), "legacy path was modified");

fs.rmSync(SB, { recursive: true, force: true });
check("domain sandbox cleaned", !fs.existsSync(SB));
if (process.exitCode) process.exit(1);
console.log("memory-domains-integration-test: all passed");
