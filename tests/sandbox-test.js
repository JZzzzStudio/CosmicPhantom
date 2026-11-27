// hermes-sandbox-test.js — 宇宙幻影沙箱测试（隔离环境，正/逆向全链路）
// 机制：覆盖 USERPROFILE 指向临时沙箱 home → 所有脚本 ROOT 自动指向沙箱（零代码侵入）
// 正向：add→查重→search→inject→log(落盘+幂等)→index/verify/stats/distill→CLI转发→MCP
// 逆向：validate 拒写×3 / add 过短拒 / 空库 fail-open / 无 transcript fail-open / 缺参 fail-open / 空查询报错 / MCP 未知工具
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writePublicState, writePublicMemory, writePublicContext, writePublicCore } = require("./fixtures/public-fixtures.cjs");

const REAL_ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-sandbox-"));
const SB_ROOT = path.join(SB, "root");
const ENV = { ...process.env, CP_ROOT: SB_ROOT };

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail || ""}`); }
}
function run(script, args, opts = {}) {
  const r = spawnSync(NODE, [path.join(SB_ROOT, script), ...args, "--root", SB_ROOT], { encoding: "utf8", timeout: 30000, env: ENV, ...opts });
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "", status: r.status };
}
function runNode(args, opts = {}) {
  const r = spawnSync(NODE, args, { encoding: "utf8", timeout: 60000, env: ENV, ...opts });
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "", status: r.status };
}

// ---------- 沙箱搭建 ----------
console.log("=== 沙箱搭建 ===");
for (const d of ["memories", "candidates", "daily", "topics", "distilled", "pro", "backup", "resources/mcp-server", "scripts/legacy/hermes", "core", ".context", "lib", "eval"]) {
  fs.mkdirSync(path.join(SB_ROOT, d), { recursive: true });
}
const SOURCES = ["inject.js", "identity-card.js", "inject-config.js", "inject.config.json", "current-state.js", "resume-context.js", "reply-policy.json", "log_turn.js", "validate.js", "link-graph.js", "skills-sync.js", "memory-cli.js", "memory-retrieval.js", "candidates.js", "lib/failopen.js", "events.js", "resources/mcp-server/index.js", "package.json"];
for (const f of SOURCES) {
  fs.mkdirSync(path.dirname(path.join(SB_ROOT, f)), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, f), path.join(SB_ROOT, f));
}
const legacyPoll = "scripts/legacy/hermes/poll-state.js";
fs.copyFileSync(path.join(REAL_ROOT, legacyPoll), path.join(SB_ROOT, legacyPoll));
fs.mkdirSync(path.join(SB_ROOT, "tools", "node"), { recursive: true });
fs.copyFileSync(process.execPath, path.join(SB_ROOT, "tools", "node", "node.exe"));
writePublicState(SB_ROOT);
writePublicMemory(SB_ROOT);
writePublicContext(SB_ROOT);
writePublicCore(SB_ROOT);
const manifestSources = ["core/rules.md", "core/reply-style.md", "reply-policy.json", ".context/CONTEXT.md", "MEMORY.md"];
const sources = Object.fromEntries(manifestSources.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(SB_ROOT, f))).digest("hex")]));
fs.writeFileSync(path.join(SB_ROOT, "resume-manifest.json"), JSON.stringify({ schemaVersion: 1, policyRevision: 2, stateFile: "current-state.json", policyFile: "reply-policy.json", sources, status: "fresh" }, null, 2));
check("沙箱就绪（临时 root + 当前 Node）", fs.existsSync(path.join(SB_ROOT, "tools", "node", "node.exe")) && fs.existsSync(path.join(SB_ROOT, "current-state.json")), SB_ROOT);

console.log("\n=== A. 正向链路 ===");
// A1 空库 fail-open（先测空库再写入）
let r = run("inject.js", ["--hint", "任何"]);
check("A1 空库 inject fail-open（空块+退出0）", r.ok && r.out.includes('count="0"'), r.out.slice(0, 80));
r = run("memory-cli.js", ["search", "任何"]);
check("A1b 空库 search 正常返回 0", r.ok && r.out.includes('"count": 0'), r.out.slice(0, 80));
// A2 add 两条（第二条与第一条相似 → 触发查重候选）
r = run("memory-cli.js", ["add", "用户偏好：所有输出使用中文", "--tags", "语言", "--type", "偏好"]);
check("A2 add 第一条", r.ok && r.out.includes('"added": true'), r.out.slice(0, 100));
const id1 = (r.out.match(/"id": "(\d+-\d+)"/) || [])[1];
r = run("memory-cli.js", ["add", "用户偏好：输出全部使用中文不要英文", "--tags", "语言", "--type", "偏好"]);
check("A3 add 第二条（过校验）", r.ok && r.out.includes('"added": true'), r.out.slice(0, 100));
check("A4 查重候选非空（吸收点A）", r.out.includes('"conflicts": [') && r.out.includes(id1 || "none"), r.out.slice(0, 120));
// A5 search
r = run("memory-cli.js", ["search", "中文"]);
check("A5 search 命中", r.ok && r.out.includes('"count": 2'), r.out.slice(0, 100));
// A6 inject 命中
r = run("inject.js", ["--hint", "中文", "--top", "2"]);
check("A6 inject 注入块含条目", r.ok && r.out.includes('count="2"'), r.out.slice(0, 100));
// A7 log 落盘 + 幂等
const tlog = path.join(SB, "t.jsonl");
fs.writeFileSync(tlog, '{"type":"user","message":{"content":[{"type":"text","text":"记住：沙箱规则"}]}}\n{"type":"user","message":{"content":[{"type":"text","text":"普通消息"}]}}\n');
r = run("log_turn.js", ["--transcript", tlog, "--session", "sb-s1"]);
check("A7 log 落盘 logged 2", r.ok && r.out.includes("logged 2 entries"), r.out);
r = run("log_turn.js", ["--transcript", tlog, "--session", "sb-s1"]);
check("A8 log 幂等静默", r.ok && r.out.trim() === "", r.out);
// K14 同族：本地时区日期（UTC 日期在凌晨会错位，读错 daily 文件导致假失败）
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const daily = fs.readFileSync(path.join(SB_ROOT, "daily", localToday() + ".md"), "utf8");
check("A9 决策触发词 ⭐ 标记", daily.includes("⭐👤 用户（决策）") && daily.includes("沙箱规则"), "daily 无 ⭐");
// A10 CLI 转发
r = run("memory-cli.js", ["inject", "--hint", "中文"]);
check("A10 CLI inject 转发", r.ok && r.out.includes("<memory-injected"), r.err.slice(0, 80));
r = run("memory-cli.js", ["log", "--transcript", tlog, "--session", "sb-cli"]);
check("A11 CLI log 转发", r.ok && r.out.includes('"logged": true'), r.out.slice(0, 80));
// A12 生命周期命令
r = run("memory-cli.js", ["index"]);
check("A12 index", r.ok && r.out.includes('"indexed"'), r.out);
r = run("memory-cli.js", ["verify"]);
check("A13 verify 0 噪音+一致", r.ok && r.out.includes('"noiseRate": 0') && r.out.includes('"indexDrift": false'), r.out.slice(0, 120));
r = run("memory-cli.js", ["stats"]);
check("A14 stats 2 条", r.ok && r.out.includes('"total": 2'), r.out);
r = run("memory-cli.js", ["distill", "--days", "30"]);
check("A15 distill 0 归档", r.ok && r.out.includes('"archived": 0'), r.out.slice(0, 100));
r = run("memory-cli.js", ["maintain"]);
check("A16 maintain 一站式", r.ok && r.out.includes('"done": true'), r.out.slice(0, 100));
// A17 MCP
const mcpIn = path.join(SB, "mcp.jsonl");
fs.writeFileSync(mcpIn, [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"recall_memory","arguments":{"query":"中文"}}}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"store_memory","arguments":{"content":"沙箱 MCP 写入候选","kind":"decision","sourceRef":"events.db:sandbox:1","confidence":0.8}}}',
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_candidates","arguments":{}}}',
  '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"verify_memory","arguments":{}}}',
].join("\n") + "\n");
r = runNode([path.join(SB_ROOT, "resources", "mcp-server", "index.js"), "--root", SB_ROOT], { input: fs.readFileSync(mcpIn, "utf8") });
// tools/call returns JSON text inside JSON-RPC JSON, so nested quotes are escaped once.
check("A17 MCP 握手+检索+候选写入+审计", r.ok && r.out.includes("serverInfo") && r.out.includes("中文") && r.out.includes('\\"added\\": true') && r.out.includes('\\"state\\": \\"candidate\\"') && r.out.includes("noiseRate"), r.out.slice(-1200));

console.log("\n=== B. 逆向链路 ===");
// B1 validate 拒写：缺 id / 非法 status / 非法 type
const b1 = path.join(SB, "b1.md");
fs.writeFileSync(b1, "---\nstatus: 非法\n---\n太短\n");
r = run("validate.js", ["check", b1]);
check("B1 缺id+非法status 拒", r.out.includes('"ok": false') && r.out.includes("缺字段 id"), r.out);
const b2 = path.join(SB, "b2.md");
fs.writeFileSync(b2, "---\nid: 20990101-0001\ncreated: 2099-01-01T00:00:00+08:00\nstatus: 🟢当前\ntype: 玄学\ntags: [x]\nscope: global\n---\n非法类型测试内容\n");
r = run("validate.js", ["check", b2]);
check("B2 非法 type 拒（吸收点B）", r.out.includes("非法类型"), r.out);
// B3 add 内容过短拒
r = run("memory-cli.js", ["add", "x"]);
check("B3 add 过短拒写", r.ok && r.out.includes('"added": false'), r.out.slice(0, 100));
// B4 search 空查询报错
r = run("memory-cli.js", ["search", ""]);
check("B4 空查询报错不崩", r.ok && r.out.includes("空查询词"), r.out.slice(0, 80));
// B5 log_turn 无 transcript → fail-open（hook-errors 记录，退出 0）
r = run("log_turn.js", ["--transcript", path.join(SB, "不存在.jsonl")]);
check("B5 无 transcript fail-open 退出0", r.ok && r.out.trim() === "", `${r.status} ${r.err.slice(0, 60)}`);
check("B5b hook-errors.log 已记录", fs.existsSync(path.join(SB_ROOT, "hook-errors.log")), "无日志");
// B6 poll-state 缺 db → fail-open
r = runNode(["--experimental-sqlite", path.join(SB_ROOT, "scripts", "legacy", "hermes", "poll-state.js"), "--db", path.join(SB, "不存在.db"), "--root", SB_ROOT]);
check("B6 poll-state 缺 db fail-open", r.ok, r.err.slice(0, 80));
// B7 MCP 未知工具 → isError
fs.writeFileSync(mcpIn, '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"hack_tool","arguments":{}}}\n');
r = runNode([path.join(SB_ROOT, "resources", "mcp-server", "index.js"), "--root", SB_ROOT], { input: fs.readFileSync(mcpIn, "utf8") });
check("B7 MCP 未知工具 isError", r.out.includes('"isError":true'), r.out.slice(0, 120));
// B8 路径穿越尝试（store_memory scope 枚举白名单）
r = run("memory-cli.js", ["add", "越界测试内容", "--scope", "../../../evil"]);
check("B8 非法 scope 被忽略（回退 global 不越界）", r.ok && r.out.includes('"scope": "global"'), r.out.slice(0, 120));
// B9 破坏性输入：非 UTF8 文件 validate
const b9 = path.join(SB, "b9.md");
fs.writeFileSync(b9, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]));
r = run("validate.js", ["check", b9]);
check("B9 二进制垃圾文件不崩", r.ok, r.err.slice(0, 60));

console.log(`\n===== 沙箱测试：正向 ${"A1-A17"} / 逆向 ${"B1-B9"} =====`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(SB, { recursive: true, force: true });
console.log(`沙箱已清理: ${!fs.existsSync(SB)}`);
process.exit(fail ? 1 : 0);
