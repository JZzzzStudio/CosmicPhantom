#!/usr/bin/env node
/**
 * ⚠️ **已废弃（2026-09-19 官方关闭）**：本文件属 ZCode 时代的**旧升级通道**，生产地位已被继承包路线取代。
 *   **留档不删，但禁止作为现行路径使用**。关闭登记：本文件位于 `scripts/legacy/`，仅供历史复现。
 *
 * upgrade-export.cjs — 无痛升级包导出器（2026-09-01 实装，用户拍板"以源机进度为主的无痛升级"）
 *
 * 与 upgrade-prepare.js（全量覆盖模式：数据层随包）的分工：
 *   - upgrade-prepare.js：目标机数据停摆/放弃时的全量覆盖升级
 *   - upgrade-export.cjs（本脚本）：目标机数据保留的"无痛升级"——只覆盖 代码/契约/技能/测试/黄金集/桶迁移器，
 *     数据层（events.db 逐字 / daily / memories / current-state.json / pro / distilled / topics / backup）保留目标机；
 *     memories 旧形态（一卡一文件）由包内 migrate-monthly.js 在目标机就地迁桶（幂等，原文件进 backup）
 *
 * 导出包结构：
 *   <out>/code/            覆盖层（源码+契约+测试+技能+运行时 tools/）
 *   <out>/upgrade-apply.cjs 顺序锁死防偷懒执行器（10 门，无 skip，失败即停）
 *   <out>/UPGRADE-GUIDE.md   升级说明（含分歧处理表）
 *   <out>/manifest.json      逐文件 SHA256（覆盖后对账用）
 *
 * 用法:
 *   node upgrade-export.cjs --out <包目录> [--root <cosmic根>]
 */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { homedir } = require("node:os");

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg("--root") || homedir().replace(/\\/g, "/") + "/.cosmic-phantom";
const OUT = arg("--out");
if (!OUT) { console.error("用法: node upgrade-export.cjs --out <包目录> [--root <根>]"); process.exit(1); }

// 覆盖层：代码 + 契约 + 技能 + 测试 + 黄金集 + 运行时（数据层绝不入包 = 无痛保证）
const CODE_FILES = [
  "arrival-check.js", "change-ledger.cjs", "compaction-inject.cjs", "current-state.js", "decision-cards.js",
  "embed-tokenizer.js", "embed.js", "events.js", "flush-reminder.cjs", "hook-smoke.cjs", "identity-card.js",
  "inject-config.js", "inject.js", "scripts/packaging/install-check.js", "scripts/legacy/packaging/install-usb.js", "link-graph.js", "log_turn.js",
  "memory-cli.js", "memory-retrieval.js", "scripts/packaging/migrate-monthly.js", "scripts/legacy/hermes/poll-state.js", "scripts/legacy/hermes/poll-transcript.js",
  "reply-check.js", "resume-context.js", "session-adapter.js", "skills-sync.js", "task-card-gate.cjs",
  "update-snapshot.js", "scripts/legacy/packaging/upgrade-prepare.js", "scripts/legacy/packaging/usb-prepare.js", "validate.js", "wrap-up.cjs", "scripts/legacy/packaging/upgrade-export.cjs",
  "reply-policy.json", "inject.config.json", "MEMORY.md", "package.json",
  ".context/CONTEXT.md",
];
const CODE_DIRS = ["tests", "skills", "core", "resources", "eval", "views", "tools"];
// 目标机数据层白名单（升级时保留 = 门1 备份 + 门2 覆盖跳过）
const PRESERVE = ["events.db", "events.db-shm", "events.db-wal", "daily", "memories", "current-state.json",
  "backup", "distilled", "topics", "pro", "state-timestamps.json", "coverage-history.json",
  "project-root.json", ".watch-paused", "history", "archive", "node_modules", "fingerprints.db"];

function walk(dir, base) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

function sha256(p) { return createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

if (!OUT) process.exit(1);
const codeDir = path.join(OUT, "code");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(codeDir, { recursive: true });

const manifest = { exportedAt: new Date().toISOString(), mode: "painless", root: ROOT, files: {} };
let count = 0;
function put(rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) return;
  const dst = path.join(codeDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  manifest.files[rel.replace(/\\/g, "/")] = { sha256: sha256(dst), bytes: fs.statSync(dst).size };
  count++;
}
for (const f of CODE_FILES) put(f);
for (const d of CODE_DIRS) {
  for (const rel of walk(path.join(ROOT, d), ROOT)) {
    if (rel.includes("node_modules")) continue;
    put(rel);   // walk 已返回相对 ROOT 的路径（含目录前缀），不可再拼 d（2026-09-01 首跑踩坑：tests/tests 双前缀静默丢文件）
  }
}
// 覆盖层自我保护：migrate-monthly.js 若漏拷则门4 无法执行（双保险：显式再放一份）
put("scripts/packaging/migrate-monthly.js");

// 覆盖清单落盘（门2 sha256 对账依据；首跑曾漏写此文件致 apply 门0 即崩——彩排实测暴露）
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

// ---- 数据层导出（全量查重补漏用，2026-09-01 用户拍板"全量不是局部"）----
// 源机数据进包但不进 code/（不参与门2 覆盖）；目标机 apply 时做查重合并：
//   memories 桶条目按 id 并集、CONTEXT 按术语名并集（源机定义优先）、events 逐字 jsonl 合并（instance 天然隔离）后重投影。
const dataDir = path.join(OUT, "data");
fs.mkdirSync(dataDir, { recursive: true });
let dataCount = 0;
const DATA_DIRS = ["memories", "distilled", "pro", "topics"];
for (const d of DATA_DIRS) {
  for (const rel of walk(path.join(ROOT, d), ROOT)) {
    const src = path.join(ROOT, rel);
    const dst = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    dataCount++;
  }
}
// events 逐字全量（真源导出，目标机按 (instance,mid) 天然隔离合并 + (role,ts,content) 内容查重）
const { DatabaseSync: DBS } = require("node:sqlite");
const evDb = new DBS(path.join(ROOT, "events.db"), { readOnly: true });
const rows = evDb.prepare("SELECT instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive, src_host FROM events ORDER BY id").all();
evDb.close();
const jsonlPath = path.join(dataDir, "events-export.jsonl");
fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
dataCount++;
console.log(JSON.stringify({ ok: true, out: OUT, codeFiles: count, dataFiles: dataCount, eventsExported: rows.length }, null, 2));

fs.copyFileSync(path.join(__dirname, "upgrade-apply.cjs"), path.join(OUT, "upgrade-apply.cjs"));   // master 在根目录（单实现：改这里=改所有未来导出）
fs.copyFileSync(path.join(ROOT, "docs", "legacy", "UPGRADE-GUIDE.md"), path.join(OUT, "UPGRADE-GUIDE.md"));

console.log(JSON.stringify({ ok: true, out: OUT, files: count, apply: true, guide: true, note: "无痛模式：数据层未入包" }, null, 2));
