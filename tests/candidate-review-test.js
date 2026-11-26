// candidate-review-test.js — candidate review, bounded source evidence, and strict confirmation.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-candidate-review-"));
const ROOT = path.join(SB, "root");
for (const dir of ["memories", "daily", "lib"]) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
for (const file of ["memory-cli.js", "memory-retrieval.js", "validate.js", "candidates.js", "candidate-review.js", "package.json", "link-graph.js", "skills-sync.js", "events.js"]) {
  fs.copyFileSync(path.join(REAL, file), path.join(ROOT, file));
}
fs.copyFileSync(path.join(REAL, "lib", "failopen.js"), path.join(ROOT, "lib", "failopen.js"));

function run(args) {
  const result = spawnSync(NODE, [path.join(ROOT, "memory-cli.js"), ...args, "--root", ROOT], { encoding: "utf8", timeout: 60000 });
  let out = null;
  try { out = JSON.parse((result.stdout || "").trim() || "{}"); } catch {}
  return { status: result.status, out, text: result.stdout || result.stderr || "" };
}
function check(name, ok, detail) { if (!ok) { console.error(`[FAIL] ${name}: ${detail || ""}`); process.exitCode = 1; } else console.log(`[PASS] ${name}`); }
function anchor(instance, mid) { return `events.db:cp-evt-v2:${createHash("sha256").update(`${instance}\0${mid}`).digest("hex").slice(0, 32)}`; }

const REVIEW_KEY = ["sk", "review", "abcdef1234567890"].join("-");
const transcript = path.join(SB, "transcript.jsonl");
fs.writeFileSync(transcript, [
  JSON.stringify({ type: "user", id: "m1", message: { content: "请记住：审阅必须先看证据再确认" } }),
  JSON.stringify({ type: "user", id: "m2", message: { content: `敏感 token ${REVIEW_KEY} 不应泄露` } }),
  JSON.stringify({ type: "assistant", id: "m3", message: { content: "[摘要] 这是一条普通摘要" } }),
  JSON.stringify({ type: "user", id: "m4", message: { content: "请记住：相邻证据也可受限展开" } }),
].join("\n") + "\n", "utf8");
const logged = spawnSync(NODE, ["--experimental-sqlite", path.join(ROOT, "events.js"), "manual", "--transcript", transcript, "--session", "review-session", "--root", ROOT], { encoding: "utf8", timeout: 60000 });
check("source fixture is ingested", logged.status === 0 && JSON.parse((logged.stdout || "{}").trim()).logged === 4, logged.stdout || logged.stderr);

const added = run(["candidate", "add", "用户确认审阅流程必须可追溯", "--kind", "decision", "--source-kind", "user_said", "--source-ref", anchor("manual", 1), "--confidence", "1", "--scope", "workspace"]);
const id = added.out?.candidate_id;
check("review candidate is created", added.out?.added === true && id, JSON.stringify(added.out));
const second = run(["candidate", "add", "用户确认相邻证据可受限展开", "--kind", "decision", "--source-kind", "user_said", "--source-ref", anchor("manual", 4), "--confidence", "1", "--scope", "workspace"]);
const id2 = second.out?.candidate_id;
const third = run(["candidate", "add", "这条候选明确拒绝并保留审计", "--kind", "decision", "--source-kind", "user_said", "--source-ref", anchor("manual", 1), "--confidence", "1", "--scope", "workspace"]);
const id3 = third.out?.candidate_id;

const review = run(["candidate", "review"]);
check("review defaults to pending", review.out?.count === 3 && review.out.items.every((item) => item.review_status === "pending"), JSON.stringify(review.out));
const deferred = run(["candidate", "defer", id]);
check("defer changes only review status", deferred.out?.ok === true && deferred.out.items?.[0]?.review_status === "deferred", JSON.stringify(deferred.out));
check("deferred candidate is excluded from pending review", run(["candidate", "review"]).out?.count === 2, JSON.stringify(run(["candidate", "review"]).out));
const blocked = run(["candidate", "confirm", id]);
check("deferred candidate cannot be confirmed", blocked.out?.confirmed === 0 && blocked.out?.missing?.[0]?.code === "CANDIDATE_REVIEW_STATUS_INVALID", JSON.stringify(blocked.out));
const resumed = run(["candidate", "resume", id]);
check("resume returns candidate to pending", resumed.out?.ok === true && resumed.out.items?.[0]?.review_status === "pending", JSON.stringify(resumed.out));

