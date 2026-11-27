// tests/retrieval-golden-test.js - shared TF/BM25 ranking golden set.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-retrieval-"));
const ROOT = path.join(SB, "root");
const MEM = path.join(ROOT, "memories");
let pass = 0, fail = 0;

function check(name, condition, detail = "") {
  if (condition) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name} -- ${detail}`); }
}
function copy(relative) {
  const target = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REAL, relative), target);
}
function run(script, args, options = {}) {
  return spawnSync(NODE, [path.join(ROOT, script), ...args, "--root", ROOT], { encoding: "utf8", timeout: 30000, ...options });
}
function writeMemory({ id, created, status = "🟢当前", type = "事件", tags = [], topicId, supersededBy, scope = "global", body }) {
  const lines = ["---", `id: ${id}`, `created: ${created}`, `status: ${status}`, `type: ${type}`, `tags: [${tags.join(", ")}]`, `scope: ${scope}`];
  if (topicId) lines.push(`topic_id: ${topicId}`);
  if (supersededBy) lines.push(`superseded_by: ${supersededBy}`);
  lines.push("---", body, "");
  fs.writeFileSync(path.join(MEM, `${id}.md`), lines.join("\n"), "utf8");
}
function search(query, top = 10, extra = []) {
  const result = run("memory-cli.js", ["search", query, "--top", String(top), ...extra]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function idsFromInject(text) {
  return [...text.matchAll(/memories[\\/]([^\\/\s)]+)\.md/g)].map(match => match[1]);
}
function idsFromRecall(text) {
  const json = JSON.parse(text);
  const section = json.recall.split("## 相关记忆（")[1] || "";
  return [...section.matchAll(/^- ([^:]+):/gm)].map(match => match[1]);
}

try {
  for (const dir of [MEM, path.join(ROOT, "daily"), path.join(ROOT, "backup"), path.join(ROOT, "distilled"), path.join(ROOT, "resources", "mcp-server")]) fs.mkdirSync(dir, { recursive: true });
  for (const file of [
    "memory-retrieval.js", "memory-cli.js", "skills-sync.js", "link-graph.js", "inject.js", "identity-card.js", "inject-config.js", "inject.config.json",
    "current-state.js", "reply-policy.json", "resume-context.js",
    "events.js", "validate.js", "log_turn.js", "package.json", "resources/mcp-server/index.js", "lib/failopen.js",
  ]) copy(file);
  const { writePublicState, writePublicMemory } = require("./fixtures/public-fixtures.cjs");
  writePublicState(ROOT);
  writePublicMemory(ROOT);
  fs.writeFileSync(path.join(ROOT, ".watch-paused"), "test\n");
  fs.writeFileSync(path.join(ROOT, "state-db-path.txt"), "# deprecated test\n");

  // 12 docs force the BM25 branch. The first eight are behavioral fixtures; four are unrelated fillers.
  writeMemory({ id: "g-boost-base", created: "2026-08-01T00:00:00Z", tags: ["plain"], body: "[事件·boost-base] signal signal tagboost ordinary" });
  writeMemory({ id: "g-boost-tag", created: "2026-08-02T00:00:00Z", tags: ["tagboost"], body: "[事件·boost-tag] signal alpha ordinary" });
  writeMemory({ id: "g-current", created: "2026-08-03T00:00:00Z", status: "🟢当前", body: "[事件·current-rank] legacyrank legacyrank current" });
  writeMemory({ id: "g-past", created: "2026-08-04T00:00:00Z", status: "🕰️过去", body: "[事件·past-rank] legacyrank legacyrank legacyrank legacyrank past" });
  writeMemory({ id: "g-super-old", created: "2026-08-01T00:00:00Z", status: "🕰️过去", topicId: "shared-topic", supersededBy: "g-super-new", body: "supersede supersede supersede old" });
  writeMemory({ id: "g-super-new", created: "2026-08-05T00:00:00Z", status: "🟢当前", topicId: "shared-topic", body: "supersede current" });
  writeMemory({ id: "g-tie-a", created: "2026-08-06T00:00:00Z", body: "[事件·tie-a] tiecase equal" });
  writeMemory({ id: "g-tie-b", created: "2026-08-06T00:00:00Z", body: "[事件·tie-b] tiecase equal" });
  for (let i = 1; i <= 4; i += 1) writeMemory({ id: `g-fill-${i}`, created: `2026-07-0${i}T00:00:00Z`, body: `[事件·fill-${i}] unrelated filler omega${i}` });

  // 检索三项修复回归 fixture（2026-08-13）：通用分类 tag 误加权 / 时序过滤 / scope 过滤
  writeMemory({ id: "t-generic-tag", created: "2026-08-07T00:00:00Z", tags: ["偏好"], body: "[事件·t-generic-tag] 回放偏好 genericpollute" });
  writeMemory({ id: "t-specific-tag", created: "2026-08-08T00:00:00Z", tags: ["回放偏好"], body: "[事件·t-specific-tag] 回放偏好 specificsignal" });
  writeMemory({ id: "t-ws-scope", created: "2026-08-09T00:00:00Z", scope: "workspace", body: "[事件·t-ws-scope] scopetest workspace-only" });
  writeMemory({ id: "t-global-scope", created: "2026-08-09T00:00:00Z", body: "[事件·t-global-scope] scopetest global-only" });

  console.log("=== Shared ranking core ===");
  const probe = path.join(ROOT, "probe.mjs");
  fs.writeFileSync(probe, `
    import { loadMemoryDocs, retrieveMemories } from ${JSON.stringify("./memory-retrieval.js")};
    const docs = loadMemoryDocs(${JSON.stringify(MEM)});
    const result = retrieveMemories("signal tagboost", { docs, top: 10 });
    console.log(JSON.stringify(result.results.map(x => ({ id:x.id, base:x.baseScore, score:x.score, boosted:!!x.boosted }))));
  `);
  let result = spawnSync(NODE, [probe], { encoding: "utf8", timeout: 30000, cwd: ROOT });
  const core = JSON.parse(result.stdout);
  const base = core.find(item => item.id === "g-boost-base");
  const boosted = core.find(item => item.id === "g-boost-tag");
  check("RG1 fixture starts with higher unboosted base score", base.base > boosted.base, JSON.stringify(core));
  check("RG2 tag boost changes the final ranking", boosted.score > base.score && core[0].id === "g-boost-tag", JSON.stringify(core));

  const boostSearch = search("signal tagboost", 5);
  check("RG3 search scores are monotonically descending", boostSearch.results.every((item, index, all) => index === 0 || all[index - 1].score >= item.score), JSON.stringify(boostSearch.results));
  check("RG4 search exposes boosted winner", boostSearch.results[0].id === "g-boost-tag" && boostSearch.results[0].boosted === true, JSON.stringify(boostSearch.results));

  const legacy = search("legacyrank", 5);
  check("RG5 past memory penalty changes ranking", legacy.results[0].id === "g-current" && legacy.results.find(x => x.id === "g-past")?.score < legacy.results[0].score, JSON.stringify(legacy.results));

  const supersede = search("supersede", 5);
  check("RG6 same topic keeps current version", supersede.results[0].id === "g-super-new" && supersede.results[0].related === 1 && !supersede.results.some(x => x.id === "g-super-old"), JSON.stringify(supersede.results));

  const tie1 = search("tiecase", 5).results.map(item => item.id);
  const tie2 = search("tiecase", 5).results.map(item => item.id);
  check("RG7 equal scores use stable ID tie-break", tie1[0] === "g-tie-a" && tie1[1] === "g-tie-b", JSON.stringify(tie1));
  check("RG8 repeated search is deterministic", JSON.stringify(tie1) === JSON.stringify(tie2), `${JSON.stringify(tie1)} != ${JSON.stringify(tie2)}`);

  console.log("=== Entry-point consistency ===");
  const expected = boostSearch.results.slice(0, 2).map(item => item.id);
  result = run("inject.js", ["--hint", "signal tagboost", "--top", "2"]);
  const injectIds = idsFromInject(result.stdout).slice(0, 2);
  check("RG9 inject uses search order", JSON.stringify(injectIds) === JSON.stringify(expected), `${JSON.stringify(injectIds)} != ${JSON.stringify(expected)}`);

  result = run("memory-cli.js", ["recall", "signal tagboost", "--bytes", "20000"]);
  const recallIds = idsFromRecall(result.stdout).slice(0, 2);
  check("RG10 recall uses search order", JSON.stringify(recallIds) === JSON.stringify(expected), `${JSON.stringify(recallIds)} != ${JSON.stringify(expected)}`);

  const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall_memory", arguments: { query: "signal tagboost", top: 2 } } }) + "\n";
  result = spawnSync(NODE, [path.join(ROOT, "resources", "mcp-server", "index.js"), "--root", ROOT], { encoding: "utf8", input: rpc, timeout: 30000, env: { ...process.env, CP_ROOT: ROOT } });
  const response = JSON.parse(result.stdout.trim().split("\n").at(-1));
  const mcpSearch = JSON.parse(response.result.content[0].text);
  const mcpIds = mcpSearch.results.map(item => item.id);
  check("RG11 MCP delegates the same search order", JSON.stringify(mcpIds) === JSON.stringify(expected), `${JSON.stringify(mcpIds)} != ${JSON.stringify(expected)}`);

  result = run("memory-cli.js", ["recall", "--bytes", "5000"]);
  const optionOnly = JSON.parse(result.stdout);
  check("RG12 recall options are not treated as query", !optionOnly.recall.includes("相关记忆（--bytes）"), optionOnly.recall.slice(-300));

  check("RG13 different topics are not folded", search("tiecase", 5).results.filter(item => item.id.startsWith("g-tie-")).length === 2, JSON.stringify(search("tiecase", 5).results));

  console.log("=== 检索三项修复回归（2026-08-13：tag 误加权/时序/scope）===");
  const genericQuery = search("回放偏好", 5);
  const gA = genericQuery.results.find(x => x.id === "t-generic-tag");
  const gB = genericQuery.results.find(x => x.id === "t-specific-tag");
  check("RG15 通用分类 tag（偏好）不再 boost", gA && gB && gA.boosted !== true && gB.boosted === true && gB.score > gA.score, JSON.stringify(genericQuery.results));

  const sincePlain = search("filler", 10);
  const sinceFiltered = search("filler", 10, ["--since", "2026-08-01"]);
  check("RG16 --since 过滤掉更早条目", sincePlain.results.length === 4 && sinceFiltered.results.length === 0, `${sincePlain.results.length} -> ${sinceFiltered.results.length}`);

  const untilFiltered = search("filler", 10, ["--until", "2026-07-02"]);
  check("RG17 --until 只保留截止日期内条目", untilFiltered.results.length === 2 && untilFiltered.results.every(x => x.id === "g-fill-1" || x.id === "g-fill-2"), JSON.stringify(untilFiltered.results.map(x => x.id)));

  const scopeAll = search("scopetest", 10);
  const scopeWs = search("scopetest", 10, ["--scope", "workspace"]);
  const scopeGlobal = search("scopetest", 10, ["--scope", "global"]);
  check("RG18 scope 过滤隔离 global/workspace", scopeAll.results.length === 2 && scopeWs.results.length === 1 && scopeWs.results[0].id === "t-ws-scope" && scopeGlobal.results.length === 1 && scopeGlobal.results[0].id === "t-global-scope", JSON.stringify({ all: scopeAll.results.map(x => x.id), ws: scopeWs.results.map(x => x.id), g: scopeGlobal.results.map(x => x.id) }));

  const rpc2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recall_memory", arguments: { query: "filler", since: "2026-08-01", top: 5 } } }) + "\n";
  result = spawnSync(NODE, [path.join(ROOT, "resources", "mcp-server", "index.js"), "--root", ROOT], { encoding: "utf8", input: rpc2, timeout: 30000, env: { ...process.env, CP_ROOT: ROOT } });
  const response2 = JSON.parse(result.stdout.trim().split("\n").at(-1));
  const mcpFiltered = JSON.parse(response2.result.content[0].text);
  check("RG19 MCP recall_memory 透传 since 过滤", mcpFiltered.results.length === 0, JSON.stringify(mcpFiltered.results.map(x => x.id)));
} finally {
  fs.rmSync(SB, { recursive: true, force: true });
  check("RG14 sandbox cleaned", !fs.existsSync(SB), SB);
}

console.log(`\n===== retrieval-golden-test: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
