#!/usr/bin/env node
/**
 * healthcheck.cjs — 迁移健康一键体检（2026-09-30）
 *
 * 用法:  node healthcheck.cjs [--package <迁移包目录>]
 * 输出:  一张体检表 + 一句结论；核心项全绿 exit 0，有红 exit 1。
 *
 * 设计（"开袋即食"验收）:
 *   · migrate.ps1 迁移完成后**自动调用**本脚本并在黑窗口打印结论——用户不用做任何事；
 *   · 也可单独运行（如从 Proma 里让 Agent 跑）——未指定 --package 时自动搜索主包；
 *   · 只读；全部 fail-open（单项异常不中断，如实标注）。
 */
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const HOME = os.homedir();
const CP = arg("--root") || path.join(HOME, ".cosmic-phantom");
const NODE = path.join(CP, "tools", "node", "node.exe");

const rows = [];
const add = (name, status, detail) => rows.push({ name, status, detail }); // status: ok | fail | info

function runNode(script, args) {
  const r = spawnSync(NODE, ["--experimental-sqlite", script, ...args], { encoding: "utf8", timeout: 120000, windowsHide: true });
  let out = null; try { out = JSON.parse((r.stdout || "").trim()); } catch {}
  return out;
}

// ── 定位主包（优先 --package；否则搜 D:/E:/F: 深度 3 的 START.bat，含 AIGC 快捷候选）──
function walkForStartBat(dir, depth, maxDepth) {
  if (depth > maxDepth) return null;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  if (items.some((e) => e.isFile() && e.name.toLowerCase() === "start.bat")) return dir;
  for (const e of items) {
    if (!e.isDirectory()) continue;
    const nm = e.name.toLowerCase();
    if (["windows", "program files", "program files (x86)", "programdata", "users", "$recycle.bin", "system volume information", "perflogs", "recovery", "msys64"].includes(nm)) continue;
    const hit = walkForStartBat(path.join(dir, e.name), depth + 1, maxDepth);
    if (hit) return hit;
  }
  return null;
}
let PKG = arg("--package");
if (PKG && !fs.existsSync(path.join(PKG, "START.bat"))) PKG = null;
if (!PKG) {
  const roots = ["D:\\AIGC", "D:\\", "E:\\AIGC", "E:\\", "F:\\", "C:\\AIGC"];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const hit = walkForStartBat(r, 0, 3);
    if (hit) { PKG = hit; break; }
  }
}

// ── 1) 包完整性 ──
if (PKG) {
  const vp = path.join(PKG, "verify-package.cjs");
  if (fs.existsSync(vp)) {
    const out = runNode(vp, ["--root", PKG, "--json"]);
    if (out) add("包完整性", out.ok === true ? "ok" : "fail", `缺失 ${out.missing} / 不匹配 ${out.mismatch} / 共 ${out.manifestEntries} 条（${PKG}）`);
    else add("包完整性", "fail", "校验器未产出结果（向旧机 Agent 报告）");
  } else add("包完整性", "fail", `包内缺 verify-package.cjs（${PKG}）`);
} else {
  add("包完整性", "info", "未定位到迁移包（可加 --package <包路径> 再看）");
}

// ── 2) CP 库健康 ──
const mc = path.join(CP, "memory-cli.js");
if (fs.existsSync(mc)) {
  const out = runNode(mc, ["verify", "--root", CP]);
  if (out) add("CP 库健康", out.noise === 0 && out.indexDrift === false ? "ok" : "fail", `noise=${out.noise} · indexDrift=${out.indexDrift} · stale ${(out.stale || []).length} 条`);
  else add("CP 库健康", "fail", "verify 未产出结果（向旧机 Agent 报告）");
} else add("CP 库健康", "fail", "缺 memory-cli.js（CP 未就位）");

// ── 3) 恢复门 ──
const rcs = path.join(CP, "resume-context.js");
if (fs.existsSync(rcs)) {
  const out = runNode(rcs, ["check", "--root", CP]);
  if (out) add("恢复门", out.ok === true ? "ok" : "info", `manifest=${out.manifest}${out.ok ? "" : "（首次收尾会自动修复）"}`);
  else add("恢复门", "fail", "check 未产出结果");
} else add("恢复门", "fail", "缺 resume-context.js");

