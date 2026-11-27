#!/usr/bin/env node
/**
 * sync-reply-policy.mjs — reply-policy 单源三件套之"生成器"(2026-08-29 实装,源:reverse-skill 经验)。
 *
 * 单源:reply-policy.json(rules 13 条 + forbidden 禁用词)是唯一事实源。
 * 派生物:各宿主注入文件的「回复门禁」段(<!-- reply-policy:start/end --> 标记包裹,幂等替换)。
 * 守卫:verify F20 逐条比对派生物与单源,漂移即 stale(本脚本先跑则永不漂移;直接手改注入文件会被 F20 抓)。
 *
 * 2026-09-15 B2 修复:支持多宿主目标（hosts.json 声明或 --agents 显式传入）。
 *   现改为多目标(HOST_TARGETS),--agents 可多次传入以覆盖默认列表。
 *   背景:Claude Code 于 2026-09-15 升为主宿主,门禁段必须自动跟随真源。
 *
 * 用法: node sync-reply-policy.mjs [--root <根>] [--agents <文件>]... [--dry-run]
 * 调用链: update-snapshot.js 尾部自动调 —— 该调用点 2026-09-15 前因 ESM require bug(B1) 从未生效。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv;
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = arg("--root") || join(homedir(), ".cosmic-phantom");
const DRY = argv.includes("--dry-run");
const POLICY = join(ROOT, "reply-policy.json");
const START = "<!-- reply-policy:start (AUTO-GENERATED, 真源 reply-policy.json, 手改会被 F20 抓) -->";
const END = "<!-- reply-policy:end -->";

// 宿主注入位——从 hosts.json 读取（单一真源，2026-09-15 立）。
// 此前为硬编码数组，与 skills-sync.js 的宿主清单分叉；现两处共用同一份注册表，新增宿主只改 hosts.json。
// 筛选：有 agentFile 且未除名。目标文件不存在则记 skipped，不算失败。
function loadHostTargets() {
  try {
    const raw = readFileSync(join(ROOT, "hosts.json"), "utf8").replace(/^\uFEFF/, "");
    const hosts = (JSON.parse(raw).hosts || []).filter((h) => h.agentFile && h.role !== "retired");
    if (hosts.length) return hosts.map((h) => ({ host: h.name, file: join(homedir(), h.agentFile) }));
  } catch { /* 注册表不可用 → 无声明目标，可见跳过，不隐式探测宿主目录 */ }
  return [];
}

// --agents 可多次传入；未传则用默认列表
function resolveTargets() {
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agents" && argv[i + 1]) files.push(argv[i + 1]);
  }
  if (!files.length) return loadHostTargets();
  return files.map((f) => ({ host: "explicit", file: f }));
}

function buildSection(policy) {
  const rules = (policy.rules || []).map((r, i) => `${i + 1}. ${r}`).join("\n");
  const forbidden = (policy.forbidden || []).join(" / ");
  return `${START}\n\n## 回复门禁 ${rules.split("\n").length} 条（本段由 reply-policy.json 自动生成，逐条遵守；手改无效，改请改真源后跑 sync-reply-policy）\n\n${rules}\n\n**禁用词（出现即违规）**：${forbidden}\n\n${END}`;
}

function syncOne(target, section) {
  const { host, file } = target;
  if (!existsSync(file)) return { host, file, skipped: "文件不存在" };
  let doc = readFileSync(file, "utf8");
  const s = doc.indexOf(START), e = doc.indexOf(END);
  if (s >= 0 && e > s) {
    const before = doc.slice(s, e + END.length);
    if (before === section) return { host, file, action: "in-sync" };
    if (!DRY) writeFileSync(file, doc.slice(0, s) + section + doc.slice(e + END.length), "utf8");
    return { host, file, action: "updated", driftFixed: true, dryRun: DRY, oldLen: before.length, newLen: section.length };
  }
  // 首次：老段落（手工版）整体替换为标记段
  const headRe = /## 回复门禁 [\d]+ 条（本文件随会话自动注入[\s\S]*?\*\*禁用词（出现即违规）\*\*：[^\n]*\n/;
  if (!headRe.test(doc)) return { host, file, error: "未找到既有门禁段也无法定位插入点" };
  if (!DRY) writeFileSync(file, doc.replace(headRe, section + "\n"), "utf8");
  return { host, file, action: "migrated", dryRun: DRY };
}

function main() {
  if (!existsSync(POLICY)) { console.log(JSON.stringify({ error: "reply-policy.json 缺失" })); process.exit(1); }
  const policy = JSON.parse(readFileSync(POLICY, "utf8"));
  const section = buildSection(policy);
  const results = resolveTargets().map((t) => syncOne(t, section));
  const errors = results.filter((r) => r.error);
  console.log(JSON.stringify({ ok: errors.length === 0, rules: (policy.rules || []).length, targets: results }));
  process.exit(errors.length ? 1 : 0);
}
main();
