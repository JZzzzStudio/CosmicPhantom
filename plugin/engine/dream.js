// dream.js — T12 离线反思第一版（只读，不改写真源）
// 三合一里先落"报告"这一步：缺 situation / 作用域分布 / 重复组 / 无证据卡。
// 纪律：本文件只读；任何写入留给后续 propose-only 版本。events 永远不碰。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listMemoryEntries, topicKey } from "./memory-retrieval.js";

const SCOPES = ["global", "workspace", "agent", "pair"];

export function planReview(root, opts = {}) {
  const memDir = join(root, "memories");
  const entries = existsSync(memDir) ? listMemoryEntries(memDir) : [];
  const scopeDist = Object.fromEntries(SCOPES.map((s) => [s, 0]));
  const missingSituation = [];
  const noEvidence = [];
  const byTopic = new Map();

  for (const e of entries) {
    const meta = e.meta || {};
    const scope = String(meta.scope || "global");
    scopeDist[scope in scopeDist ? scope : "other"] = (scopeDist[scope in scopeDist ? scope : "other"] || 0) + 1;
    if (!meta.situation && !/^situation:/m.test(String(e.raw || ""))) missingSituation.push(e.id);
    const hasEvidence = meta.source || meta.evidence || meta.sourceFlow || /^source:|^evidence:/m.test(String(e.raw || ""));
    if (!hasEvidence) noEvidence.push(e.id);
    const k = topicKey({ meta, raw: e.raw });
    if (!byTopic.has(k)) byTopic.set(k, []);
    byTopic.get(k).push(e.id);
  }
  const duplicateGroups = [...byTopic.entries()].filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, ids, n: ids.length }))
    .sort((a, b) => b.n - a.n);

  // workspace 卡 id 清单（propose 的 scope-review 提案要用；2026-11-19 修：此前只算计数没收集 id）
  const scopeReviewIds = entries.filter((e) => String(e.meta?.scope || "global") === "workspace").map((e) => e.id);
  const total = entries.length;
  return {
    at: new Date().toISOString(),
    root,
    total,
    scopeDist,
    missingSituation: { n: missingSituation.length, ids: missingSituation.slice(0, 20) },
    noEvidence: { n: noEvidence.length, ids: noEvidence.slice(0, 20) },
    duplicateGroups: { n: duplicateGroups.length, top: duplicateGroups.slice(0, 5) },
    scopeReviewIds,
    hint: "本版只报告；重分档与合并走后续 propose-only（--apply），events 永不改写",
  };
}

// 第二版（T12 v2）：propose-only —— 只产提案，不改真源。
// 依据 dsh-memu-memory：普通矛盾不注入只挂起；分档与合并必须可审可拒。
export function proposePlan(root, plan) {
  const ops = [];
  for (const id of plan.missingSituation.ids) ops.push({ op: "set-situation", id, why: "缺适用条件：没有 situation 的 lesson 检索匹配不上任务", needs: "人工补一句「何时适用」" });
  for (const g of plan.duplicateGroups.top) {
    const [keep, ...rest] = g.ids;
    if (rest.length) ops.push({ op: "merge-candidate", keep, merge: rest, topic: g.key, why: "同 topicKey 多卡，疑似同一事实的多个版本" });
  }
  for (const [scope, n] of Object.entries(plan.scopeDist)) {
    if (scope === "workspace" && n > 0) ops.push({ op: "scope-review", scope, n, ids: (plan.scopeReviewIds || []).slice(0, 50), why: "workspace 档在单机单宿主下等价于全局；接第二宿主前应改 agent 档", needs: "确认后由 --accept 分批改档" });
  }
  return { at: new Date().toISOString(), root, dryRun: true, ops, count: ops.length, note: "提案不改任何真源；逐条审阅后由人工或 --accept 执行" };
}

export function renderReport(plan) {
  const L = [];
  L.push("# dream 报告 " + plan.at.slice(0, 10));
  L.push("");
  L.push("> 只读审查：不改写任何真源。根：" + plan.root);
  L.push("");
  L.push("## 总量");
  L.push("");
  L.push("- 卡片：" + plan.total);
  L.push("- 作用域分布：" + JSON.stringify(plan.scopeDist));
  L.push("");
  L.push("## 四类问题");
  L.push("");
  L.push("| 类 | 数量 | 样例 |");
  L.push("|---|---|---|");
  L.push("| 缺 situation（无适用条件） | " + plan.missingSituation.n + " | " + (plan.missingSituation.ids.slice(0, 6).join(", ") || "—") + " |");
  L.push("| 无证据（无 source/evidence） | " + plan.noEvidence.n + " | " + (plan.noEvidence.ids.slice(0, 6).join(", ") || "—") + " |");
  L.push("| 重复组（同 topicKey 多卡） | " + plan.duplicateGroups.n + " | " + (plan.duplicateGroups.top.map((g) => g.ids.slice(0, 3).join("/")).slice(0, 3).join(" · ") || "—") + " |");
  L.push("");
  L.push("## 说明");
  L.push("");
  L.push(plan.hint);
  return L.join("\n") + "\n";
}

// 第三版（T12 v3）：逐条接受。只允许"有明确目标值"的操作，其余一律拒绝（不做猜测性写入）。
// 判据：任何一次接受都必须能回退（改前内容原文留在 pro/dream-*.md 的提案文件与 git 里）。
export function acceptOp(root, op, opts = {}) {
  const bucketFile = join(root, "memories");
  const refusals = {
    "merge-candidate": "合并需人工判断保留哪条与如何并正文；本命令拒绝自动合并",
  };
  if (!op) return { ok: false, error: "空提案" };
  if (refusals[op.op]) return { ok: false, refused: op.op, reason: refusals[op.op] };
  if (op.op === "set-situation") {
    const text = String(opts.situation || "").trim();
    if (!text) return { ok: false, refused: op.op, reason: "缺 --situation 文本（不允许自动编造适用条件）" };
    return { ok: true, op: op.op, id: op.id, situation: text, note: "由调用方写入卡片 frontmatter" };
  }
  if (op.op === "scope-review") {
    const to = String(opts.to || "").trim();
    if (!["agent", "global", "workspace"].includes(to)) return { ok: false, refused: op.op, reason: "缺 --to agent|global|workspace（作用域迁移必须显式指定目标）" };
    return { ok: true, op: op.op, to, ids: (op.ids || []).slice(0, 50), note: "由调用方改写这些卡的 scope" };
  }
  return { ok: false, refused: op.op, reason: "未知操作类型" };
}

export function writeReport(root, plan) {
  const dir = join(root, "pro");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, "dream-" + plan.at.slice(0, 10) + ".md");
  const body = renderReport(plan);
  const prev = existsSync(file) ? "" : "";
  writeFileSync(file, prev + body, "utf8");
  return file;
}