// ── 4) Git 仓库（无 git 属降级设计，不算红）──
const gitCandidates = [path.join(CP, "tools", "git", "cmd", "git.exe")];
let GIT = gitCandidates.find((p) => fs.existsSync(p)) || null;
if (!GIT) {
  const g = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  if (g.status === 0) GIT = "git";
}
if (GIT) {
  const r = spawnSync(GIT, ["-C", CP, "rev-list", "--count", "HEAD"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  const n = (r.stdout || "").trim();
  const st = spawnSync(GIT, ["-C", CP, "status", "--porcelain"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  const dirty = ((st.stdout || "").trim().split("\n").filter(Boolean)).length;
  add("Git 仓库", /^\d+$/.test(n) ? "ok" : "fail", /^\d+$/.test(n) ? `${n} commits · 工作树${dirty ? `有 ${dirty} 项待提交（正常）` : "干净"}` : "仓库读取失败");
} else {
  add("Git 仓库", "info", "未找到 git（降级设计：收尾链会自动跳过快照层）");
}

// ── 5) 关键组件（版本核对：三件定稿哈希 + 扩展四文件在位）──
const EXPECT = {
  [path.join(HOME, ".proma", "sdk-config", "extensions", "cp-autopilot.mjs")]: "6f6b82a34c230f02365ae6991425ca9b256e76057093ddbda3e1704b15b30976",
  [path.join(CP, "change-ledger.cjs")]: "7289852599074250b87ab4451c3aa550a968de2fd4356045843018e56b456650",
  [path.join(CP, "wrap-up.cjs")]: "c142e2e5868dd1a302684b8369453bb01ac9b5233e3f0bbfcdfa001c01c30216",
};
const existOnly = [
  path.join(HOME, ".proma", "sdk-config", "extensions", "reply-guard.mjs"),
  path.join(HOME, ".proma", "sdk-config", "extensions", "sts-guard.mjs"),
  path.join(HOME, ".proma", "sdk-config", "extensions", "thinking-sanitizer.mjs"),
];
let compOk = 0, compBad = [];
for (const [p, want] of Object.entries(EXPECT)) {
  if (!fs.existsSync(p)) { compBad.push(path.basename(p) + "(缺)"); continue; }
  const got = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  if (got === want) compOk++; else compBad.push(path.basename(p) + "(版本不符)");
}
for (const p of existOnly) { if (fs.existsSync(p)) compOk++; else compBad.push(path.basename(p) + "(缺)"); }
add("关键组件", compBad.length === 0 ? "ok" : "fail", compBad.length === 0 ? `6/6 在位且版本正确` : compBad.join("；"));

// ── 6) 扩展加载痕迹（提示级：Proma 首启后自动可确认）──
function lastModuleEval(logPath) {
  try {
    const ls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter((l) => l.includes("module evaluated"));
    return ls[ls.length - 1] || "";
  } catch { return ""; }
}
const apLast = lastModuleEval(path.join(CP, ".flags", "cp-autopilot.log"));
const stsLast = lastModuleEval(path.join(CP, ".flags", "sts-guard.log"));
const now = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const localDate = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
const utcDate = now.toISOString().slice(0, 10);
const todaySeen = (s) => s && (s.includes(localDate) || s.includes(utcDate));
add("扩展加载", "info",
  (todaySeen(apLast) && todaySeen(stsLast)) ? "今日已加载 ✓（cp-autopilot + sts-guard）"
    : `待 Proma 首启后确认（autopilot:${apLast ? "有待" : "无"} / sts:${stsLast ? "有待" : "无"}）`);

// ── 输出 ──
console.log("");
console.log("══════════════════════════════════════════════════");
console.log("  迁移体检 · " + now.toLocaleString("zh-CN", { hour12: false }));
console.log("══════════════════════════════════════════════════");
for (const r of rows) {
  const mark = r.status === "ok" ? "[OK]" : r.status === "fail" ? "[XX]" : "[--]";
  console.log(`  ${mark} ${r.name} — ${r.detail}`);
}
console.log("──────────────────────────────────────────────────");
const fails = rows.filter((r) => r.status === "fail");
const okCount = rows.filter((r) => r.status === "ok").length;
if (!fails.length) {
  console.log(`  结论：✅ 迁移体检通过（${okCount} 项全绿）`);
} else {
  console.log(`  结论：⚠️ 有 ${fails.length} 项需要处理——请把本窗口截图发给旧机 Agent：`);
  for (const f of fails) console.log(`    · ${f.name}：${f.detail}`);
}
console.log("══════════════════════════════════════════════════");

// 落盘（事后可查：黑窗口关了也能翻出来）
try {
  const flagDir = path.join(CP, ".flags");
  fs.mkdirSync(flagDir, { recursive: true });
  fs.writeFileSync(
    path.join(flagDir, "healthcheck-latest.json"),
    JSON.stringify({ at: now.toISOString(), package: PKG || null, rows }, null, 2),
    "utf8"
  );
  console.log("  （结果已存档：.flags\\healthcheck-latest.json）");
} catch {}
process.exit(fails.length ? 1 : 0);
