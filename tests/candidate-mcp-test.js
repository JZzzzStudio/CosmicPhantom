// candidate-mcp-test.js — MCP lifecycle, engine/instance separation, and source-boundary contract.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-candidate-mcp-"));
const ENGINE = path.join(SB, "engine");
const ROOT = path.join(SB, "instance");
for (const dir of ["memories", "daily", "lib"]) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
const engineFiles = [
  "memory-cli.js", "memory-retrieval.js", "validate.js", "candidates.js", "candidate-review.js", "package.json", "link-graph.js", "skills-sync.js",
  "current-state.js", "events.js", "resume-context.js", "inject.js", "reply-check.js", "arrival-check.js", "log_turn.js",
  "resources/mcp-server/index.js",
];
for (const file of engineFiles) {
  const src = path.join(REAL, file);
  const dst = path.join(ENGINE, file);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
for (const file of ["lib/failopen.js"]) {
  fs.mkdirSync(path.dirname(path.join(ENGINE, file)), { recursive: true });
  fs.copyFileSync(path.join(REAL, file), path.join(ENGINE, file));
}
fs.writeFileSync(path.join(ROOT, "daily", "2099-01-01.md"), "- ⭐👤 用户（决策）：MCP_INIT_DAILY_RAW_MUST_STAY_HIDDEN\n", "utf8");

function cli(args, extra = {}) {
  const r = spawnSync(NODE, [path.join(ENGINE, "memory-cli.js"), ...args, "--root", ROOT], { encoding: "utf8", timeout: 60000, env: { ...process.env, ...extra } });
  let out = null;
  try { out = JSON.parse((r.stdout || "").trim() || "{}"); } catch {}
  return { status: r.status, out, text: r.stdout || r.stderr || "" };
}
function rpc(messages) {
  const input = messages.map((request, i) => JSON.stringify({
    jsonrpc: "2.0", id: i + 1,
    method: request.method || "tools/call",
    params: request.method ? (request.params || {}) : request,
  })).join("\n") + "\n";
  const r = spawnSync(NODE, [path.join(ENGINE, "resources/mcp-server/index.js"), "--root", ROOT], { input, encoding: "utf8", timeout: 60000, env: { ...process.env, CP_WATCH_SCRIPT: path.join(SB, "missing-watch.js") } });
  return { status: r.status, rows: (r.stdout || "").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), stderr: r.stderr || "" };
}
function text(row) { return row?.result?.content?.[0]?.text || ""; }
function json(row) { try { return JSON.parse(text(row)); } catch { return null; } }
function check(name, ok, detail) { if (!ok) { console.error(`[FAIL] ${name}: ${detail || ""}`); process.exitCode = 1; } else console.log(`[PASS] ${name}`); }

const listedTools = rpc([{ method: "tools/list", params: {} }]);
const toolNames = listedTools.rows[0]?.result?.tools?.map((tool) => tool.name) || [];
check("tools/list runs from packed engine with instance root", listedTools.status === 0 && toolNames.includes("candidate_source") && toolNames.includes("confirm_candidates"), JSON.stringify(listedTools.rows[0]));
const initialized = rpc([{ method: "initialize", params: { protocolVersion: "2024-11-05" } }]);
check("MCP initialize excludes daily raw decision text", !String(initialized.rows[0]?.result?.instructions || "").includes("MCP_INIT_DAILY_RAW_MUST_STAY_HIDDEN"), JSON.stringify(initialized.rows[0]));

