#!/usr/bin/env node
// locomo-run.cjs — 用 LoCoMo（ACL 2024）外部基准测 CP 的检索层（2026-11-18）
//
// 做法：把每段对话的每一轮 → 写成一张记忆卡（id 合法、dia_id 进 tags），
//       然后对该 sample 的每个 QA 跑 CP 的检索内核，看 top-k 是否命中 evidence 的 dia_id。
// 指标：evidence recall@k（不判答案对错，只判"证据有没有被找出来"），按 LoCoMo category 分组。
//
// 用法：
//   node eval/external/locomo-run.cjs [--sample conv-26] [--top 5] [--set all|1|2|3|4|5]
//
// 说明：不写主库，全部落在 eval/external/sandbox/<sample>/。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 评测/沙箱不写生产 fail-open 统计（2026-11-19）
process.env.CP_FAILOPEN_DISABLE = "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const SAMPLE = arg('--sample', 'conv-26');
const TOP = Number(arg('--top', 5));
const CATS = arg('--set', 'all');
const SESSION_CARDS = process.argv.includes('--session-cards');
// 2026-11-19（P1-4 窗口卡）：每张卡以某一轮为主，正文带前后各 N 轮，tags 只记主轮的 dia_id。
//   这样命中仍可归因到具体某一轮，不会像会话卡那样把整段对话的 dia_id 都算成命中。
const WINDOW = Number(arg('--window', 0));
const REFINE = process.argv.includes('--refine');
// 2026-11-19（开放域实验）：会话摘要卡 —— 每个会话一张「主题 + 关键事实 + 人物」的精炼卡。
//   attrib=all   ：tags 记全会话 dia_id（会话粒度；与全文会话卡同口径，可比 48.2/36.9）
//   attrib=facts ：tags 只记被摘要引用的那几轮（轮粒度可归因，不透支）
const SUMMARY_CARDS = process.argv.includes('--summary-cards');
const SUMMARY_ATTRIB = arg('--summary-attrib', 'all');
// 2026-11-19 判据修正：原判据 tags.includes(gold) 子串误判 —— gold=「D3-1」会命中「D3-11」。
//   --exact-tags 改为按逗号切分后精确比较；默认仍 loose 以保持历史数字不断裂，但两种都同时输出。
const EXACT_TAGS = process.argv.includes('--exact-tags');
// 扫参开关（2026-11-19）：摘要卡的关键参数是可调的，不扫就下结论等于拍脑袋。
const SUM_FACTS = Number(arg('--sum-facts', 8));
const SUM_TOPICS = Number(arg('--sum-topics', 6));
// 对照组（必需）：生成「同样长、同样归因、但句子打乱」的卡。
//   用来回答一个问题：分数上涨是「摘要精选的内容有用」还是「只多了一张卡就有机会命中」？
//   随机用固定种子，保证可重跑。
const SUM_SHUFFLE = process.argv.includes('--sum-shuffle');
// 关系层启用所需：给轮卡补共享主题标签（否则图上零边，见 core/graph-edges.js 注释）。
const SUBJECT_TAGS = process.argv.includes('--card-subject-tags');

const { loadMemoryDocs, retrieveMemories, tokenize, stemEn } = await import(pathToFileURL(path.join(ROOT, 'memory-retrieval.js')).href);

