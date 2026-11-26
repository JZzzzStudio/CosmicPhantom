#!/usr/bin/env node
/**
 * ⚠️ **已废弃（2026-09-19 官方关闭）**：本文件属 ZCode 时代的**旧落地通道**（U 盘复制式安装），
 *   生产地位已被继承包路线（`pack-bundle.cjs` + `install-bundle.cjs`）取代。**留档不删，禁止作为现行路径使用**。
 *   关闭登记：本文件位于 `scripts/legacy/`，仅供历史复现。
 *
 * usb-prepare.js — 生成 U 盘全量安装包（2026-08-12；2026-08-13 升级：模型与运行时依赖随包）
 *
 * 用法:
 *   node usb-prepare.js --usb <U盘根目录> [--root <cosmic根>] [--home <用户主目录>]
 *
 * 产出（到 --usb）:
 *   cosmic-phantom/        真源整体拷贝（含隐藏文件；含模型+向量库+node_modules 运行时）
 *   templates/             宿主配置占位符模板（<USER_HOME> 替换点）
 *   install-usb.js         安装脚本（拷到新机执行）
 *   USB-INSTALL-README.md  安装说明（U 盘版，来源历史文档归档）
 *
 * 模板生成原则：从本机现有真实配置生成（占位符化），
 * 保证模板与实测配置一致（防手写模板引入新坑）。
 * 2026-08-13 变更：embedding-db（model.onnx 90MB+vectors.json）与 node_modules（onnxruntime-node
 * 等运行时依赖）改为随包——新机无网无 python 也能 100% 激活语义检索，不再需要"开发机转换脚本"。
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv;
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const USB = get("--usb");
const ROOT = get("--root") || join(homedir(), ".cosmic-phantom");
const HOME = get("--home") || homedir();

if (!USB) { console.error("缺 --usb <U盘根目录>"); process.exit(1); }

const PH = "<USER_HOME>";
const ph = (s) => String(s).split("\\").join("/").split(HOME.split("\\").join("/")).join(PH).split(PH + "/" + PH).join(PH);

// ---------- 1. 拷贝真源（含隐藏文件，排除可重建/临时） ----------
const src = ROOT;
const dst = join(USB, "cosmic-phantom");
rmSync(dst, { recursive: true, force: true });   // 2026-08-13 防残留：全量重建，防上次打包的旧模板/旧文件残留
mkdirSync(dst, { recursive: true });
const EXCLUDE = new Set(["backup", "memory-index.db", "fingerprints.db", ".watch-paused", ".zcode"]);
let copied = 0;
function copyTree(from, to) {
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(ent.name)) continue;
    const s = join(from, ent.name), d = join(to, ent.name);
    if (ent.isDirectory()) { mkdirSync(d, { recursive: true }); copyTree(s, d); }
    else { copyFileSync(s, d); copied++; }
  }
}
// 模板先生成后拷贝（2026-08-17 修复：原顺序"先拷贝后生成模板"——生成写回真源发生在拷贝之后，
// 首次打包时新生成的模板进不了包，缺 9 个；调序后首次即完整）
const T = join(ROOT, "templates");  // 常驻真源（复制真源即带上 U 盘 cosmic-phantom/templates/）
mkdirSync(T, { recursive: true });
// 2026-08-13 防残留：U 盘侧旧模板随 dst 全量重建已清；本机未装宿主时旧模板无法验证，
// 真源侧已删除（宁可缺失不可带病——旧模板曾残留 旧用户名 硬编码路径）。

// 2.1 ZCode：config.json 的 mcp+hooks 段 + 用户级 AGENTS.md
try {
  const zc = JSON.parse(readFileSync(join(HOME, ".zcode", "cli", "config.json"), "utf8"));
  const tmpl = { mcp: zc.mcp, hooks: zc.hooks };
  writeFileSync(join(T, "zcode-config.mcp-hooks.json"), JSON.stringify(tmpl, null, 1).split(HOME.split("\\").join("/")).join(PH));
  copyFileSync(join(HOME, ".zcode", "AGENTS.md"), join(T, "zcode-AGENTS.md"));
  writeFileSync(join(T, "zcode-AGENTS.md"), ph(readFileSync(join(HOME, ".zcode", "AGENTS.md"), "utf8")));
} catch (e) { console.error("ZCode 模板失败:", e.message); }
// 2.2 CodeBuddy：mcp.json + rules 三件
try {
  writeFileSync(join(T, "codebuddy-mcp.json"), ph(readFileSync(join(HOME, ".codebuddy", "mcp.json"), "utf8")));
  writeFileSync(join(T, "codebuddy-memory.md"), ph(readFileSync(join(HOME, ".codebuddy", "rules", "memory.md"), "utf8")));
  writeFileSync(join(T, "codebuddy-memory.mdc"), ph(readFileSync(join(HOME, ".codebuddy", "rules", "memory.mdc"), "utf8")));
  writeFileSync(join(T, "codebuddy-CODEBUDDY.md"), ph(readFileSync(join(HOME, ".codebuddy", "CODEBUDDY.md"), "utf8")));
} catch (e) { console.error("CodeBuddy 模板失败:", e.message); }
// 2.3 Proma：工作区 mcp.json（servers 格式！）
try {
  writeFileSync(join(T, "proma-mcp.json"), ph(readFileSync(join(HOME, ".proma", "agent-workspaces", "workspace-1786420913794", "mcp.json"), "utf8")));
} catch (e) { console.error("Proma 模板失败:", e.message); }
// 2.4 WorkBuddy：无点 mcp.json + 身份三件套
try {
  writeFileSync(join(T, "workbuddy-mcp.json"), ph(readFileSync(join(HOME, ".workbuddy", "mcp.json"), "utf8")));
  writeFileSync(join(T, "workbuddy-SOUL.md"), ph(readFileSync(join(HOME, ".workbuddy", "SOUL.md"), "utf8")));
  writeFileSync(join(T, "workbuddy-IDENTITY.md"), ph(readFileSync(join(HOME, ".workbuddy", "IDENTITY.md"), "utf8")));
  writeFileSync(join(T, "workbuddy-USER.md"), ph(readFileSync(join(HOME, ".workbuddy", "USER.md"), "utf8")));
} catch (e) { console.error("WorkBuddy 模板失败:", e.message); }
// 2.5 skills 挂载模板（ZCode 用户级）
try {
  mkdirSync(join(T, "zcode-skills"), { recursive: true });
  copyFileSync(join(HOME, ".zcode", "skills", "distill-conversation", "SKILL.md"), join(T, "zcode-skills", "distill-conversation.SKILL.md"));
  copyFileSync(join(HOME, ".zcode", "skills", "compression-recovery", "SKILL.md"), join(T, "zcode-skills", "compression-recovery.SKILL.md"));
} catch (e) { console.error("skills 模板失败:", e.message); }

copyTree(src, dst);
// 排除项说明：backup/ 为镜像留档（新机可重建）；memory-index.db/fingerprints.db 可重建（非真源）；
// .watch-paused 暂停标记不拷（新机默认不暂停；watcher 链已废弃，弹窗治理随包带灭灯器）；
// .zcode 为 ZCode 会话数据（plans 等），绝不跨机（2026-08-13 补，与 upgrade-prepare 一致）。
// 2026-08-13 起 embedding-db（model.onnx/vectors.json）与 node_modules（onnxruntime-node）随包。

// ---------- 1.5 路径占位符化（拷贝后替换，防新机残留 旧用户名 硬编码） ----------
const phSrc = (s) => String(s).split("\\").join("/").split(HOME.split("\\").join("/")).join(PH);
for (const f of ["sources.json", "project-root.json", "AGENTS.md"]) {
  const p = join(dst, f);
  if (existsSync(p)) {
    const t = readFileSync(p, "utf8");
    if (t.includes("旧用户名") || t.includes(HOME.split("\\").join("/"))) {
      writeFileSync(p, phSrc(t), "utf8");
      console.log(`占位符化: ${f}`);
    }
  }
}

// ---------- 3. 拷安装脚本 + 安装说明 ----------
const SCRIPT_SRC = join(ROOT, "scripts", "legacy", "packaging", "install-usb.js");
if (existsSync(SCRIPT_SRC)) copyFileSync(SCRIPT_SRC, join(USB, "install-usb.js"));
const README_SRC = join(ROOT, "docs", "legacy", "USB-INSTALL-BOOTSTRAP.txt");
if (existsSync(README_SRC)) copyFileSync(README_SRC, join(USB, "USB-INSTALL-README.md"));
const REPORT_SRC = join(ROOT, "docs", "legacy", "VALIDATION.md");
if (existsSync(REPORT_SRC)) copyFileSync(REPORT_SRC, join(USB, "USB-FULL-DELIVERY-REPORT.md"));
const PASTE_SRC = join(ROOT, "docs", "legacy", "USB-PASTE-TO-HOST.txt");
if (existsSync(PASTE_SRC)) copyFileSync(PASTE_SRC, join(USB, "USB-PASTE-TO-HOST.txt"));

// ---------- 4. 统计 ----------
const sizeMB = (dir) => { let n = 0; const w = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) w(p); else n += statSync(p).size; } }; w(dir); return (n / 1048576).toFixed(1); };
process.stdout.write(JSON.stringify({ usb: USB, cosmicPhantom: `${sizeMB(dst)}MB (${copied} 文件)`, templates: readdirSync(T).length, templatesList: readdirSync(T), done: true }) + "\n");
