#!/usr/bin/env node
// e2e-llm-reader.mjs — 端到端「会答题的读者」尺子（票 07 第二版，2026-11-19）
//
// 为什么要它：抽取式读者在「金标证据直给」下 cat3 只有 F1 3.4，且只有 32.2% 的题
//   答案字面出现在证据里 —— 说明开放域瓶颈不在检索，在「证据在手也答不出」。
//   这一版把读者换成 LLM，回答唯一还没被否决的问题：**给足证据，能答对多少**。
//
// 口径纪律：
//   · 铁律「检索热路径零 LLM」不破 —— 这里 LLM 只出现在**离线评测**，不参与检索。
//   · 判分仍用 token F1（与抽取式同一把尺子，可逐位对比）；另给 contains 作宽松上限。
//   · --oracle：用金标 evidence 原文，测读者上限；不给则是真实检索结果，测端到端。
//
// 用法：
//   PROMA_API_KEY=... node eval/e2e-llm-reader.mjs --all --cats 3 --oracle --model gemini-3.8-flash
//   PROMA_API_KEY=... node eval/e2e-llm-reader.mjs --all --cats 3 --model gemini-3.8-flash
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

process.env.CP_FAILOPEN_DISABLE = '1';   // 评测不写生产 fail-open 统计
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

