#!/usr/bin/env node
// locomo-factcards.mjs — 写入时归纳实验（2026-11-20）
// 目的：验证 Mem0 72.93 与 CP 42.7 的差距是否来自「写入时把话归纳成事实」。
// 做法：对每个 LoCoMo session 调一次 LLM，提取原子事实（带 evidence dia_id），写成事实卡。
// 输出：eval/external/sandbox/facts/<sample>/memories/2026-01.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    try {
      for (const line of fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
      }
    } catch { /* 没有就算了 */ }
  }
}
loadEnv();
const KEY = process.env.LLM_API_KEY || '';
const BASE = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const ENDPOINT = BASE.includes('/v1') ? BASE + '/chat/completions' : BASE + '/v1/chat/completions';
const MODEL = arg('--model', process.env.LLM_MODEL || 'deepseek-chat');
const CONCURRENCY = Number(arg('--concurrency', 6));
if (!KEY) { console.error('缺 LLM_API_KEY'); process.exit(1); }

const DATA = path.join(__dirname, 'external', 'data', 'locomo10.json');
const all = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const OUT = path.join(__dirname, 'external', 'sandbox', 'facts');
fs.rmSync(OUT, { recursive: true, force: true });

const SYSTEM = 'You extract atomic facts from a conversation for later question answering. Output ONLY a JSON array, no prose. Each item: {"fact":"one self-contained sentence using full names","evidence":["D1:9","D1:11"]}. Rules: capture traits, preferences, plans, relationships, health, work, dates; 5-10 items max; facts must be standalone (no pronouns); use the exact dia_id strings from the transcript.';

async function chat(messages, maxTokens = 1200) {
  const body = { model: MODEL, messages, temperature: 0, max_tokens: maxTokens };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return String(j.choices?.[0]?.message?.content || '');
    } catch (e) { if (attempt === 1) throw e; }
  }
  return '';
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const k = i; i += 1; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const cleanId = (s) => String(s).replace(/[^A-Za-z0-9]/g, '-');
let totalFacts = 0;
for (const sample of all) {
  const conv = sample.conversation;
  const sessKeys = Object.keys(conv).filter((k) => /^session_\d+$/.test(k)).sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
  const perSession = await mapLimit(sessKeys, CONCURRENCY, async (sk) => {
    const turns = (conv[sk] || []).filter((t) => t && t.dia_id);
    const transcript = turns.map((t) => `[${t.dia_id}] ${t.speaker}: ${String(t.text || '').replace(/\s+/g, ' ')}`).join('\n');
    if (!transcript) return [];
    const raw = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Date: ${conv[sk + '_date_time'] || ''}\nTranscript:\n${transcript}\n\nJSON:` },
    ]);
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      const arr = JSON.parse(m[0]);
      return arr.map((x) => ({ fact: String(x.fact || '').trim(), evidence: (x.evidence || []).map(cleanId) })).filter((x) => x.fact.length > 10);
    } catch { return []; }
  });
  const dir = path.join(OUT, sample.sample_id, 'memories');
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const cards = [];
  for (const list of perSession) for (const f of list) {
    n += 1;
    const tags = ['locomo', 'fact', ...f.evidence.slice(0, 3)].join(', ');
    cards.push(`---\nid: 20260101-F${String(n).padStart(4, '0')}\ncreated: 2026-01-01T00:00:00+08:00\nsource: locomo-facts/${sample.sample_id}\nstatus: 🟢当前\ntype: 事实\ntags: [${tags}]\nscope: workspace\n---\n[Fact] ${f.fact}`);
  }
  fs.writeFileSync(path.join(dir, '2026-01.md'), cards.join('\n\n§§§\n\n') + '\n', 'utf8');
  totalFacts += n;
  console.log(JSON.stringify({ sample: sample.sample_id, sessions: sessKeys.length, facts: n }));
}
console.log(JSON.stringify({ done: true, totalFacts, out: OUT }));