#!/usr/bin/env node
// longmemeval-run.mjs — 用 LongMemEval（ICLR 2025）oracle 集测 CP 检索层（2026-11-18）
//
// 口径：
//   每条题自带 haystack（oracle 版只含证据会话），把每轮对话写成一张记忆卡（session id 进 tags），
//   用 CP 的检索内核跑该题，看 top-k 是否命中 answer_session_ids → session-level recall@k。
//   abstention 题（question_id 以 _abs 结尾）没有证据会话，改测「是否返回了东西」——返回空才对。
//
// 用法：
//   node eval/external/longmemeval-run.mjs [--top 5] [--limit 500] [--type temporal-reasoning]
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const TOP = Number(arg('--top', 5));
const LIMIT = Number(arg('--limit', 500));
const ONLY_TYPE = arg('--type', null);
const LEVEL = arg('--level', 'session');

const { tokenize, readMemoryMeta, normalizeText, retrieveMemories } = await import(pathToFileURL(path.join(ROOT, 'memory-retrieval.js')).href);

const DATA = path.join(__dirname, 'data', 'longmemeval_oracle.json');
if (!fs.existsSync(DATA)) { console.error('缺少数据：' + DATA); process.exit(1); }
const all = JSON.parse(fs.readFileSync(DATA, 'utf8'));

const tagOf = (s) => String(s).replace(/[^A-Za-z0-9]/g, '-');

function buildDocs(inst) {
  const docs = [];
  const sessions = inst.haystack_sessions || [];
  const ids = inst.haystack_session_ids || [];
  sessions.forEach((turns, si) => {
    const sid = tagOf(ids[si] || `s${si}`);
    (turns || []).forEach((turn, ti) => {
      const text = String(turn && turn.content || '').replace(/\r?\n/g, ' ').trim();
      if (!text) return;
      const block = [
        '---',
        `id: 20260101-${String(docs.length + 1).padStart(4, '0')}`,
        'created: 2026-01-01T00:00:00+08:00',
        'source: longmemeval/oracle',
        'status: 🟢当前',
        'type: 事件',
        `tags: [lme, ${sid}, t-${sid}-${ti}]`,
        'scope: workspace',
        '---',
        `${turn && turn.role === 'user' ? 'User' : 'Assistant'}: ${text}`,
      ].join('\n');
      const raw = normalizeText(block);
      docs.push({ path: `q#${si}-${ti}`, raw, body: raw.replace(/^---[\s\S]*?---\s*/, ''), tokens: tokenize(raw), meta: readMemoryMeta(raw) });
    });
  });
  return docs;
}

const rows = [];
const byType = new Map();
let scored = 0, hitSum = 0, mrrSum = 0;
let absTotal = 0, absEmpty = 0;

const pool = all.filter((x) => {
  const t = String(x.question_id).endsWith('_abs') ? 'abs' : x.question_type;
  return !ONLY_TYPE || t === ONLY_TYPE;
}).slice(0, LIMIT);

for (const inst of pool) {
  const isAbs = String(inst.question_id).endsWith('_abs');
  const docs = buildDocs(inst);
  const res = retrieveMemories(inst.question, { docs, top: TOP });
  const results = res.results || [];
  const typeKey = isAbs ? 'abs' : inst.question_type;

  if (isAbs) {
    absTotal += 1;
    if (results.length === 0) absEmpty += 1;
    rows.push({ id: inst.question_id, type: typeKey, returned: results.length });
    continue;
  }

  let gold;
  if (LEVEL === 'turn') {
    gold = [];
    (inst.haystack_sessions || []).forEach((turns, si) => {
      const sid = tagOf((inst.haystack_session_ids || [])[si] || 's' + si);
      (turns || []).forEach((t, ti) => { if (t && t.has_answer) gold.push(`t-${sid}-${ti}`); });
    });
  } else {
    gold = (inst.answer_session_ids || []).map(tagOf);
  }
  if (!gold.length) continue;
  let rank = -1;
  for (let i = 0; i < results.length; i += 1) {
    const tags = String((results[i].meta && results[i].meta.tags) || '');
    if (gold.some((g) => tags.includes(g))) { rank = i + 1; break; }
  }
  scored += 1;
  hitSum += rank > 0 ? 1 : 0;
  if (rank > 0) mrrSum += 1 / rank;
  if (!byType.has(typeKey)) byType.set(typeKey, { n: 0, hit: 0 });
  const b = byType.get(typeKey);
  b.n += 1; b.hit += rank > 0 ? 1 : 0;
  rows.push({ id: inst.question_id, type: typeKey, rank, gold: gold.length, docs: docs.length, top3: results.slice(0, 3).map((r) => (r.meta && r.meta.tags) || '') });
}

const pct = (a, b) => (b ? +(a / b * 100).toFixed(1) : null);
function provenance() {
  let head = null;
  try { head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { head = null; }
  let sha = null;
  try { sha = crypto.createHash('sha256').update(fs.readFileSync(DATA)).digest('hex'); } catch { sha = null; }
  return { at: new Date().toISOString(), engineHead: head, dataSha256: sha, node: process.version, top: TOP, level: LEVEL };
}
const summary = {
  dataset: 'LongMemEval oracle (ICLR 2025)',
  top: TOP,
  level: LEVEL,
  instances: pool.length,
  scoredNoAbs: scored,
  sessionRecallAtK: pct(hitSum, scored),
  mrr: scored ? +(mrrSum / scored).toFixed(4) : null,
  abstention: { total: absTotal, returnedEmpty: absEmpty, emptyRate: pct(absEmpty, absTotal) },
  byType: Object.fromEntries([...byType].sort().map(([k, v]) => [k, { n: v.n, recall: pct(v.hit, v.n) }])),
  provenance: provenance(),
};
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(__dirname, `result-longmemeval-oracle-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify({ summary, rows }, null, 2), 'utf8');