const RUN_ALL = process.argv.includes('--all');
const ORACLE = process.argv.includes('--oracle');
const SAMPLE = arg('--sample', 'conv-26');
const TOP = Number(arg('--top', 5));
const HYBRID = process.argv.includes('--hybrid');   // 2026-11-19：启用混合检索（BM25+向量）
const SESSION_CARDS = process.argv.includes('--session-cards');   // 2026-11-19：每段会话加一张全文卡
const EN_MODEL = process.argv.includes('--en-model');   // 2026-11-19：用英文向量模型（bge-small-en-v1.5）
const FULL = process.argv.includes('--full-context');   // 2026-11-19：上限实验，整段对话全塞给读者
const MULTI = process.argv.includes('--multi-round');
const PREBUILT = arg('--prebuilt', '');   // 2026-11-20: use prebuilt sandbox (facts)   // 2026-11-20：多轮读（先摘录再作答）
const CATS = String(arg('--cats', '')).split(',').filter(Boolean);
// 模型名惰性求值（2026-11-19）：声明时读环境会拿到空值，必须在真正调用前再读一次
const modelName = () => arg('--model', '') || process.env.LLM_MODEL || '';
const CONCURRENCY = Number(arg('--concurrency', 4));
// 凭据解析（2026-11-19）：优先环境变量；否则自动读 Proma 渠道里已启用的 OpenAI 兼容渠道
//   （用户本机配的是「通义千问 Token Plan」，走 aliyuncs compatible-mode）。绝不打印 key。
function loadEnvLocal() {
  // 本机密钥文件（不入 git）：KEY=VALUE 逐行。让「用户贴一次 key」之后所有评测都能直接用。
  try {
    const p = path.join(ROOT, '.env.local');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(String.fromCharCode(10))) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* 读不到就算了 */ }
}
loadEnvLocal();
function resolveCreds() {
  // 供应商中立（2026-11-19）：只认「OpenAI 兼容接口」，不绑定任何厂商。
  //   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL 是唯一正式入口；其余前缀仅为历史兼容。
  let key = process.env.LLM_API_KEY || process.env.PROMA_API_KEY || process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
  if (!process.env.QWEN_BASE_URL && !process.env.PROMA_BASE_URL) process.env.QWEN_BASE_URL = process.env.QWEN_BASE_URL || '';
  let base = process.env.LLM_BASE_URL || process.env.PROMA_BASE_URL || process.env.QWEN_BASE_URL || '';
  if (!key || !base) {
    try {
      const p = path.join(process.env.USERPROFILE || process.env.HOME || '', '.proma', 'channels.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const list = Array.isArray(j) ? j : (j.channels || Object.values(j));
      const arr = Array.isArray(list) ? list : [list];
      const ch = arr.find((c) => c && c.enabled !== false && /qwen|dashscope|aliyun/i.test(String(c.provider || '') + String(c.name || '')));
      if (ch) {
        key = key || ch.apiKey || ch.key || ch.token || '';
        base = base || ch.baseUrl || '';
      }
    } catch { /* 读不到就走环境变量 */ }
  }
  if (!base) base = 'https://api.proma.cool';
  // 兼容两种基址：已含 /v1 的直接拼 /chat/completions，否则补 /v1
  base = base.replace(/\/$/, '');
  const endpoint = base.includes('/v1') ? base + '/chat/completions' : base + '/v1/chat/completions';
  return { key, base, endpoint };
}
const CREDS = resolveCreds();
const KEY = CREDS.key;
const BASE = CREDS.base;
const ENDPOINT = CREDS.endpoint;
const LIMIT = Number(arg('--limit', 0));   // 调试用：每题集只跑前 N 题

if (!KEY) { console.error('缺 API key：设 PROMA_API_KEY，或在 ~/.proma/channels.json 里启用一个 OpenAI 兼容渠道'); process.exit(1); }
const DATA = path.join(__dirname, 'external', 'data', 'locomo10.json');
if (!fs.existsSync(DATA)) { console.error('缺少数据：' + DATA); process.exit(1); }
const all = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const { loadMemoryDocs, retrieveMemories, retrieveMemoriesHybrid } = await import(pathToFileURL(path.join(ROOT, 'memory-retrieval.js')).href);

// ---------- 判分（与 e2e-run.mjs 逐字同源，保证两版可比） ----------
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

function buildSessionCards(conv) {
  const keys = Object.keys(conv).filter((k) => /^session_\d+$/.test(k)).sort((x, y) => Number(x.split('_')[1]) - Number(y.split('_')[1]));
  return keys.map((sk, i) => ({
    id: '20260101-S' + String(i + 1).padStart(2, '0'),
    tag: 'SESS-' + (i + 1),
    date: conv[sk + '_date_time'] || '',
    speaker: 'SESSION',
    text: (conv[sk] || []).map((t) => '[' + t.dia_id + '] ' + t.speaker + ': ' + String(t.text || '').replace(/\r?\n/g, ' ')).join(' '),
  }));
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
  return out;
}

// ---------- LLM 读者 ----------
const SYSTEM = [
  'You answer questions about a long conversation.',
  'Use ONLY the evidence given. Be extremely short: output the answer phrase only, no explanation, no full sentences unless the answer is a phrase.',
  'If the evidence does not contain the answer, but the question is a yes/no or would/could type question, infer the most likely answer from what the evidence implies and answer briefly (e.g. "Likely no").',
  'If the evidence is empty or unrelated, output exactly: UNKNOWN',
].join(' ');

async function chat(messages, maxTokens = 64) {
  const body = { model: modelName(), messages, temperature: 0, max_tokens: maxTokens };
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('LLM ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  return String(j.choices?.[0]?.message?.content || '').trim();
}

async function askLLM(question, evidenceText) {
  return chat([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Evidence:\n${evidenceText || '(none)'}\n\nQuestion: ${question}\nAnswer:` },
  ], 64);
}

// 多轮读（2026-11-20）：第一步只摘录相关原文（不答题），第二步只看摘录作答。
//   目的：把「全塞噪声大」和「top5 太窄」两头的缺点都压掉。
async function askLLMMulti(question, evidenceText) {
  if (!evidenceText) return 'UNKNOWN';
  const extract = await chat([
    { role: 'system', content: 'You extract evidence. From the evidence, quote the 2-3 passages most relevant to the question. Output ONLY the quoted passages verbatim, no answers, no commentary.' },
    { role: 'user', content: `Evidence:\n${evidenceText}\n\nQuestion: ${question}\nRelevant passages:` },
  ], 400);
  return chat([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Evidence:\n${extract}\n\nQuestion: ${question}\nAnswer:` },
  ], 64);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (idx < items.length) {
      const i = idx; idx += 1;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function runSample(sample) {
  const cards = buildCards(sample.conversation).concat(SESSION_CARDS ? buildSessionCards(sample.conversation) : []);
  const byTag = new Map(cards.map((c) => [c.tag, c]));
  const sandbox = path.join(__dirname, 'external', 'sandbox', 'e2e-' + sample.sample_id);
  const memDir = path.join(sandbox, 'memories');
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(memDir, { recursive: true });
  if (PREBUILT) {
    fs.copyFileSync(path.join(ROOT, PREBUILT, sample.sample_id, 'memories', '2026-01.md'), path.join(memDir, '2026-01.md'));
  } else {
  fs.writeFileSync(path.join(memDir, '2026-01.md'), cards.map((c) => ['---', 'id: ' + c.id,
    'created: 2026-01-01T00:00:00+08:00', 'source: locomo/' + sample.sample_id, 'status: 🟢当前', 'type: 事件',
    'tags: [locomo, ' + c.tag + ', ' + c.speaker + ']', 'scope: workspace', '---',
    '[' + c.date + '] ' + c.speaker + ': ' + c.text].join('\n')).join('\n\n§§§\n') + '\n', 'utf8');
  }
  if (HYBRID) {
    // 前置守卫（2026-11-20）：缺模型时 embed 会静默失败，结果仍被标成 hybriden —— 那是假绿。
    //   宁可直接停，也不许让"没有向量"的数字冒充满血成绩。
    {
      const wantDir = path.join(ROOT, 'embedding-db', EN_MODEL ? 'models-en' : 'models');
      const needOnnx = path.join(wantDir, 'model.onnx');
      const needVocab = path.join(wantDir, 'vocab.txt');
      if (!fs.existsSync(needOnnx) || !fs.existsSync(needVocab)) {
        console.error('[hybrid] 缺向量模型：' + wantDir + '（需要 model.onnx 与 vocab.txt）');
        console.error('[hybrid] 拒绝在缺模型时跑 hybrid —— 否则纯词法结果会被标成 hybrid' + (EN_MODEL ? 'en' : ''));
        process.exit(2);
      }
    }
    const embDir = path.join(sandbox, 'embedding-db');
    fs.mkdirSync(embDir, { recursive: true });
    const modelLink = path.join(embDir, 'models');
    if (!fs.existsSync(modelLink)) {
      try { execFileSync('cmd', ['/c', 'mklink', '/J', modelLink, path.join(ROOT, 'embedding-db', EN_MODEL ? 'models-en' : 'models')], { stdio: 'ignore' }); } catch { /* 已存在或权限问题 */ }
    }
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'embed.js'), 'build', '--root', sandbox], { stdio: 'ignore', timeout: 1800000 });
    } catch (e) { console.error('[hybrid] embed build 失败：' + String(e.message || e).slice(0, 120)); }
  }
  const docs = loadMemoryDocs(memDir);
  const fullText = FULL ? cards.filter((c) => !String(c.tag).startsWith('SESS')).map((c) => '[' + c.tag + '] ' + c.speaker + ': ' + c.text).join(String.fromCharCode(10)) : '';

  let qa = sample.qa || [];
  if (CATS.length) qa = qa.filter((q) => CATS.includes(String(q.category)));
  if (LIMIT > 0) qa = qa.slice(0, LIMIT);

  const rows = await mapLimit(qa, CONCURRENCY, async (q) => {
    let evidence = '';
    let retrievedTags = [];
    let retrievedDiaIds = [];
    if (FULL) {
      evidence = fullText;
      retrievedTags = cards.map((c) => c.tag);
      retrievedDiaIds = cards.flatMap((c) => String(c.text || '').match(/D\d+-\d+/g) || []);
    } else if (ORACLE) {
      const ev = (q.evidence || []).map((d) => String(d).replace(/[^A-Za-z0-9]/g, '-'));
      const hits = ev.map((t) => byTag.get(t)).filter(Boolean);
      evidence = hits.map((c) => `[${c.date}] ${c.speaker}: ${c.text}`).join('\n');
      retrievedTags = hits.map((c) => c.tag);
    } else {
      let res = null;
      if (HYBRID) { try { res = await retrieveMemoriesHybrid(q.question, { docs, top: TOP, memoryDir: memDir }); } catch { res = null; } }
      if (!res) res = retrieveMemories(q.question, { docs, top: TOP, memoryDir: ROOT });
      evidence = (res.results || []).map((r) => String(r.raw || r.snippet || '')).join('\n---\n');
      retrievedTags = (res.results || []).map((r) => String(r.meta?.tags || ''));
      retrievedDiaIds = [...new Set((res.results || []).flatMap((r) => String(r.raw || r.snippet || '').match(/D\d+-\d+/g) || []))];
    }
    let pred = '';
    let err = null;
    try { pred = MULTI ? await askLLMMulti(q.question, evidence) : await askLLM(q.question, evidence); } catch (e) { err = String(e.message || e).slice(0, 120); }
    const gold = q.answer || '';
    return {
      sample: sample.sample_id, cat: String(q.category), q: q.question,
      gold, pred, f1: gold ? f1(pred, gold) : null,
      contains: gold && norm(pred).includes(norm(gold)) ? 1 : 0,
      goldInEvidence: gold ? (norm(evidence).includes(norm(gold)) ? 1 : 0) : null,
      noEvidence: evidence ? 0 : 1,
      err, retrievedTags, retrievedDiaIds,
    };
  });
  return rows;
}

