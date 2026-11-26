// tests/regression-test.js — 永久回归测试（P0 两段契约 + 双轨保真 + 固化项 + 零副作用）
// 用法：node --experimental-sqlite tests/regression-test.js
// 全部运行在临时根 + 临时 state.db；生产零接触（组 D 强制 SHA-256 核对）
//
// 组 R（红灯组，证明测试能捕获缺陷）：
//   R1 游标不得越过失败消息（最终契约：events.db 段1游标）
//   R2 首尾空格保真（events 原始层 + daily 投影双层断言）
// 组 W（崩溃窗口恢复，两段契约）：
//   W1 原始事件未持久化时游标不越过（游标回退 → 重放补摄取，无重复）
//   W2 事件已持久化、游标未提交时重放不重复（游标回退 → 行数不变）
//   W3 daily 已写、投影状态未提交时重放不重复（删 projection → 重投影不重复）
//   W4 daily 写入失败时原始事件保留并可恢复投影（daily 目录故障 → 修复后补投影）
// 组 F（固化项，从 2026-08-08 ad-hoc 验证迁移）：--root 透传 / 零污染 / 指针损坏 /
//   单调告警 / 锁 / MCP 边界 / 注入块 / validate --root / 漏写标记 / 时区 id
// 组 D（零副作用）：生产文件 SHA-256 前后对照 + 生产 events.db 不得出现

