#!/usr/bin/env node
/**
 * ⚠️ **已废弃（2026-09-19 官方关闭）**：本文件属 ZCode 时代的**旧升级通道**（全量覆盖模式），
 *   生产地位已被继承包路线取代。**留档不删，禁止作为现行路径使用**。关闭登记：本文件位于 `scripts/legacy/`，仅供历史复现。
 *
 * upgrade-prepare.js — 生成"已装机全量覆盖升级包"（2026-08-13）
 *
 * 与 usb-prepare.js（全新机落地）的区别：
 *   - 数据层随包（用户裁决：本机数据覆盖目标机——目标机停摆于 2026-08-13 凌晨，无新增丢失）
 *   - 不做占位符化（两台机器用户名同为 Administrator，路径天然一致）
 *   - 不生成宿主配置模板（目标机已装 ZCode，config.json 保留它自己的；MCP/hooks 今天未变）
 *   - 排除：backup/、memory-index.db、fingerprints.db（目标机 maintain 重建）、.watch-paused、
 *     .zcode（ZCode 会话数据，绝不跨机）
 *
 * 用法:
 *   node upgrade-prepare.js --out <升级包目录> [--root <cosmic根>]
 *
 * 产出:
 *   cosmic-phantom/                        全量真源（含数据+模型+运行时）
 *   UPGRADE-ACTIONS-<YYYYMMDD>.json         逐文件 SHA256 + action 分类（日期动态，2026-08-17 修）
 *   TARGET-MACHINE-UPGRADE-INSTRUCTIONS.md 粘贴给目标机 Agent 的执行指令
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const args = process.argv;
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const OUT = get("--out");
const ROOT = get("--root") || join(homedir(), ".cosmic-phantom");
if (!OUT) { console.error("缺 --out <升级包目录>"); process.exit(1); }

const EXCLUDE = new Set(["backup", "memory-index.db", "fingerprints.db", ".watch-paused", ".zcode"]);
const dst = join(OUT, "cosmic-phantom");
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
let files = 0;
function copyTree(from, to) {
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(ent.name)) continue;
    const s = join(from, ent.name), d = join(to, ent.name);
    if (ent.isDirectory()) { mkdirSync(d, { recursive: true }); copyTree(s, d); }
    else { copyFileSync(s, d); files++; }
  }
}
copyTree(ROOT, dst);

// ---- 逐文件清单（SHA256 + action 分类）----
const DATA_PREFIXES = ["events.db", "current-state.json", "daily/", "memories/", "candidates/", "distilled/"];
const KEEP_LOCAL_NAMES = new Set(["project-root.json", "sources.json"]);
const actions = [];
function walk(p) {
  for (const ent of readdirSync(p, { withFileTypes: true })) {
    const s = join(p, ent.name);
    const rel = relative(dst, s).split("\\").join("/");
    if (ent.isDirectory()) { walk(s); continue; }
    let action = "overwrite";
    if (DATA_PREFIXES.some((pf) => rel === pf || rel.startsWith(pf))) action = "overwrite-data";
    else if (KEEP_LOCAL_NAMES.has(rel)) action = "merge-local";
    actions.push({ path: rel, action, bytes: statSync(s).size, sha256: sha256(s) });
  }
}
walk(dst);

// ---- 动态元数据（2026-08-17 修：原写死 2026-08-13B/59→72，今天的包会自称旧包误导目标机）----
const TODAY = new Date().toISOString().slice(0, 10);
let CUR_REV = null;
try { CUR_REV = JSON.parse(readFileSync(join(ROOT, "current-state.json"), "utf8")).revision ?? null; } catch {}
const REV_TEXT = CUR_REV != null ? `rev${CUR_REV}` : "当前状态";

const manifest = {
  schemaVersion: 1,
  title: `Cosmic Phantom 已装机全量覆盖升级包（${TODAY}，${REV_TEXT}）`,
  generatedAt: new Date().toISOString(),
  sourceMachine: { hostname: process.env.COMPUTERNAME || "A108", root: ROOT },
  revisionRange: { to: CUR_REV, note: `本包含至 ${REV_TEXT} 全部成果与数据层（生成时状态；目标机若落后于本 rev，覆盖零丢失需用户确认）` },
  files: actions.length,
  totalBytes: actions.reduce((s, a) => s + a.bytes, 0),
  actions,
  syncPolicy: {
    overwrite: "代码/测试/模板/文档/模型/运行时——直接覆盖目标机同路径",
    overwriteData: "events.db/current-state.json/daily/memories/distilled——用户裁决本机数据覆盖目标机（目标机凌晨后无新增）",
    mergeLocal: "sources.json/project-root.json——目标机落地后按实测更新机器段；sources.json 自动禁用缺失源",
    keepLocal: "目标机 .zcode/cli/config.json（宿主已装，路径同为 Administrator，MCP/hooks 未变，无需动）",
    regenerateLocally: "memory-index.db/fingerprints.db/backup/vectors.json 索引与镜像——目标机 maintain 重建",
    neverCopy: ".zcode 会话数据、.watch-paused"
  }
};
writeFileSync(join(OUT, `UPGRADE-ACTIONS-${TODAY.replace(/-/g, "")}.json`), JSON.stringify(manifest, null, 2) + "\n", "utf8");

// ---- 指令文档 ----
const insSrc = join(ROOT, "docs", "legacy", "UPGRADE-GUIDE.md");
if (existsSync(insSrc)) copyFileSync(insSrc, join(OUT, "TARGET-MACHINE-UPGRADE-INSTRUCTIONS.md"));

const sizeMB = (actions.reduce((s, a) => s + a.bytes, 0) / 1048576).toFixed(1);
process.stdout.write(JSON.stringify({ out: OUT, files, sizeMB: `${sizeMB}MB`, manifestEntries: actions.length, done: true }) + "\n");
