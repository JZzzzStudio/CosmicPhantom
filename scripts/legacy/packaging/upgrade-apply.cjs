#!/usr/bin/env node
/**
 * ⚠️ **已废弃（2026-09-19 官方关闭）**：本文件属 ZCode 时代的**旧升级通道**（"十门链"），生产地位已被继承包路线
 *   （`pack-bundle.cjs` + `install-bundle.cjs`）取代。其彩排测试 `tests/upgrade-rehearsal-test.js` 已随链判废。
 *   **留档不删，但禁止作为现行路径使用**。关闭登记：本文件位于 `scripts/legacy/`，仅供历史复现。
 *
 * upgrade-apply.cjs — CP 无痛升级·顺序锁死防偷懒执行器（2026-09-01 用户拍板实装）
 *
 * 防偷懒原理：10 门顺序锁死、每门内置验证断言、无 skip 开关、失败即停并给修复指引；
 *   数据层（events.db 逐字 / daily / current-state.json / pro / distilled）全程不动 = 无痛；
 *   memories 旧形态（一卡一文件）自动迁桶（幂等，原文件进 backup）；
 *   全门绿 = 实装完成的唯一判定，不接受口头声称。
 *
 * 宿主耦合门（8/9/10）：当 --root ≠ 本机注册根（彩排/异地演练）时降级为 ⏭️ 显式跳过并注明，
 *   真机升级（root=宿主注册根）时为硬门——跳过必须可见，不允许静默。
 *
 * 用法（目标机）:
 *   cd <升级包目录>
 *   node --experimental-sqlite upgrade-apply.cjs --root <目标CP根>
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { homedir } = require("node:os");

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const PKG = process.cwd();
const CODE = path.join(PKG, "code");
const ROOT = path.resolve(arg("--root") || path.join(homedir(), ".cosmic-phantom"));
if (!fs.existsSync(CODE)) { console.error("❌ 请在升级包根目录运行（找不到 code/）；cd 到包目录后重跑"); process.exit(1); }
const ONHOST = ROOT === path.resolve(path.join(homedir(), ".cosmic-phantom"));
const NODE_BIN = fs.existsSync(path.join(ROOT, "tools", "node", "node.exe")) ? path.join(ROOT, "tools", "node", "node.exe") : process.execPath;
const cli = ["--experimental-sqlite"];   // 目标机 tools/node 为 CP 便携 v24（flag 原生支持）；process.execPath 兜底场景若 node 过旧会在 events 门显式报错
const SUITES = ["identity-card-test", "continuity-recovery-test", "retrieval-golden-test", "hybrid-retrieval-test", "zcode-flush-test", "flush-reminder-test", "session-adapter-test", "wb-adapter-test", "verify-handoff-test", "recovery-test", "continuity-test", "sandbox-test", "regression-test", "watch-d18-test", "guard-selftest", "expand-test", "bucket-test"];
const needSqlite = new Set(["zcode-flush-test", "flush-reminder-test", "session-adapter-test", "verify-handoff-test", "regression-test", "watch-d18-test", "expand-test", "bucket-test"]);
const fail = (msg) => { console.error("❌ " + msg); process.exit(1); };

console.log("🚀 CP 无痛升级开始（源码/契约为主覆盖；数据/状态目标机保留；memories 自动迁桶）");
console.log("   包=" + PKG + "  目标根=" + ROOT + (ONHOST ? "（宿主注册根：硬门模式）" : "（彩排模式：门8-10 宿主耦合门显式跳过）"));

// 门0 预检
if (!fs.existsSync(path.join(ROOT, "package.json"))) fail("门0 目标根不是 CP（缺 package.json）——全新机请走 install-usb 流程");
const manifest = JSON.parse(fs.readFileSync(path.join(CODE, "..", "manifest.json"), "utf8"));
console.log("✅ 门0 预检 — 包与目标根形态正确，覆盖清单 " + Object.keys(manifest.files).length + " 文件");

// 门1 备份（强制，无开关）
const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const bk = path.join(ROOT, "backup", "pre-upgrade-" + ts);
fs.mkdirSync(bk, { recursive: true });
const PRESERVE = ["events.db", "daily", "memories", "current-state.json", ".context", "reply-policy.json", "resume-manifest.json", "core", "MEMORY.md", "memory-index.db", "links.json"];
let bkCount = 0;
function cpy(src, dst) {
  if (!fs.existsSync(src)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) { for (const name of fs.readdirSync(src)) cpy(path.join(src, name), path.join(dst, name)); }
  else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); bkCount++; }
}
for (const p of PRESERVE) cpy(path.join(ROOT, p), path.join(bk, p));
if (bkCount < 3) fail("门1 备份文件数异常（" + bkCount + "）——中止，先人工核查");
console.log("✅ 门1 备份 — " + bkCount + " 文件 → backup/pre-upgrade-" + ts + "（回滚=整目录还原）");

// 门2 代码覆盖 + sha256 对账（数据层不在清单内，物理不可能被覆盖）
let covered = 0; const mismatch = [];
for (const [rel, meta] of Object.entries(manifest.files)) {
  const dst = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(CODE, rel), dst);
  covered++;
  if (createHash("sha256").update(fs.readFileSync(dst)).digest("hex") !== meta.sha256) mismatch.push(rel);
}
if (covered !== Object.keys(manifest.files).length || mismatch.length) fail("门2 覆盖对账失败 covered=" + covered + " mismatch=" + mismatch.join(","));
console.log("✅ 门2 代码覆盖 — " + covered + " 文件 sha256 全对账（数据层未动）");

// 门3 语法门
const chkFail = [];
for (const rel of Object.keys(manifest.files)) {
  if (!/\.(js|cjs|mjs)$/.test(rel)) continue;
  const r = spawnSync(NODE_BIN, ["--check", path.join(ROOT, rel)], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) chkFail.push(rel + ":" + String(r.stderr).slice(0, 120));
}
if (chkFail.length) fail("门3 语法门失败：\n" + chkFail.join("\n"));
console.log("✅ 门3 语法门 — 全部覆盖件 --check 通过");

// 门4 memories 形态：flat 卡 > 0 → 自动迁桶（幂等）；条目对账前后一致
const memDir = path.join(ROOT, "memories");
const flatBefore = fs.existsSync(memDir) ? fs.readdirSync(memDir, { recursive: true }).filter(f => String(f).endsWith(".md") && /^\d{8}-/.test(path.basename(String(f)))).length : 0;
const st0 = JSON.parse(spawnSync(NODE_BIN, [...cli, path.join(ROOT, "memory-cli.js"), "stats", "--root", ROOT], { encoding: "utf8", timeout: 120000 }).stdout || "{}");
if (flatBefore > 0) {
  const mg = spawnSync(NODE_BIN, [...cli, path.join(ROOT, "scripts", "packaging", "migrate-monthly.js"), "--apply", "--root", ROOT], { encoding: "utf8", timeout: 300000 });
  if (mg.status !== 0) fail("门4 迁移失败：" + String(mg.stderr).slice(0, 300));
  console.log("✅ 门4a memories 迁桶 — flat 卡 " + flatBefore + " 张已入月桶（原文件在 backup/memories-flat-*）");
} else {
  console.log("✅ 门4a memories 已是桶形态/无 flat 卡 — 跳过迁移（幂等安全）");
}

// 门4b 全量查重合并（2026-09-01 用户拍板"全量不是局部"）：memories id 并集 + CONTEXT 术语并集 + 档案并集
const dataDir = path.join(PKG, "data");
const parseBlocks = (text) => String(text || "").split(/^\s*§{3,}\s*$/m).map(b => b.replace(/^\s*\n/, "").replace(/\s+$/, "")).filter(b => b.trim());
const metaId = (b) => (b.match(/^id:\s*(\S+)/m) || [])[1];
function collectIds(dir) {
  const ids = new Set();
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const rel = String(f);
    if (!rel.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    if (/^\d{4}-\d{2}\.md$/.test(path.basename(rel))) { for (const b of parseBlocks(text)) { if (b.startsWith("---")) { const id = metaId(b); if (id) ids.add(id); } } }
    else { const id = (text.match(/^id:\s*(\S+)/m) || [])[1]; if (id) ids.add(id); }
  }
  return ids;
}
const targetIds = collectIds(memDir);
let mergedCards = 0; const cardConflicts = [];
const srcMemDir = path.join(dataDir, "memories");
if (fs.existsSync(srcMemDir)) {
  for (const mf of fs.readdirSync(srcMemDir).filter(f => /^\d{4}-\d{2}\.md$/.test(f))) {
    for (const b of parseBlocks(fs.readFileSync(path.join(srcMemDir, mf), "utf8"))) {
      if (!b.startsWith("---")) continue;
      const id = metaId(b);
      if (!id) continue;
      if (targetIds.has(id)) {
        // 同 id：以源机进度为主覆盖前，先确认内容是否真有分歧（一致则零操作）
        const cur = findCardText(memDir, id);
        if (cur && cur.replace(/\s+/g, "") !== b.replace(/\s+/g, "")) cardConflicts.push(id);
        continue;
      }
      const month = id.slice(0, 4) + "-" + id.slice(4, 6);
      const bucketFile = path.join(memDir, month + ".md");
      const prev = fs.existsSync(bucketFile) ? fs.readFileSync(bucketFile, "utf8") : "# " + month + " 记忆桶\n\n§§§\n";
      fs.writeFileSync(bucketFile, prev.replace(/\s+$/, "") + "\n\n§§§\n\n" + b + "\n\n§§§\n", "utf8");
      targetIds.add(id); mergedCards++;
    }
  }
}
function findCardText(dir, id) {
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const rel = String(f);
    if (!rel.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    if (/^\d{4}-\d{2}\.md$/.test(path.basename(rel))) { for (const b of parseBlocks(text)) { if (b.startsWith("---") && metaId(b) === id) return b; } }
    else if ((text.match(/^id:\s*(\S+)/m) || [])[1] === id) return text;
  }
  return null;
}
if (cardConflicts.length) console.log("  ⚠️ 同 id 内容分歧（以源机进度为准，对方原版在门1 备份）：", cardConflicts.join(","));

// CONTEXT 术语合并：源机定义优先，对方独有术语保留追加（查重防丢）
let ctxAdded = 0;
const ctxTarget = path.join(ROOT, ".context", "CONTEXT.md");
const ctxSrcBak = path.join(bk, ".context", "CONTEXT.md");
if (fs.existsSync(ctxTarget) && fs.existsSync(ctxSrcBak)) {
  const parseTerms = (text) => {
    const blocks = {}; let cur = null;
    for (const line of text.split("\n")) {
      const m = line.match(/^- 术语：(.+)$/);
      if (m) { cur = m[1].trim().replace(/（.*$/, ""); blocks[cur] = (blocks[cur] || "") + line + "\n"; continue; }
      if (cur && /^ /.test(line)) { blocks[cur] += line + "\n"; continue; }
      cur = null;
    }
    return blocks;
  };
  const tgt = fs.readFileSync(ctxTarget, "utf8");
  const srcTerms = parseTerms(fs.readFileSync(path.join(CODE, ".context", "CONTEXT.md"), "utf8"));
  const oldTerms = parseTerms(fs.readFileSync(ctxSrcBak, "utf8"));
  const keep = [];
  for (const [name, block] of Object.entries(oldTerms)) if (!srcTerms[name]) keep.push(block);
  if (keep.length) { fs.writeFileSync(ctxTarget, tgt.replace(/\s+$/, "") + "\n\n## 术语（目标机独有，合并保留）\n\n" + keep.join("\n") + "\n"); ctxAdded = keep.length; }
}
console.log("✅ 门4b memories 查重合并 — 源机新增 " + mergedCards + " 张（同 id 分歧 " + cardConflicts.length + "），目标机独有术语保留 " + ctxAdded + " 条");
const st1 = JSON.parse(spawnSync(NODE_BIN, [...cli, path.join(ROOT, "memory-cli.js"), "stats", "--root", ROOT], { encoding: "utf8", timeout: 120000 }).stdout || "{}");
if (!st1.total || st1.total !== st0.total + mergedCards) fail("门4b 条目对账失败：原 " + st0.total + " + 合并 " + mergedCards + " ≠ 现有 " + st1.total);
console.log("✅ 门4c 条目对账 — " + st0.total + " + " + mergedCards + " = " + st1.total);

// 门4d events 逐字合并（instance 天然隔离 + 内容查重）→ 重投影补全 daily（日志补漏由单一真源管道完成，不做文件级双写）
let imported = 0, dupSkipped = 0;
const evJsonl = path.join(dataDir, "events-export.jsonl");
const evCount0 = (function () { try { const { DatabaseSync: D } = require("node:sqlite"); const db = new D(path.join(ROOT, "events.db"), { readOnly: true }); const c = db.prepare("SELECT COUNT(*) c FROM events").get().c; db.close(); return c; } catch { return 0; } })();
if (fs.existsSync(evJsonl)) {
  const { DatabaseSync: D } = require("node:sqlite");
  // 目标机无 events.db（全新逐字层）→ 先经 events.js 自举建表（openDb 内含 CREATE TABLE IF NOT EXISTS）
  if (!fs.existsSync(path.join(ROOT, "events.db"))) spawnSync(NODE_BIN, [...cli, path.join(ROOT, "events.js"), "status", "--root", ROOT], { encoding: "utf8", timeout: 60000 });
  const db = new D(path.join(ROOT, "events.db"));
  const ins = db.prepare("INSERT OR IGNORE INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive, src_host) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const dup = db.prepare("SELECT COUNT(*) c FROM events WHERE role = ? AND ts = ? AND content IS ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const line of fs.readFileSync(evJsonl, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line);
      if (dup.get(r.role, r.ts, r.content ?? null).c > 0) { dupSkipped++; continue; }
      let info = ins.run(r.instance, r.mid, r.session, r.role, r.content ?? null, r.tool_name ?? null, r.tool_calls ?? null, r.ts, r.sensitive ?? 0, r.src_host ?? null);
      if (Number(info.changes) === 0) {
        // (instance,mid) 撞车但内容不同 → 重映射 mid 再插（保留 instance 归因，杜绝静默丢事件——2026-09-01 彩排实证）
        const mx = db.prepare("SELECT COALESCE(MAX(mid),0) m FROM events WHERE instance = ?").get(r.instance).m;
        info = ins.run(r.instance, mx + 1, r.session, r.role, r.content ?? null, r.tool_name ?? null, r.tool_calls ?? null, r.ts, r.sensitive ?? 0, r.src_host ?? null);
      }
      if (Number(info.changes) === 1) imported++;
    }
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} fail("门4d events 合并失败：" + e.message); }
  db.close();
  // 重投影：合并进来的源机事件自动补投影到目标 daily（日志补漏走单一真源管道）
  spawnSync(NODE_BIN, [...cli, path.join(ROOT, "events.js"), "project", "--root", ROOT], { encoding: "utf8", timeout: 300000 });
}
console.log("✅ 门4d events 合并重投影 — 导入 " + imported + "（内容重复跳过 " + dupSkipped + "），逐字基线 " + evCount0 + "→" + (evCount0 + imported));
const evCount1 = (function () { try { const { DatabaseSync: D } = require("node:sqlite"); const db = new D(path.join(ROOT, "events.db"), { readOnly: true }); const c = db.prepare("SELECT COUNT(*) c FROM events").get().c; db.close(); return c; } catch { return 0; } })();
if (evCount1 !== evCount0 + imported) fail("门4d events 对账失败：" + evCount0 + "+" + imported + " ≠ " + evCount1);

// 门4e 档案并集（distilled/pro/topics：目标机缺的补入，同名不同内容保留双方版本）
let archAdded = 0; const archKept = [];
for (const d of ["distilled", "pro", "topics"]) {
  const s = path.join(dataDir, d);
  if (!fs.existsSync(s)) continue;
  for (const rel of (function walk(dir) { const o = []; if (!fs.existsSync(dir)) return o; for (const ent of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, ent.name); if (ent.isDirectory()) o.push(...walk(p)); else o.push(p); } return o; })(s)) {
    const relPath = path.relative(s, rel);
    const dst = path.join(ROOT, d, relPath);
    if (fs.existsSync(dst)) { const a = createHash("sha256").update(fs.readFileSync(dst)).digest("hex"), b = createHash("sha256").update(fs.readFileSync(rel)).digest("hex"); if (a !== b) { const alt = dst.replace(/(\.[^.]*)?$/, ".from-source$1"); fs.mkdirSync(path.dirname(alt), { recursive: true }); fs.copyFileSync(rel, alt); archKept.push(path.relative(ROOT, alt)); } continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(rel, dst); archAdded++;
  }
}
console.log("✅ 门4e 档案并集 — 补入 " + archAdded + "（同名分歧双版本保留 " + archKept.length + "）");

// 门5 派生索引 + verify 硬门
spawnSync(NODE_BIN, [...cli, path.join(ROOT, "memory-cli.js"), "index", "--root", ROOT], { encoding: "utf8", timeout: 600000 });
spawnSync(NODE_BIN, [...cli, path.join(ROOT, "memory-cli.js"), "relink", "--root", ROOT], { encoding: "utf8", timeout: 600000 });
spawnSync(NODE_BIN, [...cli, path.join(ROOT, "embed.js"), "build", "--root", ROOT], { encoding: "utf8", timeout: 600000 });
const vr = JSON.parse(spawnSync(NODE_BIN, [...cli, path.join(ROOT, "memory-cli.js"), "verify", "--root", ROOT], { encoding: "utf8", timeout: 120000 }).stdout || "{}");
if (vr.noise !== 0 || vr.indexDrift !== false) fail("门5 verify 硬门失败：noise=" + vr.noise + " drift=" + vr.indexDrift);
console.log("✅ 门5 派生索引 + verify — total=" + vr.total + " noise=0 drift=false");

// 门6 守卫会响（7/7 硬门）
const gs = spawnSync(NODE_BIN, [...cli, path.join(ROOT, "tests", "guard-selftest.js")], { encoding: "utf8", timeout: 600000 });
if (!/7 passed \/ 0 failed/.test(gs.stdout || "")) fail("门6 守卫自检失败：" + String(gs.stdout).slice(-260));
console.log("✅ 门6 守卫自检 — 7/7（F11/F13/F14/F15/F16/F22 都会响）");

// 门7 全量测试（17 套，0 failed 硬门）
for (const t of SUITES) {
  const args = (needSqlite.has(t) ? ["--experimental-sqlite"] : []);
  const r = spawnSync(NODE_BIN, [...args, path.join(ROOT, "tests", t + ".js")], { encoding: "utf8", timeout: 600000 });
  const tail = (String(r.stdout || "").trim().split("\n").pop() || "").slice(0, 80);
  // 套件契约：失败 exit 1、成功 exit 0（各套 summary 行格式不一，exit code 是唯一权威判定）
  if (r.status !== 0) {
    const failLines = String(r.stdout || "").split("\n").filter(l => l.includes("[FAIL]")).slice(0, 3).join(" | ");
    fail("门7 测试 " + t + " 失败（exit " + r.status + "）：tail=" + tail + " | FAIL行: " + failLines + " | stderr头: " + String(r.stderr || "").slice(0, 250));
  }
  console.log("  ✅ " + t + " — " + tail.replace(/=====/g, "").trim());
}
console.log("✅ 门7 全量测试 — " + SUITES.length + " 套全绿");

// 门8-10：宿主耦合门（真机硬门；彩排/异地根显式跳过并注明）
if (!ONHOST) {
  console.log("⏭️ 门8/9/10 宿主耦合门（hook 链/install-check/wrap-up）— 目标根≠宿主注册根（彩排模式）显式跳过；真机升级时为硬门");
} else {
  const hs = spawnSync(NODE_BIN, [...cli, path.join(ROOT, "hook-smoke.cjs"), "--deep", "--root", ROOT], { encoding: "utf8", timeout: 600000 });
  if (!/"ok":true/.test(hs.stdout || "")) fail("门8 hook 链失败（核对宿主 config.json 三事件注册）：" + String(hs.stderr).slice(0, 200));
  console.log("✅ 门8 hook 链 — deep 全真链路 ok");
  const ic = spawnSync(NODE_BIN, [...cli, path.join(ROOT, "scripts", "packaging", "install-check.js"), "--live", "--root", ROOT], { encoding: "utf8", timeout: 600000 });
  if ((ic.stdout || "").split('"ok": false').length - 1 > 0) fail("门9 install-check 有失败项（核对目标机 CP_INSTALL_EXEMPT 配置）");
  console.log("✅ 门9 install-check live — 全绿");
  const wu = spawnSync(NODE_BIN, [...cli, path.join(ROOT, "wrap-up.cjs"), "--skip-state", "--root", ROOT], { encoding: "utf8", timeout: 600000 });
  if (wu.status !== 0 || !String(wu.stdout).includes("全链通过")) fail("门10 wrap-up 六步失败");
  console.log("✅ 门10 wrap-up 六步 — 全链通过（change-ledger 已归因入 git）");
}
console.log("🎉 无痛升级完成：代码/契约=源机进度；数据/状态=目标机保留；memories=桶形态。全门绿=实装完成。");