const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const REAL = path.join(os.homedir(), ".cosmic-phantom");
const NODE = path.join(REAL, "tools", "node", "node.exe");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-regress-"));
const SB_ROOT = path.join(SB, "root");
const SB2 = path.join(SB, "root2");
const EVENTS_JS = path.join(SB_ROOT, "events.js");

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail || ""}`); }
}
function note(name, detail) { skip++; console.log(`  [SKIP] ${name} -- ${detail}`); }
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const EVENTDB = path.join(SB_ROOT, "events.db");
const hasEvents = () => fs.existsSync(EVENTS_JS);

function mkSb(root) {
  for (const d of ["memories", "daily", "backup", "topics", "distilled", "pro", "resources/mcp-server", "scripts/legacy/hermes"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of ["memory-cli.js", "memory-retrieval.js", "lib/failopen.js", "link-graph.js", "skills-sync.js", "current-state.js", "current-state.json", "resume-context.js", "reply-policy.json", "resume-manifest.json", "log_turn.js", "validate.js", "inject.js", "identity-card.js", "inject-config.js", "inject.config.json", "MEMORY.md", "events.js", "scripts/legacy/hermes/poll-state.js", "resources/mcp-server/index.js", "package.json"]) {
    const src = path.join(REAL, f);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(root, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  execFileSync("cmd", ["/c", "mklink", "/J", path.join(root, "tools"), path.join(REAL, "tools")], { stdio: "ignore" });
}
mkSb(SB_ROOT); mkSb(SB2);

// ---------- 工具 ----------
function run(root, script, args) {
  const full = [path.join(root, script), ...args];
  const argv = /(poll-state|events)\.js/.test(script) ? ["--experimental-sqlite", ...full] : full;
  const r = spawnSync(NODE, argv, { encoding: "utf8", timeout: 30000 });
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "" };
}
function runReal(script, args) {
  const r = spawnSync(NODE, [path.join(REAL, script), ...args], { encoding: "utf8", timeout: 30000 });
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "" };
}
function makeDb(root, tag, rows) {
  const db = new (require("node:sqlite").DatabaseSync)(path.join(root, `t${tag}.db`));
  db.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, tool_calls TEXT); CREATE TABLE sessions(id TEXT, ended_at TEXT);");
  for (const r of rows) db.prepare("INSERT INTO messages(id, session_id, role, content, tool_name, tool_calls) VALUES (?,?,?,?,?,?)").run(r[0], r[1], r[2], r[3], r[4] || null, r[5] || null);
  db.close();
  return path.join(root, `t${tag}.db`);
}
function ev(root) { // 打开 events.db（如存在）
  const p = path.join(root, "events.db");
  return fs.existsSync(p) ? new (require("node:sqlite").DatabaseSync)(p, { readOnly: true }) : null;
}
function readMeta(root, key) {
  const db = ev(root); if (!db) return undefined;
  const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
  db.close();
  return r ? r.value : undefined;
}
function sha256(f) {
  return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
}

// 生产零副作用快照（组 D 用）
const PROD_FILES = [
  path.join(REAL, "daily", "2026-08-08.md"),
  path.join(os.tmpdir(), "cp-external-host", "memories", "USER.md"),
  path.join(REAL, "state-poll.json"),
  path.join(REAL, "state-poll.json.bak-20260807"),
].filter(f => fs.existsSync(f));
const prodBefore = PROD_FILES.map(f => [f, sha256(f)]);
const prodEventsExistedBefore = fs.existsSync(path.join(REAL, "events.db"));

// ============ 组 R：红灯组（当前实现的缺陷捕获） ============
console.log("=== 组 R：游标契约与保真 ===");
// R1 段1摄取失败 → 游标不得越过（双轨契约：原始事件未持久化时游标不前进）
{
  const dbPath = makeDb(SB_ROOT, "r1", [
    [1, "sA", "user", "R1 会话A消息", null, null],
    [2, "sA", "user", "R1 会话A消息2", null, null],
    [3, "sB", "user", "R1 会话B消息（摄取失败场景）", null, null],
    [4, "sB", "user", "R1 会话B消息2", null, null],
  ]);
  if (hasEvents()) {
    // 实现后：模拟段1失败（events.js 退出失败）→ 游标不得越过（0）
    const evBak = path.join(SB, "events.bak");
    fs.copyFileSync(path.join(SB_ROOT, "events.js"), evBak);
    fs.writeFileSync(path.join(SB_ROOT, "events.js"), "process.exit(1);\n");
    const r = run(SB_ROOT, "scripts/legacy/hermes/poll-state.js", ["--db", dbPath, "--root", SB_ROOT]);
    fs.copyFileSync(evBak, path.join(SB_ROOT, "events.js"));
    const cursor = fs.existsSync(path.join(SB_ROOT, "events.db")) ? Number(readMeta(SB_ROOT, "cursor") || 0) : 0;
    check("R1 摄取失败时游标不越过（=0）", cursor === 0, `游标=${cursor}`);
    const n = fs.existsSync(path.join(SB_ROOT, "events.db")) ? (() => { const d = ev(SB_ROOT); const c = d.prepare("SELECT COUNT(*) c FROM events").get().c; d.close(); return c; })() : 0;
    check("R1 失败批次未进入原始事件层", n === 0, `事件数=${n}`);
  } else {
    // 实现前：诊断旧行为（预期红：指针越过失败消息）
    const ltBak = path.join(SB, "log_turn.bak");
    fs.copyFileSync(path.join(SB_ROOT, "log_turn.js"), ltBak);
    fs.writeFileSync(path.join(SB_ROOT, "log_turn.js"), "process.exit(1);\n");
    const r = run(SB_ROOT, "scripts/legacy/hermes/poll-state.js", ["--db", dbPath, "--root", SB_ROOT]);
    fs.copyFileSync(ltBak, path.join(SB_ROOT, "log_turn.js"));
    const p = JSON.parse(fs.readFileSync(path.join(SB_ROOT, "state-poll.json"), "utf8"));
    const daily = fs.readdirSync(path.join(SB_ROOT, "daily")).filter(f => f.endsWith(".md"));
    const dailyHasFail = daily.some(f => fs.readFileSync(path.join(SB_ROOT, "daily", f), "utf8").includes("R1 会话B消息"));
    check("R1 [RED-预期] 现实现：指针越过失败消息（缺陷捕获）", p.maxId === 4 && !dailyHasFail, `maxId=${p.maxId} dailyHasFailMsg=${dailyHasFail}`);
  }
}
// R2 首尾空格保真
{
  const tjsonl = path.join(SB, "r2.jsonl");
  fs.writeFileSync(tjsonl, JSON.stringify({ type: "user", message: { content: "  首尾空格消息  " } }) + "\n" + JSON.stringify({ type: "user", message: { content: "多行\n\n缩进  保留\n" } }) + "\n");
  const r = run(SB2, "log_turn.js", ["--transcript", tjsonl, "--session", "r2", "--root", SB2]);
  const dailyF = path.join(SB2, "daily", `${localToday()}.md`);
  const dc = fs.existsSync(dailyF) ? fs.readFileSync(dailyF, "utf8") : "";
  check("R2 首尾空格保留", dc.includes("  首尾空格消息  "), "被 trim 或缺失");
  check("R2 多行与空行保留", dc.includes("多行\n\n缩进  保留"), "换行/空行被改写");
  if (hasEvents()) {
    const db = ev(SB2);
    const e = db.prepare("SELECT content FROM events WHERE instance='manual' ORDER BY id").all(); db.close();
    check("R2 原始事件层不 trim", e.length >= 1 && e[0].content === "  首尾空格消息  ", JSON.stringify(e));
  } else {
    note("R2 原始事件层断言（实现后启用）", "events.js 不存在");
  }
}

// ============ 组 F：固化项（2026-08-08 ad-hoc 验证迁移） ============
console.log("=== 组 F：固化项 ===");
// F1 cmdLog --root 透传 + 生产零污染
{
  const t1jsonl = path.join(SB, "f1.jsonl");
  fs.writeFileSync(t1jsonl, '{"type":"user","message":{"content":"F1 透传验证 8f2b"}}\n');
  const r = runReal("memory-cli.js", ["log", "--transcript", t1jsonl, "--session", "f1", "--root", SB_ROOT]);
  const f1f = path.join(SB_ROOT, "daily", `${localToday()}.md`);
  const sbHas = fs.existsSync(f1f) && fs.readFileSync(f1f, "utf8").includes("F1 透传验证 8f2b");
  const prodHas = fs.readdirSync(path.join(REAL, "daily")).filter(f => f.endsWith(".md"))
    .some(f => fs.readFileSync(path.join(REAL, "daily", f), "utf8").includes("F1 透传验证 8f2b"));
  check("F1 log 写入 --root 目标", r.ok && sbHas, r.out.slice(0, 80));
  check("F1 生产 daily 零污染", !prodHas, "生产被污染!");
}
// F2 指针损坏备份重置（实现前 state-poll.json；实现后 events.db 由 SQLite 事务保证，此组保留旧断言仅实现前跑）
{
  fs.writeFileSync(path.join(SB_ROOT, "state-poll.json"), "{broken!!");
  const db2 = makeDb(SB_ROOT, "f2", [[1, "s1", "user", "F2 消息", null, null]]);
  const r = run(SB_ROOT, "scripts/legacy/hermes/poll-state.js", ["--db", db2, "--root", SB_ROOT]);
  const corrupt = fs.readdirSync(SB_ROOT).filter(f => f.startsWith("state-poll.json.corrupt-"));
  if (!hasEvents()) {
    check("F2 损坏指针被备份（实现前）", corrupt.length === 1, JSON.stringify(corrupt));
  } else {
    note("F2 指针损坏备份（实现后由 events.db 事务取代）", "state-poll.json 停用");
  }
}
// F3 锁互斥
{
  const lockPath = path.join(SB_ROOT, ".poll.lock");
  fs.writeFileSync(lockPath, "held");
  fs.utimesSync(lockPath, new Date(), new Date()); // 新鲜锁（<2 分钟不老化）
  const db3 = makeDb(SB_ROOT, "f3", [[1, "s1", "user", "F3 消息", null, null]]);
  const r = run(SB_ROOT, "scripts/legacy/hermes/poll-state.js", ["--db", db3, "--root", SB_ROOT]);
  check("F3 持有锁时 poll 跳过（skipped）", r.out.includes("skipped"), r.out.slice(0, 80));
  fs.unlinkSync(lockPath);
}
// F4 MCP 路径边界（生产根零副作用：用不存在的文件）
{
  const mcpIn = path.join(SB, "f4.jsonl");
  const realMem = path.join(REAL, "memories", fs.readdirSync(path.join(REAL, "memories")).find(f => f.endsWith(".md")));
  fs.writeFileSync(mcpIn, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "log_turn", arguments: { transcript: realMem } } }) + "\n");
  const r = spawnSync(NODE, [path.join(REAL, "resources", "mcp-server", "index.js")], { encoding: "utf8", timeout: 30000, input: fs.readFileSync(mcpIn, "utf8") });
  check("F4 库内路径被拒", r.stdout.includes('"isError":true') && r.stdout.includes("不得指向记忆库内部"), r.stdout.slice(0, 120));
  fs.writeFileSync(mcpIn, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "log_turn", arguments: { transcript: path.join(SB, "不存在.jsonl") } } }) + "\n");
  const r2 = spawnSync(NODE, [path.join(REAL, "resources", "mcp-server", "index.js")], { encoding: "utf8", timeout: 30000, input: fs.readFileSync(mcpIn, "utf8") });
  check("F4 库外路径零副作用", !r2.stdout.includes("不得指向记忆库内部") && r2.stdout.includes("transcript 不存在"), r2.stdout.slice(0, 120));
}
// F5 inject 注入块心跳
{
  fs.writeFileSync(path.join(SB_ROOT, "backup", "last-mirror.txt"), "2026-08-08T00:00:00.000Z");
  const r = run(SB_ROOT, "inject.js", ["--hint", "任意", "--root", SB_ROOT]);
  check("F5 注入块含镜像时间", r.out.includes("系统心跳"), r.out.slice(0, 100));
}
// F6 validate --root
{
  fs.writeFileSync(path.join(SB_ROOT, "memories", "bad.md"), "无 frontmatter 的坏条目\n");
  const r = run(SB_ROOT, "validate.js", ["audit", "--all", "--root", SB_ROOT]);
  const v = JSON.parse(r.out);
  check("F6 validate --root 生效", v.noise >= 1, JSON.stringify(v));
}
// F7 漏写标记（排除今天自身）——用独立根 SB3，避免 R2 已创建今天文件导致"新建"场景失效
{
  const SB3 = path.join(SB, "root3"); mkSb(SB3);
  fs.writeFileSync(path.join(SB3, "daily", "2026-07-29.md"), "# 旧\n");
  const t7 = path.join(SB, "f7.jsonl");
  fs.writeFileSync(t7, '{"type":"user","message":{"content":"F7 漏写验证"}}\n');
  const r = run(SB3, "log_turn.js", ["--transcript", t7, "--session", "f7", "--root", SB3]);
  const f7f = path.join(SB3, "daily", `${localToday()}.md`);
  const c7 = fs.existsSync(f7f) ? fs.readFileSync(f7f, "utf8") : "";
  check("F7 漏写标记触发", c7.includes("漏写标记"), c7.slice(0, 100));
}
// F8 nextId 本地时区
{
  const r = run(SB_ROOT, "memory-cli.js", ["add", "时区验证条目", "--tags", "验证", "--type", "事件", "--root", SB_ROOT]);
  const id = (r.out.match(/"id": "(\d{8}-\d{4})"/) || [])[1] || "";
  check("F8 id 日期段 = 本地日期", id.startsWith(localToday().replace(/-/g, "")), `id=${id}`);
}

// ============ 组 W：崩溃窗口（两段契约，实现后启用） ============
console.log("=== 组 W：崩溃窗口恢复 ===");
if (!hasEvents()) {
  note("W1-W4（两段契约崩溃窗口）", "events.js 不存在，实现后启用");
} else {
  const dbW = makeDb(SB_ROOT, "w", [
    [1, "sW", "user", "W 消息1", null, null],
    [2, "sW", "user", "W 消息2", null, null],
    [3, "sW", "user", "W 消息3", null, null],
  ]);
  // 基线摄取
  let r = run(SB_ROOT, "scripts/legacy/hermes/poll-state.js", ["--db", dbW, "--root", SB_ROOT]);
  check("W0 基线摄取成功", r.ok && (r.out.includes("wrote") || r.out.includes("ingested")), r.out.slice(0, 120));
  const db = () => new (require("node:sqlite").DatabaseSync)(path.join(SB_ROOT, "events.db"));
  const countEvents = () => { const d = db(); const n = d.prepare("SELECT COUNT(*) c FROM events").get().c; d.close(); return n; };
  // W1+W2：游标回退（模拟"事件已持久化、游标未提交"）→ 重放不重复
  {
    const n0 = countEvents();
    const d = db(); d.prepare("UPDATE meta SET value='1' WHERE key='cursor'").run(); d.close();
    r = run(SB_ROOT, "scripts/legacy/hermes/poll-state.js", ["--db", dbW, "--root", SB_ROOT]);
    check("W1/W2 游标回退后重放不重复", countEvents() === n0, `事件数 ${countEvents()} vs ${n0}`);
    const cur = Number(readMeta(SB_ROOT, "cursor") || -1);
    check("W1/W2 游标恢复至最新", cur === 3, `cursor=${cur}`);
  }
  // W3：daily 已写、投影状态未提交（删 projection 记录）→ 重投影不重复
  {
    const dailyF = path.join(SB_ROOT, "daily", `${localToday()}.md`);
    const before = fs.readFileSync(dailyF, "utf8");
    const d = db(); d.prepare("DELETE FROM projection").run(); d.close();
    r = run(SB_ROOT, "events.js", ["project", "--root", SB_ROOT]);
    const after = fs.readFileSync(dailyF, "utf8");
    const diff = before === after ? "" : `\nBEFORE[${before.length}]: ${JSON.stringify(before.slice(-400))}\nAFTER[${after.length}]: ${JSON.stringify(after.slice(-400))}`;
    check("W3 删投影状态后重投影不重复", after === before, diff);
    const d2 = db(); const pn = d2.prepare("SELECT COUNT(*) c FROM projection").get().c; d2.close();
    check("W3 投影状态已补记", pn >= 3, `projection=${pn}`);
  }
  // W4：daily 不可写 → 事件保留 + 游标推进 + 修复后投影恢复
  {
    const dailyDir = path.join(SB_ROOT, "daily");
    const dailyF = path.join(dailyDir, `${localToday()}.md`);
    // 追加一条新消息后破坏 daily 目录（改成同名文件）
    const d = db(); d.prepare("UPDATE meta SET value='3' WHERE key='cursor'").run(); d.close();
    const dbW2 = makeDb(SB_ROOT, "w2", [[4, "sW", "user", "W 消息4", null, null]]);
    fs.rmSync(dailyDir, { recursive: true, force: true });
    fs.writeFileSync(dailyDir, "not a dir"); // daily 路径变成文件 → append 失败
    r = run(SB_ROOT, "scripts/legacy/hermes/poll-state.js", ["--db", dbW2, "--root", SB_ROOT]);
    check("W4 投影失败时事件已摄取", countEvents() >= 4, `事件数=${countEvents()}`);
    check("W4 段1游标已推进（不阻塞）", Number(readMeta(SB_ROOT, "cursor") || -1) === 4, `cursor=${readMeta(SB_ROOT, "cursor")}`);
    // 修复 daily 目录 → 重跑投影
    fs.unlinkSync(dailyDir);
    fs.mkdirSync(dailyDir, { recursive: true });
    r = run(SB_ROOT, "events.js", ["project", "--root", SB_ROOT]);
    const c = fs.readFileSync(path.join(dailyDir, `${localToday()}.md`), "utf8");
    check("W4 修复后投影恢复（含 W 消息4）", c.includes("W 消息4"), c.slice(-200));
  }
}

// ============ 组 D：生产零副作用 ============
console.log("=== 组 D：生产零副作用 ===");
{
  // 稳定文件（守护不写）：字节级 SHA-256 必须一致
  for (const [f, h] of prodBefore.filter(([f]) => f.endsWith("USER.md") || f.endsWith("bak-20260807"))) {
    check(`D 稳定文件未变: ${path.basename(f)}`, fs.existsSync(f) && sha256(f) === h, "SHA-256 不一致!");
  }
  // 运行态文件（活跃守护会合法写入）：语义断言——指针合法推进、daily 只增且无测试特征串
  // 2026-11-18 兼容：新机首次安装时 state-poll.json 不存在（2026-08-08 起游标权威=events.db meta.cursor），
  //   旧版此处直接 readFileSync 会 ENOENT 崩掉整组 D，导致全新安装的自测必红。改为跳过该断言。
  const ptrFile = path.join(REAL, "state-poll.json");
  const ptrBeforeHit = prodBefore.find(([f]) => f.endsWith("state-poll.json"));
  if (fs.existsSync(ptrFile) && ptrBeforeHit) {
    const ptr = JSON.parse(fs.readFileSync(ptrFile, "utf8"));
    const ptrBefore = JSON.parse(fs.readFileSync(ptrBeforeHit[0], "utf8"));
    check("D 指针合法推进（未被测试重置/损坏）", Number(ptr.maxId) >= Number(ptrBefore.maxId) && /^\d+$/.test(String(ptr.maxId)), `before=${ptrBefore.maxId} after=${ptr.maxId}`);
  } else {
    note("D 指针合法推进", "state-poll.json 未生成（游标权威=events.db meta.cursor）");
  }
  const dailyNow = fs.readdirSync(path.join(REAL, "daily")).filter(f => f.endsWith(".md"))
    .some(f => fs.readFileSync(path.join(REAL, "daily", f), "utf8").match(/F1 透传验证 8f2b|R1 会话|W 消息|cp-regress/));
  check("D 生产 daily 无测试特征串", !dailyNow, "测试数据进入生产 daily!");
  const prodEventsNow = fs.existsSync(path.join(REAL, "events.db"));
  check("D 生产 events.db 未被创建", prodEventsNow === prodEventsExistedBefore, `before=${prodEventsExistedBefore} now=${prodEventsNow}`);
}

console.log(`\n===== regression-test：${pass} 通过 / ${fail} 失败 / ${skip} 跳过 =====`);
fs.rmSync(SB, { recursive: true, force: true });
console.log(`临时沙箱已清理: ${!fs.existsSync(SB)}`);
process.exit(fail ? 1 : 0);
