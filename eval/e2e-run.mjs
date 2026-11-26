#!/usr/bin/env node
// e2e-run.mjs — 端到端尺子（票 07 第一版）：检索 → 抽取式作答 → 确定性判分
//
// 为什么不用模型作答：当前环境无模型额度。抽取式作答 + 词面 F1 判分是**可复现**的下限，
//   能回答"材料里有没有答案、找得准不准"；换成模型作答只需替换 `readAnswer()` 一个函数。
//
// 用法：
//   node eval/e2e-run.mjs --sample conv-26 [--top 5]
//   node eval/e2e-run.mjs --all [--top 5]
// 输出：summary{ mainF1, exactMatch, byCategory, abstentionRate, provenance } + rows
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const SAMPLE = arg('--sample', 'conv-26');
const TOP = Number(arg('--top', 5));
const RUN_ALL = process.argv.includes('--all');
// oracle 模式（2026-11-19）：跳过检索，直接把金标 evidence 指向的轮次原文给 reader。
//   目的是把两个瓶颈拆开：到底是「找不到证据」还是「证据在手也答不出」。
const ORACLE = process.argv.includes('--oracle');
const DATA = path.join(__dirname, 'external', 'data', 'locomo10.json');
if (!fs.existsSync(DATA)) { console.error('缺少数据：' + DATA + '（见 eval/external/manifest.json）'); process.exit(1); }
const all = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const { loadMemoryDocs, retrieveMemories } = await import(pathToFileURL(path.join(ROOT, 'memory-retrieval.js')).href);

const STOP = new Set(('a an the is are was were be been being do does did doing have has had having will would shall should can could may might must i you he she it we they me him her us them my your his its our their this that these those what when where who why how which and or but if then than so to of in on at for with about as by from').split(' '));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
const tokens = (s) => norm(s).split(/\s+/).filter((w) => w && !STOP.has(w));
function f1(pred, gold) {
  const p = tokens(pred), g = tokens(gold);
  if (!p.length || !g.length) return 0;
  const pc = new Map(), gc = new Map();
  for (const w of p) pc.set(w, (pc.get(w) || 0) + 1);
  for (const w of g) gc.set(w, (gc.get(w) || 0) + 1);
  let same = 0;
  for (const [w, n] of pc) same += Math.min(n, gc.get(w) || 0);
  if (!same) return 0;
  const prec = same / p.length, rec = same / g.length;
  return +(2 * prec * rec / (prec + rec)).toFixed(4);
}

function buildCards(conv) {
  const sessKeys = Object.keys(conv).filter((k) => /^session_\d+$/.test(k)).sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
  const out = [];
  let seq = 0;
  for (const sk of sessKeys) {
    const date = conv[sk + '_date_time'] || '';
    for (const turn of conv[sk] || []) {
      if (!turn || !turn.dia_id) continue;
      seq += 1;
      out.push({
        id: '20260101-' + String(seq).padStart(4, '0'),
        tag: String(turn.dia_id).replace(/[^A-Za-z0-9]/g, '-'),
        date, speaker: turn.speaker, text: String(turn.text || '').replace(/\r?\n/g, ' '),
      });
    }
  }
  return { cards: out, sessions: sessKeys.length };
}

// 抽取式作答：在前 top-k 卡里挑与问题词重叠度最高的那句
function readAnswer(question, results) {
  const qTok = new Set(tokens(question));
  let best = { score: 0, text: '' };
  for (const r of results || []) {
    const body = String((r.snippet || r.text || '')).split(/[.!?。！？]/).map((x) => x.trim()).filter(Boolean);
    for (const sent of body) {
      const st = tokens(sent);
      if (!st.length) continue;
      const hit = st.filter((w) => qTok.has(w)).length;
      const score = hit / Math.sqrt(st.length);
      if (score > best.score) best = { score, text: sent };
    }
  }
  return best.score > 0 ? best.text : '';
}

