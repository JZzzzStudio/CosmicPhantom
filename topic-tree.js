// topic-tree.js — T04 表示层（主题树 + 结构摘要，零 LLM）
// 依据：OpenViking 的目录 L0/L1（但用模板拼装，不调用模型）+ Anthropic 的「wiki 位」。
// 纪律：全部派生，可删可重建；不写进任何真源；体积上限 = 语料 30%。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const GENERIC = new Set(["偏好", "事件", "规则", "蒸馏", "决策", "待办", "术语", "需求", "遗留"]);
const eligible = (t) => t && !GENERIC.has(t) && !/^\d{4}-\d{2}-\d{2}-\d{3,}$/.test(t) && Array.from(t).length > 1;

export function tagsOf(meta = {}) {
  const t = meta.tags;
  if (Array.isArray(t)) return t.map(String);
  if (typeof t === "string") return t.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

const rank = (s) => (String(s || "").includes("冲突") ? 3 : String(s || "").includes("当前") ? 2 : String(s || "").includes("计划") ? 1 : 0);

/** 由卡片集合构建树（纯函数） */
export function buildTree(entries) {
  const cards = entries.filter((e) => e && e.meta && e.id);
  const types = new Map();
  for (const e of cards) {
    const type = String(e.meta.type || "未分类");
    if (!types.has(type)) types.set(type, []);
    types.get(type).push(e);
  }
  const nodes = [];
  for (const [type, list] of [...types.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const tagCount = new Map();
    for (const e of list) for (const t of new Set(tagsOf(e.meta).filter(eligible))) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    const domains = [...tagCount.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
    nodes.push({ path: type, level: 1, count: list.length, domains: domains.length, top: list.slice().sort((a, b) => rank(b.meta.status) - rank(a.meta.status)).slice(0, 3).map((e) => String(e.meta.title || e.id).slice(0, 40)) });
    for (const tag of domains) {
      const sub = list.filter((e) => tagsOf(e.meta).includes(tag));
      nodes.push({ path: type + "/" + tag, level: 2, count: sub.length, top: sub.slice().sort((a, b) => rank(b.meta.status) - rank(a.meta.status)).slice(0, 3).map((e) => String(e.meta.title || e.id).slice(0, 40)) });
    }
  }
  const corpusHash = createHash("sha256").update(cards.map((e) => e.id).sort().join(",")).digest("hex").slice(0, 16);
  return { builtAt: new Date().toISOString(), corpusHash, total: cards.length, nodes };
}

/** L0：一行；L1：子域表 + 每域一行指针（模板拼装，无生成式语句） */
export function renderL0(node) {
  return "# " + node.path + "\n\n卡数 " + node.count + (node.domains ? "；子域 " + node.domains + " 个" : "") + "\n\n代表：" + (node.top.join(" / ") || "—") + "\n";
}
export function renderL1(node, children) {
  const L = ["# " + node.path + "（概览）", "", "- 卡数：" + node.count];
  if (children.length) {
    L.push("", "## 子域", "", "| 子域 | 卡数 |", "|---|---|");
    for (const c of children) L.push("| " + c.path.split("/").pop() + " | " + c.count + " |");
  }
  if (node.top && node.top.length) { L.push("", "## 代表条目", ""); for (const t of node.top) L.push("- " + t); }
  return L.join("\n") + "\n";
}

export function writeTree(root, tree) {
  const dir = join(root, "views", "topics");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), JSON.stringify(tree, null, 2) + "\n");
  for (const n of tree.nodes) {
    const p = join(dir, n.path.replace(/\//g, "__"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p + ".L0.md", renderL0(n));
    if (n.level === 1) {
      const children = tree.nodes.filter((x) => x.level === 2 && x.path.startsWith(n.path + "/"));
      writeFileSync(p + ".L1.md", renderL1(n, children));
    }
  }
  return dir;
}

/** 体积守卫：摘要总量 / 语料正文总量 */
export function treeStats(root, entries) {
  const dir = join(root, "views", "topics");
  if (!existsSync(dir)) return { present: false, files: 0, bytes: 0, corpusBytes: 0, ratio: null };
  let bytes = 0, files = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isFile()) { bytes += statSync(p).size; files += 1; }
  }
  const corpusBytes = entries.reduce((n, e) => n + Buffer.byteLength(String(e.raw || "")), 0) || 1;
  return { present: true, files, bytes, corpusBytes, ratio: +(bytes / corpusBytes).toFixed(3) };
}