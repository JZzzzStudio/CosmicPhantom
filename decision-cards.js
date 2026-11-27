#!/usr/bin/env node
/**
 * decision-cards.js — 决策卡同步器（2026-08-17 实装）
 *
 * 病根（用户 2026-08-17 指出）：daily 是自动管道（Stop hook 逐字落，从不断档），
 * 而 memories 卡是蒸馏/手动管道，8-13~8-16 决策最密集的四天零张卡——决策检索裸奔。
 *
 * 本脚本为决策卡建立"自动管道"：扫 daily/<date>.md 的「⭐👤 用户（决策）」行，
 * 逐行生成对应记忆卡（正文 = 决策原文逐字保真，frontmatter 按现有卡格式），
 * 按内容键幂等（同决策不重复写卡），写前过 validate.js check（密钥拦截等吸收点不绕行）。
 *
 * 用法:
 *   node decision-cards.js [--date YYYY-MM-DD] [--root <根>] [--dry-run]
 *   --date 默认今天；--dry-run 只报告将生成/跳过/失败，不写卡
 * 接入端可以在会话结束时调用（不传 --date = 当天）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listMemoryEntries, topicKey, appendEntry, mutateEntryById } from "./memory-retrieval.js";

const ENGINE_ROOT = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const portableNode = join(ENGINE_ROOT, "tools", "node", process.platform === "win32" ? "node.exe" : "node");
const NODE_BIN = existsSync(portableNode) ? portableNode : process.execPath;
const DRY = process.argv.includes("--dry-run");
const DATE = (process.argv.includes("--date") ? process.argv[process.argv.indexOf("--date") + 1] : new Date().toISOString().slice(0, 10));

const MEM_DIR = join(ROOT, "memories");
const DAILY_DIR = join(ROOT, "daily");
const DAILY = join(ROOT, "daily", `${DATE}.md`);
const SRC_TAG = `daily/${DATE}.md`;

// 行内决策标记（格式见 daily：- **⭐👤 用户（决策）**：原文）
const PAT = /用户（决策）\s*[*:：]+\s*(.+)/;

function parseSessionTs(lines, idx) {
  // 该行上方最近的「## 会话 id（UTC ts）」段头 → 转 +08:00 本地时间字符串
  for (let i = idx - 1; i >= 0; i--) {
    const m = lines[i].match(/^## 会话\s+\S+\s*（(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)）/);
    if (m) {
      const d = new Date(m[1]);
      const local = new Date(d.getTime() + 8 * 3600 * 1000);
      return local.toISOString().slice(0, 19) + "+08:00";
    }
  }
  return null;
}

// 内容键 + 细主题键（2026-09-01 用户拍板"决策卡合并优先"）：
//   命中已有条目（同 topicKey 或正文已含该决策原文）→ 合并追加到既有条目，不再新建卡（治"每句决策词原话都自动落卡"）
function existingIndex() {
  const keys = new Set();
  const byTopic = new Map();
  const bodies = [];
  if (!existsSync(MEM_DIR)) return { keys, byTopic, bodies };
  for (const e of listMemoryEntries(MEM_DIR)) {
    const body = e.raw.replace(/^---[\s\S]*?---/, "").trim();
    keys.add(body.slice(0, 20));
    bodies.push(body);
    const k = topicKey({ meta: e.meta, raw: e.raw, body });
    if (!byTopic.has(k)) byTopic.set(k, []);
    byTopic.get(k).push(e);
  }
  return { keys, byTopic, bodies };
}

function validateFile(file) {
  const args = [join(ENGINE_ROOT, "validate.js"), "check", file, "--skip-ephemeral", "--root", ROOT];   // 决策原文保真优先，豁免吸收点 H 临时性门
  const r = spawnSync(NODE_BIN, args, { encoding: "utf8", timeout: 30000 });
  try { return JSON.parse(r.stdout || "{}"); } catch { return { ok: false, reasons: ["校验器输出不可解析"] }; }
}

function nextSeq(prefix) {
  const used = new Set();
  if (existsSync(MEM_DIR)) {
    for (const f of readdirSync(MEM_DIR)) {
      const m = f.match(new RegExp(`^${prefix}-(\\d{4})\\.md$`));
      if (m) used.add(+m[1]);
    }
  }
  let n = 1; while (used.has(n)) n++;
  used.add(n);
  return String(n).padStart(4, "0");
}

function processDate(date) {
  const daily = join(ROOT, "daily", `${date}.md`);
  if (!existsSync(daily)) return { ok: true, date, generated: [], merged: [], skipped: [], failed: [], note: `daily/${date}.md 不存在（无日志可分）` };
  const lines = readFileSync(daily, "utf8").split("\n");
  const { keys, byTopic, bodies } = existingIndex();
  const generated = [], merged = [], skipped = [], failed = [];
  const prefix = date.replace(/-/g, "");
  const srcTag = `daily/${date}.md`;
  const batchUsed = new Set();   // 批次内已分配序号（含磁盘已占用，撞号自动进位不放弃生成）
  const nextId = () => {
    // P1-6 修复(2026-08-29):id 全库唯一——按条目枚举（桶条目+子目录遗留卡），否则新卡撞历史归档 id
    const usedIds = new Set();
    for (const e of listMemoryEntries(MEM_DIR)) {
      const m = String(e.id || "").match(new RegExp(`^${prefix}-(\\d{4})$`));
      if (m) usedIds.add(+m[1]);
    }
    let n = 1; while (usedIds.has(n) || batchUsed.has(n)) n++;
    batchUsed.add(n);
    return `${prefix}-${String(n).padStart(4, "0")}`;
  };
  lines.forEach((line, idx) => {
    const m = line.match(PAT);
    if (!m) return;
    const content = m[1].trim();
    if (!content) return;
    // 提问/质疑过滤（2026-08-17，events.js 触发词收紧的二次防线）：疑问语气词内容视为提问非决策，
    //   跳过生成（决策宁可少一张，daily 有原文；防"你再认真想想"类指令污染决策卡）
    if (/(？|\?|吗|呢|什么|怎么|哪些|哪项|为何|为什么|如何)/.test(content)) { skipped.push(content.slice(0, 24) + "…（疑似提问/质疑，非决策）"); return; }
    if (keys.has(content.slice(0, 20))) { skipped.push(content.slice(0, 24) + "…（内容已存在）"); return; }
    const created = parseSessionTs(lines, idx) || `${date}T00:00:00+08:00`;
    // 合并优先（2026-09-01 拍板）：同细主题已有条目 → 追加原话进既有卡，不新建（治决策卡碎片化）
    const candKey = topicKey({ meta: { type: "事件" }, raw: content, body: content });
    const sameTopic = (byTopic.get(candKey) || [])[0];
    if (sameTopic && !bodies.some(b => b.includes(content))) {
      if (DRY) { merged.push(`${sameTopic.id} ← ${content.slice(0, 24)}…`); return; }
      const r = mutateEntryById(MEM_DIR, sameTopic.id, (raw) => raw.replace(/\s+$/, "") + `\n（${date} 追加）${content}\n`);
      if (r.ok) { merged.push(`${sameTopic.id} ← ${content.slice(0, 24)}…`); return; }
      failed.push(`${sameTopic.id}: 合并失败`);
      return;
    }
    const id = nextId();
    const card = `---
id: ${id}
created: ${created}
source: ${srcTag}
status: ⏳待验证
type: 事件
tags: [决策, ${date}, 自动同步, 待验证]
scope: workspace
---
${content}
`;
    // 幂等：正文已含该决策原文（跨日重复）则跳过
    if (bodies.some(b => b.includes(content))) { skipped.push(content.slice(0, 24) + "…（已有条目含此原文）"); return; }
    if (DRY) { generated.push(id); return; }
    const tmp = join(MEM_DIR, `.tmp-${id}.md`);
    writeFileSync(tmp, card, "utf8");
    const v = validateFile(tmp);
    if (!v.ok) { rmSync(tmp, { force: true }); failed.push(`${id}: ${(v.reasons || []).join(";")}`); return; }
    rmSync(tmp, { force: true });   // 校验后必删临时文件，防 .tmp-*.md 残留污染统计（2026-08-17 曾留 23 个）
    // 月度分桶（2026-09-01）：写入决策发生月的桶文件（不再一卡一文件）
    appendEntry(MEM_DIR, card, { month: date.slice(0, 7) });
    keys.add(content.slice(0, 20));
    bodies.push(content);
    generated.push(id);
  });
  return { ok: failed.length === 0, date, generated, merged, skipped, failed };
}

function refreshDerivedIndexes() {
  // 写卡后刷新派生索引（2026-08-17）：memory-index（与 add 同源）+ links（relink）+ embed（增量，防 F9/F10 漂移）
  const failed = [];
  const idx = spawnSync(NODE_BIN, [join(ENGINE_ROOT, "memory-cli.js"), "index", "--root", ROOT], { encoding: "utf8", timeout: 60000 });
  if (idx.status !== 0) failed.push("索引刷新失败");
  const rl = spawnSync(NODE_BIN, [join(ENGINE_ROOT, "memory-cli.js"), "relink", "--root", ROOT], { encoding: "utf8", timeout: 60000 });
  if (rl.status !== 0) failed.push("链接图刷新失败");
  const eb = spawnSync(NODE_BIN, [join(ENGINE_ROOT, "embed.js"), "build", "--root", ROOT], { encoding: "utf8", timeout: 300000 });
  if (eb.status !== 0) failed.push("语义索引刷新失败（模型缺失可忽略，纯 BM25 不受影响）");
  return failed;
}

function main() {
  // P1-6：--all 扫全部 daily——非单日接入端摄取历史会话后
  //   调用,决策行散布多天,单日模式会漏;幂等(内容键)保证重跑安全。
  if (process.argv.includes("--all")) {
    // 已蒸馏日期守卫(2026-08-29):≤ manifest.lastRun 的 daily 已由蒸馏档案承载,重复建卡=兄弟卡循环(实测每轮+19 张)
    let lastRunDate = "";
    try { const mf = JSON.parse(readFileSync(join(ROOT, "distilled", "manifest.json"), "utf8")); lastRunDate = String(mf.lastRun || "").slice(0, 10); } catch {}
    const dates = existsSync(DAILY_DIR) ? readdirSync(DAILY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map(f => f.replace(/\.md$/, "")).filter(d => !lastRunDate || d > lastRunDate).sort() : [];
    const results = dates.map(processDate);
    const generated = results.flatMap(r => r.generated);
    const mergedFlat = () => results.flatMap(r => r.merged || []);
    const failed = results.flatMap(r => r.failed);
    const skipped = results.flatMap(r => r.skipped);
    if (!DRY && generated.length) failed.push(...refreshDerivedIndexes());
    out({ ok: failed.length === 0, mode: "all", dates: dates.length, generated, merged: mergedFlat(), skipped: skipped.slice(0, 10), failed, note: DRY ? "dry-run 未写卡" : undefined });
    return;
  }
  const r = processDate(DATE);
  if (!DRY && (r.generated.length || (r.merged || []).length)) r.failed.push(...refreshDerivedIndexes());
  r.ok = r.failed.length === 0;
  out({ ok: r.ok, date: r.date, generated: r.generated, merged: r.merged || [], skipped: (r.skipped || []).slice(0, 10), failed: r.failed, note: DRY ? "dry-run 未写卡" : undefined });
}

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); process.exitCode = obj.ok ? 0 : 1; }

main();