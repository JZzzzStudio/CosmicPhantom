#!/usr/bin/env node
/**
 * context-lint.cjs — CONTEXT.md 术语表体检（D-07，2026-10-28）
 *
 * 只读：统计体积、段落、术语数、同名重复、近义候选（归一化后相同）。
 * 用法：
 *   node context-lint.cjs [--root <根>] [--json]
 * 输出：JSON（默认）或人读摘要（--json 关闭）。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg("--root") || path.join(os.homedir(), ".cosmic-phantom");
const FILE = path.join(ROOT, ".context", "CONTEXT.md");
const SOFT_LIMIT = 30720;      // 30KB 软上限
const HARD_LIMIT = 40960;      // 40KB 硬上限

function norm(name) {
  return String(name || "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

if (!fs.existsSync(FILE)) {
  console.log(JSON.stringify({ ok: false, error: `CONTEXT.md 不存在：${FILE}` }, null, 2));
  process.exit(1);
}
const raw = fs.readFileSync(FILE, "utf8");
const bytes = Buffer.byteLength(raw);
const lines = raw.split(/\r?\n/);
const sections = [];
const terms = [];
let currentSection = "(root)";
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const h = line.match(/^##\s+(.+?)\s*$/);
  if (h) { currentSection = h[1]; sections.push({ title: h[1], line: i + 1 }); continue; }
  const t = line.match(/^-\s*术语[：:]\s*(.+?)\s*$/);
  if (t) {
    const name = t[1].trim();
    let definition = "";
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const d = lines[j].match(/^\s+定义[：:]\s*(.+)$/);
      if (d) { definition = d[1].trim(); break; }
      if (/^-\s*术语[：:]/.test(lines[j])) break;
    }
    terms.push({ name, key: norm(name), section: currentSection, line: i + 1, definition: definition.slice(0, 120) });
  }
}
const byKey = new Map();
for (const t of terms) {
  if (!byKey.has(t.key)) byKey.set(t.key, []);
  byKey.get(t.key).push(t);
}
const duplicates = [...byKey.entries()].filter(([, v]) => v.length > 1)
  .map(([key, v]) => ({ key, count: v.length, entries: v.map(x => ({ name: x.name, section: x.section, line: x.line })) }));
const result = {
  ok: duplicates.length === 0 && bytes <= SOFT_LIMIT,
  file: FILE,
  bytes,
  softLimit: SOFT_LIMIT,
  hardLimit: HARD_LIMIT,
  overSoft: bytes > SOFT_LIMIT,
  overHard: bytes > HARD_LIMIT,
  sections: sections.length,
  terms: terms.length,
  uniqueTerms: byKey.size,
  duplicates,
};
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`CONTEXT.md ${(bytes / 1024).toFixed(1)}KB / ${sections.length} 段 / ${terms.length} 术语（去重 ${byKey.size}）`);
  console.log(`软上限 ${SOFT_LIMIT / 1024}KB：${bytes > SOFT_LIMIT ? "超了" : "未超"}；重复术语：${duplicates.length} 组`);
  for (const d of duplicates) console.log(`  - ${d.key} ×${d.count}：${d.entries.map(e => e.section).join(" / ")}`);
}