const rejected = run(["candidate", "reject", id3, "--actor", "reviewer"]);
const rejectedCandidate = run(["candidate", "show", id3]);
check("reject moves candidate to terminal state with audit history", rejected.out?.rejected === 1 && rejected.out?.missing?.length === 0 && rejectedCandidate.out?.items?.[0]?.state === "rejected" && rejectedCandidate.out.items[0].review_status === "rejected" && rejectedCandidate.out.items[0].history?.some((entry) => entry.action === "rejected" && entry.actor === "reviewer"), JSON.stringify({ rejected: rejected.out, candidate: rejectedCandidate.out }));
const repeatedReject = run(["candidate", "reject", id3]);
check("repeated rejection is idempotent and does not append another rejection", repeatedReject.out?.rejected === 0 && repeatedReject.out?.missing?.length === 0 && run(["candidate", "show", id3]).out.items?.[0]?.history?.filter((entry) => entry.action === "rejected").length === 1, JSON.stringify(repeatedReject.out));
const rejectedConfirm = run(["candidate", "confirm", id3]);
check("rejected candidate cannot be confirmed", rejectedConfirm.out?.confirmed === 0 && rejectedConfirm.out?.missing?.[0]?.error === "候选状态为 rejected，不可确认", JSON.stringify(rejectedConfirm.out));
const rejectedEdit = run(["candidate", "edit", id3, "拒绝后的候选不应复活"]);
check("rejected candidate cannot be edited back into review", rejectedEdit.out?.updated === false && /只有 state=candidate/.test(rejectedEdit.out?.error || ""), JSON.stringify(rejectedEdit.out));
const rejectedPreview = run(["candidate", "preview", id3]);
check("rejected candidate is excluded from confirmation preview", rejectedPreview.out?.ready === false && rejectedPreview.out.items?.[0]?.action === "reject" && rejectedPreview.out.items?.[0]?.review_status === "rejected", JSON.stringify(rejectedPreview.out));

const sourceSummary = run(["candidate", "source", id]);
check("source summary omits event stream and raw preview", sourceSummary.out?.available === true && !sourceSummary.out.stream && !sourceSummary.out.firstUser, JSON.stringify(sourceSummary.out));
const expanded = run(["candidate", "source", id, "--expand", "--bytes", "2000"]);
const expandedText = JSON.stringify(expanded.out);
check("bounded source expansion returns anchor", expanded.out?.available === true && expanded.out.stream?.some((event) => event.anchor === true), expandedText);
check("bounded source expansion masks sensitive content", !expandedText.includes(REVIEW_KEY) && expandedText.includes("SENSITIVE EVENT REDACTED"), expandedText);
check("bounded source expansion has byte cap", Buffer.byteLength(JSON.stringify(expanded.out), "utf8") <= 2000, String(Buffer.byteLength(JSON.stringify(expanded.out), "utf8")));

const preview = run(["candidate", "preview", id, id2]);
const hash = preview.out?.previewHash;
check("preview returns a ready hash", preview.out?.ready === true && /^[a-f0-9]{64}$/.test(hash), JSON.stringify(preview.out));
const edited = run(["candidate", "edit", id2, "用户确认修改后的候选内容必须重新审阅"]);
const stale = run(["candidate", "confirm", id, id2, "--preview-hash", hash]);
const afterStale = run(["candidate", "show", id, id2]);
check("stale preview activates nothing", stale.out?.code === "CANDIDATE_PREVIEW_STALE" && afterStale.out?.items?.every((item) => item.state === "candidate" && !item.active_memory_id), JSON.stringify({ stale: stale.out, afterStale: afterStale.out }));
const preview2 = run(["candidate", "preview", id, id2]);
const confirmed = run(["candidate", "confirm", id, id2, "--preview-hash", preview2.out.previewHash]);
check("fresh preview confirms whole batch", confirmed.out?.confirmed === 2 && confirmed.out?.missing?.length === 0, JSON.stringify(confirmed.out));
const repeat = run(["candidate", "confirm", id, id2]);
check("repeated confirmation is idempotent", repeat.out?.confirmed === 0 && repeat.out?.already_confirmed === 2, JSON.stringify(repeat.out));

fs.rmSync(SB, { recursive: true, force: true });
if (process.exitCode) process.exit(1);
console.log("candidate-review-test: all passed");
