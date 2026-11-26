// link-graph.js — 宇宙幻影 · 双向链接层（P0 优化，纯升级、零冲突）
//
// 设计约定（与现有系统兼容）：
//   - 现有纸条已有 `superseded_by: <新id>`（旧→新，单向）。本层补 `supersedes: <旧id>`（新→旧）回指，使链接双向。
//   - 新增可选 `ref:` 字段（实体引用，逗号/空格分隔列表，如 `ref: [person:<USER>, decision:2026-08-13-007]`），做主题聚合。
//   - links.json 是「可重生成的派生索引」，丢了能从纸条 frontmatter 重新算，不依赖外部 DB。
//   - 全部读 frontmatter，不碰 events.db，不影响现有检索（RRF）。
//
// 导出函数（被 memory-cli.js 调用）：
//   backfillSupersedes(root, { dryRun })  -> 给"当前"纸条补 supersedes 回指（幂等）
//   buildLinks(root)                       -> 生成 links.json（双向索引）
//   queryLinks(root, id)                   -> 单节点出入边
//   queryRefs(root, id)                    -> 谁引用/取代了本节点（反向）
//   queryLineage(root, id)                 -> 决策演变全链路
//   queryGraph(root, entity)               -> 含某实体的全部纸条

import fs from "node:fs";
import path from "node:path";
import { listMemoryEntries, mutateEntryById } from "./memory-retrieval.js";

const FM_RE = /^---\n([\s\S]*?)\n---/;

// 解析 frontmatter：返回原始块文本 + 字段对象 + 正文
function parseFrontmatter(text) {
  const m = text.match(FM_RE);
  if (!m) return { fm: "", fields: {}, body: text };
  const fm = m[1];
  const fields = {};
  for (const line of fm.split("\n")) {
    const mm = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (mm) fields[mm[1]] = mm[2].trim();
  }
  return { fm, fields, body: text.slice(m[0].length) };
}

// 在 frontmatter 块中设置/更新一个字段；若无则在结束 `---` 前插入。返回新完整文件文本。
export function setField(text, key, value) {
  const m = text.match(FM_RE);
  if (!m) return text; // 无 frontmatter 不处理
  const fm = m[1];
  const lines = fm.split("\n");
  const idx = lines.findIndex(l => l.match(new RegExp("^" + key + ":")));
  if (idx >= 0) {
    lines[idx] = `${key}: ${value}`;
  } else {
    // 在结束 `---`（最后一个 ---）前插入；fm 不含结束 ---，故直接 push 到块末
    lines.push(`${key}: ${value}`);
  }
  const newFm = lines.join("\n");
  return text.slice(0, m.index) + "---\n" + newFm + "\n---" + text.slice(m.index + m[0].length);
}