const DATA = path.join(__dirname, 'data', 'locomo10.json');
if (!fs.existsSync(DATA)) { console.error('缺少数据：' + DATA); process.exit(1); }
const all = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const RUN_ALL = process.argv.includes('--all');
function provenance(extra = {}) {
  let head = null;
  try { head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { head = null; }
  let dataSha = null;
  try { dataSha = crypto.createHash('sha256').update(fs.readFileSync(DATA)).digest('hex'); } catch { dataSha = null; }
  return { at: new Date().toISOString(), engineHead: head, dataSha256: dataSha, node: process.version, top: TOP, sessionCards: SESSION_CARDS, window: WINDOW, refine: REFINE, categoryFilter: CATS, summaryCards: SUMMARY_CARDS, summaryAttrib: SUMMARY_ATTRIB, exactTags: EXACT_TAGS, sumFacts: SUMMARY_CARDS ? SUM_FACTS : null, sumTopics: SUMMARY_CARDS ? SUM_TOPICS : null, sumShuffle: SUMMARY_CARDS ? SUM_SHUFFLE : null, ...extra };
}
const samples = RUN_ALL ? all : [all.find((s) => s.sample_id === SAMPLE)];
if (!samples[0]) { console.error('找不到 sample ' + SAMPLE + '，可选：' + all.map((s) => s.sample_id).join(', ')); process.exit(1); }

// ---------- 会话摘要卡（确定性抽取，零模型，可复现） ----------
// 设计约束：检索热路径零 LLM 是项目红线；摘要卡必须能从原文完全重建，否则不同机器跑出的数字不可比。
//   attrib=all   ：tags 记全会话 dia_id → 会话粒度，和全文会话卡同一把尺子
//   attrib=facts ：tags 只记被摘要引用的轮 → 轮粒度可归因，不透支命中
const EN_STOP = new Set((`a an the and or but if then than this these those that i you he she it we they me him her us them my your his its our their mine yours am is are was were be been being do does did doing have has had having will would can could should may might must not no nor so as at by for from in into of on onto out over to up with about after before during while again further once here there when where why how all any both each few more most other some such only own same too very just don now really also got get gets getting go goes going went gone like likes liked know think want said says say lot lots thing things stuff well yeah oh hey hi okay ok sure thanks thank`).split(/\s+/));
// 主题词补充黑名单（2026-11-19 实测）：高频但无语义的泛词，会把 what / real / cool / take 顶到主题位。
const TOPIC_STOP = new Set(`what which who whom whose real cool take takes taken great look looks looking good bad best better nice little long small big new old first next give gives given make makes made feel feels felt need needs want wants went come comes came still even ever never always often sometimes back down off again around through between under above own such much many more less very quite pretty almost enough`.split(/\s+/));

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
}

