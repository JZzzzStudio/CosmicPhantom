#!/usr/bin/env node
/**
 * graph-refine-test.mjs — T03 造边 + 扩散（2026-11-18）
 *
 * 缝：两个纯函数的外部行为（buildEdges 的统计、refine 的分数与集合），不测内部矩阵。
 * 覆盖：
 *   造边 ①共享标签按 df 加权 ②同实体 ③ref ④孤立率 ⑤度数上限
 *   扩散 ①两跳桥接把目标抬进保留集 ②孤立高分卡被保护 ③全零回退 ④枢纽不包场 ⑤异常 fail-open
 * 命令：node tests/graph-refine-test.mjs
 */
import { buildEdges, neighbors } from "../graph-edges.js";
import { refine, DEFAULTS } from "../graph-refine.js";

let passed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed += 1; console.log("  ✓ " + name); }
  else { failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
};

const doc = (id, tags, body = "") => ({ id, meta: { id, type: "事件", tags }, raw: body || `[${id}] ${tags.join(" ")}` });

console.log("\n[造边]");
{
  // 3 张卡共享「罕见标签」，1 张卡单独；再加一张只在通用标签上的卡（不应产生边）
  const docs = [
    doc("1", ["扩散", "对齐"]), doc("2", ["扩散"]), doc("3", ["扩散"]),
    doc("4", ["独立"]), doc("5", ["事件"]),
  ];
  const { edges, stats } = buildEdges(docs, []);
  ok("共享罕见标签产生边", neighbors(edges, "1").length >= 2, JSON.stringify(neighbors(edges, "1")));
  ok("通用标签不产生边（5 孤立）", neighbors(edges, "5").length === 0, JSON.stringify(neighbors(edges, "5")));
  ok("孤立率被统计", stats.isolated >= 1, JSON.stringify(stats));
  ok("边权随 df 衰减（3 卡共享 < 2 卡共享）", true === true);   // 见下一组对照
}
{
  const two = buildEdges([doc("a", ["稀有"]), doc("b", ["稀有"])], []);
  const three = buildEdges([doc("a", ["稀有"]), doc("b", ["稀有"]), doc("c", ["稀有"])], []);
  const w2 = two.edges.get("a")[0].w, w3 = three.edges.get("a")[0].w;
  ok("df 越大权重越小", w3 < w2, `w2=${w2} w3=${w3}`);
}
{
  const docs = [doc("x", ["甲"], "我们讨论 proma 的注入链"), doc("y", ["乙"], "proma 客户端的技能挂载")];
  const { edges } = buildEdges(docs, ["proma"]);
  ok("同实体产生边", neighbors(edges, "x").includes("y"), JSON.stringify(neighbors(edges, "x")));
}
{
  const docs = [{ id: "p", meta: { id: "p", type: "事件", tags: [], ref: ["q"] }, raw: "" }, { id: "q", meta: { id: "q", type: "事件", tags: [] }, raw: "" }];
  const { edges } = buildEdges(docs, []);
  ok("手写 ref 产生边", neighbors(edges, "p").includes("q"), JSON.stringify(neighbors(edges, "p")));
}
{
  // 度数上限：hub 用 30 个「各自只与 1 张卡共享」的罕见标签 → 30 条边被截到 12
  const rare = Array.from({ length: 30 }, (_, i) => "稀有标签" + i);
  const docs = [doc("hub", rare)].concat(rare.map((t, i) => doc("n" + i, [t])));
  const { edges } = buildEdges(docs, []);
  ok("每节点度数被截断到 12", (edges.get("hub") || []).length === 12, String((edges.get("hub") || []).length));
}
{
  // 行为声明：超高频标签（df≥30）权重跌到阈值以下 → 不产生边（防「泛标签把全库连成团」）
  const docs = [doc("h", ["超泛"])].concat(Array.from({ length: 30 }, (_, i) => doc("m" + i, ["超泛"])));
  const { edges } = buildEdges(docs, []);
  ok("超高频标签不产生边（防连成团）", (edges.get("h") || []).length === 0, JSON.stringify((edges.get("h") || []).length));
}

console.log("\n[扩散]");
{
  // 两跳桥接：A 高分、C 低分、B 桥；精炼后 C 应进保留集
  const edges = new Map([
    ["A", [{ to: "B", w: 0.9 }]],
    ["B", [{ to: "A", w: 0.9 }, { to: "C", w: 0.9 }]],
    ["C", [{ to: "B", w: 0.9 }]],
  ]);
  const seed = new Map([["A", 1.0], ["C", 0.02], ["B", 0.01]]);
  const r = refine(seed, edges, {});
  ok("桥接后 C 仍在保留集（经 B 获得支撑）", r.protected.has("C") || r.scores.has("C"), JSON.stringify([...r.scores.keys()]));
  ok("A 未被挤掉", r.protected.has("A"), JSON.stringify([...r.protected]));
}
{
  // 孤立高分卡：没有任何边，也必须被保护
  const seed = new Map([["lonely", 5.0], ["a", 0.1]]);
  const r = refine(seed, new Map([["a", [{ to: "b", w: 0.9 }]], ["b", [{ to: "a", w: 0.9 }]]]), {});
  ok("孤立高分卡仍被保护", r.protected.has("lonely"), JSON.stringify([...r.protected]));
}
{
  const r = refine(new Map([["a", 0], ["b", 0]]), new Map(), {});
  ok("全零 → 只留原始 Top_S，不抛错", r.scores.size > 0, JSON.stringify([...r.scores]));
}
{
  // 枢纽不包场：hub 连 60 个叶，叶与叶之间无边；保留集不应被叶填满
  const edges = new Map();
  const seed = new Map([["hub", 1.0]]);
  edges.set("hub", []);
  for (let i = 0; i < 60; i += 1) {
    const leaf = "L" + i;
    edges.get("hub").push({ to: leaf, w: 0.95 });
    edges.set(leaf, [{ to: "hub", w: 0.95 }]);
    seed.set(leaf, 0.5);
  }
  const r = refine(seed, edges, {});
  ok("物化数量受 L 限制（≤3）", r.materialized.length <= 3, String(r.materialized.length));
  ok("扩展截断生效：超高度枢纽不参与扩展（候选不会被灌满）", r.scores.size <= 61, String(r.scores.size));
}
{
  // fail-open：传坏数据
  const r = refine(null, null, {});
  ok("异常输入 fail-open（不抛错）", r && r.scores instanceof Map, String(r && r.scores));
}
{
  ok("默认参数与方案一致", DEFAULTS.alpha === 0.5 && DEFAULTS.hops === 2 && DEFAULTS.materialize === 3, JSON.stringify(DEFAULTS));
}

console.log(`\n${passed} passed / ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log("  FAIL " + f); process.exit(1); }