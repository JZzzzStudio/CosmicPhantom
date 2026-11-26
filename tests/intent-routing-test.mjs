#!/usr/bin/env node
/**
 * intent-routing-test.mjs — D-13 意图感知检索规则（2026-10-28）
 *
 * 覆盖：五类意图识别 / 不命中 null / 意图调 top / decision 不折叠 / negative top
 */
import { intentOf, retrieveMemories, tokenize } from "../memory-retrieval.js";

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function makeDoc(id, text, tags = "", title = "") {
  const body = text;
  const meta = { id, status: "🟢当前", tags, title };
  return {
    path: `memories/${id}.md`,
    raw: `---\nid: ${id}\nstatus: 🟢当前\ntags: [${tags}]\ntitle: ${title}\n---\n${text}`,
    body,
    tokens: tokenize(`---\nid: ${id}\nstatus: 🟢当前\ntags: [${tags}]\ntitle: ${title}\n---\n${text}`),
    meta,
  };
}

try {
  check("T1 negative", intentOf("哪些事禁止做")?.name === "negative");
  check("T2 debug", intentOf("这个报错怎么排查")?.name === "debug");
  check("T3 decision", intentOf("为什么当时决定这么做")?.name === "decision");
  check("T4 temporal", intentOf("上次是什么时候")?.name === "temporal");
  check("T5 entity", intentOf("哪个文件出问题")?.name === "entity");
  check("T6 不命中 → null", intentOf("今天天气怎么样") === null, JSON.stringify(intentOf("今天天气怎么样")));

  const debugDocs = Array.from({ length: 10 }, (_, i) => makeDoc(`d${i}`, `报错排查第 ${i} 条`, "事件", `主题${i}`));
  const r7 = retrieveMemories("报错排查", { docs: debugDocs });
  check("T7 debug 意图 top=6", r7.results.length === 6, JSON.stringify({ n: r7.results.length }));

  const negDocs = Array.from({ length: 10 }, (_, i) => makeDoc(`n${i}`, `禁止事项第 ${i} 条`, "规则", `禁令${i}`));
  const r8 = retrieveMemories("禁止事项", { docs: negDocs });
  check("T8 negative 意图 top=5", r8.results.length === 5, JSON.stringify({ n: r8.results.length }));

  const sameTopic = [
    makeDoc("a", "[同一主题] 当时决定 A", "决策", "同一主题"),
    makeDoc("b", "[同一主题] 当时决定 B", "决策", "同一主题"),
  ];
  const r9 = retrieveMemories("为什么当时决定", { docs: sameTopic });
  check("T9 decision 不折叠（保留 2 条）", r9.results.length === 2, JSON.stringify({ n: r9.results.length }));
  const r10 = retrieveMemories("同一主题", { docs: sameTopic, fold: true });
  check("T10 默认折叠（保留 1 条）", r10.results.length === 1, JSON.stringify({ n: r10.results.length }));

  console.log(`\n${failures.length ? "❌" : "✅"} intent-routing-test: ${passed} passed / ${failures.length} failed`);
  if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
} catch (e) {
  console.error(`❌ intent-routing-test 异常：${e.stack || e.message}`);
  process.exit(1);
}