function parseIdList(raw) {
  if (!raw) return [];
  return raw.replace(/^\[|\]$/g, "").split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

// 扫描全部纸条（月度分桶：桶条目+遗留单卡统一按条目枚举），建立 id->位置、superseded_by 正向边、ref 列表
function scan(root) {
  const entries = listMemoryEntries(path.join(root, "memories"));
  const idToFile = {};
  const meta = {}; // id -> { superseded_by:[], supersedes:[], ref:[] }
  for (const e of entries) {
    const id = e.id;
    if (!id || idToFile[id]) continue;   // 同 id 重复（迁移残留）首见优先，防节点覆盖
    idToFile[id] = e.file;
    const { fields } = parseFrontmatter(e.raw);
    meta[id] = {
      superseded_by: parseIdList(fields.superseded_by),
      supersedes: parseIdList(fields.supersedes),
      ref: parseIdList(fields.ref),
    };
  }
  return { idToFile, meta, ids: Object.keys(meta) };
}

// 回填 supersedes 回指：对每个有 superseded_by: X 的纸条，确保 X 的 supersedes 含本 id。
export function backfillSupersedes(root, { dryRun = false } = {}) {
  const { meta, ids } = scan(root);
  // 计算需要的反向边：newId -> [oldId...]
  const need = {}; // newId -> Set(oldId)
  for (const id of ids) {
    for (const tg of meta[id].superseded_by) {
      if (!meta[tg]) continue; // 悬空目标跳过（本数据集无，防御性）
      (need[tg] = need[tg] || new Set()).add(id);
    }
  }
  const changed = [];
  let unchanged = 0;
  for (const tg of Object.keys(need)) {
    const have = new Set(meta[tg].supersedes);
    const add = [...need[tg]].filter(x => !have.has(x));
    if (add.length === 0) { unchanged++; continue; }
    const newValue = [...meta[tg].supersedes, ...add].join(", ");
    if (dryRun) {
      changed.push({ id: tg, file: path.basename(String(idToFileOf(root, tg) || "")), added: add, wouldBe: newValue });
      continue;
    }
    const r = mutateEntryById(root, tg, (raw) => setField(raw, "supersedes", newValue));
    if (r.ok) changed.push({ id: tg, file: path.basename(String(r.file || "")), added: add, now: newValue });
  }
  return { dryRun, changed, unchanged, total: ids.length };
}

function idToFileOf(root, id) {
  const e = listMemoryEntries(path.join(root, "memories")).find(x => x.id === id);
  return e ? e.file : null;
}

// 生成 links.json（双向索引，可重生成）
export function buildLinks(root) {
  const { meta, ids } = scan(root);
  const nodes = {};
  // 反向引用：谁 supersedes 了我 / 谁 ref 了我
  const referencedBy = {}; // id -> [ids that supersede it]
  for (const id of ids) {
    for (const tg of meta[id].supersedes) {
      (referencedBy[tg] = referencedBy[tg] || []).push(id);
    }
  }
  for (const id of ids) {
    nodes[id] = {
      superseded_by: meta[id].superseded_by,
      supersedes: meta[id].supersedes,
      ref: meta[id].ref,
      referenced_by: referencedBy[id] || [],
    };
  }
  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    note: "派生索引，可从 memories/*.md frontmatter 重生成（node link-graph.js build）",
    nodes,
  };
  const file = path.join(root, "links.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  const edges = ids.reduce((n, id) => n + nodes[id].superseded_by.length + nodes[id].supersedes.length, 0) / 2;
  return { file, nodes: ids.length, supersedeEdges: edges, refEdges: ids.reduce((n, id) => n + nodes[id].ref.length, 0) };
}

export function queryLinks(root, id) {
  const { meta } = scan(root);
  if (!meta[id]) return { id, found: false };
  return { id, found: true, superseded_by: meta[id].superseded_by, supersedes: meta[id].supersedes, ref: meta[id].ref };
}

export function queryRefs(root, id) {
  const { meta, ids } = scan(root);
  if (!meta[id]) return { id, found: false };
  const refs = ids.filter(o => meta[o].supersedes.includes(id));
  return { id, found: true, referenced_by: refs };
}

// 决策演变全链路（最新→最旧）：从查询 id 沿 superseded_by 走到最新版，再沿 supersedes 回走到最旧
export function queryLineage(root, id) {
  const { meta } = scan(root);
  if (!meta[id]) return { id, found: false };
  // 找最新版：沿 superseded_by（谁取代了我）一直走到没有更新者
  let cur = id;
  while (meta[cur] && meta[cur].superseded_by.length) cur = meta[cur].superseded_by[0];
  const latest = cur;
  // 从最新版沿 supersedes（我取代了谁）往回走 = 最新→最旧
  const chain = [];
  let node = latest;
  while (node && meta[node]) {
    chain.push(node);
    const nxt = meta[node].supersedes[0];
    node = nxt && meta[nxt] ? nxt : null;
  }
  return { id, found: true, latest, chain };
}

// 按实体（ref 值子串）查所有相关纸条
export function queryGraph(root, entity) {
  const { meta, ids } = scan(root);
  const hits = ids.filter(id => meta[id].ref.some(r => r.toLowerCase().includes(entity.toLowerCase())));
  return { entity, found: hits.length, ids: hits };
}