// Create real events.db anchors through the engine, while keeping the instance root free of engine files.
const transcript = path.join(SB, "source.jsonl");
fs.writeFileSync(transcript, [
  JSON.stringify({ type: "user", id: "source-1", message: { role: "user", content: "候选锚点的普通上下文" } }),
  JSON.stringify({ type: "assistant", id: "source-2", message: { role: "assistant", content: "[摘要] 普通邻近摘要" } }),
  JSON.stringify({ type: "user", id: "source-3", message: { role: "user", content: "候选锚点包含 api_key=SECRET_NEIGHBOR" } }),
  JSON.stringify({ type: "user", id: "source-4", message: { role: "user", content: "候选锚点主体内容" } }),
].join("\n") + "\n", "utf8");
const logged = cli(["log", "--transcript", transcript, "--session", "mcp-source"]);
check("real events.db source is created through separated engine", logged.status === 0 && fs.existsSync(path.join(ROOT, "events.db")) && logged.out?.logged === true && logged.out?.count === 4, JSON.stringify(logged.out));
check("instance root contains no copied engine CLI", !fs.existsSync(path.join(ROOT, "memory-cli.js")) && !fs.existsSync(path.join(ROOT, "events.js")), ROOT);
const status = cli(["events", "status"]);
check("instance data is visible through engine CLI", status.status === 0 && status.out?.events >= 3, JSON.stringify(status.out));
const dbUrl = pathToFileURL(path.join(ROOT, "events.db")).href;
const eventRows = spawnSync(NODE, ["--experimental-sqlite", "--input-type=module", "-e", `import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync(new URL(${JSON.stringify(dbUrl)})); console.log(JSON.stringify(db.prepare("SELECT instance,mid,session,content,sensitive FROM events WHERE session=? ORDER BY id").all("mcp-source"))); db.close();`], { encoding: "utf8" });
let rows = [];
try { rows = JSON.parse((eventRows.stdout || "").trim() || "[]"); } catch {}
const anchorRow = rows.find((row) => String(row.content).includes("候选锚点主体内容"));
const anchor = anchorRow ? `events.db:cp-evt-v2:${require("node:crypto").createHash("sha256").update(`${anchorRow.instance}\0${anchorRow.mid}`).digest("hex").slice(0, 32)}` : null;
check("real event anchor is available", Boolean(anchor), JSON.stringify(rows));

const first = rpc([
  { name: "store_memory", arguments: { content: "默认注入只读已确认提纯层", kind: "decision", sourceRef: "events.db:mcp-test:1", confidence: 0.95, scope: "workspace", actor: "user" } },
  { name: "list_candidates", arguments: { state: "candidate" } },
  { name: "list_memories", arguments: {} },
  { name: "recall_memory", arguments: { query: "默认注入只读已确认提纯层" } },
]);
const stored = json(first.rows[0]);
const listed = json(first.rows[1]);
const memoriesBefore = json(first.rows[2]);
check("store_memory creates candidate", stored?.added === true && stored?.state === "candidate", text(first.rows[0]));
check("candidate is visible with source", listed?.count === 1 && listed.items?.[0]?.source_ref === "events.db:mcp-test:1", text(first.rows[1]));
check("store_memory does not add active memory", memoriesBefore?.count === 0, text(first.rows[2]));
check("recall_memory excludes pending candidate", json(first.rows[3])?.count === 0 && !text(first.rows[3]).includes("默认注入只读已确认提纯层"), text(first.rows[3]));
const candidateId = stored?.candidate_id;

const second = rpc([
  { name: "edit_candidate", arguments: { candidateId, content: "默认检索和注入只读已确认提纯层", actor: "user" } },
  { name: "confirm_candidates", arguments: { candidateIds: [candidateId], actor: "user" } },
  { name: "confirm_candidates", arguments: { candidateIds: [candidateId], actor: "user" } },
  { name: "list_memories", arguments: {} },
  { name: "recall_memory", arguments: { query: "默认检索和注入只读已确认提纯层" } },
]);
const edited = json(second.rows[0]);
const confirmed = json(second.rows[1]);
const repeated = json(second.rows[2]);
const memoriesAfter = json(second.rows[3]);
check("edit keeps candidate pending", edited?.updated === true && edited.candidate?.state === "candidate", text(second.rows[0]));
check("explicit confirm activates exactly one card", confirmed?.confirmed === 1 && confirmed.items?.[0]?.active_memory_id, text(second.rows[1]));
check("repeat confirm is idempotent", repeated?.confirmed === 0 && repeated?.already_confirmed === 1, text(second.rows[2]));
check("active list has one card", memoriesAfter?.count === 1 && memoriesAfter.items?.[0]?.candidate_id === candidateId, text(second.rows[3]));
check("recall_memory sees confirmed active memory", json(second.rows[4])?.count > 0 && text(second.rows[4]).includes("默认检索和注入只读已确认提纯层"), text(second.rows[4]));

