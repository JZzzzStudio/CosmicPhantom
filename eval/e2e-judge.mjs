#!/usr/bin/env node
// e2e-judge.mjs — 用 LLM 判「答案是否等价」（2026-11-19）
// 为什么需要：token F1 会把 "Independence Day" vs "Fourth of July"、"filmmaker" vs "Director" 判成 0 分，
//   系统性低估。要跟 Mem0/官方 J-score 同口径比较，必须用语义判分。
// 用法：node eval/e2e-judge.mjs <result-e2e-*.json>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const FILE = process.argv[2];
if (!FILE || !fs.existsSync(FILE)) { console.error('用法：node eval/e2e-judge.mjs <result-e2e-*.json>'); process.exit(1); }

// 凭据：复用 .env.local
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).replace(/[\/]eval$/, '');
function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    try {
      for (const line of fs.readFileSync(path.join(ROOT, f), 'utf8').split(String.fromCharCode(10))) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
      }
    } catch { /* 没有就算了 */ }
  }
}
loadEnv();
const KEY = process.env.LLM_API_KEY || process.env.PROMA_API_KEY || '';
const BASE = (process.env.LLM_BASE_URL || process.env.PROMA_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const ENDPOINT = BASE.includes('/v1') ? BASE + '/chat/completions' : BASE + '/v1/chat/completions';
const MODEL = arg('--model', process.env.LLM_MODEL || '');
// 2026-11-19（票 07）：判分模型必须与作答模型分离，否则是同一模型自评。
//   JUDGE_MODEL / --judge-model 优先；未设时退回 LLM_MODEL，并强制要求 --allow-same-model。
const JUDGE_MODEL = arg('--judge-model', process.env.JUDGE_MODEL || MODEL);
const ALLOW_SAME = process.argv.includes('--allow-same-model');
if (!KEY) { console.error('缺 LLM_API_KEY（只在跑 LLM 评测时需要）'); process.exit(1); }
if (!BASE) { console.error('缺 LLM_BASE_URL'); process.exit(1); }
if (!MODEL) { console.error('缺模型名：--model 或 LLM_MODEL'); process.exit(1); }

const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const ANSWER_MODEL = String(j?.summary?.model || '').trim();
if (ANSWER_MODEL && ANSWER_MODEL === JUDGE_MODEL && !ALLOW_SAME) {
  console.error('判分模型与作答模型相同（' + JUDGE_MODEL + '）——票 07 要求分离。用 --judge-model 换一个，或显式传 --allow-same-model。');
  process.exit(2);
}
const rows = (j.rows || []).filter((r) => r.gold && String(r.gold).trim());
console.error('待判题数', rows.length);

const SYSTEM = 'You grade question answering. Given a gold answer and a predicted answer, decide if they are semantically equivalent for the question. Accept synonyms, paraphrases, and shorter/longer forms of the same fact. Output ONLY one word: CORRECT or WRONG.';
async function judge(q, gold, pred) {
  const body = {
    model: MODEL, temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Question: ${q}\nGold answer: ${gold}\nPredicted answer: ${pred}\nVerdict:` },
    ],
    max_tokens: 5,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY }, body: JSON.stringify(body) });      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const txt = String(data.choices?.[0]?.message?.content || '').toUpperCase();
      return txt.includes('CORRECT') && !txt.includes('WRONG') ? 1 : 0;
    } catch (e) { if (attempt === 1) return null; }
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i; i += 1; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const verdicts = await mapLimit(rows, 6, async (r) => ({ ...r, judge: await judge(r.q, r.gold, r.pred) }));
const ok = verdicts.filter((v) => v.judge !== null);
const correct = ok.filter((v) => v.judge === 1).length;

// 2026-11-19（票 07）：provenance + 题集冻结。没有这四个哈希，分数不可复现。
import { createHash } from 'node:crypto';
const sha = (p) => { try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); } catch { return null; } };
const gitHead = (dir) => { try { return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } };
const provenance = {
  judgedAt: new Date().toISOString(),
  judgeModel: JUDGE_MODEL,
  answerModel: ANSWER_MODEL || null,
  sameModel: ANSWER_MODEL ? ANSWER_MODEL === JUDGE_MODEL : null,
  resultFile: path.basename(FILE),
  questionsSha256: sha(path.join(ROOT, 'eval', 'external', 'evidence-cat3', 'cat3-questions.json')),
  loCoMoSha256: j?.summary?.provenance?.dataSha256 || null,
  readerProvenance: j?.summary?.provenance || null,
  engineHead: gitHead(ROOT),
  node: process.version,
};
console.log(JSON.stringify({
  file: path.basename(FILE), model: JUDGE_MODEL, answerModel: ANSWER_MODEL || null,
  judged: ok.length, failed: verdicts.length - ok.length,
  llmJudgeAccuracy: +(correct / (ok.length || 1) * 100).toFixed(1),
  tokenF1ForSameRows: +(ok.reduce((a, v) => a + (v.f1 || 0), 0) / (ok.length || 1) * 100).toFixed(1),
  provenance,
}, null, 2));
fs.writeFileSync(FILE.replace(/\.json$/, '.judged.json'), JSON.stringify(verdicts, null, 1));
fs.writeFileSync(FILE.replace(/\.json$/, '.judged.meta.json'), JSON.stringify(provenance, null, 2));
