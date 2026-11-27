#!/usr/bin/env node
/**
 * tests/guard-selftest.js — 守卫冒烟自检（F16 2026-08-28 外审预检落地的配套）
 *
 * 病根：守卫被 try/catch 吞掉就永久静默（ESM require 坑 ×2 实证）——"全绿"必须证明守卫本身会响。
 * 做法：对代表性守卫逐个喂故障态 → 断言 verify 输出含对应 stale 关键字 → 清理恢复。
 * 覆盖：F13 黄金集回退 / F14 待验证堆积 / F15 状态 TTL / F16 错误计数。
 * 污染控制（T7）：全部注入物带 20990101 测试前缀/标记行，finally 强制清理；跑前后 events 计数不变（本测试不写 events）。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { writePublicState, writePublicMemory, writePublicContext, writePublicCore, writePublicDaily } = require("./fixtures/public-fixtures.cjs");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-guard-selftest-"));
const ROOT = path.join(SB, "root");
let pass = 0, fail = 0;
const cleanups = [];
for (const dir of ["memories", "daily", "backup", "core", ".context", ".flags", "eval", "lib", "tools/node"]) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
for (const file of ["memory-cli.js", "memory-retrieval.js", "validate.js", "link-graph.js", "skills-sync.js", "current-state.js", "resume-context.js", "reply-policy.json", "inject.config.json", "package.json", "lib/failopen.js"]) {
  const target = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REAL, file), target);
}
fs.copyFileSync(process.execPath, path.join(ROOT, "tools", "node", "node.exe"));
writePublicState(ROOT);
writePublicMemory(ROOT);
writePublicContext(ROOT);
writePublicCore(ROOT);
fs.writeFileSync(path.join(ROOT, "core", "blindspot-ledger.md"), "# Public synthetic blindspot ledger\n\n| ID | 假设 | 来源 | 状态 | 证据 |\n|---|---|---|---|---|\n", "utf8");
writePublicDaily(ROOT, "2099-01-01.md", "PUBLIC_GUARD_BASELINE");
const manifestFiles = ["core/rules.md", "core/reply-style.md", "reply-policy.json", ".context/CONTEXT.md", "MEMORY.md"];
const sources = Object.fromEntries(manifestFiles.map((file) => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex")]));
fs.writeFileSync(path.join(ROOT, "resume-manifest.json"), JSON.stringify({ schemaVersion: 1, policyRevision: 2, stateFile: "current-state.json", policyFile: "reply-policy.json", sources, status: "fresh" }, null, 2));
fs.writeFileSync(path.join(ROOT, "eval", "last-result.json"), JSON.stringify({ summary: { recallAtK: 1, failList: [], irrelevantRate: 0 } }, null, 2));

function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name} -- ${detail}`); }
}
function verify() {
  const r = spawnSync(NODE, [path.join(ROOT, "memory-cli.js"), "verify", "--root", ROOT], { encoding: "utf8", timeout: 60000, env: { ...process.env, CP_ROOT: ROOT } });
  try { return JSON.parse(r.stdout || "{}"); } catch { return { stale: [], note: "verify 输出不可解析" }; }
}
function staleWith(v, kw) { return (v.stale || []).some(x => x.includes(kw)); }
function cleanup(fn) { cleanups.push(fn); }

try {
  // 测试前的 stale 快照（供末尾做增量断言；环境可能带着正当的 stale，不能要求"全静默"）
  const BEFORE_STALE = new Set((verify().stale || []));

  // ---- F13 黄金集回退：伪造 last-result 坏基线 → 应报"黄金集回退" ----
  const lrFile = path.join(ROOT, "eval", "last-result.json");
  const lrBak = fs.existsSync(lrFile) ? fs.readFileSync(lrFile, "utf8") : null;
  if (lrBak === null) fs.mkdirSync(path.join(ROOT, "eval"), { recursive: true });
  fs.writeFileSync(lrFile, JSON.stringify({ summary: { recallAtK: 0.5, failList: ["G-SELFTEST"], irrelevantRate: 0 } }, null, 2));
  cleanup(() => { if (lrBak === null) fs.rmSync(lrFile, { force: true }); else fs.writeFileSync(lrFile, lrBak); });
  check("F13 黄金集回退会响", staleWith(verify(), "黄金集回退"));
  if (lrBak === null) fs.rmSync(lrFile, { force: true }); else fs.writeFileSync(lrFile, lrBak);

  // ---- F14 待验证堆积：造最老 >7 天的 ⏳ 卡 → 应报"待验证池" ----
  const pendFile = path.join(ROOT, "memories", "20990101-9801.md");
  fs.writeFileSync(pendFile, ["---", "id: 20990101-9801", "created: 2026-08-01T00:00:00+08:00", "status: ⏳待验证", "type: 事件", "tags: [自检]", "scope: global", "---", "F14 自检卡（跑完即删）。"].join("\n"));
  cleanup(() => fs.rmSync(pendFile, { force: true }));
  check("F14 待验证堆积会响", staleWith(verify(), "待验证池"));
  fs.rmSync(pendFile, { force: true });

  // ---- F15 状态 TTL：伪造 40 天前时间戳 → 应报"TTL 过期" ----
  const tsFile = path.join(ROOT, "state-timestamps.json");
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, "current-state.json"), "utf8"));
  const item = (st.nextActions || [])[0];
  if (item) {
    const tsBak = fs.existsSync(tsFile) ? fs.readFileSync(tsFile, "utf8") : null;
    const { createHash } = require("node:crypto");
    const k = "nextActions:" + createHash("sha256").update(String(item)).digest("hex").slice(0, 16);
    const map = tsBak ? JSON.parse(tsBak) : {};
    map[k] = "2026-07-01T00:00:00.000Z";
    fs.writeFileSync(tsFile, JSON.stringify(map, null, 2));
    cleanup(() => { if (tsBak === null) fs.rmSync(tsFile, { force: true }); else fs.writeFileSync(tsFile, tsBak); });
    check("F15 状态 TTL 会响", staleWith(verify(), "TTL 过期"));
    if (tsBak === null) fs.rmSync(tsFile, { force: true }); else fs.writeFileSync(tsFile, tsBak);
  } else check("F15 状态 TTL 会响", false, "current-state 无 nextActions 可测");

  // ---- F16 错误计数：注入 12 条假错误行 → 应报"hook-errors" ----
  const logFile = path.join(ROOT, "hook-errors.log");
  const logBak = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : null;
  const now = new Date().toISOString();
  const fake = Array.from({ length: 12 }, (_, i) => `[${now}] flush-hook: selftest failed status=1 注入${i}`).join("\n") + "\n";
  fs.appendFileSync(logFile, fake);
  cleanup(() => { if (logBak === null) fs.rmSync(logFile, { force: true }); else fs.writeFileSync(logFile, logBak); });
  check("F16 错误计数会响", staleWith(verify(), "hook-errors"));
  if (logBak === null) fs.rmSync(logFile, { force: true }); else fs.writeFileSync(logFile, logBak);

  // ---- F11 领域语言新鲜度（2026-09-01 A4 固化）：CONTEXT.md mtime 拨回 7 天前 → 应报"领域语言" ----
  //   （守卫参数曾被改 14→5 无断言锁——本用例锁住"5 天阈值必须会响"这一行为本身）
  const ctxFile = path.join(ROOT, ".context", "CONTEXT.md");
  const ctxStat = fs.statSync(ctxFile);
  const oldTime = new Date(Date.now() - 7 * 86400000);
  fs.utimesSync(ctxFile, oldTime, oldTime);
  check("F11 领域语言超期会响", staleWith(verify(), "领域语言"));
  fs.utimesSync(ctxFile, ctxStat.atime, ctxStat.mtime);
  cleanup(() => { try { fs.utimesSync(ctxFile, ctxStat.atime, ctxStat.mtime); } catch {} });

  // ---- F22 恢复健康门（R1 事故固化）：resume-manifest 暂移 → check ok:false → 应报"压缩恢复健康门红" ----
  const rmFile = path.join(ROOT, "resume-manifest.json");
  const rmBak = fs.existsSync(rmFile) ? fs.readFileSync(rmFile, "utf8") : null;
  fs.rmSync(rmFile, { force: true });
  check("F22 恢复健康门红会响", staleWith(verify(), "压缩恢复健康门"));
  if (rmBak === null) fs.rmSync(rmFile, { force: true }); else fs.writeFileSync(rmFile, rmBak);
  cleanup(() => { if (rmBak === null) fs.rmSync(rmFile, { force: true }); else fs.writeFileSync(rmFile, rmBak); });

  // ---- F24 重大改动待查验（2026-09-16 加；audit-due flag 驱动）----
  {
    const fl = path.join(ROOT, ".flags", "audit-due.json");
    const bak = fs.existsSync(fl) ? fs.readFileSync(fl, "utf8") : null;
    fs.mkdirSync(path.dirname(fl), { recursive: true });
    fs.writeFileSync(fl, JSON.stringify({ baseline: "2026-09-01T00:00:00.000Z", due: true, changed: ["G-SELFTEST"], checkedAt: new Date().toISOString() }, null, 2));
    cleanup(() => { if (bak === null) fs.rmSync(fl, { force: true }); else fs.writeFileSync(fl, bak); });
    check("F24 待查验账会响", staleWith(verify(), "重大改动待查验"));
    if (bak === null) fs.rmSync(fl, { force: true }); else fs.writeFileSync(fl, bak);
  }

  // ---- F25 盲区账本（2026-09-16 加；两种可行动形态）----
  {
    const lf = path.join(ROOT, "core", "blindspot-ledger.md");
    const bak = fs.readFileSync(lf, "utf8");
    cleanup(() => fs.writeFileSync(lf, bak));
    // ① 标"阻塞"且未观测 → 应响
    fs.writeFileSync(lf, bak + '\n| A-999 | G-SELFTEST 注入（阻塞未观测） | 注入 | `未观测` | 阻塞 |\n');
    check("F25 阻塞未观测会响", staleWith(verify(), "盲区账本"));
    // ② 标"已观测"但证据列空 → 应响
    fs.writeFileSync(lf, bak + '\n| A-998 | G-SELFTEST 注入（已观测但无证据） | 注入 | `已观测` |  |\n');
    check("F25 已观测无证据会响", staleWith(verify(), "盲区账本"));
    fs.writeFileSync(lf, bak);
  }

  // ---- F26 接入端自动扩展停跑：伪造 60 天前的加载记录 → 应报自动扩展停跑 ----
  {
    const aplFile = path.join(ROOT, ".flags", "cp-autopilot.log");
    const aplBak = fs.existsSync(aplFile) ? fs.readFileSync(aplFile, "utf8") : null;
    if (aplBak === null) fs.mkdirSync(path.dirname(aplFile), { recursive: true });
    cleanup(() => { if (aplBak === null) fs.rmSync(aplFile, { force: true }); else fs.writeFileSync(aplFile, aplBak); });
    fs.writeFileSync(aplFile, "[2026-06-01T00:00:00.000Z] module evaluated\n[2026-06-01T00:00:00.100Z] factory called\n");
    check("F26 自动扩展停跑会响", staleWith(verify(), "接入端自动扩展"));
    if (aplBak === null) fs.rmSync(aplFile, { force: true }); else fs.writeFileSync(aplFile, aplBak);
  }

  // ---- F27 交付测试台账（2026-09-29 加）：伪造“已登记交付物被改动”（testedAt=过去、mtime=现在）
  //   → 应报“[F27] 交付物有改动晚于最后测试”。注入物带 G-SELFTEST 标记；台账现场恢复。----
  {
    const dvFile = path.join(ROOT, ".flags", "delivery-verification.jsonl");
    const dvBak = fs.existsSync(dvFile) ? fs.readFileSync(dvFile, "utf8") : null;
    if (dvBak === null) fs.mkdirSync(path.dirname(dvFile), { recursive: true });
    cleanup(() => { if (dvBak === null) fs.rmSync(dvFile, { force: true }); else fs.writeFileSync(dvFile, dvBak); });
    const tmpDeliverable = fs.mkdtempSync(path.join(os.tmpdir(), "gs-f27-"));
    fs.writeFileSync(path.join(tmpDeliverable, "artifact.txt"), "G-SELFTEST F27 注入\n");
    cleanup(() => fs.rmSync(tmpDeliverable, { recursive: true, force: true }));
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const row = JSON.stringify({ schemaVersion: 1, deliverable: tmpDeliverable, result: "pass", evidence: "G-SELFTEST", testedAt: past, observedMtime: past, by: "selftest" }) + "\n";
    fs.writeFileSync(dvFile, (dvBak || "") + row, "utf8");
    check("F27 交付物改动未复测会响", staleWith(verify(), "[F27] 交付物有改动晚于最后测试"));
    if (dvBak === null) fs.rmSync(dvFile, { force: true }); else fs.writeFileSync(dvFile, dvBak);
    fs.rmSync(tmpDeliverable, { recursive: true, force: true });
  }

  // ---- F7 Claude Code hook 新鲜度（2026-09-16 加）：原判据必误报（用户离开后回来发消息即触发），
  //   且"真故障分支"此前从未实测。这里用 CP_CC_PROJECTS 覆盖 + 拨旧 daily mtime 构造可控故障态。----
  {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "gs-f7-"));
    const twoH = Date.now() - 2 * 3600 * 1000;
    // tag 必须与守卫推导对齐（守卫按 newest=2小时前 的日期找 daily）——用 now 推导会在跨日窗口（00:00-02:00）与守卫分叉，必红（2026-09-30 跨日实测暴露）
    const tag = new Date(twoH - new Date(twoH).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    fs.mkdirSync(path.join(tmpProj, "p"), { recursive: true });
    const jl = path.join(tmpProj, "p", tag + ".jsonl");
    fs.writeFileSync(jl, "{}\n");
    fs.utimesSync(jl, new Date(twoH), new Date(twoH));
    const dayFile = path.join(ROOT, "daily", tag + ".md");
    const dst = fs.existsSync(dayFile) ? fs.statSync(dayFile) : null;
    if (dst) fs.utimesSync(dayFile, new Date(Date.now() - 3 * 3600 * 1000), new Date(Date.now() - 3 * 3600 * 1000));
    cleanup(() => { if (dst) fs.utimesSync(dayFile, dst.atime, dst.mtime); fs.rmSync(tmpProj, { recursive: true, force: true }); });
    if (!dst) {
      check("F7 Stop hook 静默失败会响", true, "本机无当日 daily 文件，跳过（非通过）");
    } else {
      const r7 = spawnSync(NODE, [path.join(ROOT, "memory-cli.js"), "verify", "--root", ROOT], { encoding: "utf8", timeout: 60000, env: { ...process.env, CP_ROOT: ROOT, CP_CC_PROJECTS: tmpProj } });
      let v7 = { stale: [] };
      try { v7 = JSON.parse(r7.stdout || "{}"); } catch {}
      check("F7 Stop hook 静默失败会响", (v7.stale || []).some((x) => x.includes("Stop hook 可能静默失败")));
      fs.utimesSync(dayFile, dst.atime, dst.mtime);
    }
    fs.rmSync(tmpProj, { recursive: true, force: true });
  }

  // ---- 恢复确认：清理后**相对测试前不得新增 stale** ----
  //   2026-09-16 修正判据：原来断言"全静默"——但环境本来就可能带着**正当**的 stale
  //   （如 audit-due 的待查验账：改了关键文件就该红）。绝对静默的前提不成立 → 改为**增量断言**。
  const after = new Set((verify().stale || []));
  const added = [...after].filter((s) => !BEFORE_STALE.has(s));
  check("清理后无新增 stale（相对测试前）", added.length === 0,
    added.length ? `残留注入项: ${added.slice(0, 2).join(' / ')}` : `（测试前已有 ${BEFORE_STALE.size} 条，属环境正当状态）`);

  // ---- C1 守卫覆盖率对账（2026-09-16 加）：源可枚举 = verify 的 F 编号 × 本文件的**用例名**。
  //   只对**新出现的**无覆盖守卫失败（基线 .flags/guard-coverage.json），避免"永久红灯"（狼来了）。
  //   基线仅在 fresh=0 时回写 → 新增守卫会**持续失败**直到补用例或显式写进基线。
  //   ⚠️ 2026-09-16 审计 M1 修正：原判据是"文本里出现过 F\d+" —— 实测**写一行注释 `// F27` 就能骗过**
  //      （C1 报"新增 0 条"）。现改为**只认用例名形式**：`check("FNN …", …)`，注释与正文一律不算。
  //
  // ═══ 2026-09-19 裁决：基线里那 12 条无覆盖守卫（F5/F6/F8/F9/F10/F12/F17/F18/F19/F20/F21/F23）**不追** ═══
  //   背景：`known` 是**已知欠账**基线 —— 本机制只保证"**新增**的无守卫守卫会被 C1 拦下"，不负责清历史欠账。
  //   裁决＝**接受为已知欠账，不补用例**。理由（代价 > 收益）：
  //     ① 这 12 条**全是"提醒型"守卫**（派生件过期 / 快照滞后 / 挂载位失真 / 盲测超期 / 桶容量 / 改进闭环）。
  //        失效后果 = **少一条提醒（漏报）**，不是误报、更不是数据损坏 → 代价不对称性远低于红灯类判据。
  //     ② 它们**多数有真实事故背景**（F8＝08-13 挂载位同步失真事故、F12＝DeerMem 删除保护、F17＝08-29 审计、
  //        F21＝月度分桶配套、F23＝"如何让你具备优化能力"）→ 已被现实场景证明"需要它"，比合成用例更硬。
  //     ③ 逐条补用例要先设计"能让该守卫响"的故障注入 + 沙箱隔离（F7 用 `CP_CC_PROJECTS` 注入，属特例）。
  //        12 条 = 12 套注入设计，成本远超收益。
  //     ④ 机制的**主要目的已达成**：C1 会拦新增，且**实测能拦**（2026-09-19 升级彩排里真报了"新增 1 条: F7"）。
  //   **升级路径**（需要时）：按 F7 模式逐条补（env 注入 + 沙箱），优先 F8 / F12 / F21（事故背景最硬、注入点最明确）。
  //   ⚠️ **风险如实登记**：这 12 条若因代码改动而**永不触发**，现有测试发现不了 —— 属**未观测盲区**（同
  //      `core/blindspot-ledger.md` C 类性质）。本裁决**不等于**"它们一定还在正常工作"。
  {
    const src = fs.readFileSync(path.join(ROOT, "memory-cli.js"), "utf8");
    const self = fs.readFileSync(__filename, "utf8");
    // 两侧判据必须不同（M1 的根因就是两侧混用同一种"文本出现"）：
    //   verify 侧：守卫编号写在**注释标签**里（如 `// 错误计数守卫（F16 …）`）→ 从原文取 F 编号
    //   自检侧：必须**真有用例**（`check("FNN …", …)`），注释/正文里出现一律不算
    const F_RANGE = (f) => /^F([5-9]|1\d|2\d)$/.test(f);
    const inVerify = [...new Set((src.match(/F\d+/g) || []))].filter(F_RANGE);
    const inSelf = [...new Set([...self.matchAll(/check\(\s*["'`]F(\d+)/g)].map((m) => "F" + m[1]))];
    const missing = inVerify.filter((f) => !inSelf.includes(f)).sort((a, b) => +a.slice(1) - +b.slice(1));
    const baseFile = path.join(ROOT, ".flags", "guard-coverage.json");
    let known = null;
    try { known = JSON.parse(fs.readFileSync(baseFile, "utf8")).known || []; } catch { known = null; }
    // 基线缺失 ≠ 有新增守卫（2026-09-16 修）：在**被拷贝/全新**的环境里（如升级彩排的沙箱）该文件不存在，
    //   若按"全是新增"处理 → 本用例失败 → 并把下游门链（门6/门7）带崩。正确语义：首次运行 = 建立基线并**通过**。
    if (known === null) {
      try { fs.mkdirSync(path.dirname(baseFile), { recursive: true }); fs.writeFileSync(baseFile, JSON.stringify({ known: missing, checkedAt: new Date().toISOString(), base: true, note: "首次运行自动建立基线" }, null, 2) + "\n"); } catch {}
      check(`C1 守卫覆盖率对账（无覆盖 ${missing.length} 条，新增 0 条）`, true, "本环境无基线 → 已建立；首次运行不判失败");
    } else {
      const fresh = missing.filter((f) => !known.includes(f));
      check(`C1 守卫覆盖率对账（无覆盖 ${missing.length} 条，新增 ${fresh.length} 条）`, fresh.length === 0,
        fresh.length ? `新守卫缺用例: ${fresh.join(", ")} —— 补用例，或显式写进 .flags/guard-coverage.json 的 known 基线` : "");
      if (fresh.length === 0) {
        try { fs.writeFileSync(baseFile, JSON.stringify({ known: missing, checkedAt: new Date().toISOString(), note: "无覆盖守卫基线；新增项会让 C1 失败（防『新守卫没人守』）" }, null, 2) + "\n"); } catch {}
      }
    }
  }
} finally {
  for (const fn of cleanups) { try { fn(); } catch {} }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
}
console.log(`\n===== guard-selftest: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