const sourceCandidate = rpc([{ name: "store_memory", arguments: { content: "候选锚点主体内容", kind: "decision", sourceRef: anchor, confidence: 0.95, scope: "workspace", actor: "user" } }]);
const sourceId = json(sourceCandidate.rows[0])?.candidate_id;
const source = rpc([{ name: "candidate_source", arguments: { candidateId: sourceId, expand: true, bytes: 4000 } }]);
const sourceBody = json(source.rows[0]);
check("supported candidate source expands the real anchor", sourceBody?.available === true && sourceBody.stream?.some((event) => event.anchor), text(source.rows[0]));
check("expanded source masks sensitive neighbor", !text(source.rows[0]).includes("SECRET_NEIGHBOR") && sourceBody?.stream?.some((event) => event.content === "[SENSITIVE EVENT REDACTED]"), text(source.rows[0]));
check("source response includes metadata in reported budget", sourceBody?.returned_bytes <= 4000, text(source.rows[0]));
check("expanded source byte count matches serialized payload", Number(sourceBody?.returned_bytes) === Buffer.byteLength(JSON.stringify(sourceBody), "utf8"), text(source.rows[0]));
const redacted = cli(["events", "redact", "--instance", anchorRow.instance, "--mid", String(anchorRow.mid), "--reason", "test anchor redaction"]);
const redactedSource = rpc([{ name: "candidate_source", arguments: { candidateId: sourceId, expand: true, bytes: 4000 } }]);
check("redacted anchor is masked through MCP", redacted.out?.ok === true && json(redactedSource.rows[0])?.stream?.some((event) => event.anchor && event.content === "[REDACTED]") && !text(redactedSource.rows[0]).includes("候选锚点主体内容"), `${JSON.stringify(redacted.out)} ${text(redactedSource.rows[0])}`);
const hugeTranscript = path.join(SB, "oversized.jsonl");
fs.writeFileSync(hugeTranscript, JSON.stringify({ type: "user", id: "oversized-1", message: { role: "user", content: `超长锚点 ${"长内容".repeat(3000)}` } }) + "\n", "utf8");
const hugeLogged = cli(["log", "--transcript", hugeTranscript, "--session", "mcp-oversized"]);
const hugeRowsResult = spawnSync(NODE, ["--experimental-sqlite", "--input-type=module", "-e", `import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync(new URL(${JSON.stringify(dbUrl)})); console.log(JSON.stringify(db.prepare("SELECT instance,mid,content FROM events WHERE session=? ORDER BY id").all("mcp-oversized"))); db.close();`], { encoding: "utf8" });
let hugeRows = [];
try { hugeRows = JSON.parse((hugeRowsResult.stdout || "").trim() || "[]"); } catch {}
const hugeRow = hugeRows[0];
const hugeAnchor = hugeRow ? `events.db:cp-evt-v2:${require("node:crypto").createHash("sha256").update(`${hugeRow.instance}\0${hugeRow.mid}`).digest("hex").slice(0, 32)}` : null;
const hugeCandidate = rpc([{ name: "store_memory", arguments: { content: "超长锚点预算验证候选", kind: "decision", sourceRef: hugeAnchor, confidence: 0.95, scope: "workspace", actor: "user" } }]);
const hugeSource = rpc([{ name: "candidate_source", arguments: { candidateId: json(hugeCandidate.rows[0])?.candidate_id, expand: true, bytes: 2000 } }]);
check("oversized anchor is refused when serialized metadata cannot fit the budget", hugeLogged.out?.logged === true && json(hugeSource.rows[0])?.code === "SOURCE_BUDGET_EXCEEDED", text(hugeSource.rows[0]));
const sensitiveRow = rows.find((row) => Number(row.sensitive) === 1);
const sensitiveCandidate = rpc([{ name: "store_memory", arguments: { content: "敏感邻居的候选审阅边界", kind: "decision", sourceRef: `events.db:cp-evt-v2:${require("node:crypto").createHash("sha256").update(`${sensitiveRow.instance}\0${sensitiveRow.mid}`).digest("hex").slice(0, 32)}`, confidence: 0.95, scope: "workspace", actor: "user" } }]);
const sensitiveId = json(sensitiveCandidate.rows[0])?.candidate_id;
const purge = cli(["events", "purge", "--sensitive-only", "--confirm", "--reason", "test logical purge", "--allow-after-push"]);
const afterPurge = rpc([{ name: "candidate_source", arguments: { candidateId: sensitiveId, expand: true, bytes: 2000 } }]);
check("purged neighbor is excluded from candidate source", purge.out?.purged >= 1 && json(afterPurge.rows[0])?.available === false && !text(afterPurge.rows[0]).includes("SECRET_NEIGHBOR"), `${JSON.stringify(purge.out)} ${text(afterPurge.rows[0])}`);

