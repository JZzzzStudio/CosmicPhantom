// tests/upgrade-rehearsal-test.js — 无痛升级彩排（2026-09-01 拍板"100% 实装保证 + 全量查重补漏"的验收件）
// ⚠️ 状态：**已判废（2026-09-19 执行；2026-09-16 判）** —— 文件保留不删，但**默认不跑**。
//   理由：本文件走 ZCode 时代的 upgrade-apply/upgrade-export 十门链，而**该通道已官方关闭**
//   （该文件位于 `tests/legacy/`；生产地位被 pack-bundle.cjs / install-bundle.cjs 的继承包路线取代）。
//   即便通道还在，其断言也**硬编码**了计数与字符串（「门6 守卫自检 7/7」而实测已 11 个用例；
//   「memories 270+2=272」而真源已 274）→ **红由"世界变了"驱动，不是功能回归**，作为信号已失效。
//   现行替代：继承包路线的升级验证 = `install-bundle.cjs` 的 P0/P1/P2/P3 + L1-L4a 自检（2026-09-19 实测全绿）。
//   复现历史证据：`node tests/upgrade-rehearsal-test.js --force-deprecated`（预期红）。
// 模拟"升级路线分歧的目标机"：flat 记忆卡 + 自己的 events.db / current-state / daily / distilled / 独有术语，
// 跑升级包 upgrade-apply.cjs 十门链，断言：①数据查重合并补漏（不是保留，不是覆盖）②代码=源机进度 ③目标机自有数据零丢失。
// 注意：门7 全量跑 17 套测试（数分钟），本件不在 package.json 常规链内，升级包变更时手动跑。
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.join(os.homedir(), ".cosmic-phantom");
const PKG = path.join(REAL, "..", ".cosmic-phantom-upgrade-20260901");
const NODE = path.join(REAL, "tools", "node", "node.exe");
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name} -- ${String(detail).slice(0, 220)}`); }
}
function countEvents(root) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(root, "events.db"), { readOnly: true });
    const n = db.prepare("SELECT COUNT(*) c FROM events").get().c;
    db.close();
    return n;
  } catch { return -1; }
}
function countBySession(root, session) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(root, "events.db"), { readOnly: true });
    const n = db.prepare("SELECT COUNT(*) c FROM events WHERE session = ?").get(session).c;
    db.close();
    return n;
  } catch { return -1; }
}

(async () => {
  // 判废闸（2026-09-19 执行）：默认**不跑**，并**显式说明为什么** ——
  //   既不静默删除，也不伪装成"通过"（§4.13 声称强度纪律：不给假绿）。
  if (process.argv.includes("--force-deprecated") === false) {
    console.log("⏭️  upgrade-rehearsal-test **已判废**（2026-09-19）：本件测的是 ZCode 时代**已关闭**的旧升级通道");
    console.log("   （upgrade-apply.cjs 十门链），生产地位已被继承包路线取代 —— 见 `scripts/legacy/` 归档说明。");
    console.log("   **跳过执行，不计入失败**。现行升级验证看 install-bundle.cjs 的 P0/P1/P2/P3 + L1-L4a。");
    console.log("   复现历史结果：加 --force-deprecated（其断言硬编码了已漂移的计数，红属预期）。");
    process.exit(0);
  }
  console.log("⚠️ --force-deprecated：以历史形态运行 —— 结果**不构成对现行系统的回归信号**。\n");
  if (!fs.existsSync(path.join(PKG, "upgrade-apply.cjs"))) { console.error(`升级包缺失：${PKG}（先在源机跑 node upgrade-export.cjs --out <包目录>）`); process.exit(1); }
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-upgrade-"));
  const T = path.join(SB, "target");
  const cleanup = () => { try { fs.rmSync(SB, { recursive: true, force: true }); } catch {} };
  process.on("exit", cleanup);

  // ---- 构造"分歧旧形态目标机"：flat 卡 + 自己的逐字/状态/日志/蒸馏/独有术语 ----
  fs.mkdirSync(path.join(T, "memories"), { recursive: true });
  fs.mkdirSync(path.join(T, "daily"), { recursive: true });
  fs.mkdirSync(path.join(T, ".context"), { recursive: true });
  fs.mkdirSync(path.join(T, "distilled"), { recursive: true });
  fs.writeFileSync(path.join(T, "package.json"), JSON.stringify({ name: "cosmic-phantom", type: "module", private: true }));
  fs.writeFileSync(path.join(T, "memories", "20260805-0001.md"), "---\nid: 20260805-0001\ncreated: 2026-08-05T10:00:00+08:00\nsource: daily/2026-08-05.md\nstatus: 🟢当前\ntype: 偏好\ntags: [目标机]\nscope: workspace\n---\n目标机自己的偏好卡（升级必须保留）\n");
  fs.writeFileSync(path.join(T, "memories", "20260806-0002.md"), "---\nid: 20260806-0002\ncreated: 2026-08-06T10:00:00+08:00\nsource: daily/2026-08-06.md\nstatus: ⏳待验证\ntype: 事件\ntags: [目标机]\nscope: workspace\n---\n目标机自己的待验证卡\n");
  fs.writeFileSync(path.join(T, "current-state.json"), JSON.stringify({ revision: 50, objective: "目标机旧状态", summary: "", nextActions: [], blockers: [] }, null, 2));
  fs.writeFileSync(path.join(T, "daily", "2026-08-15.md"), "# 2026-08-15 工作日志\n\n- 👤 用户：目标机自己的逐字记录\n");
  fs.writeFileSync(path.join(T, ".context", "CONTEXT.md"), "# 旧机 CONTEXT\n\n- 术语：目标机独有术语\n  定义：目标机本地共识，升级合并后必须保留。\n");
  fs.writeFileSync(path.join(T, "distilled", "target-own-distill.md"), "目标机自己的蒸馏档案\n");
  fs.copyFileSync(path.join(REAL, "AGENTS.md"), path.join(T, "AGENTS.md"));
  // 目标机自己的 events.db（2 条逐字 = 它的对话真源）
  const tf = path.join(SB, "t.jsonl");
  fs.writeFileSync(tf, [
    JSON.stringify({ type: "user", message: { content: "目标机自己的原话一（升级必须保留）" } }),
    JSON.stringify({ type: "user", message: { content: "目标机自己的原话二（升级必须保留）" } }),
  ].join("\n"));
  const evSetup = spawnSync(NODE, ["--experimental-sqlite", path.join(REAL, "events.js"), "manual", "--transcript", tf, "--session", "target-own", "--root", T], { encoding: "utf8", timeout: 60000 });

  check("T0 目标机 events.db 预置 2 条", (() => { try { return JSON.parse(evSetup.stdout).logged === 2; } catch { return false; } })(), (evSetup.stdout || evSetup.stderr).slice(0, 150));
  const eventsBefore = countEvents(T);
  check("T0b 目标机逐字层=2", eventsBefore === 2, String(eventsBefore));
  const dailyBefore = fs.readdirSync(path.join(T, "daily")).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).length;

  // ---- 跑升级包全门链 ----
  const apply = spawnSync(NODE, ["--experimental-sqlite", path.join(PKG, "upgrade-apply.cjs"), "--root", T], { encoding: "utf8", timeout: 900000, cwd: PKG });
  const errOut = String(apply.stderr || "").split("\n").filter(l => !/ExperimentalWarning|trace-warnings/.test(l)).join("\n");
  const out = apply.stdout || "";
  check("R1 apply 退出 0（全门绿）", apply.status === 0, out.slice(-300) + errOut.slice(0, 200));
  check("R1b stderr 摘要（诊断）", errOut.length === 0, errOut.slice(0, 400) || "（stderr 空）");
  check("R2 门1 备份执行", out.includes("✅ 门1 备份"));
  check("R3 门2 sha256 对账", out.includes("✅ 门2 代码覆盖"));
  check("R4 门4a 自动迁桶", out.includes("✅ 门4a memories 迁桶"));
  check("R5 门4b/4c 查重合并 + 条目对账", out.includes("✅ 门4b memories 查重合并") && out.includes("✅ 门4c 条目对账"));
  check("R5b 门4d events 合并重投影", out.includes("✅ 门4d events 合并重投影"));
  check("R5c 门4e 档案并集", out.includes("✅ 门4e 档案并集"));
  check("R6 门5 verify 硬门", out.includes("✅ 门5 派生索引 + verify"));
  check("R7 门6 守卫 7/7", out.includes("✅ 门6 守卫自检"));
  check("R8 门7 全量 17 套", out.includes("✅ 门7 全量测试 — 17 套全绿"), (out.split("\n").find(l => l.includes("门7 测试")) || errOut.split("\n").find(l => l.includes("门7 测试")) || "").slice(0, 200));
  check("R9 门8-10 彩排模式显式跳过（真机硬门）", out.includes("⏭️ 门8/9/10 宿主耦合门"));

  // ---- 数据查重合并断言（无痛 + 补漏核心）----
  check("D1 目标机自己的 2 条事件仍保留", countBySession(T, "target-own") === 2, String(countBySession(T, "target-own")));
  check("D2 目标机 events 总量 = 自有 2 + 源机全量（≥4000）", countEvents(T) >= 4000, String(countEvents(T)));
  check("D3 目标机 daily 原文件未动", fs.readFileSync(path.join(T, "daily", "2026-08-15.md"), "utf8").includes("目标机自己的逐字记录"));
  check("D4 memories flat 卡已消失（入桶）", fs.readdirSync(path.join(T, "memories")).filter(f => /^\d{8}-\d{4}\.md$/.test(f)).length === 0);
  check("D5 目标机偏好卡在月桶内且内容逐字", fs.readFileSync(path.join(T, "memories", "2026-08.md"), "utf8").includes("目标机自己的偏好卡（升级必须保留）"));
  check("D6 迁移原文件进 backup（可回滚）", fs.readdirSync(path.join(T, "backup")).some(d => d.startsWith("pre-upgrade-")));

  // ---- 代码 = 源机进度断言 ----
  check("C1 CONTEXT.md 已被源机版本覆盖", fs.readFileSync(path.join(T, ".context", "CONTEXT.md"), "utf8").includes("月度分桶"));
  check("C2 新模块落位（migrate-monthly/memory-retrieval 桶层）", fs.existsSync(path.join(T, "scripts", "packaging", "migrate-monthly.js")) && fs.readFileSync(path.join(T, "memory-retrieval.js"), "utf8").includes("splitBucketBlocks"));

  // ---- 全量查重补漏断言 ----
  const st = JSON.parse(spawnSync(NODE, ["--experimental-sqlite", path.join(T, "memory-cli.js"), "stats", "--root", T], { encoding: "utf8", timeout: 120000 }).stdout || "{}");
  check("M1 memories 合并 = 目标 2 + 源机 270 = 272", st.total === 272, JSON.stringify({ total: st.total, byScope: st.byScope }));
  check("M2 CONTEXT 双机术语并集（源机 月度分桶 + 目标机独有术语都在）", (() => { const c = fs.readFileSync(path.join(T, ".context", "CONTEXT.md"), "utf8"); return c.includes("月度分桶") && c.includes("目标机独有术语"); })());
  check("M3 daily 由重投影补漏（源机会话块出现在目标 daily，且文件数增加）", (() => {
    const files = fs.readdirSync(path.join(T, "daily")).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    if (files.length <= dailyBefore) return false;
    return files.some(f => fs.readFileSync(path.join(T, "daily", f), "utf8").includes("月度分桶改造"));
  })());
  check("M4 distilled 并集（目标机档案保留 + 源机档案补入）", fs.existsSync(path.join(T, "distilled", "target-own-distill.md")) && fs.readdirSync(path.join(T, "distilled")).some(f => f !== "target-own-distill.md"));
  check("M5 检索可命中双方卡（入桶不丢）", (() => {
    const hitTarget = (spawnSync(NODE, ["--experimental-sqlite", path.join(T, "memory-cli.js"), "search", "目标机 偏好卡", "--root", T], { encoding: "utf8", timeout: 60000 }).stdout || "").includes("20260805-0001");
    const hitSource = (spawnSync(NODE, ["--experimental-sqlite", path.join(T, "memory-cli.js"), "search", "腾讯 Agent Memory 实测", "--root", T], { encoding: "utf8", timeout: 60000 }).stdout || "").includes("20260807-0001");
    return hitTarget && hitSource;
  })());

  console.log(`\nupgrade-rehearsal-test: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("upgrade-rehearsal 异常:", e); process.exit(1); });

function writeTranscript(sb) {
  const f = path.join(sb, "t.jsonl");
  fs.writeFileSync(f, [
    JSON.stringify({ type: "user", message: { content: "目标机自己的原话一（升级必须保留）" } }),
    JSON.stringify({ type: "user", message: { content: "目标机自己的原话二（升级必须保留）" } }),
  ].join("\n"));
  return f;
}