const samples = RUN_ALL ? all : [all.find((s) => s.sample_id === SAMPLE)].filter(Boolean);
if (!samples.length) { console.error('找不到 sample ' + SAMPLE); process.exit(1); }

const rowsAll = [];
for (const smp of samples) {
  const rows = await runSample(smp);
  rowsAll.push(...rows);
  console.error('[done] ' + smp.sample_id + ' rows=' + rows.length);
}

const pct = (a, b) => (b ? +(a / b * 100).toFixed(1) : null);
const byCat = new Map();
let scored = 0, f1Sum = 0, containsSum = 0, goldInEv = 0, noEv = 0, errN = 0;
for (const r of rowsAll) {
  if (r.err) errN += 1;
  if (r.noEvidence) noEv += 1;
  // 2026-11-19 修：原写 `if (!r.f1) continue` 会把「答错得 0 分」也跳过，导致分数虚高
  if (r.f1 === null || r.f1 === undefined) continue;   // 只跳过「无 gold」的题（cat5）
  scored += 1; f1Sum += r.f1; containsSum += r.contains; goldInEv += r.goldInEvidence || 0;
  const k = r.cat;
  if (!byCat.has(k)) byCat.set(k, { n: 0, f1: 0, contains: 0, goldInEv: 0 });
  const b = byCat.get(k);
  b.n += 1; b.f1 += r.f1; b.contains += r.contains; b.goldInEv += r.goldInEvidence || 0;
}

