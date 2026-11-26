#!/usr/bin/env node
// abstain-test.mjs — T06 弃权判定（2026-11-18）
// 缝：retrieveMemories 的 verdict 与结果数量。覆盖：强命中=answerable / 并列=low_coverage 仍返回结果（2026-11-19 校准）/ abstain:false 回退 / 空库=no_evidence
import { retrieveMemories } from "../memory-retrieval.js";
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? " — " + d : ""))); };
const mk = (id, text, title) => ({ path: "p" + id, raw: "[" + title + "] " + text, body: text, tokens: Array.from(text), meta: { id: "c" + id, title, status: "🟢当前", type: "事件", tags: [] } });
const filler = Array.from({ length: 60 }, (_, i) => mk(i, "无关内容" + i, "卡" + i));
const strong = mk(99, "扩散图精炼语义边实现说明", "扩散实现");
const weak = mk(98, "扩散图精炼语义边实现说明", "弱命中A");
const weakB = mk(97, "扩散图精炼语义边实现说明", "弱命中B");   // 与 weak 同文 → 分数并列

let r = retrieveMemories("扩散 图精炼", { docs: [...filler, strong], top: 5, memoryDir: ".", abstain: true });
ok("强命中 → answerable 且有结果", r.verdict === "answerable" && r.results.length > 0, JSON.stringify({ v: r.verdict, n: r.results.length }));

r = retrieveMemories("扩散 图精炼", { docs: [...filler, weak, weakB], top: 5, memoryDir: ".", abstain: true });
// 2026-11-19 校准（票 16）：low_coverage 是“首名优势小”，不是“没有证据”，仍返回结果；只有 no_evidence 才清空。
//   依据：G-003/H-05/H-08 三道高分查询曾被误杀。
ok("并列歧义 → low_coverage 但保留结果", r.verdict === "low_coverage" && r.results.length > 0, JSON.stringify({ v: r.verdict, n: r.results.length }));
ok("  给 nearest 主题提示", Array.isArray(r.nearest) && r.nearest.length > 0, JSON.stringify(r.nearest));

const off = retrieveMemories("扩散 图精炼", { docs: [...filler, weak, weakB], top: 5, memoryDir: ".", abstain: false });
ok("abstain:false → 不再清空结果（旧行为）", off.verdict === "low_coverage", JSON.stringify({ v: off.verdict, n: off.results.length }));

r = retrieveMemories("扩散", { docs: [], top: 5, memoryDir: ".", abstain: true });
ok("空库 → no_evidence 且不抛错", r.verdict === "no_evidence" && r.results.length === 0, JSON.stringify(r.verdict));

console.log(`\n${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
