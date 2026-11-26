#!/usr/bin/env node
/**
 * coverage-cards.cjs — 事件→卡覆盖率体检（E-3，2026-10-28）
 *
 * 只读：扫 daily 的「⭐👤 用户（决策）」行，检查 memories 卡片是否覆盖（正文含决策前 24 字）。
 * 用法：node coverage-cards.cjs [--root <根>] [--days 30] [--json]
 * 输出：{ decisions, covered, uncovered, rate, samples }
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg("--root") || path.join(os.homedir(), ".cosmic-phantom");
const DAYS = Number(arg("--days") || 30);
const DAILY = path.join(ROOT, "daily");
const MEM = path.join(ROOT, "memories");

function norm(s) {
  return String(s || "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}
function readCards() {
  if (!fs.existsSync(MEM)) return [];
  const out = [];
  for (const f of fs.readdirSync(MEM)) {
    if (!f.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(MEM, f), "utf8");
    for (const block of raw.split(/^\s*§{3,}\s*$/m)) {
      const body = block.replace(/^---[\s\S]*?---\s*/, "");
      if (body.trim()) out.push(norm(body));
    }
  }
  return out;
}
function readDecisions() {
  if (!fs.existsSync(DAILY)) return [];
  const cutoff = Date.now() - DAYS * 86400000;
  const out = [];
  for (const f of fs.readdirSync(DAILY).filter(x => /^\d{4}-\d{2}-\d{2}\.md$/.test(x))) {
    const date = f.slice(0, 10);
    if (Date.parse(date + "T00:00:00+08:00") < cutoff) continue;
    const raw = fs.readFileSync(path.join(DAILY, f), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/⭐👤\s*用户（决策）\**\s*[：:]\s*(.+)$/);
      if (m) out.push({ date, text: m[1].trim() });
    }
  }
  return out;
}

const decisions = readDecisions();
const cards = readCards();
const covered = [];
const uncovered = [];
for (const d of decisions) {
  const key = norm(d.text).slice(0, 24);
  const hit = key && cards.some(c => c.includes(key));
  (hit ? covered : uncovered).push({ ...d, key });
}
const result = {
  root: ROOT,
  days: DAYS,
  decisions: decisions.length,
  covered: covered.length,
  uncovered: uncovered.length,
  rate: decisions.length ? +(covered.length / decisions.length).toFixed(3) : null,
  samples: uncovered.slice(0, 10).map(x => ({ date: x.date, text: x.text.slice(0, 80), key: x.key })),
};
if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`近 ${DAYS} 天决策行 ${result.decisions} 条；有卡 ${result.covered}；无卡 ${result.uncovered}；覆盖率 ${result.rate ?? "-"}`);
  for (const s of result.samples) console.log(`  ${s.date} ${s.text}`);
}