const invalid = rpc([{ name: "store_memory", arguments: { content: "缺来源的候选", confidence: 0.5 } }]);
check("missing source is an MCP error", invalid.rows[0]?.result?.isError === true && /sourceRef/.test(text(invalid.rows[0])), text(invalid.rows[0]));

const third = rpc([{ name: "store_memory", arguments: { content: "MCP 候选审阅闭环只通过预览后确认", kind: "decision", sourceRef: "events.db:mcp-review:1", confidence: 0.95, scope: "workspace", actor: "user" } }]);
const reviewCandidate = json(third.rows[0]);
const reviewId = reviewCandidate?.candidate_id;
const fourth = rpc([
  { name: "review_candidates", arguments: {} },
  { name: "candidate_source", arguments: { candidateId: reviewId } },
  { name: "defer_candidates", arguments: { candidateIds: [reviewId], actor: "user" } },
  { name: "review_candidates", arguments: { status: "pending" } },
  { name: "resume_candidates", arguments: { candidateIds: [reviewId], actor: "user" } },
  { name: "preview_candidate_confirmation", arguments: { candidateIds: [reviewId] } },
]);
const pendingReview = json(fourth.rows[0]);
const sourceSummary = json(fourth.rows[1]);
const deferredReview = json(fourth.rows[2]);
const pendingAfterDefer = json(fourth.rows[3]);
const resumedReview = json(fourth.rows[4]);
const confirmationPreview = json(fourth.rows[5]);
check("MCP review lists pending candidate by ID", pendingReview?.items?.some((item) => item.candidate_id === reviewId && item.review_status === "pending"), text(fourth.rows[0]));
check("MCP candidate source summary is body-free", sourceSummary?.available === false && !text(fourth.rows[1]).includes("MCP 候选审阅闭环"), text(fourth.rows[1]));
check("MCP defer excludes candidate from pending", deferredReview?.ok === true && !pendingAfterDefer?.items?.some((item) => item.candidate_id === reviewId), text(fourth.rows[2]));
check("MCP resume restores pending status", resumedReview?.ok === true && json(rpc([{ name: "review_candidates", arguments: {} }]).rows[0])?.items?.some((item) => item.candidate_id === reviewId && item.review_status === "pending"), text(fourth.rows[4]));
check("MCP confirmation preview is ready without activation", confirmationPreview?.ready === true && confirmationPreview?.previewHash && json(rpc([{ name: "list_memories", arguments: {} }]).rows[0])?.count === 1, text(fourth.rows[5]));
const strict = rpc([
  { name: "confirm_candidates", arguments: { candidateIds: [reviewId], previewHash: confirmationPreview.previewHash, actor: "user" } },
  { name: "confirm_candidates", arguments: { candidateIds: [reviewId], actor: "user" } },
]);
check("MCP strict preview confirmation activates candidate", json(strict.rows[0])?.confirmed === 1, text(strict.rows[0]));
check("MCP confirmation remains idempotent", json(strict.rows[1])?.already_confirmed === 1, text(strict.rows[1]));
fs.rmSync(SB, { recursive: true, force: true });
if (process.exitCode) process.exit(1);
console.log("candidate-mcp-test: all passed");
