// tag-normalize.js — T05 标签归一（2026-11-19）
// 现状：297 张卡 / 175 种标签（比率 0.59），标签已退化成自由文本。
// 纪律：不自动改历史卡；先给归一映射与体检数字，改历史走 dream 的 propose-only。
// F54 采用「棘轮」而不是绝对阈值：记基线，比率只许降不许升 —— 否则今天就得红。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function loadAlias(root) {
  const p = join(root, "core", "tag-alias.json");
  try { const j = JSON.parse(readFileSync(p, "utf8")); return j.canonical || {}; } catch { return {}; }
}

export function tagsOf(meta = {}) {
  const t = meta.tags;
  if (Array.isArray(t)) return t.map(String);
  if (typeof t === "string") return t.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

const norm = (s) => String(s || "").trim().toLowerCase().replace(/[\s_]+/g, "");

/** 归一到规范名；未登记的保持原样（不猜） */
export function canonicalTag(tag, alias) {
  const key = norm(tag);
  for (const [canon, list] of Object.entries(alias || {})) {
    if (norm(canon) === key) return canon;
    if (Array.isArray(list) && list.some((a) => norm(a) === key)) return canon;
  }
  return String(tag || "").trim();
}

/** 体检：种类/卡数比率 + 未登记标签前 N 名 */
export function tagReport(entries, alias) {
  const counts = new Map();
  let cards = 0;
  for (const e of entries) {
    const ts = tagsOf(e.meta || {});
    if (!ts.length) continue;
    cards += 1;
    for (const t of ts) counts.set(String(t).trim(), (counts.get(String(t).trim()) || 0) + 1);
  }
  const kinds = counts.size;
  const unregistered = [...counts.entries()]
    .filter(([t]) => canonicalTag(t, alias) === t)
    .filter(([, n]) => n === 1)
    .map(([t]) => t);
  return {
    cards, kinds,
    ratio: cards ? +(kinds / cards).toFixed(3) : 0,
    singletonTags: unregistered.length,
    top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => t + "(" + n + ")"),
  };
}

export function readBaseline(root) {
  const p = join(root, "tags-baseline.json");
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function writeBaseline(root, report) {
  const p = join(root, "tags-baseline.json");
  writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2) + "\n");
  return p;
}