function runSample(sample) {
  const { cards } = buildCards(sample.conversation);
  const byTag = new Map(cards.map((c) => [c.tag, c]));
  const sandbox = path.join(__dirname, 'external', 'sandbox', 'e2e-' + sample.sample_id);
  const memDir = path.join(sandbox, 'memories');
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(memDir, { recursive: true });
  const blocks = cards.map((c) => ['---', 'id: ' + c.id, 'created: 2026-01-01T00:00:00+08:00', 'source: locomo/' + sample.sample_id,
    'status: 🟢当前', 'type: 事件', 'tags: [locomo, ' + c.tag + ', ' + c.speaker + ']', 'scope: workspace', '---',
    '[' + c.date + '] ' + c.speaker + ': ' + c.text].join('\n'));
  fs.writeFileSync(path.join(memDir, '2026-01.md'), blocks.join('\n\n§§§\n') + '\n', 'utf8');
  const docs = loadMemoryDocs(memDir);

  const byCat = new Map();
  let mainF1 = 0, mainN = 0, em = 0, emN = 0, advN = 0, advAnswered = 0, contains = 0, inCtx = 0;
  const misses = [];
  for (const q of sample.qa || []) {
    let res;
    if (ORACLE) {
      const ev = (q.evidence || []).map((d) => String(d).replace(/[^A-Za-z0-9]/g, '-'));
      const hits = ev.map((t) => byTag.get(t)).filter(Boolean);
      res = { results: hits.map((c) => ({ snippet: `${c.speaker}: ${c.text}`, raw: `${c.speaker}: ${c.text}`, meta: { tags: c.tag } })) };
      if (!hits.length && ev.length) res = { results: [] };
    } else {
      res = retrieveMemories(q.question, { docs, top: TOP, memoryDir: ROOT });
    }
    const pred = readAnswer(q.question, res.results);
    const cat = String(q.category);
    if (cat === '5') {
      advN += 1;
      if (pred) advAnswered += 1;
      if (!byCat.has(cat)) byCat.set(cat, { n: 0, f1: 0 });
      byCat.get(cat).n += 1;
      continue;
    }
    const gold = q.answer || '';
    const s = f1(pred, gold);
    mainF1 += s; mainN += 1;
    if (gold && norm(pred).includes(norm(gold))) contains += 1;
    const ctx = (res.results || []).map((r) => norm(r.raw || r.snippet || "")).join(" ");
    if (gold && norm(gold) && ctx.includes(norm(gold))) inCtx += 1;
    em += norm(pred) && norm(pred) === norm(gold) ? 1 : 0; emN += 1;
    if (!byCat.has(cat)) byCat.set(cat, { n: 0, f1: 0 });
    const b = byCat.get(cat); b.n += 1; b.f1 += s;
    if (s < 0.3 && misses.length < 8) misses.push({ q: q.question, gold, pred: pred.slice(0, 120) });
  }
  const pct = (a, b) => (b ? +(a / b * 100).toFixed(1) : null);
  return {
    sample: sample.sample_id, cards: cards.length, top: TOP,
    mainF1: +(mainF1 / (mainN || 1) * 100).toFixed(1), mainScored: mainN,
    exactMatch: pct(em, emN),
    contains: pct(contains, mainN),
    answerInContext: pct(inCtx, mainN),
    adversarialCount: advN, adversarialAnsweredRate: pct(advAnswered, advN),
    byCategory: Object.fromEntries([...byCat].sort().map(([k, v]) => [k, { n: v.n, f1: v.n ? +(v.f1 / v.n * 100).toFixed(1) : null }])),
    misses,
  };
}

function provenance(extra = {}) {
  let head = null;
  try { head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { head = null; }
  let sha = null;
  try { sha = crypto.createHash('sha256').update(fs.readFileSync(DATA)).digest('hex'); } catch { sha = null; }
  return { at: new Date().toISOString(), engineHead: head, dataSha256: sha, node: process.version, top: ORACLE ? null : TOP, oracle: ORACLE, reader: 'extractive', judge: 'token-f1', ...extra };
}

const samples = RUN_ALL ? all : [all.find((s) => s.sample_id === SAMPLE)].filter(Boolean);
if (!samples.length) { console.error('找不到 sample ' + SAMPLE); process.exit(1); }
const rows = [];
for (const smp of samples) { const r = runSample(smp); rows.push(r); console.error('[done] ' + r.sample + ' F1=' + r.mainF1); }
const n = rows.reduce((a, r) => a + r.mainScored, 0);
const weighted = rows.reduce((a, r) => a + r.mainF1 * r.mainScored, 0) / (n || 1);
const weightedContains = rows.reduce((a, r) => a + (r.contains || 0) * r.mainScored, 0) / (n || 1);
const weightedInCtx = rows.reduce((a, r) => a + (r.answerInContext || 0) * r.mainScored, 0) / (n || 1);
const cats = {};
for (const r of rows) for (const [k, v] of Object.entries(r.byCategory)) { cats[k] = cats[k] || { n: 0, s: 0 }; cats[k].n += v.n; cats[k].s += (v.f1 || 0) / 100 * v.n; }
const summary = {
  run: RUN_ALL ? 'all' : 'sample', samples: rows.length, scored: n,
  oracle: ORACLE,
  mainF1: +weighted.toFixed(1),
  mainContains: +weightedContains.toFixed(1),
  answerInContext: +weightedInCtx.toFixed(1),
  byCategory: Object.fromEntries(Object.entries(cats).sort().map(([k, v]) => [k, { n: v.n, f1: v.n ? +(v.s / v.n * 100).toFixed(1) : null }])),
  adversarialAnsweredRate: rows.reduce((a, r) => a + (r.adversarialAnsweredRate || 0), 0) / (rows.length || 1),
  provenance: provenance(),
};
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(__dirname, 'e2e-last-result.json'), JSON.stringify({ summary, rows }, null, 2), 'utf8');