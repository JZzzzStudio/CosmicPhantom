// candidate-integrity-test.js — storage, lock, preview, and activation recovery regressions.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-candidate-integrity-"));
const ROOT = path.join(SB, "root");
fs.mkdirSync(path.join(ROOT, "memories"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "daily"), { recursive: true });
for (const file of ["memory-cli.js", "memory-retrieval.js", "validate.js", "candidates.js", "candidate-review.js", "package.json", "link-graph.js", "skills-sync.js"]) {
  fs.copyFileSync(path.join(REAL, file), path.join(ROOT, file));
}
fs.mkdirSync(path.join(ROOT, "lib"), { recursive: true });
fs.copyFileSync(path.join(REAL, "lib", "failopen.js"), path.join(ROOT, "lib", "failopen.js"));
function run(args, env = {}) {
  const r = spawnSync(NODE, [path.join(ROOT, "memory-cli.js"), ...args, "--root", ROOT], { encoding: "utf8", timeout: 60000, env: { ...process.env, ...env } });
  let out = null;
  try { out = JSON.parse((r.stdout || "").trim() || "{}"); } catch {}
  return { status: r.status, out, text: r.stdout || r.stderr || "" };
}
function check(name, ok, detail) { if (!ok) { console.error(`[FAIL] ${name}: ${detail || ""}`); process.exitCode = 1; } else console.log(`[PASS] ${name}`); }

const add = run(["candidate", "add", "锁与候选写入必须可恢复", "--kind", "decision", "--source-kind", "user_said", "--source-ref", "events.db:integrity:1", "--confidence", "1", "--scope", "workspace"]);
const id = add.out?.candidate_id;
check("baseline candidate is created", add.out?.added === true && id, JSON.stringify(add.out));

const duplicate = run(["candidate", "add", "另一条正文不应覆盖原候选", "--kind", "decision", "--source-kind", "user_said", "--source-ref", "events.db:integrity:2", "--confidence", "1", "--scope", "workspace"]);
const duplicateId = duplicate.out?.candidate_id;
const candidatePath = path.join(ROOT, "candidates", `${id}.json`);
const duplicatePath = path.join(ROOT, "candidates", `${duplicateId}.json`);
fs.copyFileSync(candidatePath, duplicatePath);
const duplicateRun = run(["candidate", "list"]);
check("filename and internal candidate ID mismatch is not listed", duplicateRun.out?.count === 1 && duplicateRun.out.items?.[0]?.candidate_id === id, JSON.stringify(duplicateRun.out));
const candidatesUrl = require("node:url").pathToFileURL(path.join(ROOT, "candidates.js")).href;
const raceId = "aa11bb22-cc33";
const createRaceScript = `import { makeCandidate, saveCandidate } from ${JSON.stringify(candidatesUrl)}; try { const candidate=makeCandidate({candidate_id:${JSON.stringify(raceId)},content:"同一候选 ID 的竞争写入",kind:"decision",source_kind:"user_said",source_ref:"events.db:race:"+process.pid,confidence:1,scope:"workspace"},String(process.pid)); saveCandidate(${JSON.stringify(ROOT)},candidate); console.log(JSON.stringify({ok:true,content:candidate.content})); } catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); }`;
function runCreateRaceWorker() {
  return new Promise((resolve) => {
    const child = spawn(NODE, ["--input-type=module", "-e", createRaceScript], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      let result;
      try { result = JSON.parse(stdout.trim()); } catch {}
      resolve({ code, result, stderr });
    });
  });
}
const runCreationRace = () => Promise.all(Array.from({ length: 8 }, runCreateRaceWorker)).then((creators) => {
  const raced = JSON.parse(fs.readFileSync(path.join(ROOT, "candidates", `${raceId}.json`), "utf8"));
  check("concurrent creation of one candidate ID publishes exactly one immutable winner", creators.every((worker) => worker.code === 0) && creators.filter((worker) => worker.result?.ok).length === 1 && creators.filter((worker) => worker.result?.code === "CANDIDATE_EXISTS_CONFLICT").length === 7 && raced.candidate_id === raceId && raced.content === "同一候选 ID 的竞争写入", JSON.stringify({ creators: creators.map((worker) => worker.result || worker.stderr), candidate_id: raced.candidate_id }));
});
const inspect = spawnSync(NODE, ["--input-type=module", "-e", `import { inspectCandidateFiles } from ${JSON.stringify(candidatesUrl)}; console.log(JSON.stringify(inspectCandidateFiles(${JSON.stringify(ROOT)})))`], { encoding: "utf8" });
check("filename mismatch is diagnosed explicitly", inspect.status === 0 && /CANDIDATE_FILENAME_MISMATCH/.test(inspect.stdout || ""), inspect.stdout || inspect.stderr);
const persist = spawnSync(NODE, ["--input-type=module", "-e", `import { readCandidate, saveCandidate } from ${JSON.stringify(candidatesUrl)}; const current=readCandidate(${JSON.stringify(ROOT)},${JSON.stringify(id)}); try { saveCandidate(${JSON.stringify(ROOT)},{...current,content:"覆盖尝试不应成功"}); console.log(JSON.stringify({ok:true})); } catch(error) { console.log(JSON.stringify({ok:false,code:error.code,content:readCandidate(${JSON.stringify(ROOT)},${JSON.stringify(id)}).content})); }`], { encoding: "utf8" });
let duplicateWrite;
try { duplicateWrite = JSON.parse((persist.stdout || "").trim()); } catch {}
check("duplicate candidate write is refused without replacing original", persist.status === 0 && duplicateWrite?.code === "CANDIDATE_EXISTS_CONFLICT" && duplicateWrite.content === "锁与候选写入必须可恢复", JSON.stringify(duplicateWrite));
fs.rmSync(duplicatePath, { force: true });

