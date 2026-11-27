// tests/bucket-test.js — 月度分桶改造（2026-09-01 拍板）沙箱测试
// 覆盖：桶条目读取/检索平价、add 落当月桶、confirm/supersede/dedup 条目级更新、
//       migrate-monthly 幂等迁移 + 原文件备份、decision-cards 合并优先。
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-bucket-"));
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
function run(script, args) {
  const r = spawnSync(NODE, ["--experimental-sqlite", path.join(ROOT, script), ...args, "--root", ROOT], { encoding: "utf8", timeout: 120000 });
  return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
}
function jparse(r) { const s = (r.out || "").trim(); const i = s.indexOf("{"); try { return JSON.parse(s.slice(i)); } catch { return {}; } }

(async () => {
  for (const f of ["events.js", "memory-cli.js", "memory-retrieval.js", "link-graph.js", "skills-sync.js", "session-adapter.js", "validate.js", "decision-cards.js", "scripts/packaging/migrate-monthly.js", "lib/failopen.js"]) copy(f);
  fs.writeFileSync(path.join(ROOT, "package.json"), JSON.stringify({ name: "cp-sandbox", type: "module", private: true }), "utf8");
  for (const d of ["memories", "daily", "backup", "distilled"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

  // ---- 遗留单卡两张（legacy 读路径基线）----
  const card = (id, body, extra = "") => `---\nid: ${id}\ncreated: 2026-08-10T10:00:00+08:00\nsource: daily/2026-08-10.md\nstatus: 🟢当前\ntype: 偏好\ntags: [测试]\nscope: workspace\n${extra}---\n${body}\n`;
  fs.writeFileSync(path.join(MEM, "20260810-0001.md"), card("20260810-0001", "部署前必须先跑回归测试（遗留卡甲）"));
  fs.writeFileSync(path.join(MEM, "20260810-0002.md"), card("20260810-0002", "回复用中文（遗留卡乙）"));

  // ---- T1 add 落当月桶（不再一卡一文件）----
  const a = jparse(run("memory-cli.js", ["add", "月度分桶改造后的新增卡内容足够长来通过校验"]));
  check("T1a add 成功", a.added === true, JSON.stringify(a).slice(0, 160));
  check("T1b 新卡落在当月桶文件", /^2026-\d{2}\.md$/.test(path.basename(String(a.file || ""))), String(a.file));
  check("T1c 根目录无新单卡文件", !fs.existsSync(path.join(MEM, `${a.id}.md`)), a.id);

  // ---- T2 检索平价：桶条目与遗留卡都能命中 ----
  const s1 = jparse(run("memory-cli.js", ["search", "月度分桶 新增卡"]));
  check("T2a 桶条目可检索", (s1.results || []).some(r => r.id === a.id), JSON.stringify((s1.results || []).map(r => r.id)));
  const s2 = jparse(run("memory-cli.js", ["search", "回归测试"]));
  check("T2b 遗留卡可检索（读路径兼容）", (s2.results || []).some(r => r.id === "20260810-0001"), JSON.stringify((s2.results || []).map(r => r.id)));

  // ---- T3 supersede 条目级更新（旧卡在遗留文件、新卡在桶内，跨形态成链）----
  const sup = jparse(run("memory-cli.js", ["supersede", "20260810-0001", a.id]));
  check("T3a supersede 成功", sup.ok === true, JSON.stringify(sup));
  const bucketText = fs.readFileSync(path.join(MEM, path.basename(String(a.file))), "utf8");
  check("T3b 新卡（桶内）含 supersedes 回指", new RegExp(`supersedes: 20260810-0001`).test(bucketText), bucketText.slice(-400));
  const legacyAfter = fs.readFileSync(path.join(MEM, "20260810-0001.md"), "utf8");
  check("T3c 遗留旧卡标 🕰️ + superseded_by", legacyAfter.includes("status: 🕰️过去") && legacyAfter.includes(`superseded_by: ${a.id}`), legacyAfter.slice(0, 260));

  // ---- T4 confirm 条目级转正 ----
  fs.writeFileSync(path.join(MEM, "20260810-0003.md"), card("20260810-0003", "待验证池里的确认制测试卡内容足够长", "").replace("status: 🟢当前", "status: ⏳待验证"));
  const cf = jparse(run("memory-cli.js", ["confirm", "20260810-0003"]));
  check("T4 confirm 转正写回", cf.confirmed === 1, JSON.stringify(cf));
  check("T4b 状态已落盘", fs.readFileSync(path.join(MEM, "20260810-0003.md"), "utf8").includes("status: 🟢当前"));

  // ---- T5 dedup --apply 条目级（正文完全重复 → 补链）----
  fs.writeFileSync(path.join(MEM, "20260810-0004.md"), card("20260810-0004", "回复用中文（遗留卡乙）").replace("status: 🟢当前", "status: 🕰️过去"));
  const dd = jparse(run("memory-cli.js", ["dedup", "--apply"]));
  check("T5 dedup 补链生效", dd.applied >= 1 || dd.groups >= 1, JSON.stringify({ groups: dd.groups, applied: dd.applied }));

  // ---- T6 migrate-monthly：dry-run → apply（桶聚合 + 原文件备份 + 幂等）----
  const before = jparse(run("memory-cli.js", ["stats"]));
  const dr = jparse(run("scripts/packaging/migrate-monthly.js", ["--dry-run"]));
  check("T6a dry-run 报告 3 张遗留卡", dr.legacyFiles === 4, JSON.stringify({ legacy: dr.legacyFiles, plan: dr.plan }));
  const ap = jparse(run("scripts/packaging/migrate-monthly.js", ["--apply"]));
  check("T6b apply 迁移 4 张", ap.moved === 4, JSON.stringify(ap).slice(0, 240));
  const after = jparse(run("memory-cli.js", ["stats"]));
  check("T6c 迁移前后条目总数一致", after.total === before.total, JSON.stringify({ before: before.total, after: after.total }));
  check("T6d 根目录无遗留单卡（全部入桶）", fs.readdirSync(MEM).filter(f => /^\d{8}-\d{4}\.md$/.test(f)).length === 0, JSON.stringify(fs.readdirSync(MEM)));
  check("T6e 原文件在 backup 且不删", fs.existsSync(path.join(ROOT, "backup", String(ap.backup || "").split("backup" + path.sep).pop() || "x")) || fs.readdirSync(path.join(ROOT, "backup")).some(d => d.startsWith("memories-flat-")), String(ap.backup));
  const mp = jparse(run("scripts/packaging/migrate-monthly.js", ["--dry-run"]));
  check("T6f 重跑 dry-run 零遗留（幂等）", mp.legacyFiles === 0, JSON.stringify({ legacy: mp.legacyFiles }));
  const s3 = jparse(run("memory-cli.js", ["search", "回归测试"]));
  check("T6g 迁移后检索仍命中（入桶不丢）", (s3.results || []).some(r => r.id === "20260810-0001"), JSON.stringify((s3.results || []).map(r => r.id)));

  // ---- T7 decision-cards 合并优先 ----
  // 预置同主题既有卡（type=事件；正文标点内嵌使候选非其子串，绕过原文重复跳过、命中 topicKey 合并）
  fs.writeFileSync(path.join(MEM, "20260810-0005.md"), `---\nid: 20260810-0005\ncreated: 2026-08-10T09:00:00+08:00\nsource: daily/2026-08-10.md\nstatus: 🟢当前\ntype: 事件\ntags: [决策]\nscope: workspace\n---\n每周三。发布\n`);
  const dailyPath = path.join(ROOT, "daily", "2026-08-10.md");
  fs.writeFileSync(dailyPath, "# 2026-08-10 工作日志\n\n## 会话 t1（2026-08-10T02:00:00.000Z）· 通道：ZCode\n- **⭐👤 用户（决策）**：每周三发布\n---\n", "utf8");
  const dc = jparse(run("decision-cards.js", ["--date", "2026-08-10"]));
  check("T7a 同主题决策走合并不新建", (dc.merged || []).length === 1 && (dc.generated || []).length === 0, JSON.stringify({ generated: dc.generated, merged: dc.merged, skipped: dc.skipped }));
  const dc2 = jparse(run("decision-cards.js", ["--date", "2026-08-10"]));
  check("T7b 重跑幂等（不再合并不再新建）", (dc2.merged || []).length === 0 && (dc2.generated || []).length === 0, JSON.stringify({ generated: dc2.generated, merged: dc2.merged }));

  // ---- T8 verify 全绿（桶形态下噪音 0 / 无漂移）----
  run("memory-cli.js", ["index"]);   // 迁移后派生索引重建（真实流程由 maintain/wrap-up 承担）
  const v = jparse(run("memory-cli.js", ["verify"]));
  check("T8 verify 噪音 0 / 无漂移", v.noise === 0 && v.indexDrift === false, JSON.stringify({ noise: v.noise, drift: v.indexDrift, total: v.total, bad: (v.bad || []).slice(0, 2) }));

  // ---- T9 distill 真删路径（2026-09-01 P1：🕰️ 超期条目从月桶摘出成 distilled 档案）----
  const bucketFile = path.join(MEM, "2026-08.md");
  fs.appendFileSync(bucketFile, `---\nid: 20260801-0006\ncreated: 2026-08-01T10:00:00+08:00\nsource: daily/2026-08-01.md\nstatus: 🕰️过去\ntype: 事件\ntags: [测试]\nscope: workspace\n---\n超期归档验证卡\n\n§§§\n`);
  const d1 = run("memory-cli.js", ["distill", "--days", "30"]);
  check("T9a 蒸馏可跑（退出 0）", d1.status === 0 && d1.out.includes("distilled/"), JSON.stringify({ status: d1.status, err: d1.err.slice(0, 120) }));
  // ⚠️ 2026-09-16 契约更新：`memory-cli.js:672` 注释写明**刻意废除**"把超期 🕰️ 条目摘出为
  //   distilled/mem-<id>.md"（历史教训：摘出即离开检索池 → golden-set 命中率下降）。
  //   故 T9b/T9c 由"摘出成功"改为"**不得**摘出（防回归到旧行为）"；T9d 计数相应为前值+1。
  check("T9b 不产生 mem-<id>.md 档案（旧行为已废除）", !fs.existsSync(path.join(ROOT, "distilled", "mem-20260801-0006.md")));
  check("T9c 条目仍在月桶内（可召回）", fs.readFileSync(bucketFile, "utf8").includes("20260801-0006"));
  const v9 = jparse(run("memory-cli.js", ["verify"]));
  check("T9d 蒸馏后 verify 仍全绿且计数 = 前值+1", v9.noise === 0 && v9.indexDrift === false && v9.total === v.total + 1, JSON.stringify({ total: v9.total, expect: v.total + 1, noise: v9.noise, drift: v9.indexDrift }));

  console.log(`\nbucket-test: ${pass} pass, ${fail} fail, sandbox=${SB}`);
  const cleanup = () => { try { fs.rmSync(SB, { recursive: true, force: true }); } catch {} };
  process.on("exit", cleanup);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("bucket-test 异常:", e); process.exit(1); });