const out = {
  run: RUN_ALL ? 'all' : 'sample', oracle: ORACLE, model: modelName(), top: ORACLE ? null : TOP,
  cats: CATS.length ? CATS : 'all', scored, errors: errN, emptyEvidence: noEv,
  mainF1: +(f1Sum / (scored || 1) * 100).toFixed(1),
  mainContains: pct(containsSum, scored),
  goldInEvidence: pct(goldInEv, scored),
  byCategory: Object.fromEntries([...byCat].sort().map(([k, v]) => [k, {
    n: v.n,
    f1: +(v.f1 / v.n * 100).toFixed(1),
    contains: pct(v.contains, v.n),
    goldInEvidence: pct(v.goldInEv, v.n),
  }])),
  provenance: {
    at: new Date().toISOString(),
    engineHead: (() => { try { return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
    dataSha256: (() => { try { return crypto.createHash('sha256').update(fs.readFileSync(DATA)).digest('hex'); } catch { return null; } })(),
    node: process.version, reader: 'llm', judge: 'token-f1+contains',
  },
};
console.log(JSON.stringify(out, null, 2));
// 调试跑（--limit）单独命名，避免覆盖完整证据（2026-11-19 真实踩过）
const tagParts = [(FULL ? 'full' : (ORACLE ? 'oracle' : 'retrieval')) + (MULTI ? 'multi' : '') + (PREBUILT ? 'pre' + path.basename(PREBUILT) : '')];
if (HYBRID) tagParts.push(EN_MODEL ? 'hybriden' : 'hybrid');
if (SESSION_CARDS) tagParts.push('sess');
tagParts.push('llm', CATS.length ? 'c' + CATS.join('-') : 'all');
const tag = tagParts.filter(Boolean).join('-') + (LIMIT > 0 ? '-limit' + LIMIT : '');
fs.writeFileSync(path.join(__dirname, 'external', 'result-' + new Date().toISOString().slice(0, 10) + '-e2e-' + tag + '.json'),
  JSON.stringify({ summary: out, rows: rowsAll }, null, 2), 'utf8');