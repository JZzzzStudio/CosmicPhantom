#!/usr/bin/env node
/**
 * eval-retrieval.js — 检索黄金集跑分器（P1-1，2026-08-28）
 *
 * 用法：node eval-retrieval.js [--root <r>] [--k 5] [--case G-001,G-002]
 *
 * 指标（0812 对标 P0-P1 建议）：
 *   Recall@K      期望集合命中率（逐题：|命中|/|期望|，宏平均）
 *   MRR           首个期望结果的排名倒数均值
 *   NDCG@K        二元相关度的归一化折损累计增益
 *   无关召回率     期望空题中"top1 仍出结果"的占比（越低越好）
 *   冲突命中率     fold 代表为 🕰️过去 但存在 🟢当前 期望的题数（越低越好）
 *   token 成本代理 逐题 topK snippet 字节量总和均值（量级监控，非精确 token）
 *
 * 检索链与 search 命令同口径：retrieveMemoriesHybrid → 回退 retrieveMemories（fail-open）。
 * 真源只读：本脚本零写入，可随时跑；改库/改检索链后重跑，作为验收门槛。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { retrieveMemories, retrieveMemoriesHybrid } from "../memory-retrieval.js";
import { uniqueBinaryNdcg } from "./retrieval-metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = get("--root") || join(__dirname, "..");
const K = Number(get("--k") || 5);
const BM25_ONLY = args.includes("--bm25-only");
const only = get("--case") ? get("--case").split(",") : null;
const MEMORY_DIR = join(ROOT, "memories");

const setName = get("--set") === "heldout" ? "golden-heldout.json" : get("--set") === "adversarial" ? "golden-adversarial.json" : "golden-set.json";
const gold = JSON.parse(readFileSync(join(__dirname, setName), "utf8"));
let cases = only ? gold.cases.filter(c => only.includes(c.id)) : gold.cases;
// heldout 集：期望为关键词级锚（expect_keyword），命中判定=结果 id/路径/标题/snippet 含任一关键词
for (const c of cases) {
  if (c.expect_keyword) c.expect = Array.isArray(c.expect_keyword) ? c.expect_keyword : [c.expect_keyword];
}

function isMatch(r, exp) {
  if (Array.isArray(exp)) return exp.some(e => isMatch(r, e));
  if (r.id === exp || (r.path || "").includes(exp)) return true;   // 精确 id 锚（golden-set）
  const hay = (String(r.title || "") + " " + String(r.snippet || "")).toLowerCase();
  return hay.includes(String(exp).toLowerCase());                   // 关键词级锚（heldout / adversarial）
}
function hitRank(results, expectIds) {
  // 返回 {firstRank, hitSet}：命中判定 = isMatch（id 精确 / 关键词）
  const hitSet = new Set();
  let firstRank = null;
  results.forEach((r, i) => {
    for (const exp of expectIds) {
      if (isMatch(r, exp)) { hitSet.add(exp); if (firstRank === null) firstRank = i + 1; }
    }
  });
  return { firstRank, hitSet };
}

function ndcgFor(results, expect, k) {
  const matchesByRank = results.slice(0, k).map((r) => expect.filter((exp) => isMatch(r, exp)));
  return uniqueBinaryNdcg(matchesByRank, expect.length, k);
}

async function main() {
  // 期望条目状态映射：conflict 判定需要知道期望是否本身就是 🕰️过去（期望即过去 ≠ 冲突）
  const { loadMemoryDocs } = await import("../memory-retrieval.js");
  const statusById = new Map(loadMemoryDocs(MEMORY_DIR).map(d => [d.meta?.id, d.meta?.status || "🟢当前"]));
  const rows = [];
  for (const c of cases) {
    let result = null, mode = "bm25";
    if (!BM25_ONLY) {
      try { result = await retrieveMemoriesHybrid(c.query, { memoryDir: MEMORY_DIR, top: K }); if (result) mode = "hybrid"; } catch {}
    }
    if (!result) result = retrieveMemories(c.query, { memoryDir: MEMORY_DIR, top: K });
    const results = result.results || [];
    const expect = c.expect || [];
    const { firstRank, hitSet } = hitRank(results, expect);
    const ndcg = ndcgFor(results, expect, K);
    const forbidHit = (c.forbid || []).filter(fid => results.some(r => r.id === fid || (r.path || "").includes(fid)));
    // conflict：期望含 🟢当前 版本，但召回结果里该 topic 的代表是 🕰️过去（该出当前却出了过去）；
    // 期望本身就是过去条目的题（如状态回填考点）不算冲突。
    const expectHasCurrent = expect.some(exp => (statusById.get(exp) || "").includes("当前"));
    const pastRepHit = expectHasCurrent && results.some(r => r.status === "🕰️过去" && expect.some(exp => r.id === exp || (r.path || "").includes(exp)));
    const bytes = results.reduce((s, r) => s + Buffer.byteLength(r.snippet || ""), 0);
    rows.push({
      id: c.id, 考点: c.考点, mode, top1: results[0]?.id || null, top1Score: results[0]?.score ?? 0,
      maxSim: result.maxSim, lowConfidence: result.lowConfidence || undefined,
      recall: expect.length ? +(hitSet.size / expect.length).toFixed(4) : null,
      mrr: firstRank ? +(1 / firstRank).toFixed(4) : 0, ndcg,
      forbidHit: forbidHit.length ? forbidHit : undefined,
      pastRepHit: pastRepHit || undefined,
      strictTop1Pass: c.strict_top1 ? !!(results[0] && isMatch(results[0], expect)) : undefined,
      strictTop3Pass: c.strict_top3 ? results.slice(0, 3).some(r => isMatch(r, expect)) : undefined,
      bytes,
      note: c.note,
    });
  }

  const judged = rows.filter(r => r.recall !== null);
  const irr = rows.filter(r => r.考点 === "无关召回");
  const summary = {
    at: new Date().toISOString(), k: K, cases: rows.length, mode: rows[0]?.mode,
    strategy: BM25_ONLY ? "bm25-only" : "production-default",
    metricVersion: "unique-binary-anchor-v2",
    recallAtK: judged.length ? +(judged.reduce((s, r) => s + r.recall, 0) / judged.length).toFixed(4) : null,
    mrr: judged.length ? +(judged.reduce((s, r) => s + r.mrr, 0) / judged.length).toFixed(4) : null,
    ndcg: judged.filter(r => r.ndcg !== null).length
      ? +(judged.filter(r => r.ndcg !== null).reduce((s, r) => s + r.ndcg, 0) / judged.filter(r => r.ndcg !== null).length).toFixed(4) : null,
    irrelevantRate: irr.length ? +(irr.filter(r => r.top1Score > 0).length / irr.length).toFixed(4) : null,
    conflictHits: rows.filter(r => r.pastRepHit).map(r => r.id),
    strictTop1Pass: rows.filter(r => r.strictTop1Pass === true).length,
    strictTop1Total: rows.filter(r => r.strictTop1Pass !== undefined).length,
    strictTop1Fail: rows.filter(r => r.strictTop1Pass === false).map(r => r.id),
    strictTop3Pass: rows.filter(r => r.strictTop3Pass === true).length,
    strictTop3Total: rows.filter(r => r.strictTop3Pass !== undefined).length,
    strictTop3Fail: rows.filter(r => r.strictTop3Pass === false).map(r => r.id),
    avgBytes: Math.round(rows.reduce((s, r) => s + r.bytes, 0) / rows.length),
    failList: rows.filter(r => (r.recall !== null && r.recall < 1) || r.forbidHit).map(r => r.id),
  };
  const scope = {
    set: get("--set") === "heldout" ? "heldout" : get("--set") === "adversarial" ? "adversarial" : "golden",
    questions: cases.length,
    k: Number(get("--k") || 5),
    note: "仅代表该题集；不可外推为通用记忆能力",
  };
  process.stdout.write(JSON.stringify({ scope, summary, rows }, null, 2) + "\n");
}

main().catch(e => { process.stderr.write(String(e?.stack || e) + "\n"); process.exit(1); });
