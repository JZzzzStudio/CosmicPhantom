// lib/graph-edges.js — 语义邻接派生（T03，2026-11-18）
//
// 由来（实测）：links.json 290 节点 / 149 边，其中 121 条是「新卡替代旧卡」、ref 边 0 条、
//   159 张卡孤立 → 这是时间链，不是语义图；扩散没有边可扩散。
//
// 三类边（全部确定性、零 LLM、可重建）：
//   ① 共享标签：w = Σ_t 1/log(2+df(t))     ← 常见标签几乎不产生边
//   ② 同实体：  w = 命中实体数 / 2 × 0.8，上限 0.8
//   ③ 手写引用：w = 1.0（frontmatter ref/supersedes 已有，此处只登记）
// 约束：只留 w ≥ MIN_W；每节点最多 MAX_DEG 条（防枢纽）。
//
// 设计纪律：本文件只产出派生数据；write 到 links.json 的 derived 段，不碰 supersede 真关系。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIN_W = 0.3;
export const MAX_DEG = 12;

const GENERIC_TAGS = new Set(["偏好", "事件", "规则", "蒸馏", "决策", "待办", "术语", "需求", "遗留"]);

/** 卡片标签归一（frontmatter 可能是数组或逗号串） */
export function tagsOf(meta = {}) {
  const t = meta.tags;
  if (Array.isArray(t)) return t.map(String);
  if (typeof t === "string") return t.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function eligible(tag) {
  if (GENERIC_TAGS.has(tag)) return false;
  if (/^\d{4}-\d{2}-\d{2}-\d{3,}$/.test(tag)) return false;  // 日期编号 = 出生证，非语义
  return Array.from(tag).length > 1;
}

export function loadEntities(root) {
  const p = join(root, "core", "entities.json");
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(j.entities) ? j.entities.map((e) => String(e).toLowerCase()) : [];
  } catch { return []; }
}

/**
 * 从卡片集合派生边。
 * @param {{id:string, meta:object, raw:string}[]} docs
 * @param {string[]} entities 受控实体词表（小写）
 * @returns {{edges:Map<string,{to:string,w:number,kind:string}[]>, stats:object}}
 */
export function buildEdges(docs, entities = []) {
  const withId = docs.filter((d) => d.meta && d.meta.id);
  const tagDf = new Map();
  for (const d of withId) for (const t of new Set(tagsOf(d.meta).filter(eligible))) tagDf.set(t, (tagDf.get(t) || 0) + 1);

  const adj = new Map();   // id -> Map(to -> {w, kinds:Set})
  const put = (a, b, w, kind) => {
    if (!a || !b || a === b || w < MIN_W) return;
    if (!adj.has(a)) adj.set(a, new Map());
    if (!adj.has(b)) adj.set(b, new Map());
    const bump = (x, y) => {
      const cur = adj.get(x).get(y) || { w: 0, kinds: new Set() };
      cur.w += w; cur.kinds.add(kind);
      adj.get(x).set(y, cur);
    };
    bump(a, b); bump(b, a);
  };

  // ① 共享标签（按 df 加权）
  const byTag = new Map();
  for (const d of withId) for (const t of new Set(tagsOf(d.meta).filter(eligible))) {
    if (!byTag.has(t)) byTag.set(t, []);
    byTag.get(t).push(d.meta.id);
  }
  for (const [tag, ids] of byTag) {
    const df = tagDf.get(tag) || ids.length;
    const w = 1 / Math.log(2 + df);
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) put(ids[i], ids[j], w, "tag");
  }

  // ② 同实体（受控词表命中）
  if (entities.length) {
    const hits = new Map();   // id -> Set(entity)
    for (const d of withId) {
      const text = String(d.raw || "").toLowerCase();
      const set = new Set();
      for (const e of entities) if (e && text.includes(e)) set.add(e);
      if (set.size) hits.set(d.meta.id, set);
    }
    const ids = [...hits.keys()];
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
      let shared = 0;
      for (const e of hits.get(ids[i])) if (hits.get(ids[j]).has(e)) shared += 1;
      if (shared) put(ids[i], ids[j], Math.min(0.8, (shared / 2) * 0.8), "entity");
    }
  }

  // ③ 手写引用（ref 指向的 id 若存在）
  const known = new Set(withId.map((d) => d.meta.id));
  for (const d of withId) {
    const refs = [].concat(d.meta.ref || [], d.meta.refs || []);
    for (const r of refs) {
      const target = String(r).trim();
      if (known.has(target)) put(d.meta.id, target, 1.0, "ref");
    }
  }

  // 截断：每节点保留权重最高的 MAX_DEG 条
  const edges = new Map();
  let total = 0, weak = 0;
  for (const [id, m] of adj) {
    const list = [...m.entries()].map(([to, v]) => ({ to, w: +v.w.toFixed(3), kind: [...v.kinds].sort().join("+") }))
      .sort((a, b) => b.w - a.w || a.to.localeCompare(b.to));
    weak += Math.max(0, list.length - MAX_DEG);
    edges.set(id, list.slice(0, MAX_DEG));
    total += Math.min(list.length, MAX_DEG);
  }
  const isolated = withId.length - [...edges.keys()].filter((k) => (edges.get(k) || []).length > 0).length;
  const nonSupersede = total;
  return {
    edges,
    stats: {
      nodes: withId.length,
      edges: nonSupersede,
      isolated,
      isolatedRate: withId.length ? +(isolated / withId.length).toFixed(3) : 0,
      truncated: weak,
      entities: entities.length,
      tagsUsed: byTag.size,
    },
  };
}

/** 邻接查询：一跳邻居 id 列表（不带权重） */
export function neighbors(edges, id) {
  return (edges.get(id) || []).map((e) => e.to);
}