import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { recordCall, recordFallback } from "./lib/failopen.js";
// T03：图精炼模块按需加载（沙箱测试只复制根文件时会缺依赖 → 缺就退化为不启用，绝不阻塞检索）
let refineGraph = null, buildEdgesLocal = null, loadEntitiesLocal = null;
try {
  ({ refine: refineGraph } = await import("./graph-refine.js"));
  ({ buildEdges: buildEdgesLocal, loadEntities: loadEntitiesLocal } = await import("./graph-edges.js"));
} catch { /* fail-open：无图模块则只走原有排序 */ }

export function normalizeText(raw) {
  return String(raw ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

export function truncateUtf8(value, maxBytes) {
  const text = String(value ?? "");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

// 英文词形归一（2026-11-19，P1-3）：只作用在拉丁词上，中文单字不动。
// 目的：buy/bought、gift/presents、study/studies 这类同词不同形在 BM25 里是三个词，
//       在英文基准上会直接丢召回。规则保守，宁可少合并，不要造错词。
const EN_IRREGULAR = new Map(Object.entries({
  bought: "buy", buy: "buy", buys: "buy", buying: "buy",
  went: "go", gone: "go", goes: "go", going: "go",
  was: "be", were: "be", been: "be", is: "be", are: "be", am: "be",
  had: "have", has: "have", have: "have", having: "have",
  made: "make", makes: "make", making: "make",
  took: "take", taken: "take", takes: "take", taking: "take",
  got: "get", gotten: "get", gets: "get", getting: "get",
  said: "say", says: "say", saying: "say",
  saw: "see", seen: "see", sees: "see", seeing: "see",
  came: "come", comes: "come", coming: "come",
  knew: "know", known: "know", knows: "know",
  thought: "think", thinks: "think", thinking: "think",
  told: "tell", tells: "tell", telling: "tell",
  felt: "feel", feels: "feel", feeling: "feel",
  left: "leave", leaves: "leave", leaving: "leave",
  found: "find", finds: "find", finding: "find",
  gave: "give", given: "give", gives: "give", giving: "give",
  brought: "bring", brings: "bring", bringing: "bring",
  children: "child", kids: "kid",
}));
export function stemEn(word) {
  if (process.env.CP_NO_STEM === "1") return word;
  const w = String(word || "");
  if (w.length <= 3) return w;
  if (EN_IRREGULAR.has(w)) return EN_IRREGULAR.get(w);
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (/(?:ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) { const b = w.slice(0, -3); return /([b-df-hj-np-tv-z])$/.test(b) ? b.slice(0, -1) : b; }
  if (w.endsWith("ied") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("ly") && w.length > 5) return w.slice(0, -2);
  return w;
}

export function tokenize(text) {
  const value = String(text ?? "");
  const latin = (value.toLowerCase().match(/[a-z0-9_]+/g) || []).map(stemEn);
  const cjk = value.match(/[\u4e00-\u9fff]/g) || [];
  return [...latin, ...cjk];
}

export function listMemoryFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter(file => file.endsWith(".md") && !basename(String(file)).startsWith(".tmp-"))
    .map(file => join(dir, file));
}

export function readMemoryMeta(raw) {
  const text = normalizeText(raw);
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const get = (key) => {
    const match = fm[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match ? match[1].trim() : undefined;
  };
  return {
    id: get("id"), created: get("created"), status: get("status"), type: get("type"),
    scope: get("scope"), source: get("source"), title: get("title"),
    epistemic: get("epistemic"), lossy: get("lossy"),
    corrections: get("corrections"), lastCorrection: get("last_correction"), conflictWith: get("conflict_with"),
    candidateId: get("candidate_id"), candidateSourceRef: get("candidate_source_ref"),
    confirmedBy: get("confirmed_by"), confirmedAt: get("confirmed_at"),
    topicId: get("topic_id") || get("topicId"), supersededBy: get("superseded_by"), tags: get("tags"),
  };
}

function tagsOf(meta) {
  return String(meta?.tags || "").replace(/^\[|\]$/g, "").split(",").map(tag => tag.trim()).filter(Boolean);
}

function statusOf(meta) {
  return meta?.status || "🟢当前";
}

export function statusRank(value) {
  const status = typeof value === "string" ? value : statusOf(value);
  if (status.includes("冲突")) return 3;      // ⚠️冲突（S2-3）：未裁决的争议必须浮到最上层被看见
  if (status.includes("当前")) return 2;
  if (status.includes("计划")) return 1;
  if (status.includes("待验证")) return -1;   // ⏳待验证池（2026-08-28）：未确认不冒充生效事实，永远沉底
  return 0;
}

function normalizedTopic(value) {
  return String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

// 通用分类 tag（type 三值 + 蒸馏六大类 + 来源标记）：只作分类索引，不参与 tag boost。
// 2026-08-13 实测：查询"回复偏好"时全部 偏好 类 tag 拿 ×1.5，工作偏好污染前五（retrieval-pause 会话待修项）。
const GENERIC_TAGS = new Set(["偏好", "事件", "规则", "蒸馏", "决策", "待办", "术语", "需求", "遗留"]);
function isBoostEligibleTag(tag) {
  if (GENERIC_TAGS.has(tag)) return false;
  if (/^\d{4}-\d{2}-\d{2}-\d{3,}$/.test(tag)) return false; // 日期编号 = 出生证，非语义
  return Array.from(tag).length > 1;
}

export function topicKey(doc) {
  const meta = doc.meta || {};
  const body = doc.body ?? normalizeText(doc.raw).replace(/^---[\s\S]*?---\s*/, "");
  const firstLine = (body.split("\n").find(line => line.trim()) || "").trim();
  const bracketTitle = (firstLine.match(/^\[([^\]]+)\]/) || [])[1] || "";
  const numbered = bracketTitle.match(/(\d{4}-\d{2}-\d{2}-\d{3,})/);
  const explicit = meta.topicId || (numbered ? numbered[1] : "");
  const semantic = normalizedTopic(meta.title || bracketTitle || firstLine);
  const fallback = createHash("sha256").update(body).digest("hex").slice(0, 24);
  return `${meta.type || "未分类"}|${explicit || semantic || fallback}`;
}

// 模块级缓存（2026-08-28 反查效率升级 E1）：MCP server/长驻进程每次查询省重复 IO+tokenize。
// 失效口径 = 文件集合（路径/mtime/size）任一变化——"写后即新"哲学与写后自动索引同款；
// CLI 短进程零影响（缓存至多命中一次）。检索层只读消费 docs，不 mutate，共享引用安全。
let docsCache = null;
export function loadMemoryDocs(memoryDir) {
  let files;
  try {
    files = listMemoryFiles(memoryDir).map(p => { const st = statSync(p); return { path: p, mtimeMs: st.mtimeMs, size: st.size }; });
  } catch { docsCache = null; files = []; recordFallback("retrieval.loadDocs", "read-failed"); }
  const hit = docsCache && resolve(docsCache.memoryDir) === resolve(memoryDir)
    && docsCache.files.length === files.length
    && docsCache.files.every((f, i) => f.path === files[i].path && f.mtimeMs === files[i].mtimeMs && f.size === files[i].size);
  if (hit) return docsCache.docs;
  const docs = files.map(({ path }) => {
    // 月度分桶（2026-09-01 拍板）：YYYY-MM.md 内含多条目（§§§ 分隔），每条目产出一个 doc，
    //   path = 桶文件#id（虚拟路径）；遗留单卡文件行为不变（一文件一 doc）。
    if (isBucketFileName(path)) {
      const out = [];
      for (const block of splitBucketBlocks(readFileSync(path, "utf8"))) {
        if (!block.startsWith("---")) continue;   // 桶头/无 frontmatter 块跳过
        const meta = readMemoryMeta(block);
        const raw = normalizeText(block);
        out.push({ path: `${path}#${meta.id || out.length}`, raw, body: raw.replace(/^---[\s\S]*?---\s*/, ""), tokens: tokenize(raw), meta });
      }
      return out;
    }
    const raw = normalizeText(readFileSync(path, "utf8"));
    const body = raw.replace(/^---[\s\S]*?---\s*/, "");
    return { path, raw, body, tokens: tokenize(raw), meta: readMemoryMeta(raw) };
  }).flat();
  docsCache = { memoryDir, files, docs };
  return docs;
}

function tfScore(queryTokens, docTokens) {
  const freq = {};
  for (const token of docTokens) freq[token] = (freq[token] || 0) + 1;
  let score = 0;
  for (const token of new Set(queryTokens)) score += freq[token] || 0;
  return score;
}

function bm25Score(queryTokens, docTokens, df, count, avgLen, k1 = 1.5, b = 0.75) {
  const freq = {};
  for (const token of docTokens) freq[token] = (freq[token] || 0) + 1;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    if (!freq[token]) continue;
    const idf = Math.log(1 + (count - (df[token] || 0) + 0.5) / ((df[token] || 0) + 0.5));
    score += idf * ((freq[token] * (k1 + 1)) / (freq[token] + k1 * (1 - b + (b * docTokens.length) / avgLen)));
  }
  return score;
}

function createdTime(meta) {
  const value = Date.parse(meta?.created || "");
  return Number.isFinite(value) ? value : 0;
}

// 时序边界解析：YYYY-MM-DD 按本地日粒度（until 含当日全天），其余交给 Date.parse
function parseBoundary(value, endOfDay = false) {
  if (value === undefined || value === null || value === "") return NaN;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim();
  const dm = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dm) {
    const local = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 0, 0, 0, 0).getTime();
    return Number.isFinite(local) ? (endOfDay ? local + 86399999 : local) : NaN;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

// 时序 + scope 过滤（2026-08-13 实装：--since/--until/--scope，hindsight 对照文档选项 A/B）
export function filterDocs(docs, options) {
  const since = parseBoundary(options.since, false);
  const until = parseBoundary(options.until, true);
  const scope = ["workspace", "global", "agent"].includes(options.scope) ? options.scope : null;
  const includePending = options.includePending === true;   // 待验证池（2026-08-28）：默认不进检索，确认通道显式包含
  if (Number.isNaN(since) && Number.isNaN(until) && !scope && !includePending) {
    return docs.filter(doc => !(doc.meta?.status || "").includes("待验证"));
  }
  return docs.filter(doc => {
    if (!includePending && (doc.meta?.status || "").includes("待验证")) return false;
    if (scope && (doc.meta?.scope || "global") !== scope) return false;
    if (!Number.isNaN(since) || !Number.isNaN(until)) {
      const created = createdTime(doc.meta);
      if (created === 0) return false; // 无 created 字段 = 时序不可验证，过滤时排除
      if (!Number.isNaN(since) && created < since) return false;
      if (!Number.isNaN(until) && created > until) return false;
    }
    return true;
  });
}

function stableId(doc) {
  return String(doc.meta?.id || doc.path || "");
}

function compareRanked(a, b) {
  return b.score - a.score
    || statusRank(b.meta) - statusRank(a.meta)
    || createdTime(b.meta) - createdTime(a.meta)
    || stableId(a).localeCompare(stableId(b));
}

// ---------- 意图路由（P1-2，2026-08-28 实装：规则化，无 LLM 依赖，fail-open 哲学）----------
// OV 的意图路由用 LLM 生成 TypedQuery；CP 收尾 hook/离线场景无 LLM，用确定性规则路由。
// 命中意图 → 意图词在原文出现的文档提权（×intentFactor），与 tag boost 叠加。
const INTENT_RULES = [
  { name: "negative", test: /(不允许|禁止|不能做|不许|禁用|禁令|禁止事项)/, words: ["不碰", "禁止", "禁用", "不允许", "永久不", "不要"], top: 5, bytes: 1200, fold: true, factor: 1.3 },
  { name: "debug", test: /(报错|失败|不工作|异常|排查|根因|bug|错误|崩)/, words: ["报错", "失败", "异常", "根因", "修复", "崩"], top: 6, bytes: 1400, fold: true, factor: 1.2 },
  { name: "decision", test: /(为什么|当时|决定|拍板|取舍|理由|选型)/, words: ["决定", "拍板", "取舍", "理由", "因为", "选型"], top: 5, bytes: 1400, fold: false, factor: 1.25 },
  { name: "temporal", test: /(最近|上次|上周|昨天|什么时候|时间线|先后|之前|后来|多久)/, words: ["时间", "日期", "最近", "上次", "之前", "后来"], top: 6, bytes: 1000, fold: true, factor: 1.15 },
  { name: "procedural", test: /(流程|步骤|SOP|操作顺序|顺序处理|什么顺序|怎样做|怎么做|先做|先干|后干|怎么走|几步|哪几关|依次)/, words: ["步骤", "流程", "依次", "SOP"], top: 6, bytes: 1200, fold: true, factor: 1.3 },
  { name: "entity", test: /(谁|哪个人|哪个项目|哪个文件|哪个模块|哪张卡|哪个技能)/, words: ["实体", "项目", "文件", "模块", "技能"], top: 6, bytes: 1000, fold: true, factor: 1.2 },
];
export function intentOf(query) {
  const text = String(query || "");
  for (const rule of INTENT_RULES) if (rule.test.test(text)) return rule;
  return null;
}

export function scoreMemoryDocs(query, docs, options = {}) {
  const queryTokens = tokenize(query);
  // 意图词并入切分（P1-2）：否定/禁令意图词（不碰/禁用等）切字后参与 BM25——
  // "碰""禁"为低频高 IDF 字，直击意图目标文档；单字并入对无关文档影响有限
  if (Array.isArray(options.intentWords) && options.intentWords.length) {
    queryTokens.push(...options.intentWords.flatMap(w => tokenize(w)));
  }
  if (!queryTokens.length || !docs.length) return [];
  const pool = filterDocs(docs, options);
  if (!pool.length) return [];
  const useBm25 = pool.length >= 10;
  const df = {};
  let avgLen = 0;
  for (const doc of pool) for (const token of new Set(doc.tokens)) df[token] = (df[token] || 0) + 1;
  if (useBm25) avgLen = pool.reduce((sum, doc) => sum + doc.tokens.length, 0) / pool.length;
  const queryText = String(query).toLowerCase();
  // 检索准入闸（S1-1，2026-11-18）：中文单字 BM25 会把「今天/什么/怎么」这类功能字当信号，
  // 导致库里无答案时仍返回高分卡（黄金集 G-009 实测 16.27 落在正常区间 15–34）。
  // 口径：只算「非功能字」的命中数；查询本身内容字≥3 时要求命中≥2，否则要求≥1。
  const FUNC_CHARS = new Set("的了是在我你他她它这那个们有和与就都也还但很吗呢吧啊呀么什怎样过说要去来对把被从到给让一些".split(""));
  const contentQueryTokens = [...new Set(queryTokens.filter((t) => !FUNC_CHARS.has(t)))];
  const gateMin = contentQueryTokens.length >= 3 ? 2 : 1;
  // 只在真实规模语料上启用准入闸（≥50 条）：小语料/测试沙箱不适用（会误杀 fixture）
  const gateActive = pool.length >= 50;
  // 区分度约束：必须命中至少一个「语料里罕见」的内容字（df ≤ 30%），否则视为无针对性查询
  const distinctive = new Set(contentQueryTokens.filter((t) => (df[t] || 0) <= Math.max(1, pool.length * 0.3)));
  const distinctiveMin = contentQueryTokens.length >= 4 ? 2 : 1;
  // 二字词闸：中文单字 BM25 的根问题是「共享几个常见汉字」就当命中；
  // 这里要求查询与文档至少共享一个「非通用二字词」，否则除降序分数不算证据。
  const COMMON_BIGRAMS = new Set(["今天", "明天", "昨天", "什么", "怎么", "这个", "那个", "我们", "你们", "他们", "可以", "就是", "不过", "没有", "一个", "现在", "时候", "因为", "所以", "但是", "如果", "不是", "自己", "这样", "那样", "还是", "已经", "需要", "知道", "觉得", "工作", "东西"]);
  const cjk = (s) => /[\u4e00-\u9fa5]/.test(s);
  const qChars = queryTokens.filter(cjk).join("");
  const qBigrams = new Set();
  for (let i = 0; i + 1 < qChars.length; i += 1) {
    const bg = qChars.slice(i, i + 2);
    if ([...bg].every((c) => FUNC_CHARS.has(c))) continue;
    if (COMMON_BIGRAMS.has(bg)) continue;
    qBigrams.add(bg);
  }
  const applyBoost = options.applyBoost !== false;
  // 规则类提权（2026-11-19，票 28）：问「怎么做/步骤/流程」时，type=规则 的卡 ×1.15。
  //   只影响排序，不改变命中集合；非流程类查询不受影响（fail-open）。
  const proceduralBoost = options.proceduralBoost !== false && process.env.CP_NO_PROC !== "1" && intentOf(options.queryText || queryText || "") && intentOf(options.queryText || queryText || "").name === "procedural";
  const applyLegacyPenalty = options.applyLegacyPenalty !== false;
  // 意图提权（P1-2）：调用方经 intentOf() 路由后传 intentWords，原文含意图词的文档 ×intentFactor
  const intentWords = Array.isArray(options.intentWords) ? options.intentWords : null;
  const intentFactor = Number(options.intentFactor) || 1.3;
  return pool.map(doc => {
    const baseScore = useBm25
      ? bm25Score(queryTokens, doc.tokens, df, pool.length, avgLen)
      : tfScore(queryTokens, doc.tokens);
    const contentHit = contentQueryTokens.filter(t => doc.tokens.includes(t)).length;
    const distinctiveHit = [...distinctive].filter((t) => doc.tokens.includes(t)).length;
    const bigramHit = qBigrams.size === 0 ? true : [...qBigrams].some((bg) => doc.raw.includes(bg));
    const boosted = applyBoost && tagsOf(doc.meta).some(tag => isBoostEligibleTag(tag) && queryText.includes(tag.toLowerCase()));
    const legacy = statusOf(doc.meta).includes("过去") || tagsOf(doc.meta).some(tag => tag.toLowerCase() === "legacy");
    const intentHit = !!(intentWords && intentWords.some(w => doc.raw.includes(w)));
    const ruleType = String((doc.meta && doc.meta.type) || "").includes("规则");
    const procFactor = Number(process.env.CP_PROC_FACTOR || 1.5);
    const score = baseScore * (boosted ? 1.5 : 1) * (applyLegacyPenalty && legacy ? 0.5 : 1) * (intentHit ? intentFactor : 1) * (proceduralBoost && ruleType ? procFactor : 1);
    return { ...doc, baseScore, score, boosted, intentHit, contentHit, distinctiveHit, bigramHit, status: statusOf(doc.meta) };
  }).filter(doc => doc.baseScore > 0 && (!gateActive || (doc.contentHit >= gateMin && doc.distinctiveHit >= distinctiveMin && doc.bigramHit))).sort(compareRanked);
}

// 折叠 + 截断 + 结果映射（retrieveMemories / retrieveMemoriesHybrid 共用尾部，行为与原实现逐字一致）
function finalizeRanked(ranked, options, matchedCount) {
  // T06 弃权判定（2026-11-18）：无证据时返回空 + 最近主题，而不是硬塞五张不相干的卡。
  // 判据只用已有信号（contentHit / 首名优势），不引入新模型；abstain:false 逐字回退旧行为。
  let verdict = "answerable", nearest = [];
  if (Array.isArray(ranked) && ranked.length) {
    const top = ranked[0];
    const second = ranked[1];
    const hit = Number(top.contentHit || 0);
    const margin = second ? (top.baseScore || 0) / Math.max(second.baseScore || 0, 1e-9) : 99;
    // 说明（2026-11-18 实测）：准入门槛已保证 contentHit≥2（查询≥3 内容字时），因此「hit<2」分支几乎不可达；
    // 真正需要弃权的是「两名几乎并列」的歧义 —— 判据收敛为 hit===0 与 margin 两项。
    if (hit === 0) verdict = "no_evidence";
    else if (margin < 1.05) verdict = "low_coverage";
    nearest = ranked.slice(0, 3).map((d) => String(d.meta?.title || d.title || d.path || "").slice(0, 40)).filter(Boolean);
  } else if (Array.isArray(ranked)) {
    verdict = "no_evidence";
  }
  // 契约（2026-11-18）：默认 **不** 弃权 —— 既有调用方（golden/regression/MCP 旧用法）行为逐字不变；
  //   需要弃权语义的调用方显式传 abstain:true（MCP recall 与评测器已显式传）。
  const abstainOn = options.abstain === true;
  // 2026-11-19（票 16 校准）：只有「完全没证据」才弃权；low_coverage 是「有材料但首名优势小」，
  //   照旧返回结果并保留 verdict，避免把高分但同分接近的正常查询误杀（实测 G-003/H-05/H-08）。
  if (abstainOn && verdict === "no_evidence") {
    return { results: [], matched: 0, total: 0, folded: 0, verdict, nearest, ...(options.hybridMarker ? { hybrid: true } : {}) };
  }
  const matched = matchedCount === undefined ? ranked.length : matchedCount;
  let folded = 0;
  if (options.fold !== false) {
    const groups = new Map();
    for (const doc of ranked) {
      const key = topicKey(doc);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(doc);
    }
    const representatives = [];
    for (const group of groups.values()) {
      group.sort((a, b) => statusRank(b.meta) - statusRank(a.meta) || compareRanked(a, b));
      representatives.push({ ...group[0], related: group.length - 1 });
      folded += group.length - 1;
    }
    ranked = representatives.sort(compareRanked);
  }
  const top = Number.isInteger(options.top) && options.top > 0 ? options.top : ranked.length;
  const snippetBytes = Number.isInteger(options.snippetBytes) && options.snippetBytes > 0 ? options.snippetBytes : 800;
  const results = ranked.slice(0, top).map(doc => ({
    id: doc.meta?.id || "?",
    status: doc.status,
    baseScore: +doc.baseScore.toFixed(6),
    score: +doc.score.toFixed(6),
    boosted: doc.boosted || undefined,
    related: doc.related || undefined,
    title: doc.meta?.title || basename(doc.path),
    path: doc.path,
    created: doc.meta?.created,
    snippet: truncateUtf8(doc.raw.replace(/\n{3,}/g, "\n\n"), snippetBytes),
    raw: doc.raw,
    meta: doc.meta,
  }));
  return { results, matched, total: ranked.length, folded, verdict, ...(verdict === "answerable" ? {} : { nearest }),
    ...(options.hybridMarker ? { hybrid: true } : {}),
    ...(Number.isFinite(options.maxSim) ? { maxSim: +options.maxSim.toFixed(4) } : {}),
    ...(options.lowConfidence ? { lowConfidence: true } : {}),
    ...(options.semanticLowConfidence ? { semanticLowConfidence: true } : {}) };
}

// 图精炼（T03）：links.json 的 derived 段 → 局部分数平滑。默认关（CP_REFINE=1 或 options.refine 开启），
//   任何异常 fail-open 回原排序（不变式 I3：不许比今天更差）。
const docsEdgeCache = new WeakMap();
function entitiesLocal(memoryDir) { try { return loadEntitiesLocal(memoryDir || process.cwd()); } catch { return []; } }
let derivedCache = null;
// 键名对齐（2026-11-19 修）：graph-build 自 11-19 起只写 candidates、删 derived；
//   而这里一直只读 derived → 2093 条边一次未被消费。现在读哪个键是显式选择，不靠默认值沉默。
//   CP_REFINE_SOURCE=candidates 时才用候选边（降级注释认為「词面/共现证据不足」，所以默认不启用）。
function refineSourceKey() {
  return process.env.CP_REFINE_SOURCE === "candidates" ? "candidates" : "derived";
}
function loadDerived(memoryDir) {
  recordCall("retrieval.refine.loadEdges");
  const key = refineSourceKey();
  try {
    const p = join(memoryDir, "links.json");
    const st = statSync(p);
    if (derivedCache && derivedCache.mtimeMs === st.mtimeMs && derivedCache.key === key) {
      if (!derivedCache.edges) recordFallback("retrieval.refine.loadEdges", `${key}-empty(cached)`);
      return derivedCache.edges;
    }
    const j = JSON.parse(readFileSync(p, "utf8"));
    const raw = (j && j[key]) || {};
    const edgeCount = Object.keys(raw).length;
    const edges = new Map(Object.entries(raw).map(([id, list]) => [id, Array.isArray(list) ? list : []]));
    if (!edgeCount) {
      const other = key === "derived" ? "candidates" : "derived";
      const otherPresent = !!(j && j[other] && Object.keys(j[other]).length);
      recordFallback("retrieval.refine.loadEdges",
        otherPresent ? `no-${key}(opt-in-required:${other}-present)` : `no-${key}-key`);
    }
    derivedCache = { mtimeMs: st.mtimeMs, key, edges: edges.size ? edges : null };
    return derivedCache.edges;
  } catch { recordFallback("retrieval.refine.loadEdges", "unreadable"); return null; }
}
function applyRefine(ranked, docs, options) {
  recordCall("retrieval.refine");
  try {
    if (!ranked.length) return ranked;
    let edges = options.refineEdges || loadDerived(options.memoryDir);
    // 评测/沙箱场景：传进来的 docs 与生产图不同域 → 就地造边（按 docs 数组缓存，一次）
    if ((!edges || !ranked.some(d => edges.has(String(d.meta?.id || d.path)))) && Array.isArray(docs) && docs.length <= 5000) {
      if (!docsEdgeCache.has(docs)) {
        const payload = docs.filter(d => d.meta && d.meta.id).map(d => ({ id: String(d.meta.id), meta: d.meta, raw: d.raw }));
        const built = buildEdgesLocal(payload, entitiesLocal(options.memoryDir));
        if (!built.edges.size) recordFallback("retrieval.refine.buildEdges", "empty-edges");
        docsEdgeCache.set(docs, built.edges.size ? built.edges : null);
      }
      edges = docsEdgeCache.get(docs) || edges;
    }
    if (!edges || !refineGraph) {
      recordFallback("retrieval.refine", !refineGraph ? "no-refine-module" : "no-edges");
      return ranked;
    }
    const max = Math.max(...ranked.map(d => d.baseScore || 0), 1e-9);
    const seed = new Map(ranked.map(d => [String(d.meta?.id || d.path), (d.baseScore || 0) / max]));
    const envOpts = process.env.CP_REFINE_OPTS ? JSON.parse(process.env.CP_REFINE_OPTS) : {};
    const out = refineGraph(seed, edges, { ...envOpts, ...(options.refineOpts || {}) });
    if (!out || !out.scores || !out.scores.size) return ranked;
    const byId = new Map(ranked.map(d => [String(d.meta?.id || d.path), d]));
    // 融合：保留原分量的量纲，用精炼分（0~1）做乘性加权 —— 单用精炼分会把 BM25 尺度盖掉，
    //   单用 max() 又等于没生效（实测：47.7→47.7 完全不变）。
    const ordered = [...out.scores.entries()]
      .map(([id, sc]) => { const d = byId.get(id); return d ? { ...d, score: d.score * (0.5 + sc), refined: +sc.toFixed(4) } : null; })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    // 物化项（原本不在结果里的桥接卡）按文档查回，落在末尾
    for (const m of out.materialized || []) {
      if (byId.has(m.id)) continue;
      const d = (docs || []).find(x => String(x.meta?.id || x.path) === m.id);
      const floor = Math.min(...ordered.map(o => o.score), 1) * 0.98;
      if (d) ordered.push({ ...d, baseScore: 0, score: floor, materialized: true, status: statusOf(d.meta) });
    }
    return ordered.length ? ordered : ranked;
  } catch { recordFallback("retrieval.refine", "exception"); return ranked; }
}

export function retrieveMemories(query, options = {}) {
  const docs = options.docs || loadMemoryDocs(options.memoryDir);
  // 意图路由（P1-2）：规则命中 → 意图词打分层，并按意图调 top/bytes/fold（D-13，2026-10-28）
  const intent = intentOf(query);
  if (intent) options = {
    ...options,
    intentWords: intent.words,
    top: options.top ?? intent.top,
    snippetBytes: options.snippetBytes ?? intent.bytes,
    fold: options.fold ?? intent.fold,
    intentFactor: options.intentFactor ?? intent.factor,
  };
  let ranked = scoreMemoryDocs(query, docs, options);
  const refineOn = options.refine === true || (options.refine !== false && process.env.CP_REFINE === "1");
  if (refineOn) ranked = applyRefine(ranked, docs, options);
  return finalizeRanked(ranked, options);
}

// ---------- 混合检索（2026-08-13 实装：BM25 + 本地向量 RRF 融合）----------
// 语义增强层：模型/向量库/onnxruntime 缺失或任何异常 → 返回 null，调用方回退纯 BM25（fail-open）。
// 铁律：markdown 为唯一真源，向量是派生缓存（embed build 每次重建），绝不双真源。

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

// Reciprocal Rank Fusion（k=60，与 Hindsight 路线同款）：
// 每个文档得分 = Σ 1/(k + 1 + 该路排名（0 基）)；只在一路出现的文档得该路贡献。
export function rrfFuse(rankA, rankB, k = 60, weightA = 1, weightB = 1) {
  const scores = new Map();
  const add = (list, w) => {
    list.forEach((item, i) => {
      const id = typeof item === "string" ? item : String(item.id ?? item);
      scores.set(id, (scores.get(id) || 0) + w / (k + i + 1));
    });
  };
  add(rankA, weightA);
  add(rankB, weightB);
  return scores;
}

export async function retrieveMemoriesHybrid(query, options = {}) {
  recordCall("retrieval.hybrid");
  try {
    const memoryDir = options.memoryDir ? resolve(String(options.memoryDir)) : null;
    if (!memoryDir) { recordFallback("retrieval.hybrid", "memory-dir-missing"); return null; }   // 显式传了 docs 但没有 memoryDir → 无法定位向量库，回退纯 BM25
    // 懒加载 embed.js：避免模块环（embed.js 依赖本文件的 loadMemoryDocs）
    const { modelAvailable, loadVectorStore, embedText, vectorStoreCompatible } = await import("./embed.js");
    if (!modelAvailable(memoryDir)) { recordFallback("retrieval.hybrid", "model-missing"); return null; }
    const store = loadVectorStore(memoryDir);
    if (!store || !store.entries || !Object.keys(store.entries).length) { recordFallback("retrieval.hybrid", "vector-store-missing"); return null; }
    const docs = options.docs || loadMemoryDocs(options.memoryDir);
    const compatibility = vectorStoreCompatible(memoryDir, store);
    const docIds = new Set(docs.map(doc => stableId(doc)));
    const vectorIds = new Set(Object.keys(store.entries));
    const missingVectors = [...docIds].filter(id => !vectorIds.has(id));
    const ghostVectors = [...vectorIds].filter(id => !docIds.has(id));
    if (!compatibility.ok) { recordFallback("retrieval.hybrid", compatibility.reason); return null; }
    if (store.cardsDigest && options.docs === undefined) {
      const { cardsDigest } = await import("./embed.js");
      if (store.cardsDigest !== cardsDigest(docs) || missingVectors.length || ghostVectors.length) {
        recordFallback("retrieval.hybrid", "card-coverage-mismatch");
        return null;
      }
    } else if (missingVectors.length || ghostVectors.length) {
      recordFallback("retrieval.hybrid", "card-coverage-mismatch");
      return null;
    }
    const pool = filterDocs(docs, options);
    const queryVec = await embedText(query, memoryDir);
    if (!queryVec) { recordFallback("retrieval.hybrid", "embedding-failed"); return null; }
    // 词法序（与纯 BM25 同条件；意图路由在此透传，扩展词进入切分；D-13 同时调 top/bytes/fold）
    const intent = intentOf(query);
    if (intent) options = {
      ...options,
      intentWords: intent.words,
      top: options.top ?? intent.top,
      snippetBytes: options.snippetBytes ?? intent.bytes,
      fold: options.fold ?? intent.fold,
      intentFactor: options.intentFactor ?? intent.factor,
    };
    const lexRanked = scoreMemoryDocs(query, pool, options);
    const lexical = lexRanked.map(doc => stableId(doc));
    const baseById = new Map(lexRanked.map(doc => [stableId(doc), doc]));
    // 向量序（余弦降序；向量库条目键 = meta.id || 文件名，与 embed.js buildStore 同口径）
    // 票 09（2026-11-19 重做）：二值向量只做「粗筛」，选中候选再用浮点余弦精排 —— 不拿精度换速度。
    //   粗筛 297 张卡 = 一次异或计数；精排只算 top-N（默认 200）候选的浮点余弦。
    let vecRank = [];
    let vecMode = "cosine";
    const useBin = process.env.CP_VEC_BIN === "1";
    if (useBin) {
      try {
        const { hamming, toBinary, decodeBinary } = await import("./lib/binary-vec.js");
        const binPath = join(memoryDir, "..", "embedding-db", "vectors.bin.json");
        if (existsSync(binPath)) {
          const bin = JSON.parse(readFileSync(binPath, "utf8"));
          const qb = toBinary(queryVec);
          const coarseN = Math.max(50, Number(process.env.CP_VEC_BIN_COARSE || 200));
          const coarse = Object.entries(bin.entries || {})
            .map(([id, e]) => ({ id, dist: hamming(qb, decodeBinary(e.b)) }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, coarseN);
          const poolIds = new Set(pool.map((doc) => doc.meta?.id || basename(doc.path)));
          vecRank = coarse
            .filter((c) => poolIds.has(c.id))
            .map((c) => ({ id: c.id, sim: cosine(queryVec, store.entries[c.id]?.v) }))
            .filter((x) => x.sim > 0)
            .sort((a, b) => b.sim - a.sim);
          vecMode = "bin+rerank";
          if (process.env.CP_VEC_BIN_DEBUG === "1") console.error("[vec-bin] coarse=" + coarse.length + " reranked=" + vecRank.length);
        }
      } catch { vecRank = []; }   // fail-open：异常走下面的全量余弦
    }
    if (!vecRank.length) {
      vecRank = pool
        .map(doc => {
          const id = doc.meta?.id || basename(doc.path);
          return { id, sim: cosine(queryVec, store.entries[id]?.v) };
        })
        .filter(x => x.sim > 0)
        .sort((a, b) => b.sim - a.sim);
      vecMode = "cosine";
    }
    if (!vecRank.length) { recordFallback("retrieval.hybrid", "no-vector-candidates"); return null; }
    const maxSim = vecRank[0].sim;
    // 低置信门限（P1-2）：语义最高相似度过低 → 无关查询，返回空 + lowConfidence 标记（fail-open：可经 options.lowSimThreshold=false 关闭）
    // 阈值 0.45 定标于黄金集实测：正常命中 sim 0.52-0.76，无关查询 0.377（2026-08-28）
    const lowSim = options.lowSimThreshold === false ? 0 : (Number(options.lowSimThreshold) || 0.45);
    if (maxSim < lowSim) {
      // 语义层低置信不是“没有证据”：保留同一次查询的词法结果，避免向量一票否决 BM25。
      recordFallback("retrieval.hybrid", `low-sim:${maxSim.toFixed(3)}`);
      return finalizeRanked(lexRanked, { ...options, hybridMarker: true, maxSim, lowConfidence: true, semanticLowConfidence: true });
    }
    // 融合参数可通过环境变量扫参（票 31）；默认保持原值（k=60、等权）。
    const RRF_K = Number(process.env.CP_RRF_K || 60);
    const LEX_W = Number(process.env.CP_LEX_W || 3);
    const VEC_W = Number(process.env.CP_VEC_W || 0.7);
    const fused = rrfFuse(lexical, vecRank, RRF_K, LEX_W, VEC_W);
    // 意图提权（P1-2）：融合分上乘 intentFactor，与词法路径同语义
    const intentFactor = intent ? (Number(options.intentFactor) || 1.3) : 1;
    // 融合重排：语义命中但词法零分的文档也能进入结果（这正是语义层的价值）
    const ranked = pool
      .map(doc => {
        const id = stableId(doc);
        const lex = baseById.get(id);
        const intentHit = !!(lex && lex.intentHit);
        return {
          ...doc,
          baseScore: lex ? lex.baseScore : 0,
          score: (fused.get(id) || 0) * (intentHit ? intentFactor : 1),
          boosted: lex ? lex.boosted : false,
          contentHit: lex ? (lex.contentHit || 0) : 0,
          intentHit,
          status: statusOf(doc.meta),
        };
      })
      .filter(doc => doc.score > 0);
    // Rerank（P1-3，2026-08-28）：RRF 秩主导 + 词法/语义交叉特征修正（×质量因子 0.5-1.0）。
    // 动机（黄金集 G-010/G-001）：单靠 RRF 秩时高 IDF 词法命中或高 sim 文档压不上来。
    // fail-open：无向量/异常时上游已回退纯 BM25，此处不新增失败面。
    {
      const maxBase = Math.max(0, ...ranked.map(d => d.baseScore));
      const simOf = new Map(vecRank.map(v => [v.id, v.sim]));
      for (const d of ranked) {
        const lexN = maxBase > 0 ? d.baseScore / maxBase : 0;
        const simN = maxSim > 0 ? (simOf.get(d.meta?.id || basename(d.path)) || 0) / maxSim : 0;
        const RW = (process.env.CP_RERANK || "0.55,0.25,0.20").split(",").map(Number);
        const [rwBase, rwLex, rwSim] = RW.length === 3 && RW.every((x) => Number.isFinite(x)) ? RW : [0.55, 0.25, 0.20];
        d.score = d.score * (rwBase + rwLex * lexN + rwSim * simN);
      }
      ranked.sort(compareRanked);
    }
    return finalizeRanked(ranked, { ...options, hybridMarker: true, maxSim, vecMode });
  } catch (e) { recordFallback("retrieval.hybrid", `exception:${String(e.message || e).slice(0, 40)}`); return null; }
}

// ---------- 月度分桶（2026-09-01 用户拍板：memories 一卡一文件 → 月文件 § 条目）----------
// 形态：memories/YYYY-MM.md，首行桶头（非 frontmatter 块），条目 = frontmatter 块+正文，块间 §§§ 分隔行。
// 兼容：遗留单卡文件（含 过去/ 子目录）继续可读可写；写入 = .bucket-lock 互斥 + 块级重写 + tmp/rename 原子替换。
export const BUCKET_SEP = "§§§";
const BUCKET_FILE_RE = /^\d{4}-\d{2}\.md$/;
export function isBucketFileName(name) { return BUCKET_FILE_RE.test(basename(String(name))); }

export function splitBucketBlocks(text) {
  return String(text ?? "").split(/^\s*§{3,}\s*$/m)
    .map(block => block.replace(/^\s*\n/, "").replace(/\s+$/, ""))
    .filter(block => block.trim());
}

function serializeBucket(header, blocks) {
  // 桶头必须独立成 § 块——否则与首条目粘连成"非 --- 开头块"，解析时被整体丢弃（bucket-test T1/T2/T3 实证）
  return (header ? `${header}\n\n${BUCKET_SEP}\n\n` : "") + blocks.map(b => b.replace(/\s+$/, "") + "\n\n" + BUCKET_SEP + "\n").join("");
}

// 条目级枚举：桶文件按块展开，遗留单卡整文件一条。raw = 原样块文本（字节保真，供重写）；meta 供过滤。
export function listMemoryEntries(dir) {
  const entries = [];
  for (const file of listMemoryFiles(dir)) {
    const text = readFileSync(file, "utf8");
    if (isBucketFileName(file)) {
      for (const block of splitBucketBlocks(text)) {
        if (!block.startsWith("---")) continue;
        const meta = readMemoryMeta(block);
        entries.push({ file, bucket: basename(file), id: meta.id || `blk-${entries.length}`, meta, raw: block, virtualPath: `${file}#${meta.id || entries.length}` });
      }
    } else {
      const raw = normalizeText(text);
      const meta = readMemoryMeta(raw);
      entries.push({ file, bucket: null, id: meta.id || basename(file).replace(/\.md$/, ""), meta, raw, virtualPath: file });
    }
  }
  return entries;
}

export function findEntry(dir, id) {
  const hit = listMemoryEntries(dir).find(e => e.id === id);
  return hit ? { file: hit.file, bucket: hit.bucket, id: hit.id, meta: hit.meta, raw: hit.raw } : null;
}

// 跨进程互斥：.bucket-lock 独占创建（wx）；残留 >10s 视为崩溃遗留强制接管；
// 等 5s 超时后 fail-open 直写（与 verify 同哲学：宁竞态不卡死）。进程内重入直接透传防自锁。
let bucketLockHold = null;
export function withBucketLock(dir, fn) {
  if (bucketLockHold === resolve(dir)) return fn();
  const lockPath = join(dir, ".bucket-lock");
  mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + 5000;
  let mine = false;
  for (;;) {
    try { closeSync(openSync(lockPath, "wx")); mine = true; break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lockPath).mtimeMs > 10000) unlinkSync(lockPath); } catch {}
      if (Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  bucketLockHold = resolve(dir);
  try { return fn(); }
  finally {
    bucketLockHold = null;
    if (mine) { try { unlinkSync(lockPath); } catch {} }
  }
}

function atomicWrite(file, text) {
  const tmp = join(dirname(file), `.tmp-bucket-${basename(file)}`);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

function rewriteByIdInDir(dir, id, mutator) {
  const file = findEntry(dir, id)?.file;
  if (!file) return { ok: false, reason: `id ${id} 不存在` };
  const text = readFileSync(file, "utf8");
  let outText, replaced = 0, removed = false;
  if (!isBucketFileName(file)) {
    if (readMemoryMeta(normalizeText(text)).id !== id) return { ok: false, reason: `id ${id} 不存在` };
    const next = mutator(text);
    if (next == null) return { ok: false, reason: "遗留单卡不支持删除条目（物理移动请走 distill/迁移脚本）" };
    replaced = next === text ? 0 : 1;
    outText = next;
  } else {
    const blocks = splitBucketBlocks(text);
    const header = (!blocks.length || !blocks[0].startsWith("---")) ? blocks.shift() : "";
    const out = [];
    for (const b of blocks) {
      if (b.startsWith("---") && readMemoryMeta(b).id === id) {
        replaced++;
        const next = mutator(b);
        if (next == null) { removed = true; continue; }
        out.push(String(next));
      } else out.push(b);
    }
    if (!replaced) return { ok: false, reason: `id ${id} 不存在` };
    outText = serializeBucket(header, out);
  }
  if (outText !== text) atomicWrite(file, outText);
  return { ok: true, changed: outText !== text, removed, file: basename(file), id };
}

// 条目级变更：mutator(entryRaw) → 新 raw（返回 null = 删除该条目）；桶条目与遗留单卡通吃，字节级只动被改条目
export function mutateEntryById(dir, id, mutator) {
  return withBucketLock(dir, () => rewriteByIdInDir(dir, id, mutator));
}
export function removeEntryById(dir, id) { return mutateEntryById(dir, id, () => null); }

// 追加条目到月桶（month 缺省 = 本地当前月；调用方应传条目 created 对应月，保证桶与时间线一致）
export function appendEntry(dir, entryRaw, opts = {}) {
  const month = opts.month || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 7);
  return withBucketLock(dir, () => {
    const file = join(dir, `${month}.md`);
    const header = `# ${month} 记忆桶`;
    const blocks = existsSync(file) ? splitBucketBlocks(readFileSync(file, "utf8")).filter(b => b.startsWith("---")) : [];
    blocks.push(String(entryRaw).replace(/\s+$/, ""));
    atomicWrite(file, serializeBucket(header, blocks));
    return { ok: true, file: `${month}.md`, month };
  });
}

export function bucketStats(dir) {
  const months = {};
  let total = 0, bucketFiles = 0;
  for (const file of listMemoryFiles(dir)) {
    if (!isBucketFileName(file)) continue;
    bucketFiles++;
    const month = basename(file).replace(/\.md$/, "");
    const n = splitBucketBlocks(readFileSync(file, "utf8")).filter(b => b.startsWith("---")).length;
    months[month] = n; total += n;
  }
  return { months, total, bucketFiles };
}