const empty = run(["candidate", "confirm", "", "--preview-hash", "bad"]);
check("empty ID is rejected before preview parsing", empty.out?.missing?.[0]?.code === "CANDIDATE_IDS_REQUIRED", JSON.stringify(empty.out));
const malformed = run(["candidate", "confirm", id, "--preview-hash", "bad"]);
check("malformed preview hash is rejected", malformed.out?.code === "CANDIDATE_PREVIEW_HASH_INVALID", JSON.stringify(malformed.out));

fs.writeFileSync(path.join(ROOT, "candidates", `.${id}.lock`), `${process.pid + 1000000}:stale-token`, "utf8");
const stale = run(["candidate", "confirm", id]);
check("stale lock is reported for manual recovery", stale.out?.missing?.[0]?.code === "CANDIDATE_LOCK_STALE" && fs.existsSync(path.join(ROOT, "candidates", `.${id}.lock`)) && fs.readdirSync(path.join(ROOT, "memories")).length === 0, JSON.stringify(stale.out));
const lockPath = path.join(ROOT, "candidates", `.${id}.lock`);
fs.rmSync(lockPath, { force: true });
fs.writeFileSync(lockPath, `${process.pid}:active-test-token`, "utf8");
const busy = run(["candidate", "confirm", id]);
check("active lock is not removed or bypassed", busy.out?.missing?.[0]?.code === "CANDIDATE_BUSY" && fs.readFileSync(lockPath, "utf8") === `${process.pid}:active-test-token`, JSON.stringify(busy.out));
fs.rmSync(lockPath, { force: true });
const liveOwner = spawn(NODE, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
try {
  fs.writeFileSync(lockPath, `${liveOwner.pid}:reused-pid-token`, "utf8");
  const reusedPid = run(["candidate", "confirm", id]);
  check("a simulated PID-reuse lock is conservatively treated as busy", reusedPid.out?.missing?.[0]?.code === "CANDIDATE_BUSY" && fs.readFileSync(lockPath, "utf8") === `${liveOwner.pid}:reused-pid-token`, JSON.stringify(reusedPid.out));
} finally {
  liveOwner.kill();
  fs.rmSync(lockPath, { force: true });
}
fs.writeFileSync(lockPath, "not-a-pid:unreadable-owner", "utf8");
const unreadableOwner = run(["candidate", "confirm", id]);
check("an unreadable lock owner is not auto-removed", unreadableOwner.out?.missing?.[0]?.code === "CANDIDATE_BUSY" && fs.readFileSync(lockPath, "utf8") === "not-a-pid:unreadable-owner", JSON.stringify(unreadableOwner.out));
fs.rmSync(lockPath, { force: true });

const locked = run(["candidate", "confirm", id], { CP_TEST_FAIL_CANDIDATE_UPDATE: id });
const partial = locked.out?.partial_activations?.[0];
check("active-memory write failure to finalize candidate is structured", partial?.status === "active_memory_written_candidate_pending" && partial.active_memory_id && partial.code === "CANDIDATE_ACTIVATION_STATE_SAVE_FAILED", JSON.stringify(locked.out));
const candidateAfterPartial = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
check("partial activation leaves candidate pending", candidateAfterPartial.state === "candidate" && !candidateAfterPartial.active_memory_id, JSON.stringify(candidateAfterPartial));
const structured = spawnSync(NODE, ["--input-type=module", "-e", `import { updateCandidate } from ${JSON.stringify(candidatesUrl)}; console.log(JSON.stringify(updateCandidate(${JSON.stringify(ROOT)},${JSON.stringify(id)},()=>{const error=new Error("structured failure"); error.code="TEST_STRUCTURED_ERROR"; throw error;})))`], { encoding: "utf8" });
let structuredResult;
try { structuredResult = JSON.parse((structured.stdout || "").trim()); } catch {}
check("self-locking candidate updates preserve structured mutator errors", structured.status === 0 && structuredResult?.code === "TEST_STRUCTURED_ERROR", JSON.stringify(structuredResult));
const retry = run(["candidate", "confirm", id]);
check("retry reconciles partial activation without duplicate active card", retry.out?.confirmed === 0 && retry.out?.already_confirmed === 1 && retry.out?.items?.[0]?.status === "reconciled", JSON.stringify(retry.out));
const memories = fs.readdirSync(path.join(ROOT, "memories"));
check("partial activation retry leaves one active memory file", memories.length === 1, memories.join(","));

const creationRace = runCreationRace();
const concurrentScript = `import { updateCandidate } from ${JSON.stringify(candidatesUrl)}; let completed=0; while(completed<25){ const result=updateCandidate(${JSON.stringify(ROOT)},${JSON.stringify(id)}, current=>{current.history.push({at:new Date().toISOString(),action:"concurrent-test",actor:String(process.pid)});return current;}); if(result.ok) completed++; else if(result.code==="CANDIDATE_BUSY") await new Promise(resolve=>setTimeout(resolve,5)); else {console.error(JSON.stringify(result));process.exit(2);} }`;
function runConcurrentUpdater() {
  return new Promise((resolve) => {
    const child = spawn(NODE, ["--input-type=module", "-e", concurrentScript], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
Promise.all([runConcurrentUpdater(), runConcurrentUpdater()]).then(async (workers) => {
  await creationRace;
  const finalCandidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  const concurrentUpdates = finalCandidate.history.filter((item) => item.action === "concurrent-test").length;
  check("concurrent direct updateCandidate calls serialize without lost history", workers.every((worker) => worker.code === 0) && concurrentUpdates === 50, JSON.stringify({ workers: workers.map(({ code, stderr }) => ({ code, stderr })), concurrentUpdates }));
  fs.rmSync(SB, { recursive: true, force: true });
  if (process.exitCode) process.exit(1);
  console.log("candidate-integrity-test: all passed");
});