// 主题（高频实词）+ 人物（speaker）+ 关键事实（带时间/所有格/数字线索的句子，逐条存 dia_id）
function summaryOfSession(turns, opts = {}) {
  const speakers = [];
  for (const t of turns) {
    const sp = String(t.speaker || '').trim();
    if (sp && !speakers.includes(sp)) speakers.push(sp);
  }
  // 人名不进主题词：cat1/cat3 的题面大量带人名（"What did Caroline..."），
  //   若人名当主题词，摘要卡会因对人名而造成虚高命中，污染实验。
  const personStop = new Set(speakers.flatMap((s) => [s.toLowerCase(), stemEn(s.toLowerCase())]));
  const freq = new Map();
  for (const t of turns) {
    for (const tok of tokenize(String(t.text || ''))) {
      // 中文主题需分词器，本实验语料为英文；中文单字不进主题词表，避免噪声
      if (tok.length < 4 || EN_STOP.has(tok) || TOPIC_STOP.has(tok) || personStop.has(tok) || /^\d+$/.test(tok)) continue;
      freq.set(tok, (freq.get(tok) || 0) + 1);
    }
  }
  const topics = [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, opts.topics || SUM_TOPICS)
    .map(([w]) => w);
  const scored = [];
  for (const t of turns) {
    for (const s of splitSentences(t.text)) {
      let sc = 0;
      if (/\b(?:19|20)\d{2}\b/.test(s)) sc += 3;
      if (/\byears? ago\b|\blast (?:week|month|year|summer|night)\b/i.test(s)) sc += 2;
      if (/\bmy \w+/i.test(s)) sc += 2;
      if (/\bi have\b|\bi've\b/i.test(s)) sc += 1;
      if (/\b\d+\b/.test(s)) sc += 1;
      if (s.length >= 40 && s.length <= 220) sc += 1;
      if (sc <= 0) continue;
      scored.push({ sc, dia: t.dia_id, speaker: t.speaker, text: s });
    }
  }
  const picked = [];
  const seen = new Set();
  for (const f of scored.sort((a, b) => b.sc - a.sc)) {
    const key = f.text.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(f);
    if (picked.length >= (opts.facts || SUM_FACTS)) break;
  }
  picked.sort((a, b) => turns.findIndex((t) => t.dia_id === a.dia) - turns.findIndex((t) => t.dia_id === b.dia));
  const body = [
    `主题: ${topics.length ? topics.join(' / ') : '(无高频词)'}`,
    `人物: ${speakers.join(', ') || '(未知)'}`,
    '关键事实:',
    ...picked.map((f) => `- [${f.dia}] ${f.speaker}: ${f.text.slice(0, 180)}`),
  ].join('\n');
  return { body, facts: picked, topics, speakers };
}

// 对照组：同样长度、同样归因、同样结构的卡，但句子是完全打乱的（固定种子）。
//   若它也能把分数抬到同样高，说明提升来自“多一张覆盖整会话的卡”，不是摘要的精选能力。
function shuffleOfSession(turns, seed = 42) {
  const all = [];
  for (const t of turns) for (const s of splitSentences(t.text)) all.push(`[${t.dia_id}] ${t.speaker}: ${s}`);
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = all.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const body = [
    '主题: (对照组-打乱)',
    '人物: (对照组-打乱)',
    '关键事实:',
    ...all.slice(0, SUM_FACTS).map((s) => `- ${s.slice(0, 180)}`),
  ].join('\n');
  return { body, facts: [], topics: [], speakers: [] };
}

function runSample(sample) {
// ---- 1. 组卡：每轮一张 ----
const conv = sample.conversation;
const sessKeys = Object.keys(conv).filter((k) => /^session_\d+$/.test(k)).sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
const cards = [];
let seq = 0;
const diaToId = new Map();
for (const sk of sessKeys) {
  const date = conv[`${sk}_date_time`] || '';
  const turns = (conv[sk] || []).filter((t) => t && t.dia_id);
  for (let ti = 0; ti < turns.length; ti += 1) {
    const turn = turns[ti];
    seq += 1;
    const id = `20260101-${String(seq).padStart(4, '0')}`;
    const tag = turn.dia_id.replace(/[^A-Za-z0-9]/g, '-');
    diaToId.set(tag, turn.dia_id);
    let text = String(turn.text || '').replace(/\r?\n/g, ' ');
    if (WINDOW > 0) {
      const lo = Math.max(0, ti - WINDOW), hi = Math.min(turns.length - 1, ti + WINDOW);
      text = turns.slice(lo, hi + 1).map((t) => `${t.speaker}: ${String(t.text || '').replace(/\r?\n/g, ' ')}`).join(' / ');
    }
    cards.push({ id, tags: [tag, turn.speaker], sess: sk, date, speaker: turn.speaker, text });
  }
}

if (SESSION_CARDS) {
  for (const sk of sessKeys) {
    const turns = (conv[sk] || []).filter((t) => t && t.dia_id);
    if (!turns.length) continue;
    seq += 1;
    const id = `20260101-${String(seq).padStart(4, '0')}`;
    const date = conv[`${sk}_date_time`] || '';
    const tags = turns.map((t) => t.dia_id.replace(/[^A-Za-z0-9]/g, '-'));
    for (const tg of tags) diaToId.set(tg, tg);
    const body = turns.map((t) => `${t.speaker}: ${String(t.text || '').replace(/\r?\n/g, ' ')}`).join(' / ').slice(0, 4000);
    cards.push({ id, tags, sess: sk, date, speaker: 'session', text: `[${date}] session ${sk}: ${body}`, session: true });
  }
}

if (SUMMARY_CARDS) {
  for (const sk of sessKeys) {
    const turns = (conv[sk] || []).filter((t) => t && t.dia_id);
    if (!turns.length) continue;
    seq += 1;
    const id = `20260101-${String(seq).padStart(4, '0')}`;
    const date = conv[`${sk}_date_time`] || '';
    const sm = SUM_SHUFFLE ? shuffleOfSession(turns) : summaryOfSession(turns, { facts: SUM_FACTS, topics: SUM_TOPICS });
    const allDia = turns.map((t) => t.dia_id.replace(/[^A-Za-z0-9]/g, '-'));
    const factDia = [...new Set(sm.facts.map((f) => f.dia.replace(/[^A-Za-z0-9]/g, '-')))].sort();
    // 打乱对照只有全会话归因才有意义（它不引用具体轮）；否则卡上没有 dia_id，永远不会命中
    const tags = (SUMMARY_ATTRIB === 'facts' && !SUM_SHUFFLE) ? factDia : allDia;
    for (const tg of allDia) diaToId.set(tg, tg);
    cards.push({ id, tags, sess: sk, date, speaker: 'summary', session: true, summary: true,
      text: `[session ${sk} summary] ${date}\n${sm.body}` });
  }
}

const sessionIds = new Set(cards.filter((c) => c.session && !c.summary).map((c) => c.id));
const summaryIds = new Set(cards.filter((c) => c.summary).map((c) => c.id));
const sandbox = path.join(__dirname, 'sandbox', SAMPLE);
const memDir = path.join(sandbox, 'memories');
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(memDir, { recursive: true });

const bucket = path.join(memDir, '2026-01.md');
// 共享主题标签（2026-11-19）：给轮卡补上会话主题词，让关系层（graph-edges 的「共享标签边」）有边可造。
//   实测背景：links.json 的 derived 段全库 0 边（HippoRAG2/Memary 关系层已登记为「死机制」），
//   LoCoMo 卡上每张只有自己唯一的 D-x 标签 + speaker（df 过高被 MIN_W 滤掉）→ 图上一根边也没。
if (SUBJECT_TAGS) {
  for (const sk of sessKeys) {
    const turns = (conv[sk] || []).filter((t) => t && t.dia_id);
    if (!turns.length) continue;
    const sm = summaryOfSession(turns, { facts: 0, topics: SUM_TOPICS });
    for (const c of cards) {
      if (c.session || c.sess !== sk) continue;
      c.tags = [...new Set([...c.tags, ...sm.topics])];
    }
  }
}

const blocks = cards.map((c) => [
  '---',
  `id: ${c.id}`,
  'created: 2026-01-01T00:00:00+08:00',
  `source: locomo/${SAMPLE}`,
  'status: 🟢当前',
  'type: 事件',
  `tags: [locomo, ${c.tags.join(', ')}]`,
  'scope: workspace',
  '---',
  c.summary ? c.text : `[${c.date}] ${c.speaker}: ${c.text}`,
].join('\n'));
fs.writeFileSync(bucket, blocks.join('\n\n§§§\n') + '\n', 'utf8');

// ---- 2. 加载 + 逐题检索 ----
const docs = loadMemoryDocs(memDir);
const qaAll = sample.qa || [];
const qa = CATS === 'all' ? qaAll : qaAll.filter((q) => String(q.category) === String(CATS));

const byCat = new Map();
// 两套判据并行：loose = 历史口径（子串包含，会把 D3-11 算成命中 D3-1）；exact = 精确 tag。
const tagTokens = (s) => String(s || '').replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean);
let hitSum = 0, mrrSum = 0, scored = 0, emptyReturned = 0, sessionHits = 0, turnHits = 0, summaryHits = 0;
let exactHitSum = 0, exactMrrSum = 0, falseHitCount = 0;
const misses = [];

for (const q of qa) {
  const gold = (q.evidence || []).map((d) => d.replace(/[^A-Za-z0-9]/g, '-')).filter(Boolean);
  const res = retrieveMemories(q.question, { docs, top: TOP, memoryDir: ROOT, refine: REFINE });
  const got = (res.results || []).map((r) => ({
    id: String(r.id || (r.meta && r.meta.id) || ''),
    tags: String((r.meta && r.meta.tags) || ''),
    toks: tagTokens((r.meta && r.meta.tags) || ''),
  }));
  if (!res.results || res.results.length === 0) emptyReturned += 1;
  const looseIdx = got.findIndex((g) => gold.some((x) => g.tags.includes(x)));
  const exactIdx = got.findIndex((g) => gold.some((x) => g.toks.includes(x)));
  const rank = looseIdx + 1;
  const exactRank = exactIdx + 1;
  const hit = looseIdx >= 0 ? 1 : 0;
  const exactHit = exactIdx >= 0 ? 1 : 0;
  const viaSession = hit === 1 && sessionIds.has(got[looseIdx].id);
  const viaSummary = hit === 1 && summaryIds.has(got[looseIdx].id);
  if (gold.length) {
    scored += 1;
    hitSum += hit;
    exactHitSum += exactHit;
    if (hit) mrrSum += 1 / rank;
    if (exactHit) exactMrrSum += 1 / exactRank;
    if (hit && !exactHit) falseHitCount += 1;   // 子串误判：实际没命中金轮，却被算命中
    if (viaSession) sessionHits += 1;
    if (viaSummary) summaryHits += 1;
    if (hit && !viaSession && !viaSummary) turnHits += 1;
    const k = String(q.category);
    if (!byCat.has(k)) byCat.set(k, { n: 0, hit: 0, exact: 0 });
    const b = byCat.get(k);
    b.n += 1; b.hit += hit; b.exact += exactHit;
    if (!hit && misses.length < 8) misses.push({ q: q.question, gold, top3: res.results.slice(0, 3).map((r) => (r.meta && r.meta.tags) || '') });
  }
}

const pct = (a, b) => (b ? +(a / b * 100).toFixed(1) : null);
// 2026-11-19（票 29a）：主分剔除 cat5（对抗类，题面在对话里没有答案），单列报告；
//   同时显式标注粒度：逐轮卡=轮粒度，+会话卡=会话粒度，两者不可相减比较。
const catList = [...byCat];
const mainCats = catList.filter(([k]) => String(k) !== '5');
const mainN = mainCats.reduce((a, [, v]) => a + v.n, 0);
const mainHit = mainCats.reduce((a, [, v]) => a + v.hit, 0);
const mainExactHit = mainCats.reduce((a, [, v]) => a + v.exact, 0);
const adv = byCat.get('5') || { n: 0, hit: 0, exact: 0 };
// 粒度标签必须说清楚：摘要卡 attrib=all 是会话粒度，attrib=facts 才回到轮粒度（不能混为一谈）
const granularity = SUMMARY_CARDS
  ? (SESSION_CARDS ? 'session+summary' : (SUMMARY_ATTRIB === 'facts' ? 'turn+summary-facts' : 'summary(all)'))
  : (SESSION_CARDS ? 'session' : 'turn');
const out = ({
  sample: sample.sample_id,
  cards: cards.length,
  cardKinds: { turn: cards.filter((c) => !c.session).length, session: cards.filter((c) => c.session && !c.summary).length, summary: cards.filter((c) => c.summary).length },
  sessions: sessKeys.length,
  qaTotal: qaAll.length,
  qaScored: scored,
  top: TOP,
  categoryFilter: CATS,
  recallAtK: pct(hitSum, scored),
  mainRecallAtK: pct(mainHit, mainN),
  mainScored: mainN,
  // exact 判据（2026-11-19 修正）：按 tag 精确比较，不再用子串；与 loose 同时输出便于对账
  recallAtKExact: pct(exactHitSum, scored),
  mainRecallAtKExact: pct(mainExactHit, mainN),
  mrrExact: scored ? +(exactMrrSum / scored).toFixed(4) : null,
  falseHitCount,
  falseHitRate: pct(falseHitCount, scored),
  adversarialRecallAtK: pct(adv.hit, adv.n),
  adversarialScored: adv.n,
  adversarialShare: scored ? +(adv.n / scored).toFixed(3) : null,
  granularity,
  window: WINDOW,
  summaryAttrib: SUMMARY_CARDS ? SUMMARY_ATTRIB : null,
  sessionHitRate: scored ? +(sessionHits / scored).toFixed(3) : null,
  summaryHitRate: scored ? +(summaryHits / scored).toFixed(3) : null,
  turnOnlyRecallAtK: pct(turnHits, scored),
  turnHits,
  mrr: scored ? +(mrrSum / scored).toFixed(4) : null,
  emptyResultRate: pct(emptyReturned, qa.length),
  byCategory: Object.fromEntries([...byCat].sort().map(([k, v]) => [k, { n: v.n, recall: pct(v.hit, v.n) }])),
  byCategoryExact: Object.fromEntries([...byCat].sort().map(([k, v]) => [k, { n: v.n, recall: pct(v.exact, v.n) }])),
  sessionCards: cards.filter((c) => c.session && !c.summary).length,
  sessionHits,
  summaryCards: cards.filter((c) => c.summary).length,
  summaryHits,
  missSamples: misses,
});
return out;
}
if (RUN_ALL) {
  const rows = [];
  for (const smp of samples) { const r = runSample(smp); rows.push(r); console.error('[done] ' + r.sample + ' recall@' + r.top + '=' + r.recallAtK + ' exact=' + r.recallAtKExact); }
  const scored = rows.reduce((a, r) => a + r.qaScored, 0);
  const weighted = rows.reduce((a, r) => a + (r.recallAtK || 0) * r.qaScored, 0) / (scored || 1);
  const mainScored = rows.reduce((a, r) => a + (r.mainScored || 0), 0);
  const mainWeighted = rows.reduce((a, r) => a + (r.mainRecallAtK || 0) * (r.mainScored || 0), 0) / (mainScored || 1);
  const mainWeightedExact = rows.reduce((a, r) => a + (r.mainRecallAtKExact || 0) * (r.mainScored || 0), 0) / (mainScored || 1);
  const exactWeighted = rows.reduce((a, r) => a + (r.recallAtKExact || 0) * r.qaScored, 0) / (scored || 1);
  const falseHits = rows.reduce((a, r) => a + (r.falseHitCount || 0), 0);
  const advScored = rows.reduce((a, r) => a + (r.adversarialScored || 0), 0);
  const advWeighted = rows.reduce((a, r) => a + (r.adversarialRecallAtK || 0) * (r.adversarialScored || 0), 0) / (advScored || 1);
  const cats = {};
  const catsExact = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.byCategory)) { cats[k] = cats[k] || { n: 0, hit: 0 }; cats[k].n += v.n; cats[k].hit += (v.recall || 0) / 100 * v.n; }
    for (const [k, v] of Object.entries(r.byCategoryExact)) { catsExact[k] = catsExact[k] || { n: 0, hit: 0 }; catsExact[k].n += v.n; catsExact[k].hit += (v.recall || 0) / 100 * v.n; }
  }
  const summary = { run: 'all', samples: rows.length, qaScored: scored, weightedRecallAtK: +weighted.toFixed(1),
    weightedRecallAtKExact: +exactWeighted.toFixed(1),
    mainWeightedRecallAtK: +mainWeighted.toFixed(1), mainWeightedRecallAtKExact: +mainWeightedExact.toFixed(1), mainScored,
    falseHitCount: falseHits, falseHitRate: scored ? +(falseHits / scored * 100).toFixed(1) : null,
    adversarialWeightedRecallAtK: +advWeighted.toFixed(1), adversarialScored: advScored,
    granularity: SUMMARY_CARDS
      ? (SESSION_CARDS ? 'session+summary' : (SUMMARY_ATTRIB === 'facts' ? 'turn+summary-facts' : 'summary(all)'))
      : (SESSION_CARDS ? 'session' : 'turn'),
    window: WINDOW,
    summaryAttrib: SUMMARY_CARDS ? SUMMARY_ATTRIB : null,
    summaryCards: rows.reduce((a, r) => a + (r.summaryCards || 0), 0),
    summaryHits: rows.reduce((a, r) => a + (r.summaryHits || 0), 0),
    byCategory: Object.fromEntries(Object.entries(cats).sort().map(([k, v]) => [k, { n: v.n, recall: +(v.hit / (v.n || 1) * 100).toFixed(1) }])),
    byCategoryExact: Object.fromEntries(Object.entries(catsExact).sort().map(([k, v]) => [k, { n: v.n, recall: +(v.hit / (v.n || 1) * 100).toFixed(1) }])),
    perSample: rows.map(r => ({ sample: r.sample, cards: r.cards, qa: r.qaScored, recall: r.recallAtK, recallExact: r.recallAtKExact, mainRecall: r.mainRecallAtK, mainRecallExact: r.mainRecallAtKExact, falseHits: r.falseHitCount, sessionHitRate: r.sessionHitRate, summaryHitRate: r.summaryHitRate, mrr: r.mrr })),
    provenance: provenance() };
  console.log(JSON.stringify(summary, null, 2));
  // 文件名带参数，否则扫参会互相覆盖（默认参数沿用旧名，不破坏已存结果）
  const isDefaultSum = SUMMARY_CARDS && !SUM_SHUFFLE && SUM_FACTS === 8 && SUM_TOPICS === 6;
  const sumTag = !SUMMARY_CARDS ? ''
    : (isDefaultSum ? (SUMMARY_ATTRIB === 'facts' ? '-sumfacts' : '-summary')
      : (SUM_SHUFFLE ? '-sumshuffle' : `-sum-f${SUM_FACTS}t${SUM_TOPICS}`) + (SUMMARY_ATTRIB === 'facts' ? '-facts' : ''));
  const tag = (SESSION_CARDS ? '-session' : '-turn') + (WINDOW > 0 ? '-w' + WINDOW : '') + sumTag;
  if (!process.argv.includes('--no-save')) fs.writeFileSync(path.join(__dirname, 'result-' + new Date().toISOString().slice(0,10) + tag + '.json'), JSON.stringify({ summary, rows }, null, 2), 'utf8');
} else {  console.log(JSON.stringify(runSample(samples[0]), null, 2));
}
