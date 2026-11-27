#!/usr/bin/env node
/**
 * memory-cli.js — 宇宙幻影引擎 CLI（10 命令契约，v3.0 §5.1）
 *
 * 命令:
 *   search <q> [--top N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--scope global|workspace]
 *                                 检索（BM25，中文单字切分，<500 条够用；时序/scope 过滤 2026-08-13 实装）
 *   add <content> [--scope S] [--tags T1,T2] [--type 偏好|事件|规则] [--source SRC]
 *                                 写入条目（前置 validate 三层校验；吸收点A：写前查重候选提示）
 *   log --transcript <f> [--session id]   写强制入口（转发 log_turn.js 逻辑）
 *   inject --hint <ctx> [--top N]         读强制入口（转发 inject.js 逻辑）
 *   import --from <dir>           导入既有记忆目录（只读拷贝 + source 指针）
 *   index                         全量重建索引（memory-index.db，JSON，可重建非真源）
 *   verify                        全库审计（调 validate audit + 索引一致性 + 吸收台账）
 *   distill [--days 30]           归档超期 daily（物理不删，移入 distilled/）；🕰️ 记忆卡不再移出检索池（2026-09-15 用户拍板）
 *   maintain                      一站式：index + distill + project-version + mirror
 *   project-version               项目根 .version 更新（ADR-001 层2，收尾/maintain 调用）
 *   stats                         统计 {total, byScope, byStatus, dbBytes}
 *   quota                         注入/记忆各预算点占用一键聚合（身份卡/胶囊双通道/recall/AGENTS 注入/CONTEXT 新鲜度）
 *   expand --memory <条目id|路径> | --session <会话> | --evt <cp-evt锚点> [--bytes N] [--tool-calls]
 *                                 渐进展开（2026-08-31）：L1 命中 → L2 会话上下文 → L3 逐字事件流（核心转发 events.js，只读）
 *   candidate distill-events [--apply] [--scope S] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit N] [--after-id N]
 *                                 从 events.db 提取明确记忆指令为候选；默认 dry-run，超过 limit 时用 nextAfterId 继续；--apply 仍不确认候选
 *
 * 纪律: 所有写路径过 validate；输出 JSON 到 stdout，日志到 stderr；零第三方依赖
 */
import { readFileSync, writeFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, renameSync, appendFileSync, rmSync, openSync, writeSync, closeSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { listMemoryFiles, listMemoryEntries, findEntry, appendEntry, mutateEntryById, bucketStats, loadMemoryDocs, normalizeText, readMemoryMeta, retrieveMemories, retrieveMemoriesHybrid, scoreMemoryDocs, tokenize, truncateUtf8 } from "./memory-retrieval.js";
import { backfillSupersedes, buildLinks, queryLinks, queryRefs, queryLineage, queryGraph, setField } from "./link-graph.js";
import { checkSkillSync } from "./skills-sync.js";
// Candidate storage is optional for legacy sandboxes that only exercise the active-memory path.
// The candidate command reports a visible error when its module is absent; ordinary commands keep working.
let candidateModule = null;
try { candidateModule = await import("./candidates.js"); } catch {}
let candidateReview = null;
try { candidateReview = await import("./candidate-review.js"); } catch {}
let legacyCompat = null;
try { ({ inspectLegacyLayout: legacyCompat } = await import("./legacy-memory-compat.js")); } catch {}
let memoryDomains = null;
try { memoryDomains = await import("./memory-domains.js"); } catch {}
import { summarize as failopenSummarize, FAILOPEN_THRESHOLDS } from "./lib/failopen.js";
// F23 单实现：lib/verify-absorbed.js。沙箱测试可能只复制根文件而不带 lib/，
//   故用动态导入 + fail-open（缺失时 F23 跳过，不阻塞其他命令）；生产根有 lib，正常。
let checkAbsorbedLedger = null;
try { ({ checkAbsorbedLedger } = await import("./lib/verify-absorbed.js")); } catch {}
// F50/F51 单实现：lib/sync-check.js（同上 fail-open：沙箱只复制根文件时跳过，不阻塞其他命令）
// 2026-11-18 避坑：cmdVerify 内部已有 `const checkMap = batchValidateCheck()`（条目级校验映射），
//   直接解构成同名会遮蔽，导致 TypeError: checkMap is not a function。故用别名导入。
let checkSyncRepos = null, checkDirectoryMap = null;
// F55 隐私探针（T13）：沙箱只复制根文件时会缺模块 → 缺就跳过，不阻塞 verify
let privacyProbe = null, globalSurfaceFiles = [];
// F52 表示层（T04）：同样可选装载，缺模块时跳过
let treeBuild = null, treeStatsFn = null;
// F54 标签体检（T05）：同样可选装载
let tagReportFn = null, tagAliasFn = null, tagBaselineRead = null, tagBaselineWrite = null;
try { const _tn = await import("./tag-normalize.js"); ({ tagReport: tagReportFn, loadAlias: tagAliasFn, readBaseline: tagBaselineRead, writeBaseline: tagBaselineWrite } = _tn); globalThis.__cpTagNormalize = _tn; } catch {}
try { ({ buildTree: treeBuild, treeStats: treeStatsFn } = await import("./topic-tree.js")); } catch {}
try { ({ probe: privacyProbe, GLOBAL_SURFACE_FILES: globalSurfaceFiles } = await import("./privacy-probe.js")); } catch {}
try { ({ checkSync: checkSyncRepos, checkMap: checkDirectoryMap } = await import("./lib/sync-check.js")); } catch {}

// K22：支持 --root（沙箱/自定义根；K18 同族——整理链路的参数透传）
// 2026-11-18（T00）：默认根改为「先看当前目录」—去—否则家目录。
//   实案：在干净克隆里跑 verify 报的是家目录库的 total 290，写命令更会直接写穿生产库。
const DEFAULT_HOME_ROOT = join(homedir(), ".cosmic-phantom");
function resolveRoot() {
  const i = process.argv.indexOf("--root");
  if (i > -1 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  if (process.env.CP_ROOT) return resolve(process.env.CP_ROOT);
  const cwd = process.cwd();
  try {
    const pkg = join(cwd, "package.json");
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).name === "cosmic-phantom") return cwd;
  } catch { /* 读不到就当不是引擎仓 */ }
  return DEFAULT_HOME_ROOT;
}
const ROOT = resolveRoot();
// 引擎代码与实例数据可分离：打包插件从 engine/ 取模块，--root 只指向实例数据。
const ENGINE_ROOT = dirname(resolve(process.argv[1] || "."));
// 三态判定：instance（有卡或事件）/ engine（引擎仓工作副本）/ empty
function resolveMode(root) {
  // 判据（2026-11-18 二次修正）：只要有“实例态标记”就算实例——memories/ 目录（含空目录，
  //   新建实例即如此）/ events.db / current-state.json 三者任一；引擎仓 clone 这三样都没有
  //   （全在 .gitignore 里），因此不会误判为引擎态。纯 package.json 存在不足以判定实例。
  const marks = ["memories", "events.db", "current-state.json"].filter((p) => existsSync(join(root, p)));
  if (marks.length) return "instance";
  return existsSync(join(root, "package.json")) ? "engine" : "empty";
}
const MODE = resolveMode(ROOT);
// 写命令清单（T00）：引擎态下默认拒绝，需 --allow-engine-write 显式放行
const WRITE_CMDS = new Set(["add", "candidate", "domains", "mutate", "supersede", "correct", "index", "maintain", "distill", "organize", "relink", "import", "reject", "dream"]);
// 便携运行时（K15 修复配套）；ROOT 缺 tools/node 时（沙箱/副拷贝）回退当前 node——
//   否则 spawnSync 静默 ENOENT 空输出（2026-08-31 expand 沙箱测试暴露）
const NODE_BIN = existsSync(join(ROOT, "tools", "node", "node.exe")) ? join(ROOT, "tools", "node", "node.exe") : process.execPath;
const MEM_DIR = join(ROOT, "memories");
const DAILY_DIR = join(ROOT, "daily");
const TOPICS_DIR = join(ROOT, "topics");
const DISTILLED_DIR = join(ROOT, "distilled");
const BACKUP_DIR = join(ROOT, "backup");
const INDEX_DB = join(ROOT, "memory-index.db");
const VALID_STATUS = ["🟢当前", "🔜计划", "🕰️过去"];
// T05（2026-11-19）：类型分层——规则拆成 procedural（可复用做法）与 constraint（禁令红线）
const VALID_TYPES = ["偏好", "事件", "规则", "procedural", "constraint"];
const SNIPPET_BYTES = 800;  // 2026-08-11 优化：预览级信息 800B 足够判断，全文在文件可读；原 2048×5 每次检索约 10KB 属浪费

// 宿主健康检查必须显式声明路径；缺少配置时不探测用户目录或安装目录。
const HOST_CHECKS_PATH = process.env.CP_HOST_CHECKS ? resolve(process.env.CP_HOST_CHECKS) : join(ROOT, "host-checks.json");
function loadHostChecks() {
  const requested = Boolean(process.env.CP_HOST_CHECKS);
  if (!existsSync(HOST_CHECKS_PATH)) {
    return requested
      ? { configured: true, configDir: dirname(HOST_CHECKS_PATH), error: `host-checks.json 不存在: ${HOST_CHECKS_PATH}` }
      : { configured: false, configDir: dirname(HOST_CHECKS_PATH), data: {} };
  }
  try {
    const data = JSON.parse(readFileSync(HOST_CHECKS_PATH, "utf8").replace(/^\uFEFF/, ""));
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("必须是 JSON 对象");
    return { configured: true, configDir: dirname(HOST_CHECKS_PATH), data };
  } catch (error) {
    return { configured: true, configDir: dirname(HOST_CHECKS_PATH), error: `host-checks.json 无法解析: ${error.message}` };
  }
}
function validateHostChecks(config) {
  const errors = config.error ? [config.error] : [];
  const data = config.data || {};
  const pathValue = (label, value, baseDir = config.configDir) => {
    if (value === undefined) return;
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${label} 必须是非空路径`);
      return;
    }
    const file = resolve(baseDir, value.trim());
    if (!existsSync(file)) errors.push(`${label} 不存在: ${file}`);
  };
  const pathSetting = (envName, configuredValue) => process.env[envName] === undefined
    ? { value: configuredValue, baseDir: config.configDir }
    : { value: process.env[envName], baseDir: process.cwd() };
  const checkPathSetting = (label, envName, configuredValue) => {
    const setting = pathSetting(envName, configuredValue);
    pathValue(label, setting.value, setting.baseDir);
  };
  const objectValue = (label, value) => {
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) errors.push(`${label} 必须是 JSON 对象`);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
  const hook = objectValue("hook", data.hook);
  checkPathSetting("hook.logDir", "CP_HOOK_LOG_DIR", hook.logDir);
  checkPathSetting("hook.configPath", "CP_HOOK_CONFIG", hook.configPath);
  const transcript = objectValue("transcript", data.transcript);
  checkPathSetting("transcript.projectsDir", "CP_CC_PROJECTS", transcript.projectsDir);
  const skillMounts = objectValue("skillMounts", data.skillMounts);
  checkPathSetting("skillMounts.home", "CP_SKILL_HOME", skillMounts.home);
  const injection = objectValue("injection", data.injection);
  checkPathSetting("injection.userFile", "CP_INJECTION_USER_FILE", injection.userFile);
  if (data.replyPolicyTargets !== undefined && !Array.isArray(data.replyPolicyTargets)) {
    errors.push("replyPolicyTargets 必须是数组");
  } else {
    for (const [index, item] of (data.replyPolicyTargets || []).entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`replyPolicyTargets[${index}] 必须是 JSON 对象`);
        continue;
      }
      pathValue(`replyPolicyTargets[${index}].path`, item.path === undefined ? "" : item.path);
    }
  }
  if (process.env.CP_REPLY_POLICY_FILE !== undefined) {
    pathValue("CP_REPLY_POLICY_FILE", process.env.CP_REPLY_POLICY_FILE, process.cwd());
  }
  return errors;
}
const HOST_CHECKS = (() => {
  const loaded = loadHostChecks();
  const errors = validateHostChecks(loaded);
  return { ...loaded, errors, error: errors[0] || null };
})();
function explicitHostPath(value, baseDir = HOST_CHECKS.configDir) {
  if (typeof value !== "string" || !value.trim()) return null;
  return resolve(baseDir, value.trim());
}
function envOrConfiguredPath(envName, configuredValue) {
  if (process.env[envName] !== undefined) {
    const value = String(process.env[envName]).trim();
    return value ? resolve(value) : null;
  }
  return explicitHostPath(configuredValue);
}
function replyPolicyTargets() {
  const targets = [];
  const configured = Array.isArray(HOST_CHECKS.data?.replyPolicyTargets) ? HOST_CHECKS.data.replyPolicyTargets : [];
  for (const item of configured) {
    const file = explicitHostPath(item?.path);
    if (file) targets.push({ host: String(item.name || "configured host"), file });
  }
  const envFile = envOrConfiguredPath("CP_REPLY_POLICY_FILE", undefined);
  if (envFile) targets.push({ host: process.env.CP_REPLY_POLICY_NAME || "configured host", file: envFile });
  return targets;
}
function explicitUserInjectionPath() {
  return envOrConfiguredPath("CP_INJECTION_USER_FILE", HOST_CHECKS.data?.injection?.userFile);
}

// ---------- 工具 ----------
const normalize = normalizeText;
const listMd = listMemoryFiles;
const readMeta = readMemoryMeta;
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function withMemoryWriteLock(action) {
  const lock = join(ROOT, ".memory-write.lock");
  mkdirSync(ROOT, { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // wx makes acquisition atomic; do not create a directory and write its owner later.
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      acquired = true;
      break;
    } catch {
      let owner = 0;
      let lockAge = Infinity;
      try { owner = Number(readFileSync(lock, "utf8").trim()); } catch {}
      try { lockAge = Date.now() - statSync(lock).mtimeMs; } catch {}
      if (owner && pidAlive(owner)) {
        const error = new Error(`活跃记忆正在被 PID ${owner} 写入`);
        error.code = "MEMORY_BUSY";
        throw error;
      }
      // A just-created empty lock may be between openSync and writeSync. Do not
      // mistake that crash window for a stale lock and let two writers proceed.
      if (!owner && lockAge < 30_000) {
        const error = new Error("活跃记忆写锁正在建立");
        error.code = "MEMORY_BUSY";
        throw error;
      }
      rmSync(lock, { recursive: true, force: true });
    }
  }
  if (!acquired) {
    const error = new Error("无法获取活跃记忆写锁");
    error.code = "MEMORY_BUSY";
    throw error;
  }
  try { return action(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
function nextId() {
  // K14 修透：id 日期段用本地时区（原 UTC 在凌晨窗口会挂到前一天）
  // 月度分桶（2026-09-01）：写锁保护下按条目枚举，避免并发确认分配相同 ID。
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10).replace(/-/g, "");
  let max = 0;
  for (const e of listMemoryEntries(MEM_DIR)) {
    const m = String(e.id || "").match(/^(\d{8})-(\d{4})$/);
    if (m && m[1] === today) max = Math.max(max, Number(m[2]));
  }
  return `${today}-${String(max + 1).padStart(4, "0")}`;
}
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }
function rmSyncSafe(p) { try { rmSync(p, { force: true }); } catch {} }

// ---------- 命令 ----------
// D-20（2026-10-28）：证据够了就停（规则版）。
//   不足（空结果/低置信/top1 分=0）→ 扩 top 一次（上限 12）；仍不足则标 lowEvidence。
function assessEvidence(result) {
  const results = result?.results || [];
  const top1 = Number(results[0]?.score || 0);
  return { enough: results.length > 0 && !result?.lowConfidence && top1 > 0, top1: +top1.toFixed(4), count: results.length };
}
async function searchOnce(q, top, options = {}) {
  const opts = {
    memoryDir: MEM_DIR, top, snippetBytes: SNIPPET_BYTES, abstain: options.abstain === true,
    since: get("--since"), until: get("--until"), scope: get("--scope"),
  };
  let result = null;
  // abstain 只控制最终是否弃权，不切换检索引擎；同一查询必须先走同一条 hybrid/BM25 链。
  if (get("--bm25-only") === undefined) {
    try { result = await retrieveMemoriesHybrid(q, opts); } catch {}
  }
  if (!result) result = retrieveMemories(q, opts);
  return result;
}
async function cmdSearch(q, top = 5, options = {}) {
  if (!q) return out({ error: "空查询词" });
  let result = await searchOnce(q, top, options);
  let evidence = { rounds: 1, ...assessEvidence(result), expandedTo: top };
  if (!evidence.enough && evidence.count > 0 && top < 12) {
    const top2 = Math.min(top * 2, 12);
    const result2 = await searchOnce(q, top2, options);
    result = result2;
    evidence = { rounds: 2, ...assessEvidence(result2), expandedTo: top2 };
  }
  evidence.lowEvidence = !evidence.enough;
  out({ count: result.results.length, total: result.total, folded: result.folded, ...(options.abstain ? { verdict: result.verdict || "answerable" } : {}), evidence, ...(result.hybrid ? { hybrid: true } : {}), ...(Number.isFinite(result.maxSim) ? { maxSim: result.maxSim } : {}), ...(result.lowConfidence ? { lowConfidence: true } : {}), ...(result.semanticLowConfidence ? { semanticLowConfidence: true } : {}), results: result.results.map(({ raw, meta, created, baseScore, ...item }) => item) });
}

function addActiveMemoryUnlocked(content, opts = {}) {
  if (!content || content.trim().length < 4) return { added: false, error: "内容为空或过短" };
  const scope = opts.scope === "workspace" ? "workspace" : "global";
  const id = nextId();
  const now = new Date();
  // 动态时区偏移（原硬编码 +08:00，跨时区机器 created 会错）
  const pad2 = n => String(n).padStart(2, "0");
  const offMin = -now.getTimezoneOffset();
  const iso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace(/\.\d{3}Z$/, `${offMin >= 0 ? "+" : "-"}${pad2(Math.floor(Math.abs(offMin) / 60))}:${pad2(Math.abs(offMin) % 60)}`);
  const tags = (opts.tags || "").split(",").map(t => t.trim()).filter(Boolean);
  const type = VALID_TYPES.includes(opts.type) ? opts.type : undefined;
  const typeLine = type ? `type: ${type}\n` : "";
  // epistemic 分级（S1-3）：不传则不写（视为 unknown），不默默当事实
  const EPISTEMIC = ["fact", "inference", "summary", "self_eval"];
  const epiLine = EPISTEMIC.includes(opts.epistemic) ? `epistemic: ${opts.epistemic}\n` : "";
  // source_kind（B4 接线，2026-11-19）：这条从哪来；非法值报错，不静默
  const SOURCE_KINDS = ["user_said", "assistant_said", "told", "imagined", "inferred", "tool"];
  if (opts.sourceKind && !SOURCE_KINDS.includes(opts.sourceKind)) {
    return { added: false, error: `非法 source_kind "${opts.sourceKind}"（合法值：${SOURCE_KINDS.join("/")}）` };
  }
  const sourceKindLine = 'source_kind: ' + (opts.sourceKind || 'user_said') + '\n';
  const provenanceLines = opts.candidateId
    ? `candidate_id: ${String(opts.candidateId)}\ncandidate_source_ref: ${String(opts.candidateSourceRef || "") || "unknown"}\nconfirmed_by: ${String(opts.confirmedBy || "user")}\nconfirmed_at: ${String(opts.confirmedAt || now.toISOString())}\n`
    : "";
  const situationLine = opts.situation && String(opts.situation).trim().length >= 4 ? 'situation: ' + String(opts.situation).trim() + '\n' : '';
  const entitiesLine = opts.entities ? 'entities: [' + String(opts.entities).split(',').map((x) => x.trim()).filter(Boolean).join(', ') + ']\n' : '';
  if (opts.epistemic && !EPISTEMIC.includes(opts.epistemic)) {
    return { added: false, error: `非法 epistemic "${opts.epistemic}"（合法值：${EPISTEMIC.join("/")}）` };
  }
  const source = opts.source || `daily/${now.toISOString().slice(0, 10)}.md`;
  const entry =
`---
id: ${id}
created: ${iso}
source: ${source}
status: 🟢当前
${typeLine}${epiLine}${sourceKindLine}${provenanceLines}${situationLine}${entitiesLine}tags: [${tags.join(", ")}]
scope: ${scope}
---
${content.trim()}
`;
  const tmpFile = join(MEM_DIR, `.tmp-${id}.md`);
  mkdirSync(MEM_DIR, { recursive: true });
  writeFileSync(tmpFile, entry, "utf8");
  // 前置校验（单实现：validate.js check）
  const v = validateCheck(tmpFile);
  if (!v.ok) { rmSyncSafe(tmpFile); return { added: false, file: tmpFile, reasons: v.reasons, suggestion: "校验失败：修正后重试" }; }
  // 吸收点 A：写前查重候选（不阻断，提示由调用方裁决）
  const candidates = findConflicts(content, id);
  // 月度分桶（2026-09-01）：写入当月桶文件（校验用临时文件必删，防 .tmp-*.md 残留污染统计）
  rmSyncSafe(tmpFile);
  const bucket = appendEntry(MEM_DIR, entry, { month: id.slice(0, 4) + "-" + id.slice(4, 6) });
  const finalPath = join(MEM_DIR, bucket.file);
  // 写后派生索引自动刷新（2026-08-17 补全）：add/store_memory 落盘即重建 memory-index.db，
  //   根除"写入后 indexDrift 漂移、verify 报不一致"的长期缺口（08-17 两次 store_memory 后均漂移）；
  //   links/embed 为独立派生层，仍由 relink/embed 重建（事件驱动，不随每次写入自动跑）。
  cmdIndex(true);
  const res = { added: true, id, file: finalPath, path: finalPath, scope, conflicts: candidates };
  if (candidates.length) {
    // 写卡护栏（2026-08-17）：高相似度强提示合并/跳过，防碎片堆积（8-17 曾一天落 5 卡、3 张重复/过程性的教训）
    const top = candidates[0].score;
    res.conflictHint = top >= 80
      ? `检测到高度相似条目（${candidates[0].id}，score ${top.toFixed(0)}）——强烈建议合并/跳过而非新增（记忆卡边界：过程/重复内容落 daily 或并旧卡）`
      : "检测到相似旧条目，建议裁决：新增/跳过/更新/合并（旧条目改 🕰️ 并加 superseded_by）";
  }
  return res;
}

function addActiveMemory(content, opts = {}) {
  return withMemoryWriteLock(() => addActiveMemoryUnlocked(content, opts));
}

function cmdAdd(content, opts) {
  // `add` is the explicit user-facing write path. Automatic extraction uses
  // `candidate add`; candidate confirmation remains the only promotion path.
  try { out(addActiveMemory(content, opts)); }
  catch (error) { out({ added: false, error: String(error.message || error), code: error.code || "MEMORY_WRITE_ERROR" }); }
}

function candidateArg(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function candidatePositionals(args) {
  const valueFlags = new Set(["--actor", "--preview", "--preview-hash", "--status", "--review-status", "--bytes", "--root"]);
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value.startsWith("--")) {
      if (valueFlags.has(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function cmdCandidate(args) {
  if (!candidateModule) return out({ error: "候选模块不可用", code: "CANDIDATE_MODULE_MISSING" });
  const { makeCandidate, listCandidates, readCandidate, saveCandidate, updateCandidate, updateCandidateWithinLock, withCandidateLock, withCandidateLocks } = candidateModule;
  const sub = args[0] || "list";
  if (["review", "defer", "resume", "source", "preview"].includes(sub)) {
    if (!candidateReview) return out({ ok: false, error: "候选审阅模块不可用", code: "CANDIDATE_REVIEW_MODULE_MISSING" });
    try {
      const actor = String(candidateArg(args, "--actor") || "user");
      if (/[\r\n]/.test(actor) || actor.length > 120) return out({ ok: false, error: "actor 非法", code: "INVALID_ACTOR" });
      if (sub === "review") {
        return out(candidateReview.reviewCandidates(ROOT, { status: candidateArg(args, "--status") || candidateArg(args, "--review-status") || "pending" }));
      }
      if (sub === "defer" || sub === "resume") {
        const ids = candidateArg(args, "--id") ? [candidateArg(args, "--id")] : candidatePositionals(args.slice(1));
        if (!ids.length) return out({ ok: false, error: `用法: candidate ${sub} <candidate_id> [...]`, code: "CANDIDATE_ID_REQUIRED" });
        const results = ids.map((id) => {
          try {
            const result = candidateReview.setCandidateReviewStatus(ROOT, id, sub === "defer" ? "deferred" : "pending", actor);
            return { candidate_id: id, ok: result.ok, ...(result.ok ? { review_status: result.candidate.review_status || (sub === "defer" ? "deferred" : "pending") } : { error: result.error, code: result.code }) };
          } catch (error) { return { candidate_id: id, ok: false, error: String(error.message || error), code: error.code || "CANDIDATE_REVIEW_FAILED" }; }
        });
        return out({ ok: results.every((result) => result.ok), updated: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, items: results });
      }
      if (sub === "source") {
        const id = candidateArg(args, "--id") || candidatePositionals(args.slice(1))[0];
        if (!id) return out({ ok: false, error: "用法: candidate source <candidate_id> [--expand --bytes N]", code: "CANDIDATE_ID_REQUIRED" });
        const result = args.includes("--expand")
          ? candidateReview.expandCandidateSource(ROOT, id, candidateArg(args, "--bytes"))
          : candidateReview.candidateSource(ROOT, id);
        return out(result);
      }
      const all = args.includes("--all");
      const ids = all
        ? listCandidates(ROOT, { state: "candidate" }).filter(item => (item.review_status || "pending") === "pending").map(item => item.candidate_id)
        : candidatePositionals(args.slice(1));
      return out(candidateReview.previewCandidateConfirmation(ROOT, ids));
    } catch (error) {
      return out({ ok: false, error: String(error.message || error), code: error.code || "CANDIDATE_REVIEW_FAILED" });
    }
  }
  if (sub === "distill-events") {
    const childArgs = ["--experimental-sqlite", join(ENGINE_ROOT, "candidate-distill.js"), "--root", ROOT];
    if (args.includes("--apply")) childArgs.push("--apply");
    for (const flag of ["--scope", "--since", "--until", "--limit", "--after-id"]) {
      const value = candidateArg(args, flag);
      if (value !== undefined) childArgs.push(flag, value);
    }
    const child = spawnSync(NODE_BIN, childArgs, { encoding: "utf8", timeout: 120000 });
    process.stdout.write(child.stdout || child.stderr || "");
    if (child.status) process.exitCode = child.status;
    return;
  }
  const actorValue = String(candidateArg(args, "--actor") || (sub === "add" ? "agent" : "user"));
  if (/[\r\n]/.test(actorValue) || actorValue.length > 120) return out({ error: "actor 非法：不能包含换行且不超过 120 字符", code: "INVALID_ACTOR" });
  if (sub === "list" || sub === "show") {
    const id = sub === "show" ? args[1] : undefined;
    const items = id ? (readCandidate(ROOT, id) ? [readCandidate(ROOT, id)] : []) : listCandidates(ROOT, { state: candidateArg(args, "--state") });
    return out({ count: items.length, items });
  }
  if (sub === "migrate") {
    const apply = args.includes("--apply");
    const entries = listMemoryEntries(MEM_DIR).filter(entry => String(entry.meta?.status || "").includes("待验证"));
    const details = [];
    const kindOf = { 偏好: "preference", 规则: "rule", procedural: "rule", constraint: "rule", 术语: "term", 决策: "decision", 事件: "decision", 需求: "decision", 待办: "checkpoint" };
    for (const entry of entries) {
      const meta = entry.meta || {};
      const sourceRef = String(meta.source || "").trim();
      const scope = meta.scope;
      const body = String(entry.raw || "").replace(/^---[\\s\\S]*?---\\s*/, "").trim();
      const targetId = createHash("sha256").update(`legacy-pending:${entry.id}`).digest("hex");
      const detail = { legacy_memory_id: entry.id, source_ref: sourceRef || null, target_candidate_id: targetId, action: "skip" };
      const reasons = [];
      if (!sourceRef || /[\\r\\n]/.test(sourceRef)) reasons.push("缺失或非法 source_ref");
      if (!["global", "workspace"].includes(scope)) reasons.push("缺失或非法 scope");
      if (body.length < 4) reasons.push("正文为空或过短");
      if (reasons.length) { detail.reason = reasons.join("；"); details.push(detail); continue; }
      const existing = candidateModule.readCandidate(ROOT, targetId);
      if (existing) {
        detail.action = existing.source_ref === sourceRef && existing.content === body ? "already_migrated" : "conflict";
        if (detail.action === "conflict") detail.reason = "目标 candidate_id 已存在但内容或来源不一致";
        details.push(detail);
        continue;
      }
      if (!apply) { detail.action = "would_migrate"; details.push(detail); continue; }
      try {
        const candidate = candidateModule.makeCandidate({
          candidate_id: targetId,
          kind: kindOf[meta.type] || "decision",
          content: body,
          source_kind: "inferred",
          source_ref: sourceRef,
          confidence: 0.5,
          scope,
          situation: `legacy_memory_id=${entry.id}`,
        }, "migration");
        candidate.legacy_memory_id = entry.id;
        candidate.legacy_status = meta.status;
        candidateModule.saveCandidate(ROOT, candidate);
        detail.action = "migrated";
      } catch (error) {
        detail.reason = String(error.message || error);
      }
      details.push(detail);
    }
    return out({ dryRun: !apply, scanned: entries.length, migrated: details.filter(item => item.action === "migrated").length, wouldMigrate: details.filter(item => item.action === "would_migrate").length, alreadyMigrated: details.filter(item => item.action === "already_migrated").length, skipped: details.filter(item => item.action === "skip" || item.action === "conflict").length, details, note: "旧 ⏳待验证 卡保留在 memories/；候选仍需显式 candidate confirm 才会激活" });
  }
  if (sub === "add") {
    const content = args[1];
    const sourceKind = candidateArg(args, "--source-kind");
    const sourceRef = candidateArg(args, "--source-ref");
    const confidence = Number(candidateArg(args, "--confidence"));
    try {
      const candidate = makeCandidate({
        content, kind: candidateArg(args, "--kind"), source_kind: sourceKind,
        source_ref: sourceRef, confidence, scope: candidateArg(args, "--scope"),
        situation: candidateArg(args, "--situation"),
      }, actorValue);
      saveCandidate(ROOT, candidate);
      return out({ added: true, candidate_id: candidate.candidate_id, state: candidate.state, file: join(ROOT, "candidates", `${candidate.candidate_id}.json`) });
    } catch (error) {
      return out({ added: false, error: String(error.message || error), code: error.code || "INVALID_CANDIDATE" });
    }
  }
  if (sub === "edit") {
    const id = args[1], content = args[2];
    if (!id || !content) return out({ updated: false, error: "用法: candidate edit <id> <content> [--source-ref ref]" });
    let result;
    try {
      result = withCandidateLock(ROOT, id, () => updateCandidateWithinLock(ROOT, id, (current) => {
        if (current.state !== "candidate") throw new Error("只有 state=candidate 的候选可编辑");
        const next = { ...current, content: String(content).trim(), review_status: "pending" };
        if (candidateArg(args, "--source-ref")) throw new Error("source_ref 是原始证据指针，不可在编辑候选时覆盖");
        next.history.push({ at: new Date().toISOString(), action: "edited", actor: actorValue, content: next.content, source_ref: next.source_ref, review_status: "pending" });
        return next;
      }));
    } catch (error) {
      result = { ok: false, error: String(error.message || error), code: error.code };
    }
    return out({ updated: result.ok, ...(result.ok ? { candidate: result.candidate } : { error: result.error, ...(result.code ? { code: result.code } : {}) }) });
  }
  if (sub === "reject") {
    const ids = candidatePositionals(args.slice(1));
    let rejected = 0, missing = [];
    for (const id of ids) {
      let result;
      try {
        result = withCandidateLock(ROOT, id, () => updateCandidateWithinLock(ROOT, id, (current) => {
          if (current.state !== "candidate") return current;
          current.state = "rejected";
          current.review_status = "rejected";
          current.history.push({ at: new Date().toISOString(), action: "rejected", actor: actorValue });
          rejected += 1;
          return current;
        }));
      } catch (error) {
        result = { ok: false, error: String(error.message || error), code: error.code };
      }
      if (!result.ok) missing.push({ id, error: result.error, ...(result.code ? { code: result.code } : {}) });
    }
    return out({ rejected, missing, remaining: listCandidates(ROOT, { state: "candidate" }).length });
  }
  if (sub === "confirm") {
    const ids = args.includes("--all")
      ? listCandidates(ROOT, { state: "candidate" }).filter(item => (item.review_status || "pending") === "pending").map(item => item.candidate_id)
      : candidatePositionals(args.slice(1));
    if (!ids.length) return out({ confirmed: 0, already_confirmed: 0, missing: [{ id: null, error: "候选 ID 不能为空", code: "CANDIDATE_IDS_REQUIRED" }], items: [] });
    if (new Set(ids).size !== ids.length) return out({ confirmed: 0, already_confirmed: 0, missing: [{ id: null, error: "候选 ID 不得重复", code: "CANDIDATE_BATCH_INVALID" }], items: [] });
    const actor = actorValue;
    const strictPreview = args.includes("--preview-hash") || args.includes("--preview");
    const previewHash = candidateArg(args, "--preview-hash") ?? candidateArg(args, "--preview");
    if (strictPreview && (!previewHash || !/^[a-f0-9]{64}$/i.test(previewHash))) return out({ ok: false, error: "确认预览指纹缺失或格式非法；请重新预览", code: "CANDIDATE_PREVIEW_HASH_INVALID" });
    if (strictPreview) {
      if (!candidateReview) return out({ ok: false, error: "候选审阅模块不可用", code: "CANDIDATE_REVIEW_MODULE_MISSING" });
      const preflight = candidateReview.validateCandidateConfirmationPreview(ROOT, ids, previewHash);
      if (!preflight.ok) return out(preflight);
    }
    let confirmed = 0, already_confirmed = 0, missing = [], partial_activations = [], items = [], lockedPreflight = null;
    const processOne = (id) => {
      let result;
      try {
        const candidate = readCandidate(ROOT, id);
        if (!candidate) result = { kind: "missing", error: "候选不存在或格式非法" };
        else if (candidate.state === "confirmed") {
          const active = listMemoryEntries(MEM_DIR).find(entry => entry.id === candidate.active_memory_id
            && String(entry.raw).split(/\r?\n/).some(line => line.trim() === `candidate_id: ${id}`));
          result = active
            ? { kind: "already", active_memory_id: candidate.active_memory_id }
            : { kind: "missing", error: "候选已确认但对应活跃卡缺失或 provenance 不匹配" };
        } else if (candidate.state !== "candidate") result = { kind: "missing", error: `候选状态为 ${candidate.state}，不可确认` };
        else if ((candidate.review_status || "pending") !== "pending") result = { kind: "missing", error: `候选审阅状态为 ${candidate.review_status}，不可确认`, code: "CANDIDATE_REVIEW_STATUS_INVALID" };
        else {
          // If a process crashed after writing the active card, reconcile instead of duplicating it.
          const existing = listMemoryEntries(MEM_DIR).find(entry => String(entry.raw).split(/\r?\n/).some(line => line.trim() === `candidate_id: ${id}`));
          if (existing) {
            const saved = updateCandidateWithinLock(ROOT, id, (current) => {
              current.state = "confirmed";
              current.review_status = "confirmed";
              current.active_memory_id = existing.id;
              current.confirmed_at = current.confirmed_at || new Date().toISOString();
              current.confirmed_by = current.confirmed_by || actor;
              current.history.push({ at: new Date().toISOString(), action: "reconciled", actor, active_memory_id: existing.id });
              return current;
            });
            result = saved.ok
              ? { kind: "already", active_memory_id: existing.id, status: "reconciled" }
              : { kind: "partial", active_memory_id: existing.id, error: saved.error, code: saved.code || "CANDIDATE_ACTIVATION_STATE_SAVE_FAILED" };
          } else {
            const active = addActiveMemory(candidate.content, {
              scope: candidate.scope,
              type: candidate.kind === "preference" ? "偏好" : candidate.kind === "rule" ? "规则" : "事件",
              tags: `distilled-candidate,${candidate.kind}`,
              source: `candidate/${id}`,
              sourceKind: candidate.source_kind,
              situation: candidate.situation,
              candidateId: id,
              candidateSourceRef: candidate.source_ref,
              confirmedBy: actor,
            });
            if (!active.added) result = { kind: "missing", error: active.error || (active.reasons || []).join("；") };
            else {
              const saved = updateCandidateWithinLock(ROOT, id, (current) => {
                current.state = "confirmed";
                current.review_status = "confirmed";
                current.active_memory_id = active.id;
                current.confirmed_at = new Date().toISOString();
                current.confirmed_by = actor;
                current.history.push({ at: current.confirmed_at, action: "confirmed", actor, active_memory_id: active.id });
                return current;
              });
              result = saved.ok
                ? { kind: "confirmed", active_memory_id: active.id }
                : { kind: "partial", active_memory_id: active.id, error: saved.error, code: saved.code || "CANDIDATE_ACTIVATION_STATE_SAVE_FAILED" };
            }
          }
        }
      } catch (error) {
        result = { kind: "missing", error: String(error.message || error), code: error.code };
      }
      if (result.kind === "confirmed") {
        confirmed += 1;
        items.push({ candidate_id: id, active_memory_id: result.active_memory_id, status: "confirmed" });
      } else if (result.kind === "already") {
        already_confirmed += 1;
        items.push({ candidate_id: id, active_memory_id: result.active_memory_id, status: result.status || "already_confirmed" });
      } else if (result.kind === "partial") {
        const recovery = { candidate_id: id, active_memory_id: result.active_memory_id, status: "active_memory_written_candidate_pending", code: result.code, error: result.error, retry: "candidate confirm <candidate_id>" };
        partial_activations.push(recovery);
        items.push({ candidate_id: id, active_memory_id: result.active_memory_id, status: recovery.status });
      } else {
        missing.push({ id, error: result.error, ...(result.code ? { code: result.code } : {}) });
      }
    };
    try {
      withCandidateLocks(ROOT, ids, () => {
        if (strictPreview) {
          lockedPreflight = candidateReview.validateCandidateConfirmationPreview(ROOT, ids, previewHash);
          if (!lockedPreflight.ok) return;
        }
        ids.forEach(processOne);
      });
    } catch (error) {
      return out({ confirmed: 0, already_confirmed: 0, missing: [{ id: ids[0] || null, error: String(error.message || error), code: error.code }], items: [] });
    }
    if (lockedPreflight && !lockedPreflight.ok) return out(lockedPreflight);
    return out({ confirmed, already_confirmed, partial_activations, missing, items });
  }
  return out({ error: "用法: candidate add|list|show|edit|review|source|defer|resume|preview|confirm|reject" });
}

function findConflicts(content, excludeId) {
  const docs = loadMemoryDocs(MEM_DIR);
  const scored = scoreMemoryDocs(content, docs, { applyBoost: false, applyLegacyPenalty: false })
    .filter(d => d.meta.id !== excludeId && (d.meta.status || "🟢当前") !== "🕰️过去")
    .slice(0, 3);
  return scored.map(d => ({ id: d.meta.id, title: d.meta.title, path: d.path, status: d.meta.status || "🟢当前", score: +d.baseScore.toFixed(2) }));
}

function validateCheck(file) {
  // 单实现原则（2026-08-11）：校验逻辑唯一真源 = validate.js check；本函数只做转发，不维护副本
  const args = [join(ENGINE_ROOT, "validate.js"), "check", file];
  if (ROOT !== join(homedir(), ".cosmic-phantom")) args.push("--root", ROOT);   // K22 同族：透传
  const child = spawnSync(NODE_BIN, args, { encoding: "utf8", timeout: 30000 });
  if (child.status !== 0 || !child.stdout) {
    // fail-safe：校验器不可用时拒写（宁可不写，不可放行）
    return { ok: false, reasons: [`校验器不可用（validate.js 退出码 ${child.status}）`], suggestion: "检查 validate.js 是否随根目录拷贝" };
  }
  try {
    const r = JSON.parse(child.stdout);
    return { ok: !!r.ok, reasons: r.reasons || [], suggestion: r.suggestion };
  } catch {
    return { ok: false, reasons: ["校验器输出不可解析"], suggestion: "检查 validate.js 输出契约" };
  }
}

// 批量校验（2026-08-16 效率优化）：一次进程跑 validate.js check-all，替代 verify 逐文件 spawn
// （74 文件 3.3s → ~150ms，实测 62.8x）。失败返回空表 → 调用方回退 validateCheck 逐个（fail-open，可靠性不降级）。
function batchValidateCheck(files) {
  const args = [join(ENGINE_ROOT, "validate.js"), "check-all"];
  if (ROOT !== join(homedir(), ".cosmic-phantom")) args.push("--root", ROOT);   // K22 同族：透传
  const child = spawnSync(NODE_BIN, args, { encoding: "utf8", timeout: 60000 });
  if (child.status !== 0 || !child.stdout) return {};
  try {
    const j = JSON.parse(child.stdout);
    const map = {};
    for (const r of (j.results || [])) map[r.file] = { ok: !!r.ok, reasons: r.reasons || [] };
    return map;
  } catch { return {}; }
}

function cmdLog(tp, sid) {
  if (!tp || !existsSync(tp)) return out({ logged: false, error: "transcript 不存在" });
  // 单实现原则：转发 log_turn.js（K15：原 require 在 ESM 下直接崩溃，未测出的死命令）
  const ltArgs = [join(ENGINE_ROOT, "log_turn.js"), "--transcript", tp, "--session", sid || "anon"];
  // K18 同族（第三次修复）：不透传 --root 时子进程用 homedir 默认根 → 沙箱/自定义根下 log 落盘到生产 daily
  if (ROOT !== join(homedir(), ".cosmic-phantom")) ltArgs.push("--root", ROOT);
  const child = spawnSync(NODE_BIN, ltArgs, { encoding: "utf8", timeout: 30000 });
  // §5.1 契约 {logged, count, file}：从输出解析（"logged N entries -> path"）
  const m = (child.stdout || "").match(/logged (\d+) entries -> (.+)/);
  out({ logged: child.status === 0 && !!(m || (child.stdout || "").includes("logged")), count: m ? Number(m[1]) : 0, file: m ? m[2].trim() : undefined, output: (child.stdout || "").trim() });
}

function cmdInject(hint, top) {
  const ijArgs = [join(ENGINE_ROOT, "inject.js"), "--hint", hint || "", "--top", String(top || 3)];
  // 同族透传（读对库）：inject.js 已支持 --root（契约一致化）
  if (ROOT !== join(homedir(), ".cosmic-phantom")) ijArgs.push("--root", ROOT);
  const child = spawnSync(NODE_BIN, ijArgs, { encoding: "utf8", timeout: 30000 });
  process.stdout.write(child.stdout || "");
}

function cmdCurrent(sub, commandArgs) {
  const currentArgs = [join(ENGINE_ROOT, "current-state.js"), sub || "show", ...commandArgs];
  if (ROOT !== join(homedir(), ".cosmic-phantom")) currentArgs.push("--root", ROOT);
  const child = spawnSync(NODE_BIN, currentArgs, { encoding: "utf8", timeout: 30000, input: sub === "update" && !commandArgs.includes("--file") ? readFileSync(0, "utf8") : undefined });
  process.stdout.write(child.stdout || "");
  if (child.status) process.exitCode = child.status;
}

function cmdResume(sub, commandArgs) {
  const resumeArgs = [join(ENGINE_ROOT, "resume-context.js"), sub || "check", ...commandArgs];
  if (ROOT !== join(homedir(), ".cosmic-phantom")) resumeArgs.push("--root", ROOT);
  const child = spawnSync(NODE_BIN, resumeArgs, { encoding: "utf8", timeout: 30000 });
  process.stdout.write(child.stdout || "");
  if (child.status) process.exitCode = child.status;
}

function cmdReplyCheck(argsForCheck) {
  const checkArgs = [join(ENGINE_ROOT, "reply-check.js"), ...argsForCheck];
  if (ROOT !== join(homedir(), ".cosmic-phantom")) checkArgs.push("--root", ROOT);
  const child = spawnSync(NODE_BIN, checkArgs, { encoding: "utf8", timeout: 30000, input: argsForCheck.includes("--file") ? undefined : readFileSync(0, "utf8") });
  process.stdout.write(child.stdout || "");
  if (child.status) process.exitCode = child.status;
}

function cmdArrival(argsForArrival) {
  const arrivalArgs = [join(ENGINE_ROOT, "arrival-check.js"), ...argsForArrival];
  if (ROOT !== join(homedir(), ".cosmic-phantom")) arrivalArgs.push("--root", ROOT);
  const child = spawnSync(NODE_BIN, arrivalArgs, { encoding: "utf8", timeout: 30000 });
  process.stdout.write(child.stdout || "");
  if (child.status) process.exitCode = child.status;
}

function cmdIndex(silent) {
  // 月度分桶：条目级索引（桶条目 path=桶文件#id）
  const docs = listMemoryEntries(MEM_DIR).map(e => ({ path: e.virtualPath, id: e.id, tokens: tokenize(e.raw), mtime: statSync(e.file).mtimeMs }));
  const idx = { builtAt: new Date().toISOString(), count: docs.length, docs: docs.map(d => ({ path: d.path, id: d.id, mtime: d.mtime })) };
  writeFileSync(INDEX_DB, JSON.stringify(idx, null, 2), "utf8");
  if (!silent) out({ indexed: docs.length, count: docs.length, db: INDEX_DB });
}

// 先落后删（DeerMem 删除保护启发，2026-08-17）：新卡必须存在且校验通过，旧卡才标 🕰️+superseded_by。
//   防"旧的删了、新的没落成"的静默断裂；写后重建链接图。
function cmdSupersede(oldId, newId, opts = {}) {
  // 冲突态（2026-11-19，票 21）：两条并列而不是判输赢；status=⚠️冲突 + conflicts_with。
  const asConflict = opts.asConflict === true;
  // 回滚（S2-3）：清掉 superseded_by 并把状态改回当前
  if (opts.rollback) {
    if (!oldId) return out({ ok: false, error: "用法: supersede <id> --rollback" });
    const e = findEntry(MEM_DIR, oldId);
    if (!e) return out({ ok: false, error: `卡 ${oldId} 不存在` });
    if (opts.preview) return out({ ok: true, preview: true, id: oldId, supersededBy: e.meta.supersededBy || null, will: "清除 superseded_by + 状态→🟢当前" });
    const r = mutateEntryById(MEM_DIR, oldId, (raw) => {
      let next = raw.replace(/^status:.*$/m, "status: 🟢当前");
      next = next.replace(/^superseded_by:.*\n?/m, "");
      next = next.replace(/^conflicts_with:.*/m, "");
      return next;
    });
    if (!r.ok) return out({ ok: false, error: r.reason });
    buildLinks(ROOT);
    return out({ ok: true, rollback: oldId });
  }
  if (!oldId || !newId) return out({ ok: false, error: "用法: supersede <旧id> <新id> [--preview]" });
  // 月度分桶（2026-09-01）：新旧卡都可能是桶内条目——按 id 定位，校验用临时物化文件（validate 单实现不改）
  const oldEntry = findEntry(MEM_DIR, oldId);
  const newEntry = findEntry(MEM_DIR, newId);
  if (!oldEntry) return out({ ok: false, error: `旧卡 ${oldId} 不存在` });
  if (!newEntry) return out({ ok: false, error: `新卡 ${newId} 不存在——先落后删：先建新卡再 supersede` });
  const tmpNew = join(MEM_DIR, `.tmp-supersede-${newId}.md`);
  writeFileSync(tmpNew, newEntry.raw, "utf8");
  const v = validateCheck(tmpNew);
  rmSyncSafe(tmpNew);
  if (!v.ok) return out({ ok: false, error: `新卡校验失败：${(v.reasons || []).join(";")}`, suggestion: "新卡通过校验后才允许标记旧卡" });
  if (opts.preview) {
    return out({
      ok: true, preview: true, oldId, newId, oldStatus: oldEntry.meta.status,
      will: asConflict
        ? ["旧卡 status → ⚠️冲突", `旧卡 conflicts_with → ${newId}`, "重建链接图"]
        : ["旧卡 status → 🕰️过去", `旧卡 superseded_by → ${newId}`, "重建链接图 + backfillSupersedes"],
    });
  }
  if (asConflict) {
    const rc = mutateEntryById(MEM_DIR, oldId, (raw) => {
      let next = raw.replace(/^status:.*$/m, "status: ⚠️冲突");
      next = /^conflicts_with:/m.test(next) ? next.replace(/^conflicts_with:.*$/m, "conflicts_with: " + newId) : next.replace(/^status:.*$/m, (m) => m + "\nconflicts_with: " + newId);
      return next;
    });
    if (!rc.ok) return out({ ok: false, error: rc.reason });
    buildLinks(ROOT);
    return out({ ok: true, conflict: oldId, with: newId });
  }
  const r = mutateEntryById(MEM_DIR, oldId, (raw) => {
    let next = raw.replace(/^status:.*$/m, "status: 🕰️过去");
    next = /^superseded_by:.*$/m.test(next)
      ? next.replace(/^superseded_by:.*$/m, `superseded_by: ${newId}`)
      : next.replace(/^scope:.*$/m, (m) => `superseded_by: ${newId}\n${m}`);
    return next;
  });
  if (!r.ok) return out({ ok: false, error: r.reason });
  const rl = backfillSupersedes(ROOT, {});
  if (!rl.dryRun) buildLinks(ROOT);
  out({ ok: true, superseded: oldId, by: newId, file: r.file, relink: { changed: rl.changed?.length, unchanged: rl.unchanged } });
}

// 纠正登记（S2-2，2026-11-18）：把「用户纠错」变成可累积信号
//   corrections +1 / last_correction = 当前时间 / 正文追一行纠错记录
//   与 Mnemosyne 的反馈分级同源：你的口头纠正属于 user_explicit，权重最高，但不得被 Agent 自评替代
function cmdCorrect(id, note) {
  if (!id) return out({ ok: false, error: "用法: correct <id> [--note 说明]" });
  const e = findEntry(MEM_DIR, id);
  if (!e) return out({ ok: false, error: `卡 ${id} 不存在` });
  const prev = Number((e.meta && e.meta.corrections) || 0);
  const nowIso = new Date().toISOString();
  const r = mutateEntryById(MEM_DIR, id, (raw) => {
    let next = raw;
    const setF = (k, v) => {
      next = new RegExp(`^${k}:`, "m").test(next)
        ? next.replace(new RegExp(`^${k}:.*$`, "m"), `${k}: ${v}`)
        : next.replace(/^scope:.*$/m, (m) => `${k}: ${v}\n${m}`);
    };
    setF("corrections", prev + 1);
    setF("last_correction", nowIso);
    if (note) next = next.replace(/\s*$/, "") + `\n- 纠正@${nowIso.slice(0, 10)}：${String(note).trim()}\n`;
    return next;
  });
  if (!r.ok) return out({ ok: false, error: r.reason });
  out({ ok: true, id, corrections: prev + 1, last_correction: nowIso, file: r.file });
}

// daily 索引（2026-11-19，票 30）：daily 只保留 30 天，超期文件被 distill 移进 distilled/。
//   索引把「哪一天在哪」一次列清，避免“文件变少了”被误判成丢数据。派生层，可删可重建。

// 标签归并（2026-11-19，票 05 前半）：把同义/同类标签折到规范名，卡号与日期折成「蒸馏条目」「日期」。
//   纪律：默认 dry-run；--apply 必须带 --confirm；改前整目录备份 + 逐卡变更清单，可回滚。
function fsStatSize(p) { try { return statSync(p).size; } catch { return 0; } }

function cmdTagNormalize(apply, confirm) {
  const SOURCE_DIR = MEM_DIR;
  const files = listMemoryFiles(SOURCE_DIR);
  const entryById = new Map(listMemoryEntries(SOURCE_DIR).map((e) => [String(e.id), e]));
  const alias = tagAliasFn ? tagAliasFn(ROOT) : {};

  const TAGMAP_MODE = process.env.CP_TAGMAP || 'all';
  const isCardId = (t) => /^\d{8}-\d{3,4}$/.test(t) || /^\d{4}-\d{2}-\d{2}-\d{3}$/.test(t);
  const isDate = (t) => /^\d{4}-\d{2}-\d{2}$/.test(t);
  const mapTag = (t) => {
    if (isCardId(t)) return '蒸馏条目';
    if (TAGMAP_MODE === 'ids') return t;
    if (isDate(t)) return '日期';
    if (TAGMAP_MODE === 'ids-dates') return t;
    try { const { canonicalTag } = requireTagger(); return canonicalTag(t, alias); } catch { return t; }
  };
  function requireTagger() { return globalThis.__cpTagNormalize || {}; }
  const changes = [];
  const newTagsById = new Map();
  for (const e of entryById.values()) {
    const raw = String(e.meta && e.meta.tags ? e.meta.tags : '').replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean);
    const mapped = [...new Set(raw.map(mapTag).filter(Boolean))];
    const a = JSON.stringify(raw.slice().sort());
    const b = JSON.stringify(mapped.slice().sort());
    if (a !== b) { changes.push({ id: e.id, before: raw, after: mapped }); newTagsById.set(String(e.id), mapped); }
  }
  if (!apply) {
    const kinds = new Set(); for (const e of entryById.values()) String(e.meta && e.meta.tags || '').replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean).forEach((t) => kinds.add(t));
    return out({ dryRun: true, cards: entryById.size, changedCards: changes.length, kindsBefore: kinds.size, ratioBefore: +(kinds.size / (entryById.size || 1)).toFixed(3), sample: changes.slice(0, 5) });
  }
  if (!confirm) return out({ refused: '改历史卡必须显式 --confirm', changedCards: changes.length });

  // 备份（整目录复制，体积小）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bk = join(ROOT, 'backup', 'memories-pre-tagmerge-' + stamp);
  cpSync(SOURCE_DIR, bk, { recursive: true });
  const manifest = { at: new Date().toISOString(), backup: bk, changedCards: changes.length, changes };
  writeFileSync(join(ROOT, 'backup', 'tag-merge-' + stamp + '.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 逐文件重写 tags 行（按 id 命中）
  let rewritten = 0;
  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    const blocks = raw.split(/^\s*§{3,}\s*$/m);
    let dirty = false;
    const next = blocks.map((block) => {
      const idm = block.match(/^id:\s*(\S+)\s*$/m);
      if (!idm || !newTagsById.has(idm[1])) return block;
      const tags = newTagsById.get(idm[1]);
      const line = 'tags: [' + tags.join(', ') + ']';
      if (/^tags:.*$/m.test(block)) { dirty = true; return block.replace(/^tags:.*$/m, line); }
      return block;
    });
    if (dirty) { writeFileSync(f, next.join('\n§§§\n'), 'utf8'); rewritten += 1; }
  }
  out({ ok: true, files: rewritten, changedCards: changes.length, backup: bk });
}

function cmdDailyIndex() {
  const rows = new Map();
  try {
    for (const f of readdirSync(DAILY_DIR).filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x)).sort()) rows.set(f.slice(0, 10), "daily/" + f);
  } catch {}
  try {
    for (const f of readdirSync(DISTILLED_DIR).filter((x) => /^daily-\d{4}-\d{2}-\d{2}\.md$/.test(x)).sort()) {
      const d = f.slice(6, 16);
      if (!rows.has(d)) rows.set(d, "distilled/" + f);
    }
  } catch {}
  const dates = [...rows.keys()].sort();
  const lines = ["# daily 索引（自动生成，勿手改）", "", "> 由 `memory-cli.js daily-index` 生成；daily 只保留 30 天，超期文件在 distilled/。", "", "| 日期 | 位置 |", "|---|---|"];
  for (const d of dates) lines.push("| " + d + " | `" + rows.get(d) + "` |");
  writeFileSync(join(ROOT, "daily-index.md"), lines.join("\n") + "\n", "utf8");
  out({ ok: true, dates: dates.length, file: "daily-index.md" });
}
function hashFileForVerify(file) {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return null; }
}

function cardsDigestForVerify(entries) {
  const items = entries.map(e => ({ id: e.id, fp: createHash("sha256").update(String(e.raw || "")).digest("hex") }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

function semanticHealthForVerify(entries) {
  const modelPath = join(ROOT, "embedding-db", "models", "model.onnx");
  const vocabPath = join(ROOT, "embedding-db", "models", "vocab.txt");
  const vectorPath = join(ROOT, "embedding-db", "vectors.json");
  const modelPresent = existsSync(modelPath);
  const vocabPresent = existsSync(vocabPath);
  const runtimePresent = existsSync(join(ROOT, "node_modules", "onnxruntime-node", "package.json"));
  const vectorsPresent = existsSync(vectorPath);
  const base = { modelPresent, vocabPresent, runtimePresent, vectorsPresent, vectorsSha: vectorsPresent ? hashFileForVerify(vectorPath)?.slice(0, 16) : null };
  if (!modelPresent || !vocabPresent || !runtimePresent) return { ...base, mode: "bm25-degraded", degraded: true, reason: "model-or-runtime-missing" };
  if (!vectorsPresent) return { ...base, mode: "bm25-degraded", degraded: true, reason: "vector-store-missing" };
  try {
    const v = JSON.parse(normalize(readFileSync(vectorPath, "utf8")));
    const ids = new Set(Object.keys(v.entries || {}));
    const cardIds = new Set(entries.map(e => e.id).filter(Boolean));
    const missing = [...cardIds].filter(id => !ids.has(id));
    const ghosts = [...ids].filter(id => !cardIds.has(id));
    const modelSha = hashFileForVerify(modelPath);
    const vocabSha = hashFileForVerify(vocabPath);
    const expectedId = process.env.CP_EMBED_MODEL_ID || "bge-small-zh-v1.5";
    const meta = v.modelMeta || {};
    const compatible = v.schemaVersion === 2 && meta.id === expectedId && meta.modelSha256 === modelSha && meta.vocabSha256 === vocabSha && v.cardsDigest === cardsDigestForVerify(entries) && missing.length === 0 && ghosts.length === 0;
    const reason = compatible ? null : (missing.length || ghosts.length ? "card-coverage-mismatch" : (meta.id !== expectedId || meta.modelSha256 !== modelSha || meta.vocabSha256 !== vocabSha ? "model-mismatch" : (v.schemaVersion !== 2 ? "legacy-vector-store" : "cards-digest-mismatch")));
    return { ...base, mode: compatible ? "hybrid-ready" : "bm25-degraded", degraded: !compatible, reason, schemaVersion: v.schemaVersion || 1, model: v.model || null, modelMeta: meta, coverage: { total: entries.length, embedded: ids.size, missing: missing.length, ghosts: ghosts.length }, cardsDigest: v.cardsDigest || null };
  } catch (e) { return { ...base, mode: "broken", degraded: true, reason: `vector-store-invalid:${String(e.message || e).slice(0, 60)}` }; }
}

function auditCandidateLinks(entries) {
  if (!candidateModule) return { available: false, checked: 0, issues: [], brokenReferences: 0, duplicateActivations: 0, unconfirmedCurrent: 0 };
  const candidateRecords = candidateModule.inspectCandidateFiles(ROOT);
  const candidates = candidateRecords.filter(record => record.valid).map(record => record.candidate);
  const byId = new Map(candidates.map(candidate => [candidate.candidate_id, candidate]));
  const refs = new Map();
  const issues = candidateRecords.filter(record => !record.valid).map(record => ({
    kind: "invalid_candidate",
    candidate_id: record.candidate?.candidate_id || null,
    file: record.file,
    reason: record.errors.join("；"),
  }));
  for (const entry of entries) {
    const candidateId = String(entry.meta?.candidateId || "").trim();
    if (!candidateId) continue;
    if (!refs.has(candidateId)) refs.set(candidateId, []);
    refs.get(candidateId).push(entry);
    const candidate = byId.get(candidateId);
    if (!candidate) {
      issues.push({ kind: "broken_reference", candidate_id: candidateId, active_memory_id: entry.id, reason: "活跃卡引用的候选不存在" });
      continue;
    }
    if (candidate.state !== "confirmed" && String(entry.meta?.status || "").includes("当前")) {
      issues.push({ kind: "unconfirmed_current", candidate_id: candidateId, active_memory_id: entry.id, candidate_state: candidate.state, reason: "未确认候选已有当前活跃卡" });
    }
  }
  for (const [candidateId, activeEntries] of refs) {
    if (activeEntries.length > 1) {
      issues.push({ kind: "duplicate_activation", candidate_id: candidateId, active_memory_ids: activeEntries.map(entry => entry.id), reason: "同一候选物化出多张活跃卡" });
    }
    const candidate = byId.get(candidateId);
    if (candidate?.state === "confirmed" && !candidate.active_memory_id) {
      issues.push({ kind: "confirmed_without_provenance", candidate_id: candidateId, reason: "候选已确认但缺 active_memory_id" });
    }
  }
  for (const candidate of candidates) {
    if (candidate.state === "confirmed" && !refs.has(candidate.candidate_id)) {
      issues.push({ kind: "broken_reference", candidate_id: candidate.candidate_id, reason: "候选已确认但找不到活跃卡回指" });
    }
    if (candidate.state === "confirmed" && candidate.active_memory_id && refs.has(candidate.candidate_id)
      && !refs.get(candidate.candidate_id).some(entry => entry.id === candidate.active_memory_id)) {
      issues.push({ kind: "broken_reference", candidate_id: candidate.candidate_id, active_memory_id: candidate.active_memory_id, reason: "active_memory_id 不存在或不匹配" });
    }
  }
  const counts = {
    brokenReferences: issues.filter(issue => issue.kind === "broken_reference").length,
    duplicateActivations: issues.filter(issue => issue.kind === "duplicate_activation").length,
    unconfirmedCurrent: issues.filter(issue => issue.kind === "unconfirmed_current").length,
    invalidCandidates: issues.filter(issue => issue.kind === "invalid_candidate").length,
  };
  return { available: true, checked: candidateRecords.length, ...counts, issues: issues.slice(0, 50) };
}

function cmdVerify() {
  const entries = listMemoryEntries(MEM_DIR);
  const candidateInfo = auditCandidateLinks(entries);
  let noise = 0, empty = 0, legacy = 0; const bad = [];
  let workInfo = { exists: false, items: 0, problems: 0 };
  let coverageInfo = null;
  let pendCount = 0, pendOldest = 0;   // F14 统计随主循环顺带（2026-08-29 复杂度整改：省一遍全量 IO）
  const checkMap = batchValidateCheck();   // 效率优化：批量一次进程（check-all 已条目级，键=id）；失败回退逐条物化
  for (const e of entries) {
    const meta = e.meta;
    if ((meta.status || "").includes("待验证")) {
      pendCount += 1;
      const t = Date.parse(meta.created || "");
      if (Number.isFinite(t) && (!pendOldest || t < pendOldest)) pendOldest = t;
    }
    const isLegacy = (meta.tags || "").includes("legacy") || (meta.status || "").includes("过去");
    const v = checkMap[e.id] || { ok: true, reasons: [] };   // check-all 与本函数同源枚举，缺失仅在校验器崩溃（fail-open 不误报洪水）
    if (!v.ok) {
      if (isLegacy) { legacy++; continue; }   // §4.4 反思 3：legacy 条目不进噪音统计（防误报洪水）
      noise++; if (v.reasons.some(r => r.includes("过短"))) empty++; bad.push({ file: e.id, reasons: v.reasons });
    }
  }
  // 索引一致性（事故 A4 对策）
  let idxCount = -1;
  if (existsSync(INDEX_DB)) { try { idxCount = JSON.parse(normalize(readFileSync(INDEX_DB, "utf8"))).count; } catch {} }
  const drift = idxCount >= 0 && idxCount !== entries.length;
  // 新鲜度（§8.1 #3：守护死亡可感知——写强制停摆时 verify 必须显式暴露）
  const stale = [];
  for (const error of HOST_CHECKS.errors || []) stale.push(`宿主检查配置错误：${error}`);
  try {
    if (existsSync(DAILY_DIR)) {
      const dfs = readdirSync(DAILY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
      // 2026-11-18：改用真源时间（events.db MAX(ts)）判定“写强制是否停摆”。
      //   原实现看 daily 文件 mtime——恢复/克隆/拷贝后 mtime=今天，停摆闸被抹平（实测：19 天 daily 拷回即转绿）。
      let lastTs = NaN;
      try {
        const evDb = join(ROOT, "events.db");
        if (existsSync(evDb)) {
          const r = spawnSync(NODE_BIN, ["--experimental-sqlite", "-e",
            "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);const r=db.prepare('SELECT MAX(ts) m FROM events').get();console.log(r&&r.m||'')",
            evDb], { encoding: "utf8", timeout: 20000 });
          if (r.status === 0) lastTs = Date.parse(String(r.stdout || "").trim());
        }
      } catch {}
      if (dfs.length) {
        const mtDays = (Date.now() - statSync(join(DAILY_DIR, dfs[dfs.length - 1])).mtimeMs) / 86400000;
        const days = Number.isFinite(lastTs) && lastTs > 0 ? (Date.now() - lastTs) / 86400000 : mtDays;
        if (days > 3) stale.push(`daily 最近写入 ${dfs[dfs.length - 1]}（${days.toFixed(1)} 天前，写强制可能停摆）`);
      } else stale.push("daily 无任何日志");
    }
    const lm = join(BACKUP_DIR, "last-mirror.txt");
    if (existsSync(lm)) {
      const days = (Date.now() - statSync(lm).mtimeMs) / 86400000;
      if (days > 7) stale.push(`镜像 ${days.toFixed(1)} 天未更新（maintain 可能未运行）`);
    }
    // 视图新鲜度（F5 防静默过期，2026-08-16）：current.md 等过期但未刷新 → 显式暴露（事件驱动设计，不自动刷新）
    if (existsSync(VIEWS_DIR)) {
      for (const f of readdirSync(VIEWS_DIR).filter(x => x.endsWith(".md"))) {
        const m = normalize(readFileSync(join(VIEWS_DIR, f), "utf8")).match(/<!-- view: (\S+) \| generatedAt: (\S+) \| expiryDays: (\d+) -->/);
        if (!m) continue;
        const age = (Date.now() - new Date(m[2]).getTime()) / 86400000;
        if (age > +m[3]) stale.push(`视图 ${m[1]} 已过期 ${age.toFixed(1)} 天（蒸馏后 view refresh --all 刷新）`);
      }
    }
    // 快照一致性（F6 防静默滞后，2026-08-17）：AGENTS.md 快照段 revision ≠ current-state → 显式暴露（收尾漏跑 update-snapshot 的守卫；只读不自动改）
    const agentsRaw = existsSync(join(ROOT, "AGENTS.md")) ? readFileSync(join(ROOT, "AGENTS.md"), "utf8") : "";
    const snapRev = agentsRaw.match(/<!-- snapshot-start -->[\s\S]*?revision (\d+)/);
    if (snapRev && existsSync(join(ROOT, "current-state.json"))) {
      const st = JSON.parse(normalize(readFileSync(join(ROOT, "current-state.json"), "utf8")));
      if (st.revision != null && +snapRev[1] !== st.revision) {
        stale.push(`AGENTS.md 快照 revision ${snapRev[1]} ≠ 状态 ${st.revision}（收尾漏跑 update-snapshot.js）`);
      }
    }
    // F7：只检查显式声明的接入端日志；没有路径就不探测宿主目录。
    const hookLogDir = envOrConfiguredPath("CP_HOOK_LOG_DIR", HOST_CHECKS.data?.hook?.logDir);
    const hookConfigPath = envOrConfiguredPath("CP_HOOK_CONFIG", HOST_CHECKS.data?.hook?.configPath);
    if (hookLogDir) {
      const configMtime = hookConfigPath && existsSync(hookConfigPath) ? statSync(hookConfigPath).mtimeMs : 0;
      const today = new Date();
      let hookFails = 0, hookDay = "";
      for (const off of [0, 1]) {
        const d = new Date(today.getTime() - off * 86400000);
        const tag = d.toISOString().slice(0, 10);
        const logFile = join(hookLogDir, `hook-${tag}.jsonl`);
        if (!existsSync(logFile)) continue;
        for (const ln of readFileSync(logFile, "utf8").split("\n")) {
          if (!ln.includes('"event":"hook.run.failed"')) continue;
          const m = ln.match(/"timestamp":"([^"]+)"/);
          if (m && Date.parse(m[1]) <= configMtime) continue;
          if (m && Date.now() - Date.parse(m[1]) > 2 * 86400000) continue;
          hookFails++; hookDay = tag;
        }
      }
      if (hookFails > 0) stale.push(`hook.run.failed ×${hookFails}（${hookDay}；配置修改后仍有失败，请检查接入端 hook）`);
    }
    // F7：显式声明的会话来源目录比 daily 新且已静默，才提示接入端可能漏跑 Stop hook。
    //   回合进行中 transcript 刚更新时不报，避免把正常延迟误判成故障。
    try {
      const ccProj = envOrConfiguredPath("CP_CC_PROJECTS", HOST_CHECKS.data?.transcript?.projectsDir);
      let newest = 0;
      if (existsSync(ccProj)) {
        for (const d of readdirSync(ccProj)) {
          let files = [];
          try { files = readdirSync(join(ccProj, d)); } catch { continue; }
          for (const f of files) {
            if (!f.endsWith(".jsonl")) continue;
            try { const m = statSync(join(ccProj, d, f)).mtimeMs; if (m > newest) newest = m; } catch {}
          }
        }
      }
      if (newest > 0) {
        const tag = new Date(newest - new Date(newest).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        const dayFile = join(ROOT, "daily", `${tag}.md`);
        const dayM = existsSync(dayFile) ? statSync(dayFile).mtimeMs : 0;
        const idleMin = Math.round((Date.now() - newest) / 60000);
        const F7_IDLE_MIN = Number(process.env.CP_F7_IDLE_MIN || 30);
        if (dayM > 0 && idleMin > F7_IDLE_MIN) {
          const lagMin = Math.round((newest - dayM) / 60000);
          if (lagMin > 30) stale.push(`Stop hook 可能静默失败：transcript 比 daily 新 ${lagMin} 分钟且已静默 ${idleMin} 分钟（检查显式声明的接入端 hook）`);
        }
      }
    } catch { /* fail-open */ }
    // skill 挂载位一致性（F8 防同步失真，2026-08-17）：08-13 事故——daily 声称"已同步且 diff 一致"，
    //   但挂载位副本 mtime 证实从未落盘，宿主长期停留旧版（30 天蒸馏间隔）无人察觉、两次被用户抓包。
    //   这里对每个有挂载的宿主逐一 diff 真源 skills/*/SKILL.md，缺/不一致显式暴露。
    const skillHome = envOrConfiguredPath("CP_SKILL_HOME", HOST_CHECKS.data?.skillMounts?.home);
    if (skillHome) {
      for (const r of checkSkillSync(ROOT, skillHome)) {
        if (!r.ok) stale.push(`挂载位 ${r.mount}/skills/${r.skill} ${r.detail}`);
      }
    }
    // 语义索引新鲜度（F9 2026-08-17）：embedding-db/vectors.json 是 embed.js build 的派生索引，
    //   不在收尾链时可能静默过期（08-16 构建后新条目不在向量里，纯 BM25 不受影响但 hybrid 检索缺新条目）。
    //   修法：node embed.js build --root <根>（maintain 的 embed 步骤亦覆盖）。
    try {
      const vp = join(ROOT, "embedding-db", "vectors.json");
      if (existsSync(vp)) {
        const v = JSON.parse(normalize(readFileSync(vp, "utf8")));
        const vn = Array.isArray(v.entries) ? v.entries.length : Object.keys(v.entries || {}).length;
        if (v.updatedAt) {
          const days = (Date.now() - new Date(v.updatedAt).getTime()) / 86400000;
          if (days > 7) stale.push(`语义索引 ${days.toFixed(1)} 天未更新（embedding-db/vectors.json，跑 embed.js build 重建）`);
        }
        if (vn !== entries.length) stale.push(`语义索引条目 ${vn} ≠ 记忆 ${entries.length}（必须逐条覆盖，跑 embed.js build 重建）`);
        const semantic = semanticHealthForVerify(entries);
        if (semantic.mode !== "hybrid-ready") stale.push(`语义层 ${semantic.mode}：${semantic.reason || "未满足混合检索条件"}（检索会退化为 BM25）`);
        // D11 双向对账（2026-09-28 立，来源 9-27 挑刺 D11）：残魂=向量有卡无（删卡残留）；漏嵌=卡有向量无。
        try {
          const vIds = new Set(Object.keys(v.entries || {}));
          const cIds = new Set(entries.map(e => e.meta && e.meta.id).filter(Boolean));
          const ghosts = [...vIds].filter(id => !cIds.has(id));
          const missingEmb = [...cIds].filter(id => !vIds.has(id));
          if (ghosts.length) stale.push(`语义索引残魂 ${ghosts.length} 条（向量有卡无：${ghosts.slice(0, 3).join(',')}${ghosts.length > 3 ? '…' : ''}；跑 embed.js build 重建清除）`);
          if (missingEmb.length) stale.push(`语义索引漏嵌 ${missingEmb.length} 条（卡有向量无：${missingEmb.slice(0, 3).join(',')}${missingEmb.length > 3 ? '…' : ''}；跑 embed.js build 重建）`);
        } catch {}
      } else {
        // 2026-11-18：模型在位但向量库缺失时不再静默——显式暴露“语义层没建”。
        //   原实现只在 vectors.json 存在时才查，导致缺库/缺 onnxruntime 时 verify 一片绿，
        //   而检索已经静默降级纯 BM25（正是用户最容易被骗的地方）。
        const mp = join(ROOT, "embedding-db", "models", "model.onnx");
        if (existsSync(mp)) {
          const ortOk = existsSync(join(ROOT, "node_modules", "onnxruntime-node", "package.json"));
          stale.push(ortOk
            ? "语义索引缺失（模型在位但 embedding-db/vectors.json 不存在，跑 embed.js build 重建）"
            : "语义层未启用（模型在位但缺 node_modules/onnxruntime-node，检索已静默降级纯 BM25；装依赖，或移走模型以显式降级）");
        }
      }
    } catch {}
    // 链接图新鲜度（F10 2026-08-17）：links.json 是 link-graph buildLinks 的派生索引，
    //   与语义索引同理可能静默过期（08-16 构建后新条目无链接关系）。修法：memory-cli.js relink。
    try {
      const lp = join(ROOT, "links.json");
      if (existsSync(lp)) {
        const l = JSON.parse(normalize(readFileSync(lp, "utf8")));
        const ln = Array.isArray(l.nodes) ? l.nodes.length : Object.keys(l.nodes || {}).length;
        if (l.generatedAt) {
          const days = (Date.now() - new Date(l.generatedAt).getTime()) / 86400000;
          if (days > 7) stale.push(`链接图 ${days.toFixed(1)} 天未更新（links.json，跑 memory-cli.js relink 重建）`);
        }
        if (Math.abs(ln - entries.length) > 3) stale.push(`链接图节点 ${ln} ≠ 记忆 ${entries.length}（偏差>3，跑 memory-cli.js relink 重建）`);
      }
    } catch {}
    // 领域语言新鲜度（F11 2026-08-17，.context 利用率治理）：CONTEXT.md 超 5 天未回流 → stale。
    //   08-12 补写后一度停更 4 天零回流（8-13~8-17 的新共识一个词条都没进），属"写着但没人维护"的静默腐化；
    //   阈值 14→5 天（2026-08-31 用户拍板）：14 天拦不住"两天级"漏写（08-31 实证：08-29 回流后当日共识漏写零报警）。
    //   回流时机 = 共识落盘/收尾/蒸馏回流。ADR 不检查（用户 2026-08-12 决定不工具化、维持现状）。
    try {
      const cp = join(ROOT, ".context", "CONTEXT.md");
      if (existsSync(cp)) {
        const days = (Date.now() - statSync(cp).mtimeMs) / 86400000;
        if (days > 5) stale.push(`领域语言 CONTEXT.md ${days.toFixed(1)} 天未回流（达成共识立即写回，或跑蒸馏回流）`);
      }
    } catch {}
    // 悬空 superseded_by（F12 2026-08-17，DeerMem 删除保护落地）：指向不存在的卡 → stale。
    //   link-graph backfill 对悬空目标静默跳过，这里显式暴露"旧卡标了、新卡没落"的断裂。
    try {
      const idSet = new Set();
      for (const f of files) { try { const id = readMeta(normalize(readFileSync(f, "utf8"))).id; if (id) idSet.add(id); } catch {} }
      for (const f of files) {
        const meta = readMeta(normalize(readFileSync(f, "utf8")));
        for (const tg of String(meta.supersededBy || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
          // 蒸馏档案型 superseded_by(2026-08-29):distilled/<date>.md 指向蒸馏档案非卡,校验档案存在即可(蒸馏 skill 规范形态)
          if (tg.startsWith("distilled/")) { if (!existsSync(join(ROOT, tg))) stale.push(`悬空 superseded_by：${meta.id} → ${tg}（蒸馏档案不存在）`); continue; }
          if (!idSet.has(tg)) stale.push(`悬空 superseded_by：${meta.id} → ${tg}（目标卡不存在，先落后删断裂；先建新卡再 supersede）`);
        }
      }
    } catch {}
    // 黄金集回退守卫（F13 2026-08-28 用户拍板评测挂链）：上次 maintain 落盘的评测结果，
    //   R@5<1.0 / failList 非空 / 无关召回>0 任一命中 → stale（检索改动的验收门槛，回退当场暴露）。
    //   fail-open：last-result.json 缺失 = 未建基线，提示首跑；解析失败静默（不阻塞 verify）。
    try {
      const ef = join(ROOT, "eval", "last-result.json");
      if (!existsSync(ef)) stale.push("黄金集无基线（eval/last-result.json 不存在，跑 memory-cli.js maintain 或 eval/eval-retrieval.js 首跑）");
      else {
        const gs = JSON.parse(readFileSync(ef, "utf8")).summary || {};
        if ((gs.recallAtK ?? 1) < 1 || (gs.failList || []).length > 0 || (gs.irrelevantRate ?? 0) > 0) {
          stale.push(`黄金集回退：R@5=${gs.recallAtK} fail=${JSON.stringify(gs.failList || [])} irr=${gs.irrelevantRate}（改检索后跑 maintain 重评过关）`);
        }
      }
    } catch {}
    // 待验证池堆积守卫（F14 2026-08-28）：自动提取的 ⏳ 卡无人确认会烂在池里——
    //   >20 张或最老 >7 天 → stale 提醒审阅（confirm 转正 / reject 拒绝）。
    //   2026-08-29：统计并入主循环（本段只判定），verify 耗时回落。
    {
      const oldestDays = pendOldest ? (Date.now() - pendOldest) / 86400000 : 0;
      if (pendCount > 20) stale.push(`待验证池堆积 ${pendCount} 张（>20，跑 memory-cli.js confirm 审阅转正 / reject 清池）`);
      else if (oldestDays > 7) stale.push(`待验证池最老卡 ${oldestDays.toFixed(1)} 天未确认（>7 天，跑 memory-cli.js confirm 审阅）`);
    }
    // 记忆桶容量守卫（F21 2026-09-01，月度分桶配套）：单桶条目 >500 → 提示蒸馏减量（防单桶膨胀回退成新形态的单文件病）
    try {
      const bs = bucketStats(MEM_DIR);
      for (const [m, n] of Object.entries(bs.months || {})) {
        if (n > 500) stale.push(`记忆桶 ${m}.md 条目 ${n}（>500，跑 memory-cli.js distill 蒸馏减量）`);
      }
    } catch {}
    // 恢复健康门守卫（F22 2026-09-01，R1 事故落地）：resume check ok:false = 压缩恢复健康门红
    //   （manifest stale/changed 等）→ stale 显式暴露 + 指向 refresh；wrap-up 第 ④ 步已收进自动重戳（双保险）。
    try {
      const rc = spawnSync(NODE_BIN, [join(ENGINE_ROOT, "resume-context.js"), "check", "--root", ROOT], { encoding: "utf8", timeout: 15000 });
      if (rc.status !== 0) {
        let detail = "resume check ok:false";
        try { const j = JSON.parse((rc.stdout || "").trim()); detail = `manifest=${j.manifest}${(j.changed || []).length ? " changed=" + j.changed.join(",") : ""}`; } catch {}
        stale.push(`压缩恢复健康门红（${detail}；跑 node resume-context.js refresh --root <根> 重戳）`);
      }
    } catch {}
    // 接入端自动扩展停跑守卫（F26）：扩展每次加载写 .flags/cp-autopilot.log，
    //   最后一条 module evaluated 超 48h = 自动层疑似停跑（升级覆盖/目录丢失/语法错）——静默失效必须暴露。
    try {
      const apl = join(ROOT, ".flags", "cp-autopilot.log");
      if (existsSync(apl)) {
        const lastEvt = readFileSync(apl, "utf8").split("\n").filter(l => l.includes("module evaluated")).slice(-1)[0] || "";
        const mm = lastEvt.match(/^\[([^\]]+)\]/);
        if (mm) {
          const ageH = (Date.now() - Date.parse(mm[1])) / 3600000;
          if (ageH > 48) stale.push(`接入端自动扩展已 ${Math.floor(ageH)}h 未见加载（>48h，自动层疑似停跑；检查已声明的扩展文件与 .flags/cp-autopilot.log）`);
        }
      }
    } catch {}
    // F27 交付测试台账守卫（2026-09-29，STS×CP C1）：交付物（迁移包等）改动晚于最后测试 = 未复测交付。
    //   台账 .flags/delivery-verification.jsonl 由 record-delivery-test.cjs 追加（pass/fail/retired）；
    //   判据：交付物当前最新 mtime（目录=递归最大） > 最后 testedAt + 2s 容差 → stale；retired 跳过。
    try {
      const dvf = join(ROOT, ".flags", "delivery-verification.jsonl");
      if (existsSync(dvf)) {
        const latest = new Map();
        for (const ln of readFileSync(dvf, "utf8").split("\n")) {
          if (!ln.trim()) continue;
          let r; try { r = JSON.parse(ln); } catch { continue; }
          if (!r.deliverable) continue;
          const prev = latest.get(r.deliverable);
          if (!prev || String(r.testedAt || "") >= String(prev.testedAt || "")) latest.set(r.deliverable, r);
        }
        for (const [deliverable, r] of latest) {
          if (r.result === "retired") continue;
          if (!existsSync(deliverable)) {
            stale.push(`[F27] 交付物不存在：${deliverable}（台账登记过但路径消失——移动/删除？更新台账或记 retired）`);
            continue;
          }
          let mx = 0;
          const walk = (p) => {
            let st; try { st = statSync(p); } catch { return; }
            if (st.mtimeMs > mx) mx = st.mtimeMs;
            if (st.isDirectory()) {
              let kids = []; try { kids = readdirSync(p); } catch { return; }
              for (const k of kids) walk(join(p, k));
            }
          };
          walk(deliverable);
          const testedAt = Date.parse(r.testedAt || "");
          if (mx && testedAt && mx > testedAt + 2000) {
            stale.push(`[F27] 交付物有改动晚于最后测试：${deliverable}（改动 ${new Date(mx).toISOString().slice(0, 16)} / 最后测试 ${new Date(testedAt).toISOString().slice(0, 16)}）——复测后跑 node record-delivery-test.cjs 更新台账`);
          }
        }
      }
    } catch {}
    // 改进闭环守卫（F23 2026-09-15 立）：用户问「如何让你具备优化能力」→ 定位到系统缺
    //   「改进输入 → 转化 → 验收」这条链（外部吸收有账本、内部摩擦没账本，且都缺落地验收）。
    //   两类判据**分开**，不共用超期阈值——把"卡在 Agent"和"卡在用户"混算会互相掩盖：
    //     ① improvement-ledger 的 `未转化` = 卡在 Agent（我该做没做）→ 阈值 14 天
    //     ② absorbed-notes 的 `待裁决`   = 卡在用户（等拍板）  → 阈值 30 天（用户节奏）
    try {
      const led = join(ROOT, "core", "improvement-ledger.md");
      if (existsSync(led)) {
        for (const ln of readFileSync(led, "utf8").split("\n")) {
          const idm = ln.match(/^\|\s*(I-\d+)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/);
          if (!idm) continue;
          if (!ln.includes("`未转化`")) continue;
          const days = Math.floor((Date.now() - Date.parse(idm[2])) / 86400000);
          if (days > 14) stale.push(`改进台账 ${idm[1]} 未转化 ${days} 天（卡在 Agent：转成 hook/守卫/门禁后补证据，或改判否决）`);
        }
      }
    } catch {}
    try {
      if (!checkAbsorbedLedger) {
        if (existsSync(join(ROOT, "core", "absorbed-notes.md"))) stale.push("[F23] 校验实现缺失（lib/verify-absorbed.js），F23 未执行");
      } else {
        const abResult = checkAbsorbedLedger(ROOT);
        if (abResult.stale) stale.push(abResult.stale);
      }
    } catch {}
    // 重大改动待查验守卫（F24 2026-09-16，改进台账 I-007 转化）：原"重大改动后主动跑对抗式查验"
    //   是**自觉**（只有"用户说挑刺/蒸馏连动"两个触发），无账可查。改由 audit-due.cjs 在 Stop 链尾
    //   侦测关键文件 mtime → 落 flag；本守卫读 flag 报红，把"我到底跑没跑"变成机器可判。
    //   清账唯二条件：产出 pro/audit-*.md 后 `audit-due.cjs --clear --by <档案>`，或改判否决并写明理由。
    try {
      const af = join(ROOT, ".flags", "audit-due.json");
      if (existsSync(af)) {
        const f = JSON.parse(readFileSync(af, "utf8").replace(/^\uFEFF/, ""));
        if (f.due) {
          const list = (f.changed || []).slice(0, 4).join("、");
          stale.push(`重大改动待查验 ${(f.changed || []).length} 个关键文件（${list}${(f.changed || []).length > 4 ? "…" : ""}，自 ${String(f.baseline || "").slice(0, 10)}）——跑对抗式查验产出 pro/audit-*.md 后 audit-due.cjs --clear --by <档案> 清账`);
        }
        // 守卫自身盲区（T4 自查 2026-09-16）：本守卫靠"flag 存在且 due"报警——若 audit-due.cjs
        //   静默失败（Stop 链断、脚本报错），flag 永远停在 due:false，F24 就变成**假绿**（最坏情况：
        //   机制死了却报平安）。对策：checkedAt 过旧（Stop 链每会话尾必跑，>7 天=链断）也报红。
        if (f.checkedAt && (Date.now() - Date.parse(f.checkedAt)) / 86400000 > 7) {
          const d = ((Date.now() - Date.parse(f.checkedAt)) / 86400000).toFixed(1);
          stale.push(`audit-due 已 ${d} 天未运行（Stop 链应每会话尾更新 flag；久未更新=该机制可能已停跑，F24 当前是假绿）`);
        }
      }
    } catch {}
    // 盲区账本守卫（F25 2026-09-16 立，用户定为最高优先级的问题：「看不见的部分还有多少」）。
    //   只报**可行动**的两类，刻意避免永久红灯（否则又是一次"狼来了"）：
    //     ① 标"阻塞"且状态仍 `未观测` 的假设 —— 它正被依赖却从未验证
    //     ② 标 `已观测` 但证据列为空 —— 无证据 = 未观测（防纸面成功）
    //   刻意**不报** B 类 L3/L4=0：新机不存在是"已知的、故意的"状态，报了就是永久噪音（等真机落地后自然消）。
    try {
      const bf = join(ROOT, "core", "blindspot-ledger.md");
      if (existsSync(bf)) {
        const blockingUnobserved = [];
        const paperObserved = [];
        for (const ln of readFileSync(bf, "utf8").split("\n")) {
          const m = ln.match(/^\|\s*([ABCD]-\d+)\s*\|/);
          if (!m) continue;
          // 判据须排除"非阻塞"（否则 `includes("阻塞")` 会把"非阻塞"也算成阻塞 —— 2026-09-16 三态验证抓到）
          if (ln.includes("`未观测`") && ln.includes("阻塞") && !ln.includes("非阻塞")) blockingUnobserved.push(m[1]);
          if (ln.includes("`已观测`")) {
            const cols = ln.split("|").map((s) => s.trim());
            const evidence = cols[cols.length - 2] || "";
            if (!evidence || evidence === "—" || evidence === "-") paperObserved.push(m[1]);
          }
        }
        if (blockingUnobserved.length) {
          stale.push(`盲区账本：${blockingUnobserved.join("、")} 标"阻塞"却仍未观测（正在依赖未验证的假设，去跑观测或改判）`);
        }
        if (paperObserved.length) {
          stale.push(`盲区账本：${paperObserved.join("、")} 标"已观测"但证据为空（无证据 = 未观测，补证据或改回）`);
        }
      }
    } catch {}
    // 错误计数守卫（F16 2026-08-28 外审预检）：hook-errors.log 是全系统 fail-open 的唯一出口，
    //   没人翻 = 没有。近 24h 错误行 >10 → stale 主动报（logErr/logMCP 已在写，缺的只是"有人看"）。
    try {
      const lf = join(ROOT, "hook-errors.log");
      if (existsSync(lf)) {
        const dayAgo = Date.now() - 86400000;
        const errLines = readFileSync(lf, "utf8").split("\n").filter(l => {
          const m = l.match(/^\[(.+?)\]/);
          if (!m) return false;
          const t = Date.parse(m[1]);
          return Number.isFinite(t) && t >= dayAgo && /failed|失败|error|EXCEPTION|回滚/i.test(l);
        });
        if (errLines.length > 10) stale.push(`hook-errors.log 近 24h 错误 ${errLines.length} 条（>10，fail-open 出口在响，翻日志定位：${(errLines[0] || "").slice(0, 60)}…）`);
      }
    } catch {}
    // 验收隔离（Mnemosyne 借鉴，2026-11-18）：题集 sha256 冻结，变更必须显式 accept
    try {
      const lockF = join(ROOT, "eval", "suite.lock.json");
      if (existsSync(lockF)) {
        const lock = JSON.parse(readFileSync(lockF, "utf8"));
        const changed = [];
        for (const [f, h] of Object.entries(lock.sets || {})) {
          const p3 = join(ROOT, "eval", f);
          if (!existsSync(p3)) { changed.push(f + "(缺失)"); continue; }
          const cur = createHash("sha256").update(readFileSync(p3)).digest("hex");
          if (cur !== h) changed.push(f);
        }
        if (changed.length) stale.push(`验收题集已变更（${changed.join(",")}）——若确属有意修改，跑 node eval/suite-lock.cjs accept --reason "..." 重新冻结`);
      }
    } catch {}
    // heldout 盲测提醒（F17 2026-08-29 审计）：盲测基线 >31 天未跑 → stale（盲测价值=定期第三方视角，靠人会忘）
    try {
      const hf = join(ROOT, "eval", "heldout-baseline.json");
      if (existsSync(hf)) {
        const days = (Date.now() - statSync(hf).mtimeMs) / 86400000;
        if (days > 31) stale.push(`heldout 盲测基线 ${days.toFixed(0)} 天未重跑（>31 天，跑 node eval/eval-retrieval.js --set heldout --k 5 对比基线）`);
      }
    } catch {}
    // 状态项 TTL 守卫（F15 2026-08-28，Loci 教训"过期数据比没有数据更糟"）：
    //   nextActions >30 天 / blockers >14 天未变 → stale（挂起会烂，显式暴露让下次收工清）。
    try {
      const tf = join(ROOT, "state-timestamps.json");
      if (existsSync(tf)) {
        const map = JSON.parse(readFileSync(tf, "utf8"));
        const st = JSON.parse(readFileSync(join(ROOT, "current-state.json"), "utf8"));
        const keyOf = (item) => createHash("sha256").update(String(item)).digest("hex").slice(0, 16);
        for (const item of (st.nextActions || [])) {
          const t = map["nextActions:" + keyOf(item)];
          if (t && (Date.now() - Date.parse(t)) / 86400000 > 30) stale.push(`nextActions 项 ${String(item).slice(0, 30)}… 已挂 30+ 天（TTL 过期，收尾时清或重述）`);
        }
        for (const item of (st.blockers || [])) {
          const t = map["blockers:" + keyOf(item)];
          if (t && (Date.now() - Date.parse(t)) / 86400000 > 14) stale.push(`blockers 项 ${String(item).slice(0, 30)}… 已阻塞 14+ 天（TTL 过期，解决或移除）`);
        }
      }
    } catch {}
  } catch { /* fail-open */ }
  // 注入体积记账（2026-08-17，④）：AGENTS.md（工作区+用户级）+ reply-policy 全量注入字节，
  //   无预算意识会持续膨胀每个会话的固定成本；>20KB 显式提示精简。
  let injections = { agentsWs: 0, agentsUser: 0, replyPolicy: 0, total: 0 };
  try {
    const userInjection = explicitUserInjectionPath();
    for (const [k, p] of [["agentsWs", join(ROOT, "AGENTS.md")], ["agentsUser", userInjection], ["replyPolicy", join(ROOT, "reply-policy.json")]]) {
      if (p && existsSync(p)) injections[k] = statSync(p).size;
    }
    injections.total = injections.agentsWs + injections.agentsUser + injections.replyPolicy;
    if (injections.total > 20000) stale.push(`注入体积 ${(injections.total / 1024).toFixed(1)}KB（工作区+显式用户级+门禁）——考虑精简，每个会话固定成本随体积增长`);
    if (injections.agentsUser > 12000) stale.push(`显式用户级注入 ${(injections.agentsUser / 1024).toFixed(1)}KB（>12KB 软上限）——精简或下沉 daily/pro 档案`);
  } catch {}
  // 吸收台账（ADR-001 层1，2026-08-12）：调 events.js coverage，显式暴露源缺口
  let absorption;
  try {
    const r = spawnSync(NODE_BIN, ["--experimental-sqlite", join(ENGINE_ROOT, "events.js"), "coverage", "--root", ROOT], { encoding: "utf8", timeout: 20000 });
    if (r.status === 0) {
      const j = JSON.parse((r.stdout || "").split("\n").filter(Boolean).pop() || "{}");
      absorption = { checked: j.checked, aligned: j.aligned, gaps: j.gaps };
      // F18 消费（2026-08-29）：critical 级 gap 转 stale——源文件大量消失必须顶到收尾自检第一屏
      for (const g of (j.gaps || [])) {
        if (g.critical) stale.push(`🔴 [F18] ${g.reason}`);
      }
    }
  } catch { /* fail-open */ }
  // F19 无归因变更守卫（2026-08-29）：change-log.jsonl 最近 48h 内存在"无归因文件变更" = 有非 agent
  //   管道路径的内容层改动（Proma 事故形态），必须顶到 stale 提醒人工确认。
  try {
    const cl = join(ROOT, "change-log.jsonl");
    if (existsSync(cl)) {
      const lines = readFileSync(cl, "utf8").split("\n").filter(Boolean);
      for (const ln of lines.slice(-5).reverse()) {
        try {
          const r = JSON.parse(ln);
          if (r.at && Date.now() - Date.parse(r.at) < 48 * 3600000 && r.unattributed > 0) {
            stale.push(`⚠️ [F19] 最近文件变更存在 ${r.unattributed} 处无归因（非 agent 管道修改？）——核对 change-log.jsonl ${r.at.slice(0, 16)}：${(r.changes || []).filter(c => !c.attributed).map(c => c.file).slice(0, 3).join(", ")}`);
            break;
          }
        } catch {}
      }
    }
  } catch { /* fail-open */ }
  // F20 门禁派生物一致性守卫：单源 reply-policy.json → 显式声明的接入端文件。
  try {
    const pol = JSON.parse(readFileSync(join(ROOT, "reply-policy.json"), "utf8"));
    const targets = replyPolicyTargets();
    if (HOST_CHECKS.configured && targets.length === 0) {
      stale.push("⚠️ [F20] 未配置门禁派生目标，门禁一致性检查已跳过");
    }
    const fbLine = "**禁用词（出现即违规）**：" + (pol.forbidden || []).join(" / ");
    for (const t of targets) {
      if (!existsSync(t.file)) { stale.push(`⚠️ [F20] ${t.host} 门禁文件不存在: ${t.file}`); continue; }
      const ag = readFileSync(t.file, "utf8");
      const seg = ag.slice(ag.indexOf("<!-- reply-policy:start"), ag.indexOf("<!-- reply-policy:end -->"));
      if (!seg.includes("reply-policy:start")) stale.push(`⚠️ [F20] ${t.host} 门禁段标记缺失(应跑 sync-reply-policy 重建派生物)`);
      else {
        const missFb = seg.includes(fbLine) ? [] : [fbLine];
        const missRule = (pol.rules || []).filter((r, i) => !seg.includes(r.slice(0, 18)));
        if (missFb.length || missRule.length) stale.push(`⚠️ [F20] ${t.host} 门禁派生物漂移:禁用词缺 ${missFb.join("/")};规则缺 ${missRule.length} 条——跑 node sync-reply-policy.mjs 同步`);
      }
    }
  } catch (e) { stale.push("⚠️ [F20] 门禁一致性检查自身失败: " + (e.message || "").slice(0, 60)); }
  // F28 在制品健康守卫（2026-10-28 立，吸收 mattpocock/skills 四段）：work/ 规格与票据图
  //   只在有 work/ 时开销；work.cjs 缺失/异常一律 fail-open（不阻塞收尾），但异常本身进 stale 以免静默。
  try {
    if (existsSync(join(ROOT, "work"))) {
      workInfo.exists = true;
      const workScript = join(ENGINE_ROOT, "work.cjs");
      if (!existsSync(workScript)) stale.push("⚠️ [F28] work/ 存在但 work.cjs 缺失（在制品无法校验）");
      else {
        const r = spawnSync(NODE_BIN, [workScript, "audit", "--root", ROOT], { encoding: "utf8", timeout: 30000 });
        let audit = null;
        try { audit = JSON.parse((r.stdout || "").trim()); } catch {}
        if (!audit) stale.push("⚠️ [F28] work.cjs audit 无 JSON 输出（在制品未校验）");
        else {
          workInfo.items = (audit.items || []).length;
          workInfo.problems = (audit.items || []).filter(i => (i.problems || []).length > 0).length;
          for (const item of audit.items || []) for (const p of item.problems || []) stale.push(`[F28] ${item.slug}：${p}`);
        }
      }
    }
  } catch (e) { stale.push("⚠️ [F28] 在制品检查自身失败: " + (e.message || "").slice(0, 60)); }
  // F29 技能执行留痕（2026-10-28 立，D-11）：技能内容执行了但无机器证据 = 靠自觉。
  //   判据：manifest.lastRun 晚于最近一条 skill-runs 记录 → 蒸馏已更新却无留痕。
  try {
    const mf = join(ROOT, "distilled", "manifest.json");
    const sf = join(ROOT, ".flags", "skill-runs.jsonl");
    if (existsSync(mf) && existsSync(sf)) {
      const manifest = JSON.parse(readFileSync(mf, "utf8").replace(/^\uFEFF/, ""));
      const lines = readFileSync(sf, "utf8").trim().split("\n").filter(Boolean);
      let last = null;
      try { last = JSON.parse(lines[lines.length - 1]); } catch {}
      const lastRun = Date.parse(manifest.lastRun || "");
      const lastAt = last ? Date.parse(last.at || "") : NaN;
      const skillFile = join(ROOT, "skills", "distill-conversation", "SKILL.md");
      const skillSha = existsSync(skillFile) ? createHash("sha256").update(readFileSync(skillFile)).digest("hex") : null;
      if (!last || last.skill !== "distill-conversation") {
        stale.push("[F29] 最近技能留痕不是 distill-conversation（跑 node skill-log.cjs distill-conversation）");
      } else if (skillSha && last.sha256 !== skillSha) {
        stale.push("[F29] 留痕的 SKILL.md 版本与当前不一致（重跑 skill-log）");
      } else if (Number.isFinite(lastRun) && (!Number.isFinite(lastAt) || lastAt < lastRun)) {
        stale.push(`[F29] 蒸馏 ${String(manifest.lastRun).slice(0, 10)} 已更新但无技能执行留痕（跑 node skill-log.cjs distill-conversation）`);
      }
    }
  } catch (e) { stale.push("⚠️ [F29] 技能留痕检查自身失败: " + (e.message || "").slice(0, 60)); }
  // F30 蒸馏后置守卫（2026-10-28 立，D-12）：manifest / 档案 / 编号三者一致；超 30 天提醒。
  try {
    const mf = join(ROOT, "distilled", "manifest.json");
    if (existsSync(mf)) {
      const m = JSON.parse(readFileSync(mf, "utf8").replace(/^\uFEFF/, ""));
      const after = /^(\d{4}-\d{2}-\d{2})T/.exec(String(m.lastRun || ""));
      if (!after) stale.push("[F30] distilled/manifest.json lastRun 缺失或格式非法");
      else {
        const file = join(ROOT, "distilled", `${after[1]}.md`);
        if (!existsSync(file)) stale.push(`[F30] manifest lastRun=${after[1]} 但 distilled/${after[1]}.md 不存在`);
        else {
          const txt = readFileSync(file, "utf8");
          const nums = [...txt.matchAll(new RegExp(`${after[1]}-(\\d{3})`, "g"))].map(x => Number(x[1]));
          const uniq = [...new Set(nums)].sort((a, b) => a - b);
          for (let i = 0; i < uniq.length; i += 1) {
            if (uniq[i] !== i + 1) { stale.push(`[F30] 蒸馏编号不连续：期望 ${String(i + 1).padStart(3, "0")}，实际 ${String(uniq[i]).padStart(3, "0")}`); break; }
          }
          const declared = (txt.match(/精华条目：\s*(\d+)\s*条/) || [])[1];
          if (declared && uniq.length !== Number(declared)) stale.push(`[F30] 档案声明 ${declared} 条，编号实际 ${uniq.length} 个`);
          const mfiles = Array.isArray(m.files) ? m.files : [];
          if (mfiles.length && !mfiles.includes(`${after[1]}.md`)) stale.push(`[F30] manifest.files 缺 ${after[1]}.md`);
        }
        const days = (Date.now() - Date.parse(m.lastRun)) / 86400000;
        if (days > 30) stale.push(`[F30] 蒸馏已 ${days.toFixed(0)} 天未跑（>30 天，跑 distill-conversation）`);
      }
    }
  } catch (e) { stale.push("⚠️ [F30] 蒸馏后置检查自身失败: " + (e.message || "").slice(0, 60)); }
  // F31 CONTEXT 术语表治理（2026-10-28 立，D-07）：同名重复或超软上限 → stale。
  //   F11 看新鲜度（是否回流），F31 看体积/重复（是否膨胀）；两者分工不重叠。
  try {
    const ctx = join(ROOT, ".context", "CONTEXT.md");
    if (existsSync(ctx)) {
      const raw = readFileSync(ctx, "utf8");
      const bytes = Buffer.byteLength(raw);
      const keys = new Map();
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^-\s*术语[：:]\s*(.+?)\s*$/);
        if (!m) continue;
        const k = m[1].toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
        keys.set(k, (keys.get(k) || 0) + 1);
      }
      const dups = [...keys.entries()].filter(([, n]) => n > 1).map(([k]) => k);
      if (dups.length) stale.push(`[F31] CONTEXT 同名术语重复 ${dups.length} 组（${dups.slice(0, 3).join("、")}）——合并到一处`);
      if (bytes > 30720) stale.push(`[F31] CONTEXT ${(bytes / 1024).toFixed(1)}KB > 30KB 软上限——归档历史补记到 distilled/glossary-archive-YYYY-MM.md`);
    }
  } catch (e) { stale.push("⚠️ [F31] CONTEXT 术语检查自身失败: " + (e.message || "").slice(0, 60)); }
  // F32 事件→卡覆盖率（2026-10-28 立，E-3）：最近 30 天决策行 ≥5 且卡片覆盖 <80% → stale。
  //   样本 <5 不报（避免小样本噪声）；脚本缺失/异常 fail-open。
  try {
    const cov = join(ROOT, "coverage-cards.cjs");
    if (existsSync(cov) && existsSync(join(ROOT, "daily"))) {
      const r = spawnSync(NODE_BIN, [cov, "--root", ROOT, "--days", "30", "--json"], { encoding: "utf8", timeout: 30000 });
      let c = null;
      try { c = JSON.parse((r.stdout || "").trim()); } catch {}
      if (c) {
        coverageInfo = { decisions: c.decisions, covered: c.covered, uncovered: c.uncovered, rate: c.rate };
        if (Number(c.decisions) >= 5 && c.rate !== null && c.rate < 0.8) {
          stale.push(`[F32] 决策卡覆盖 ${c.covered}/${c.decisions}（${(c.rate * 100).toFixed(0)}% <80%）——补卡或标记不产卡原因`);
        }
      }
    }
  } catch (e) { stale.push("⚠️ [F32] 覆盖率检查自身失败: " + (e.message || "").slice(0, 60)); }
  // D3 时效双判据（2026-09-28 立，来源 9-27 挑刺 D3）：无活动时把时效类告警折叠为"休眠态确认"
  //   病根：用户零活动与机制停跑在信号上不可区分（7 条全响→疲劳→真故障淹没）；近 7 天无新事件=正常沉默。
  try {
    let recentAct = -1;
    try {
      const evDb = join(ROOT, "events.db");
      if (existsSync(evDb)) {
        const q = spawnSync(NODE_BIN, ["--experimental-sqlite", "-e",
          "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);console.log(db.prepare(\"SELECT COUNT(*) c FROM events WHERE ts > datetime('now','-7 days')\").get().c);",
          evDb], { encoding: "utf8", timeout: 15000 });
        recentAct = Number((q.stdout || "").trim());
        if (Number.isNaN(recentAct)) recentAct = -1;
      }
    } catch {}
    if (recentAct === 0) {
      const TIME_PAT = /(天未更新|天未运行|未回流|停摆|疑似停跑)/;
      const timeStale = stale.filter(s => TIME_PAT.test(s));
      if (timeStale.length >= 3) {
        for (const s of timeStale) { const i = stale.indexOf(s); if (i >= 0) stale.splice(i, 1); }
        stale.push(`💤 休眠态确认：近 7 天无新活动，${timeStale.length} 条时效类告警已折叠（有活动仍未更新=真停跑，届时自动恢复逐条显示）`);
      }
    }
  } catch {}
  // F35 纠错时效（S2-2，2026-11-18）：被用户纠正过但 30 天未修订的当前卡
  try {
    const staleCorr = (entries || []).filter((e) => {
      const m = e.meta || {};
      const n = Number(m.corrections || 0);
      if (!(n > 0)) return false;
      if (!String(m.status || "").includes("当前")) return false;
      const at = Date.parse(m.lastCorrection || "");
      if (!Number.isFinite(at)) return true;
      return (Date.now() - at) / 86400000 > 30;
    });
    if (staleCorr.length) stale.push(`[F35] ${staleCorr.length} 张卡被纠正后 30 天未修订（${staleCorr.slice(0, 3).map((e) => (e.meta || {}).id).join(",")}）——要么改卡，要么降为🕰️`);
  } catch {}
  // F34 epistemic 分级（S1-3，2026-11-18，Mnemosyne 借鉴）：推断/自评/摘要不得以「🟢当前」存在
  try {
    const badEpi = (entries || []).filter((e) => {
      const m = e.meta || {};
      if (!["inference", "self_eval", "summary"].includes(m.epistemic)) return false;
      return String(m.status || "").includes("当前");
    });
    if (badEpi.length) stale.push(`[F34] ${badEpi.length} 条推断/自评类条目被标为🟢当前（${badEpi.slice(0, 3).map((e) => (e.meta || {}).id).join(",")}）——降为⏳待验证或补证据后改 fact`);
  } catch {}
  // F53 语义邻接守卫（2026-11-18）：边太稀 → 扩散等于空转；孤立太多 → 图退化成点集。
  let graphInfo = null;
  try {
    const lp = join(ROOT, "links.json");
    if (existsSync(lp)) {
      const lj = JSON.parse(readFileSync(lp, "utf8"));
      const st = lj.candidateStats || null;
      const edgesN = st ? st.edges : 0;
      const isoRate = st ? st.isolatedRate : 1;
      // F53 消费方一致性（2026-11-19 补）：光有边不够，还得看「写的那段」和「读的那段」是否同一个键。
      //   事故复原：graph-build 写 candidates、applyRefine 读 derived（被 delete）→ 2093 条边无人消费，
      //   而这里只看 candidateStats.edges=2093 就报绿 —— 监控测的不是机制实际用的那条数据。
      const hasDerived = !!(lj.derived && Object.keys(lj.derived).length);
      const hasCandidates = !!(lj.candidates && Object.keys(lj.candidates).length);
      const refineKey = process.env.CP_REFINE_SOURCE === "candidates" ? "candidates" : "derived";
      const consumed = refineKey === "candidates" ? hasCandidates : hasDerived;
      // 机制已被用户废弃（2026-11-19）：针对它的检查必须一起结项，
      //   否则红灯常亮 = 没人再看红灯（比不报更糟）。结论仍留在 graphInfo 里可见，只是不计 stale。
      const deprecated = lj.refineDeprecated === true;
      const declaredDowngrade = lj.refineMode === 'candidates-only' || deprecated;
      graphInfo = { edges: edgesN, isolatedRate: isoRate, builtAt: st ? st.builtAt : null, sourceKey: refineKey, consumed, deprecated };
      if (!st) stale.push("[F53] links.json 缺 candidateStats（未跑 graph-build）——邻接候选未生成");
      else if (!deprecated) {
        if (edgesN < 300) stale.push(`[F53] 语义邻接过稀：${edgesN} 条（<300），扩散等于空转——跑 memory-cli.js graph-build`);
        if (isoRate > 0.35) stale.push(`[F53] 孤立卡占比 ${(isoRate * 100).toFixed(1)}%（>35%，2026-11-18 校准：当前语料 30%）——图已退化成点集`);
      } else {
        graphInfo.deprecatedNote = lj.refineDeprecatedReason || "关系层已废弃（2026-11-19），孤立率仅供参考";
      }
      graphInfo.refineMode = lj.refineMode || null;
      if (!consumed) {
        const msg = `[F53] 图数据与消费方口径不一致：写了 ${hasCandidates ? "candidates" : "（空）"}／读 ${refineKey}`
          + ` → 候选边无人消费。显式降级请设 CP_REFINE_SOURCE=candidates，否则需补写 ${refineKey}`;
        // 已显式声明的降级：不报红灯（否则红灯常亮=没人看），但必须留痕可见
        if ((declaredDowngrade && refineKey === 'derived') || deprecated) graphInfo.declaredDowngrade = lj.refineModeReason || true;
        else stale.push(msg);
      }
    }
  } catch (e) { graphInfo = { error: String(e.message || e).slice(0, 80) }; }
  // F56 fail-open 守卫（2026-11-19）：兜底触发率 100% = 该机制从未真正生效（死机制）。
  //   起因：graph-build 写 candidates、applyRefine 读 derived，2093 条边一次未被消费，
  //   而 verify 只看 candidateStats 报绿灯 —— 三类口径不交叉校验的典型事故。
  let failopenInfo = null;
  try {
    const fo = { summarize: failopenSummarize, FAILOPEN_THRESHOLDS };
    const items = fo.summarize();
    const dead = items.filter((x) => x.dead);
    const inconsistent = items.filter((x) => x.inconsistent);
    if (inconsistent.length) stale.push(`[F56] fail-open 计数不一致 ${inconsistent.length} 处（fallback 次数超过调用次数，计数器或旧数据需修复）：` + inconsistent.slice(0, 5).map((x) => x.name).join("、"));
    // 有意降级 vs 意外空转：reason 里带 opt-in-required 的，是把开关关了而不是坏了（不报红但记账）
    const degraded = items.filter((x) => !x.dead && x.calls >= fo.FAILOPEN_THRESHOLDS.MIN_CALLS && x.rate === 1
      && (x.topReasons || []).some((r) => r.includes("opt-in-required")));
    failopenInfo = { items: items.slice(0, 12), dead: dead.map((d) => d.name), inconsistent: inconsistent.map((d) => d.name), degraded: degraded.map((d) => d.name), thresholds: fo.FAILOPEN_THRESHOLDS };
    if (dead.length) {
      stale.push(`[F56] fail-open 死机制 ${dead.length} 处（触发率 100%，从未真正生效）：`
        + dead.slice(0, 5).map((d) => `${d.name}${d.topReasons && d.topReasons[0] ? `(${d.topReasons[0]})` : ""}`).join("；"));
    }
  } catch (e) { failopenInfo = { error: String(e.message || e).slice(0, 80) }; }
  // F54 标签体检（T05）：棘轮——比率与独用标签数只许降不许升
  let tagsInfo = null;
  try {
    if (tagReportFn) {
      const rep = tagReportFn(listMemoryEntries(MEM_DIR), tagAliasFn(ROOT) || {});
      const base = tagBaselineRead(ROOT);
      tagsInfo = { ...rep, baselineRatio: base ? base.ratio : null };
      if (base) {
        if (rep.ratio > base.ratio + 0.02) stale.push("[F54] 标签比率回升 " + rep.ratio + "（基线 " + base.ratio + "）——新卡请复用既有标签");
        if (rep.singletonTags > base.singletonTags + 20) stale.push("[F54] 只用一次的标签增加 " + (rep.singletonTags - base.singletonTags) + " 个（基线 " + base.singletonTags + "）");
      }
    }
  } catch (e) { tagsInfo = { error: String(e.message || e).slice(0, 80) }; }
  // F52 表示层守卫（T04：树与语料不同步 / 体积超限）
  let treeInfo = null;
  try {
    const entries = listMemoryEntries(MEM_DIR);
    const fresh = treeBuild ? treeBuild(entries).corpusHash : null;
    const st = treeStatsFn ? treeStatsFn(ROOT, entries) : { present: false, bytes: 0, ratio: null };
    let built = null;
    try { built = JSON.parse(readFileSync(join(ROOT, "views", "topics", "index.json"), "utf8")).corpusHash; } catch {}
    treeInfo = { present: st.present, corpusHash: built, expected: fresh, bytes: st.bytes, ratio: st.ratio };
    if (!st.present) stale.push("[F52] 表示层缺失：views/topics 不存在（跑 memory-cli.js tree）");
    else {
      if (built !== fresh) stale.push("[F52] 主题树过期：corpusHash " + String(built).slice(0, 8) + " ≠ " + fresh.slice(0, 8) + "（跑 memory-cli.js tree 重建）");
      if (st.ratio > 0.3) stale.push("[F52] 表示层体积 " + (st.ratio * 100).toFixed(1) + "% 超过语料 30%（下游会膨胀成负担）");
    }
  } catch (e) { treeInfo = { error: String(e.message || e).slice(0, 80) }; }
  // F55 隐私探针（T13，2026-11-19）：非 global 作用域的卡，内容不得出现在全局注入面。
  let privacyInfo = null;
  try {
    const surfaces = globalSurfaceFiles.map((f) => join(ROOT, f)).filter((p) => existsSync(p)).map((p) => readFileSync(p, "utf8")).join(String.fromCharCode(10));
    const priv = listMemoryEntries(MEM_DIR).filter((e) => String(e.meta?.scope || "global") !== "global")
      .map((e) => ({ id: e.id, scope: String(e.meta?.scope || ""), raw: e.raw }));
    const guardrail = (() => { const f = join(ROOT, "AGENTS.md"); try { return existsSync(f) ? readFileSync(f, "utf8") : ""; } catch { return ""; } })();
    const r = privacyProbe ? privacyProbe(priv, surfaces, { preferenceSurface: guardrail }) : { checked: 0, skipped: 0, leakCount: 0, leaks: [] };
    privacyInfo = { checked: r.checked, skipped: r.skipped, leakCount: r.leakCount, leaks: r.leaks.slice(0, 5), preferenceLeakCount: r.preferenceLeakCount || 0, preferenceLeaks: (r.preferenceLeaks || []).slice(0, 5) };
    if (r.preferenceLeakCount) stale.push("[F55] 私有偏好的整句出现在全局注入面：" + r.preferenceLeakCount + " 条（样例 " + r.preferenceLeaks.slice(0, 3).map((l) => l.id).join(", ") + "）");
    if (r.leakCount) stale.push("[F55] 私有作用域内容出现在全局注入面：" + r.leakCount + " 条（样例 " + r.leaks.slice(0, 3).map((l) => l.id + "@" + l.scope).join(", ") + "）");
  } catch (e) { privacyInfo = { error: String(e.message || e).slice(0, 80) }; }
  // F50 双仓同步守卫（2026-11-18）：工作没进 GitHub / 脏着没提交 —— 换机器就接不上。
  //   离线判据：只比本地 HEAD 与 origin-tracking，不 fetch；缺 git/缺仓不报红（不伪造红灯）。
  let syncInfo = null, mapInfo = null;
  try {
    if (checkSyncRepos) {
      const s = checkSyncRepos(ROOT, undefined, { fetch: process.env.CP_F50_FETCH === "1" });
      syncInfo = { ok: s.ok, engine: s.engine, data: s.data, fetched: s.fetched, fetchedHint: s.fetchedHint };
      for (const p of s.problems) stale.push(p);
    }
  } catch (e) { syncInfo = { error: String(e.message || e).slice(0, 80) }; }
  // F51 目录地图守卫（2026-11-18）：地图声明 vs 磁盘实存，多一个少一个都报。
  try {
    if (checkDirectoryMap) {
      const m = checkDirectoryMap(ROOT);
      mapInfo = { ok: m.ok, missing: m.missing, extra: m.extra, unmappedFiles: m.unmappedFiles, mapped: m.mapped.length, real: (m.real || []).length };
      if (m.ok === false) {
        if (m.extra.length) stale.push(`[F51] 磁盘上有目录未入 DIRECTORY-MAP：${m.extra.join(", ")}（新增顶层目录必须同步更新地图）`);
        if (m.missing.length) stale.push(`[F51] DIRECTORY-MAP 列了但磁盘没有：${m.missing.join(", ")}（已删就移入「已核销」段）`);
        if ((m.unmappedFiles || []).length) stale.push(`[F51] 根文件未入 DIRECTORY-MAP：${m.unmappedFiles.join(", ")}（新增脚本必须登记，或在「已核销」段说明）`);
      }
    }
  } catch (e) { mapInfo = { error: String(e.message || e).slice(0, 80) }; }
  // 语义层状态（2026-11-19，票 17）：模型 / 运行时 / 索引分开报，不把“hybrid”当一句口号
  const conflictCards = entries.filter((e) => String(e.raw || "").includes("status: ⚠️冲突")).map((e) => e.id);
  const correctionsTop = entries
    .map((e) => ({ id: e.id, n: Number((String(e.raw || "").match(/^corrections:\s*(\d+)/m) || [])[1] || 0) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  const hasLine = (raw, prefix) => String(raw || "").split("\n").some((l) => l.startsWith(prefix));
  const situationCount = entries.filter((e) => hasLine(e.raw, "situation:")).length;
  const entitiesCount = entries.filter((e) => hasLine(e.raw, "entities:")).length;
  const epistemicDist = {};
  for (const e of entries) {
    const line = String(e.raw || "").split("\n").find((l) => l.startsWith("epistemic:"));
    const k = line ? line.slice(10).trim() : "unknown";
    epistemicDist[k] = (epistemicDist[k] || 0) + 1;
  }
  let semanticInfo = null;
  try { semanticInfo = semanticHealthForVerify(entries); }
  catch (e) { semanticInfo = { mode: "broken", degraded: true, reason: String(e.message || e).slice(0, 80) }; }
  if (candidateInfo.available && candidateInfo.issues.length) {
    stale.push(`[candidate] ${candidateInfo.issues.length} 条候选来源/升格异常（broken=${candidateInfo.brokenReferences}, duplicate=${candidateInfo.duplicateActivations}, unconfirmed=${candidateInfo.unconfirmedCurrent}）`);
  }
  out({ auditedAt: new Date().toISOString(), mode: MODE, root: ROOT, semantic: semanticInfo, total: entries.length, fields: { cards: entries.length, situation: situationCount, entities: entitiesCount, epistemic: epistemicDist, correctionsTop, conflicts: conflictCards.length, conflictIds: conflictCards.slice(0, 5) }, noise, empty, legacy, noiseRate: entries.length ? +(noise / entries.length).toFixed(3) : 0, bad: bad.slice(0, 20), stale, indexDrift: drift, indexHint: drift ? "索引与真源不一致，运行 index 重建" : undefined, absorption, injections, work: workInfo, coverage: coverageInfo, candidates: candidateInfo, sync: syncInfo, map: mapInfo, graph: graphInfo, failopen: failopenInfo, privacy: privacyInfo, tree: treeInfo, tags: tagsInfo });
}

function cmdDistill(days = 30, dryRun = false) {
  // K14 同族修复（2026-09-01 挑刺 T2）：cutoff 用本地日期口径（原 UTC 口径在 +08:00 的本地凌晨会多留一天，实测 08-01 卡漏归档）
  const cutoff = new Date(Date.now() - days * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  let archived = 0, skipped = 0;
  const would = [];   // dry-run 候选（只预览不移动）
  if (!dryRun) mkdirSync(DISTILLED_DIR, { recursive: true });
  // daily 超期 → distilled/（物理不删，保留 source 语义）
  if (existsSync(DAILY_DIR)) {
    for (const f of readdirSync(DAILY_DIR)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
      if (f.slice(0, 10) < cutoff) {
        if (dryRun) { would.push({ src: join(DAILY_DIR, f), dst: join(DISTILLED_DIR, `daily-${f}`) }); continue; }
        renameSync(join(DAILY_DIR, f), join(DISTILLED_DIR, `daily-${f}`)); archived++;
      }
    }
  }
  // memories **不再参与 distill 归档**（2026-09-15 用户拍板）。
  //   原则：🕰️ 条目留在检索池内，靠 fold 折叠 + 旧记忆降权（weight 0.5）控制权重，不物理移出。
  //   依据：DIRECTORY-MAP「memories/过去/ — 🕰️过去态卡归档，检索递归可达、默认折叠」。
  //   历史教训：此前会把超期 🕰️ 条目摘出为 distilled/mem-<id>.md → 不在检索池 → golden-set
  //     G-004（期望"🕰️但正文已回填完成"的条目仍可召回）失败，R@5 由 1.0 退至 0.8889。
  //   2026-09-15 同时把已误移出的 31 条回迁 memories。
  skipped = listMemoryEntries(MEM_DIR).length;
  if (dryRun) {
    out({ dryRun: true, scanned: "daily+memories", wouldArchive: would.length, candidates: would, note: "仅预览，未移动任何文件" });
    return;
  }
  cmdIndex(true);  // 归档后重建索引（静默：distill 单命令单 JSON 输出契约）
  out({ scanned: "daily+memories", archived, skipped, note: "归档物理不删，位于 distilled/" });
}

// ref-hunt：实体引用候选提取（2026-08-16）
// 保守策略：机器只出候选，经确认后 --apply 才写 frontmatter（用户裁决制，防误标）
// 实体白名单（CONTEXT.md 约定 ref: [person:<USER>, decision:2026-08-13-007]）：
//   person:<USER>          —— 正文提及用户称呼
//   decision:YYYY-MM-DD-NNN —— 正文引用蒸馏档案决策编号
// 自引用排除：memories 纸条正文首行标题头 `[类型·档案编号]` 即本条目标识（同一档案条目可有新旧多版），
//   该编号是"我是谁"而非"我引用谁"，必须排除；其余编号才是候选。
function cmdRefHunt(apply = false) {
  const entries = listMemoryEntries(MEM_DIR);
  const DECISION_RE = /(20\d{2}-\d{2}-\d{2}-\d{3,4})/g;
  const configuredPerson = String(process.env.CP_USER_NAME || "").trim();
  const PERSON_WHITELIST = configuredPerson ? [configuredPerson] : [];
  const candidates = [];
  const byType = {};
  for (const e of entries) {
    const id = e.id;
    const raw = normalize(e.raw);
    const fm = (raw.match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
    const hasRef = /^ref:/m.test(fm);   // 不依赖 readMeta（其字段集不含 ref）
    const body = raw.replace(/^---[\s\S]*?\n---\s*/, "");
    const headNo = (body.match(/^\[(?:需求|决策|术语|待办|遗留|偏好|事件)·(\d{4}-\d{2}-\d{2}-\d{3,4})/) || [])[1];
    const refs = new Set();
    // 决策编号引用（仅正文区，frontmatter 的 supersede 字段不重复计入）
    let m;
    DECISION_RE.lastIndex = 0;
    while ((m = DECISION_RE.exec(body))) {
      const d = m[1];
      if (d === headNo) continue;   // 标题头编号 = 本条目档案标识，非引用
      refs.add(`decision:${d}`);
    }
    // 人物白名单
    for (const p of PERSON_WHITELIST) if (body.includes(p)) refs.add(`person:${p}`);
    if (refs.size) {
      candidates.push({ file: e.virtualPath, id, hasRef, suggestedRef: [...refs], evidence: body.replace(/\s+/g, " ").slice(0, 60) });
      for (const r of refs) byType[r.split(":")[0]] = (byType[r.split(":")[0]] || 0) + 1;
    }
  }
  if (!apply) {
    out({
      dryRun: true,
      scanned: entries.length,
      candidates: candidates.length,
      byType,
      candidates,
      note: "只读候选预览，未写任何文件；确认后执行 ref-hunt --apply（候选制落盘）",
    });
    return;
  }
  // --apply：候选制落盘（人工裁决点）。跳过已有 ref 的（防覆盖人工标注）；写前备份可回滚；幂等重跑不重复写。
  const toWrite = candidates.filter(c => !c.hasRef);
  const skipped = candidates.length - toWrite.length;
  let backedUp = 0, applied = 0;
  const details = [];
  if (toWrite.length) {
    const bkDir = join(BACKUP_DIR, `ref-apply-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`);
    mkdirSync(bkDir, { recursive: true });
    for (const c of toWrite) {
      const entry = findEntry(MEM_DIR, c.id);
      if (!entry) continue;
      copyFileSync(entry.file, join(bkDir, c.id + ".md"));   // 写前备份（可回滚）
      backedUp++;
      const next = setField(entry.raw, "ref", `[${c.suggestedRef.join(", ")}]`);
      if (next !== entry.raw) { mutateEntryById(MEM_DIR, c.id, () => next); applied++; details.push({ id: c.id, ref: `[${c.suggestedRef.join(", ")}]` }); }
    }
    if (applied) buildLinks(ROOT);   // ref 变化后重生成派生索引
  }
  out({ dryRun: false, scanned: files.length, candidates: candidates.length, applied, skipped, backedUp, backupDir: backedUp ? join(BACKUP_DIR, "") : undefined, details, note: "ref 已写入 frontmatter；回滚=从 backupDir 恢复" });
}

// judge：蒸馏档案证据校验（只读疑点清单，2026-08-16）
// 对齐 Macro Judge 的"语义复核"思路，落地为证据真实性校验（不引入 LLM，保真链不变）：
//   high：编号重复/格式非法（确定性错误）
//   low：来源日期无 daily 对应 / 来源标注不可追溯（截断 id）/ 条目过短疑似空洞
function cmdJudge() {
  const files = existsSync(DISTILLED_DIR) ? readdirSync(DISTILLED_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)) : [];
  const dailyDates = existsSync(DAILY_DIR) ? new Set(readdirSync(DAILY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map(f => f.slice(5, 10))) : new Set();
  const issues = [];
  const seen = new Set();
  let entries = 0;
  for (const f of files) {
    const raw = normalize(readFileSync(join(DISTILLED_DIR, f), "utf8"));
    const lines = raw.split("\n");
    // 表格结构感知：每张表独立识别"来源"列位（需求表 3 列、术语表 4 列等，列结构不同）
    let srcCol = -1;
    for (const line of lines) {
      if (!line.startsWith("|")) continue;
      if (line.includes("来源")) {
        const cells = line.split("|");
        const idx = cells.findIndex(c => c.includes("来源"));
        if (idx > 1) { srcCol = idx; continue; }   // 新表头 → 更新列位
      }
      if (srcCol < 0) continue;
      const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2}-\d{3,4})\s*\|/);
      if (!m) continue;
      const cells = line.split("|");
      if (cells.length <= srcCol + 1) continue;
      entries++;
      const no = m[1];
      const src = (cells[srcCol] || "").trim();
      // 内容 = 编号列与来源列之间最长列（跳过编号列：其恒 14 字符会永远胜出致空洞判定死代码）
      // 需求表=内容；决策表=内容（归属列更短）；术语表=定义（术语名更短）
      let content = "";
      for (let i = 2; i < srcCol; i++) {
        const c = (cells[i] || "").trim();
        if (c.length > content.length) content = c;
      }
      if (seen.has(no)) issues.push({ file: f, no, level: "high", why: "编号重复" });
      seen.add(no);
      if (!/^\d{4}-\d{2}-\d{2}-\d{3}$/.test(no)) issues.push({ file: f, no, level: "high", why: "编号格式非法" });
      // 来源日期（MM-DD）与 daily 对应
      const dates = [...src.matchAll(/(\d{2})-(\d{2})/g)].map(x => `${x[1]}-${x[2]}`);
      for (const d of dates) if (!dailyDates.has(d)) issues.push({ file: f, no, level: "low", why: `来源日期 ${d} 无 daily 对应`, src });
      // 截断来源 id（无日期且形如 -xxx 或孤立短词；文件名中的连字符不算——要求整段无日期且以 · 或 / 分隔短词）
      if (!dates.length && /[·\/]\s*-\w{2,8}\b|^\s*-\w{2,8}\b/.test(src)) issues.push({ file: f, no, level: "low", why: "来源标注不可追溯（截断 id 无日期）", src });
      // 空洞：内容过短
      const plain = content.replace(/\*\*|`/g, "").trim();
      if (plain.length < 8) issues.push({ file: f, no, level: "low", why: "条目过短疑似空洞", src: plain });
    }
  }
  const high = issues.filter(i => i.level === "high");
  out({ dryRun: true, files: files.length, entries, issues: issues.length, high: high.length, low: issues.length - high.length, issues: issues.slice(0, 50), note: "只读证据校验，未写任何文件；人工裁决后自行处理" });
}

// view：声明式可刷新视图（对齐 Macro ai_projection 思路，事件驱动不轮询）
// 视图声明在 views/<name>.json（name/description/expiryDays）；渲染产物 views/<name>.md；
// 刷新时机 = 蒸馏后跑 view refresh --all（事件驱动，无定时任务）
const VIEWS_DIR = join(ROOT, "views");

function viewDecls() {
  if (!existsSync(VIEWS_DIR)) return [];
  return readdirSync(VIEWS_DIR).filter(f => f.endsWith(".json")).map(f => {
    try { return { ...JSON.parse(normalize(readFileSync(join(VIEWS_DIR, f), "utf8"))), file: f }; }
    catch { return null; }
  }).filter(Boolean);
}

function renderCurrentView() {
  const lines = [];
  const groups = {};
  for (const e of listMemoryEntries(MEM_DIR)) {
    const meta = e.meta;
    if (meta.status && !meta.status.includes("当前")) continue;
    const body = e.raw.replace(/^---[\s\S]*?\n---\s*/, "").replace(/\s+/g, " ").slice(0, 80);
    const type = meta.type || "其它";
    (groups[type] = groups[type] || []).push({ id: e.id, body });
  }
  for (const [type, items] of Object.entries(groups)) {
    lines.push(`## ${type}（${items.length}）`);
    for (const it of items) lines.push(`- \`${it.id}\` ${it.body}`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderView(decl) {
  if (decl.name === "current" || decl.renderer === "current") return renderCurrentView();
  return null;   // 未定义渲染器
}

function viewFreshness(name) {
  const out = join(VIEWS_DIR, `${name}.md`);
  if (!existsSync(out)) return { exists: false };
  const raw = readFileSync(out, "utf8");
  const m = raw.match(/<!-- view: (\S+) \| generatedAt: (\S+) \| expiryDays: (\d+) -->/);
  if (!m) return { exists: true, parseError: true };
  const gen = new Date(m[2]).getTime();
  const ageDays = (Date.now() - gen) / 86400000;
  return { exists: true, generatedAt: m[2], ageDays: +ageDays.toFixed(1), expired: ageDays > +m[3], expiryDays: +m[3] };
}

function cmdView(args) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const decls = viewDecls();
    out({ views: decls.map(d => ({ name: d.name, description: d.description, expiryDays: d.expiryDays, ...viewFreshness(d.name) })), note: "视图声明 views/*.json；过期不自动刷新（事件驱动，distill 后 view refresh --all）" });
    return;
  }
  if (sub === "init") {
    mkdirSync(VIEWS_DIR, { recursive: true });
    const f = join(VIEWS_DIR, "current.json");
    if (existsSync(f)) return out({ created: false, error: "current.json 已存在" });
    writeFileSync(f, JSON.stringify({ name: "current", description: "当前状态卡：所有 🟢当前 记忆条目按类型聚合（对齐 Macro ai_projection 个人视图）", renderer: "current", expiryDays: 7 }, null, 2));
    return out({ created: true, file: f });
  }
  const name = sub === "show" || sub === "refresh" ? args[1] : null;
  const all = args.includes("--all");
  if ((sub === "show" || sub === "refresh") && !name && !all) return out({ error: "用法: view show <name> | view refresh <name>|--all" });
  const decls = viewDecls();
  if (sub === "show") {
    const d = decls.find(x => x.name === name);
    if (!d) return out({ error: `视图 ${name} 未声明` });
    const body = renderView(d);
    if (body === null) return out({ error: `视图 ${name} 无渲染器` });
    return out({ name, dryRun: true, body: `# 🧭 当前视图（${name}）\n\n> 预览渲染（dry-run 未写入）\n\n${body}` });
  }
  if (sub === "refresh") {
    const targets = all ? decls : decls.filter(x => x.name === name);
    const results = [];
    for (const d of targets) {
      const body = renderView(d);
      if (body === null) { results.push({ name: d.name, ok: false, why: "无渲染器" }); continue; }
      mkdirSync(VIEWS_DIR, { recursive: true });
      const gen = new Date().toISOString();
      const header = `<!-- view: ${d.name} | generatedAt: ${gen} | expiryDays: ${d.expiryDays} -->\n# 🧭 当前视图（${d.name}）\n\n> 声明式可刷新视图（对齐 Macro ai_projection）：蒸馏后 refresh --all 重生成\n\n`;
      writeFileSync(join(VIEWS_DIR, `${d.name}.md`), header + body);
      results.push({ name: d.name, ok: true, generatedAt: gen, expiryDays: d.expiryDays });
    }
    return out({ refreshed: results.length, results, note: "已写入 views/<name>.md；可回滚（重跑 refresh 或删 md 保留声明）" });
  }
  return out({ error: "用法: view list|init|show <name>|refresh <name>|--all" });
}

function cmdMirror() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  let copied = 0;
  for (const dir of [MEM_DIR, DAILY_DIR, TOPICS_DIR]) {
    if (!existsSync(dir)) continue;
    for (const f of listMd(dir)) {
      const rel = f.slice(ROOT.length + 1).replace(/[\\/]/g, "_");
      copyFileSync(f, join(BACKUP_DIR, rel));
      copied++;
    }
  }
  // 项目根镜像（ADR-001 层2，2026-08-12）：身份证 + version + 目录清单（防 10 号事故：项目根丢失可恢复身份）
  try {
    const reg = JSON.parse(normalize(readFileSync(join(ROOT, "project-root.json"), "utf8")));
    const pr = reg.projectRoot;
    if (pr && existsSync(pr)) {
      const prBak = join(BACKUP_DIR, "project-root");
      mkdirSync(prBak, { recursive: true });
      for (const f of [".project-root.json", ".version"]) {
        const p = join(pr, f);
        if (existsSync(p)) { copyFileSync(p, join(prBak, f)); copied++; }
      }
      // 目录清单（只列文件名+大小+mtime，不镜像内容）
      const manifest = [];
      const walk = (d) => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, ent.name);
          if (ent.isDirectory()) { if (!ent.name.startsWith(".") && ent.name !== "node_modules") walk(p); }
          else if (!ent.name.startsWith(".")) { const st = statSync(p); manifest.push({ path: p.slice(pr.length + 1).replace(/[\\/]/g, "/"), size: st.size, mtime: st.mtime.toISOString() }); }
        }
      };
      walk(pr);
      writeFileSync(join(prBak, "manifest.json"), JSON.stringify({ rootId: reg.rootId, files: manifest.length, at: new Date().toISOString() }, null, 2));
      copied++;
    }
  } catch { /* 项目根未配置/解析失败则跳过 */ }
  const continuityFiles = ["current-state.json", "reply-policy.json", "resume-manifest.json"];
  for (const file of continuityFiles) {
    const source = join(ROOT, file);
    if (existsSync(source)) {
      copyFileSync(source, join(BACKUP_DIR, file));
      copied++;
    }
  }
  writeFileSync(join(BACKUP_DIR, "last-mirror.txt"), new Date().toISOString(), "utf8");
  out({ mirrored: copied, backup: BACKUP_DIR, at: new Date().toISOString() });
}

// 项目根 version 更新（ADR-001 层2，2026-08-12）：收尾/maintain 时更新项目根 .version + 真源登记 lastVerified
// 校验只比 version（平时不吵）；version 倒退 = 异常替换，arrival-check 会报
function cmdProjectVersion() {
  try {
    const regFile = join(ROOT, "project-root.json");
    if (!existsSync(regFile)) return { ok: false, error: "project-root.json 不存在（未配置项目根）" };
    const reg = JSON.parse(normalize(readFileSync(regFile, "utf8")));
    const pr = reg.projectRoot;
    if (!pr || !existsSync(pr)) return { ok: false, error: `项目根目录不存在: ${pr}` };
    const verFile = join(pr, ".version");
    let version = 0;
    if (existsSync(verFile)) { try { version = JSON.parse(normalize(readFileSync(verFile, "utf8"))).version || 0; } catch {} }
    version += 1;
    const fileCount = (() => { let n = 0; const walk = (d) => { for (const ent of readdirSync(d, { withFileTypes: true })) { const p = join(d, ent.name); if (ent.isDirectory()) { if (!ent.name.startsWith(".") && ent.name !== "node_modules") walk(p); } else if (!ent.name.startsWith(".")) n += 1; } }; walk(pr); return n; })();
    writeFileSync(verFile, JSON.stringify({ rootId: reg.rootId, version, updatedAt: new Date().toISOString(), files: fileCount }, null, 2), "utf8");
    reg.lastVerified = new Date().toISOString();
    reg.lastVersion = version;
    writeFileSync(regFile, JSON.stringify(reg, null, 2), "utf8");
    return { ok: true, rootId: reg.rootId.slice(0, 8), version, files: fileCount };
  } catch (e) { return { ok: false, error: e.message }; }
}

function cmdMaintain() {
  cmdIndex();
  cmdEmbedBuild();   // 2026-08-13：向量缓存重建（模型缺失时跳过，纯 BM25 不受影响）
  cmdDistill(30);
  cmdProjectVersion();   // 先更新 version，mirror 才能镜像到（顺序敏感，2026-08-12）
  cmdMirror();
  cmdOrganize(["--apply"]);   // 2026-08-28 memories 治理：🕰️ 卡归档过去/ 子目录（幂等）
  cmdEvalGolden();   // 2026-08-28：黄金集评测挂链（用户拍板），收尾链末步自动验收检索
  try { cmdDailyIndex(); } catch {}
  // 票 12：周期 review —— 每次 maintain 产一份 dream 报告（只读），提案单独 --propose
  try { const r = spawnSync(process.execPath, ["--experimental-sqlite", join(ENGINE_ROOT, "memory-cli.js"), "dream", "--write", "--root", ROOT], { encoding: "utf8", timeout: 60000 }); console.log(r.status === 0 ? "[maintain] dream 报告已刷新" : "[maintain] dream 跳过：" + String(r.stderr || "").slice(0, 60)); } catch (e) { console.log("[maintain] dream 跳过：" + String(e.message || e).slice(0, 60)); }
  out({ done: true, steps: ["index", "embed", "distill", "project-version", "mirror", "organize", "eval", "daily-index"] });
}

// 黄金集评测（F13 前置，2026-08-28 用户拍板挂收尾链）：跑 eval/eval-retrieval.js，
//   结果落 eval/last-result.json 供 verify F13 守卫读取；评测失败 fail-open 不阻塞 maintain。
function cmdEvalGolden() {
  const r = spawnSync(NODE_BIN, [join(ENGINE_ROOT, "eval", "eval-retrieval.js"), "--root", ROOT, "--k", "5"], { encoding: "utf8", timeout: 120000 });
  try {
    const j = JSON.parse((r.stdout || "").trim());
    mkdirSync(join(ROOT, "eval"), { recursive: true });
    writeFileSync(join(ROOT, "eval", "last-result.json"), JSON.stringify(j, null, 2), "utf8");
    const s = j.summary || {};
    out({ eval: { scope: j.scope, recallAtK: s.recallAtK, mrr: s.mrr, ndcg: s.ndcg, irrelevantRate: s.irrelevantRate, failList: s.failList || [] } });
  } catch { out({ eval: "skipped", reason: "eval-retrieval 输出异常（fail-open）" }); }
}

function cmdEmbedBuild() {
  // 向量层为可选增强：模型缺失/onnxruntime 缺失时输出跳过信息（fail-open，绝不失败）
  const child = spawnSync(NODE_BIN, [join(ENGINE_ROOT, "embed.js"), "build", "--root", ROOT], { encoding: "utf8", timeout: 300000 });
  try {
    const j = JSON.parse((child.stdout || "").trim());   // 整段解析（embed build 为多行 pretty JSON）
    if (j.error) out({ embed: "skipped", reason: j.error.slice(0, 120) });
    else out({ embed: "built", total: j.total, kept: j.kept, embedded: j.embedded, missing: j.missing });
  } catch { out({ embed: "skipped", reason: "embed build 输出异常（fail-open）" }); }
}

// 待验证池确认通道（2026-08-28 用户拍板"自动提取+待验证池"）：
//   confirm              列出全部 ⏳待验证 卡
//   confirm <id...>|--all  转正 → 🟢当前（frontmatter 加 confirmed 时间戳）
//   reject <id...>       拒绝 → 🕰️过去（不物理删，历史保留）
// memories 目录治理（2026-08-28 用户拍板"①去重+②分层，关联链红线"）：
//   dedup  [--apply]     正文完全重复的组 → 保留一组一卡，其余 🕰️+superseded_by 指向保留卡（supersede 语义不物理删；已有链的卡不碰）
//   organize [--apply]   根目录的 🕰️ 卡移入 memories/过去/ 子目录（幂等；maintain 末步自动归档）
function cmdDedup(args) {
  const apply = args.includes("--apply");
  const docs = loadMemoryDocs(MEM_DIR);
  const groups = new Map();
  for (const d of docs) {
    const body = d.body.trim();
    if (body.length <= 10) continue;   // 过短正文不并（误合并风险）
    if (!groups.has(body)) groups.set(body, []);
    groups.get(body).push(d);
  }
  const dups = [...groups.entries()].filter(([, v]) => v.length > 1);
  const rank = (d) => ((d.meta.status || "").includes("当前") ? 3 : (d.meta.status || "").includes("过去") ? 0 : 1);
  const actions = [];
  for (const [, v] of dups) {
    const sorted = [...v].sort((a, b) => rank(b) - rank(a) || (Date.parse(b.meta.created || "") || 0) - (Date.parse(a.meta.created || "") || 0));
    const keepId = sorted[0].meta.id;
    for (const d of sorted.slice(1)) {
      // 关联链红线（用户 2026-08-28）：已正确指向保留卡的跳过；已指向别处的保守不碰；过去但无链的补链（重复大头，跳过则永远清不掉）
      if (d.meta.supersededBy === keepId) continue;
      if (d.meta.supersededBy && d.meta.supersededBy !== keepId) continue;
      actions.push({ id: d.meta.id, file: d.path, keepId, wasPast: (d.meta.status || "").includes("过去") });
    }
  }
  if (!apply) return out({ groups: dups.length, wouldSupersede: actions.length, actions });
  let applied = 0;
  for (const a of actions) {
    const r = mutateEntryById(MEM_DIR, a.id, (raw) => {
      let t = raw;
      if (!a.wasPast) t = t.replace(/^status:\s*.+$/m, "status: 🕰️过去");
      return t.replace(/^(scope:\s*.+)$/m, `$1
superseded_by: ${a.keepId}`);
    });
    if (r.ok) applied += 1;
  }
  buildLinks(ROOT);   // 关联链重建（红线动作）
  out({ applied, groups: dups.length, linksRebuilt: true });
}

function cmdOrganize(args) {
  // 月度分桶（2026-09-01）：🕰️ 状态随条目驻留月桶内（折叠/检索已按状态沉底），物理移动仅对遗留单卡保留
  const apply = args.includes("--apply");
  const pastDir = join(MEM_DIR, "过去");
  const entries = listMemoryEntries(MEM_DIR);
  const legacyPast = entries.filter(e => !e.bucket && dirname(e.file) === MEM_DIR && (e.meta.status || "").includes("过去"));
  const bucketPast = entries.filter(e => e.bucket && (e.meta.status || "").includes("过去"));
  if (!apply) return out({ wouldMove: legacyPast.length, files: legacyPast.map(m => basename(m.file)), bucketPast: bucketPast.length, note: "桶内 🕰️ 条目驻留月桶（状态即归档），仅遗留单卡物理移动" });
  if (legacyPast.length) mkdirSync(pastDir, { recursive: true });
  for (const m of legacyPast) renameSync(m.file, join(pastDir, basename(m.file)));
  out({ moved: legacyPast.length, dir: pastDir, bucketPast: bucketPast.length });
}

function cmdConfirm(args) {
  const now = new Date().toISOString();
  const pending = listMemoryEntries(MEM_DIR).filter(e => (e.meta.status || "").includes("待验证"));
  const mode = args[0];
  if (!mode || mode === "--list") {
    return out({ pending: pending.length, items: pending.map(p => ({ id: p.id, created: p.meta.created, file: p.virtualPath.split("#").pop() || p.file, snippet: p.raw.replace(/^---[\s\S]*?---/, "").trim().slice(0, 60) })) });
  }
  const toConfirm = mode === "--all" ? pending.map(p => p.id).filter(Boolean) : mode === "reject" ? [] : args;
  const toReject = mode === "reject" ? args.slice(1) : [];
  let confirmed = 0, rejected = 0, missing = [];
  const byId = new Map(pending.map(p => [p.id, p]));
  for (const id of toConfirm) {
    const p = byId.get(id);
    if (!p) { missing.push(id); continue; }
    // T6 对称性（2026-08-29 审计）：不合格卡不得转正——确认动作本身要有门（否则垃圾转正成噪音卡）
    // 月度分桶：校验对象 = 物化的临时单卡文件（validate 单实现不改）
    const tmp = join(MEM_DIR, `.tmp-confirm-${id}.md`);
    writeFileSync(tmp, p.raw, "utf8");
    const v = validateCheck(tmp);
    rmSyncSafe(tmp);
    if (!v.ok) { missing.push(`${id}（校验不过：${(v.reasons || []).join("；").slice(0, 60)}）`); continue; }
    const r = mutateEntryById(MEM_DIR, id, (t) => t
      .replace(/^status:\s*⏳待验证\s*$/m, "status: 🟢当前")
      .replace(/^(scope:\s*.+)$/m, `$1
confirmed: ${now}`));
    if (r.ok) confirmed += 1; else missing.push(id);
  }
  for (const id of toReject) {
    const p = byId.get(id);
    if (!p) { missing.push(id); continue; }
    const r = mutateEntryById(MEM_DIR, id, (t) => t.replace(/^status:\s*⏳待验证\s*$/m, "status: 🕰️过去"));
    if (r.ok) rejected += 1; else missing.push(id);
  }
  out({ mode: mode === "reject" ? "reject" : "confirm", confirmed, rejected, missing, remaining: pending.length - confirmed - rejected });
}

function cmdCompatibility(args = []) {
  if (!legacyCompat) return out({ ok: false, error: "兼容报告模块不可用", code: "LEGACY_COMPAT_MODULE_MISSING" });
  try { return out(legacyCompat(ROOT, { details: args.includes("--details") })); }
  catch (error) { return out({ ok: false, error: String(error.message || error), code: "LEGACY_COMPAT_REPORT_FAILED" }); }
}

const DOMAIN_VALUE_FLAGS = new Set(["--root", "--scope", "--source-ref", "--source-kind", "--review-status", "--id", "--domain", "--domains", "--actor", "--reason", "--query", "--content"]);
function domainsPositionals(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value.startsWith("--")) {
      if (DOMAIN_VALUE_FLAGS.has(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function domainsAuthorization(args) {
  return { explicit_user_confirmation: args.includes("--user-confirmed"), actor: candidateArg(args, "--actor") };
}

function cmdDomains(args = []) {
  if (!memoryDomains) return out({ ok: false, error: "三域记忆模块不可用", code: "MEMORY_DOMAINS_MODULE_MISSING" });
  const [resource, action, ...tail] = args;
  const options = domainsAuthorization(args);
  try {
    let result;
    if (resource === "status" && domainsPositionals(args).length === 1) result = memoryDomains.inspectProduct(ROOT);
    else if (resource === "search") {
      const query = candidateArg(args, "--query") || domainsPositionals(args.slice(1))[0] || "";
      const requestedDomain = candidateArg(args, "--domain");
      const crossDomain = args.includes("--cross-domain");
      if ((requestedDomain && crossDomain) || (!requestedDomain && !crossDomain)) {
        return out({ ok: false, error: "检索必须指定 --domain，或显式使用 --cross-domain；两者不可并用", code: requestedDomain ? "INVALID_ARGS" : "DOMAIN_REQUIRED" });
      }
      result = memoryDomains.searchMemories(ROOT, { domain: requestedDomain, cross_domain: crossDomain, query, scope: candidateArg(args, "--scope") });
    } else if (resource === "candidate" && action === "create") {
      const candidateContent = candidateArg(args, "--content") || domainsPositionals(tail)[0];
      result = memoryDomains.createCandidate(ROOT, { content: candidateContent, scope: candidateArg(args, "--scope"), source_ref: candidateArg(args, "--source-ref"), source_kind: candidateArg(args, "--source-kind"), ...options });
    } else if (resource === "candidate" && action === "list") {
      result = { ok: true, candidates: memoryDomains.listCandidates(ROOT, { review_status: candidateArg(args, "--review-status") }) };
    } else if (resource === "candidate" && action === "show") {
      const candidateId = candidateArg(args, "--id") || domainsPositionals(tail)[0];
      result = { ok: true, candidate: memoryDomains.getCandidate(ROOT, candidateId) };
    } else if (resource === "candidate" && action === "classify") {
      result = memoryDomains.classifyCandidate(ROOT, { candidate_id: candidateArg(args, "--id"), primary_domain: candidateArg(args, "--domain"), domains: candidateArg(args, "--domains")?.split(",").map(value => value.trim()).filter(Boolean), ...options });
    } else if (resource === "candidate" && action === "edit") {
      result = memoryDomains.editCandidate(ROOT, { candidate_id: candidateArg(args, "--id"), content: candidateArg(args, "--content") || domainsPositionals(tail)[0], ...options });
    } else if (resource === "candidate" && action === "defer") {
      result = memoryDomains.deferCandidate(ROOT, { candidate_id: candidateArg(args, "--id"), ...options });
    } else if (resource === "candidate" && action === "resume") {
      result = memoryDomains.resumeCandidate(ROOT, { candidate_id: candidateArg(args, "--id"), ...options });
    } else if (resource === "candidate" && action === "reject") {
      result = memoryDomains.rejectCandidate(ROOT, { candidate_id: candidateArg(args, "--id"), reason: candidateArg(args, "--reason"), ...options });
    } else if (resource === "candidate" && action === "confirm") {
      result = memoryDomains.confirmCandidate(ROOT, { candidate_id: candidateArg(args, "--id"), ...options });
    } else if (resource === "correct") {
      const values = domainsPositionals(args.slice(1));
      result = memoryDomains.correctMemory(ROOT, { memory_id: candidateArg(args, "--id") || values[0], content: candidateArg(args, "--content") || values[1], ...options });
    } else {
      return out({ ok: false, error: "用法: domains status|search|candidate create|list|show|classify|edit|defer|resume|reject|confirm|correct" , code: "INVALID_COMMAND" });
    }
    return out(result);
  } catch (error) {
    return out({ ok: false, error: String(error.message || error), code: error.code || "MEMORY_ERROR" });
  }
}

function cmdStats() {
  const entries = listMemoryEntries(MEM_DIR);
  const byScope = {}, byStatus = {}, byType = {};
  for (const e of entries) {
    const s = e.meta.scope || "?"; byScope[s] = (byScope[s] || 0) + 1;
    const st = e.meta.status || "?"; byStatus[st] = (byStatus[st] || 0) + 1;
    const t = e.meta.type || "未分类"; byType[t] = (byType[t] || 0) + 1;
  }
  const dailyCount = existsSync(DAILY_DIR) ? readdirSync(DAILY_DIR).filter(f => f.endsWith(".md")).length : 0;
  out({ total: entries.length, dailyFiles: dailyCount, byScope, byStatus, byType, buckets: bucketStats(MEM_DIR), dbBytes: existsSync(INDEX_DB) ? statSync(INDEX_DB).size : 0 });
}

// quota：注入/记忆各预算点占用一键聚合（2026-09-01 优化 #3）
//   真源分工：身份卡/胶囊（inject 链）= inject.js --report 单实现；hook 胶囊 = resume-context render 实测；
//   recall = 无查询实测（门禁+状态+术语+最近工作，即新会话开场注入的主体）；AGENTS 注入 = statSync（与 verify 同源）。
function cmdQuota() {
  const pct = (b, c) => (c > 0 ? +(b / c * 100).toFixed(1) : 0);
  const configErrors = [];
  const measurementErrors = [];
  const commandFailure = (label, result) => {
    const detail = String(result?.error?.message || result?.stderr || "").trim().replace(/\s+/g, " ").slice(0, 240);
    return `${label} 失败${result?.status == null ? "（未启动）" : `（退出码 ${result.status}）`}${detail ? `: ${detail}` : ""}`;
  };
  const rep = spawnSync(NODE_BIN, [join(ENGINE_ROOT, "inject.js"), "--report", "--root", ROOT], { encoding: "utf8", timeout: 30000 });
  let identityCard = { bytes: null, budget: null, util: null, warn: false }, recoveryInject = { bytes: null, budget: null, util: null, warn: false }, memoryBudget = null;
  try {
    if (rep.status !== 0 || rep.error) throw new Error(commandFailure("inject --report", rep));
    const j = JSON.parse((rep.stdout || "").trim());
    if (!j.identityCard || !j.recovery || !j.memory || !Number.isFinite(j.identityCard.bytes) || !Number.isFinite(j.identityCard.budget) || !Number.isFinite(j.recovery.bytes) || !Number.isFinite(j.recovery.budget) || !Number.isFinite(j.memory.budget)) throw new Error("缺少完整预算字段");
    identityCard = { bytes: j.identityCard.bytes, budget: j.identityCard.budget, util: pct(j.identityCard.bytes, j.identityCard.budget), warn: !!j.identityCard.warn };
    recoveryInject = { bytes: j.recovery.bytes, budget: j.recovery.budget, util: pct(j.recovery.bytes, j.recovery.budget), warn: !!j.recovery.warn };
    memoryBudget = j.memory.budget;
    if ((j.configErrors || []).length) configErrors.push(...j.configErrors);
  } catch (error) {
    measurementErrors.push(`${commandFailure("inject --report", rep)}: ${error.message}`);
  }
  const hook = spawnSync(NODE_BIN, [join(ENGINE_ROOT, "resume-context.js"), "render", "--root", ROOT], { encoding: "utf8", timeout: 30000 });
  let recoveryHook = { bytes: null, budget: recoveryInject.budget, util: null };
  if (hook.status === 0 && hook.error == null && typeof hook.stdout === "string") {
    const bytes = Buffer.byteLength(hook.stdout);
    recoveryHook = { bytes, budget: recoveryInject.budget, util: recoveryInject.budget == null ? null : pct(bytes, recoveryInject.budget) };
  } else measurementErrors.push(commandFailure("resume-context render", hook));
  const rec = spawnSync(NODE_BIN, [join(ENGINE_ROOT, "memory-cli.js"), "recall", "--bytes", "5000", "--root", ROOT], { encoding: "utf8", timeout: 30000 });
  let recall = { bytes: null, budget: null, util: null, truncated: false };
  try {
    if (rec.status !== 0 || rec.error) throw new Error(commandFailure("memory-cli recall", rec));
    const j = JSON.parse((rec.stdout || "").trim());
    if (!Number.isFinite(j.bytes) || !Number.isFinite(j.budget)) throw new Error("缺少 bytes/budget 字段");
    recall = { bytes: j.bytes, budget: j.budget, util: pct(j.bytes, j.budget), truncated: !!j.truncated };
  } catch (error) {
    measurementErrors.push(`${commandFailure("memory-cli recall", rec)}: ${error.message}`);
  }
  const injections = { agentsWs: 0, agentsUser: 0, replyPolicy: 0, total: 0 };
  const hostConfigErrors = HOST_CHECKS.errors || [];
  try {
    const userInjection = explicitUserInjectionPath();
    for (const [k, p] of [["agentsWs", join(ROOT, "AGENTS.md")], ["agentsUser", userInjection], ["replyPolicy", join(ROOT, "reply-policy.json")]]) {
      if (p && existsSync(p)) injections[k] = statSync(p).size;
    }
    injections.total = injections.agentsWs + injections.agentsUser + injections.replyPolicy;
  } catch {}

  let contextDays = null;
  try { contextDays = +((Date.now() - statSync(join(ROOT, ".context", "CONTEXT.md")).mtimeMs) / 86400000).toFixed(1); } catch {}
  const warnings = [];
  if (identityCard.warn) warnings.push("身份卡接近预算");
  if (recoveryInject.warn) warnings.push("恢复胶囊（inject）接近预算");
  if (recoveryHook.bytes > recoveryHook.budget * 0.9) warnings.push("恢复胶囊（hook）接近预算");
  if (recall.truncated || recall.util > 90) warnings.push("recall 开场注入接近/已达预算");
  if (injections.agentsUser > 12000) warnings.push("agentsUser 超 12KB 软上限");
  if (injections.total > 20000) warnings.push("注入总量超 20KB");
  out({ ok: measurementErrors.length === 0, identityCard, recoveryInject, recoveryHook, recall, memorySegmentBudget: memoryBudget, injections, context: { daysSinceWrite: contextDays, staleAtDays: 5 }, configErrors: [...configErrors, ...hostConfigErrors], measurementErrors, warnings, note: "口径统一：胶囊双通道均读 inject.config.json recoveryBytes；宿主路径只来自显式配置；warn 线 90%。recall 口径 = 新会话开场注入主体（无查询实测）；测量失败不会以 0 计入。" });
}

function cmdImport(fromDir) {
  if (!fromDir || !existsSync(fromDir)) return out({ imported: 0, error: "来源目录不存在" });
  const files = readdirSync(fromDir).filter(f => f.endsWith(".md"));
  let imported = 0; const conflicts = [];
  mkdirSync(MEM_DIR, { recursive: true });
  for (const f of files) {
    const raw = normalize(readFileSync(join(fromDir, f), "utf8"));
    const meta = readMeta(raw);
    if (!meta.id) { conflicts.push({ file: f, reason: "无 id，需补 frontmatter（legacy 降权）" }); continue; }
    if (findEntry(MEM_DIR, meta.id)) { conflicts.push({ file: f, reason: "同 id 条目已存在，人工裁决" }); continue; }
    const tagged = raw.replace(/^(---\n)/, `$1source: import/${f}\n`);
    appendEntry(MEM_DIR, tagged, { month: String(meta.created || "").slice(0, 7) || undefined });
    imported++;
  }
  cmdIndex();
  out({ imported, conflicts, note: "冲突条目需人工裁决；legacy 条目加 status: 🕰️ + tags: [legacy] 降权" });
}

// ---------- 入口 ----------
const args = process.argv.slice(2);
const cmd = args[0];
const candidateDistillDryRun = cmd === "candidate" && args[1] === "distill-events" && !args.includes("--apply");
const domainsReadOnly = cmd === "domains" && (args[1] === "status" || args[1] === "search" || (args[1] === "candidate" && ["list", "show"].includes(args[2])));
// T00 根隔离护树：引擎态下写命令默认拒绝；显式 domains 查询保持只读。
if (WRITE_CMDS.has(cmd) && MODE !== "instance" && !candidateDistillDryRun && !domainsReadOnly && !process.argv.includes("--allow-engine-write")) {
  out({ ok: false, blocked: "ENGINE_MODE_WRITE", mode: MODE, root: ROOT,
    hint: "当前根不是完整实例（无 memories/ 或 events.db）。写命令默认拒绝；确实要写就加 --allow-engine-write，或用 --root <完整实例目录>" });
  process.exit(1);
}
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
function positiveInt(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}
function positionalAfterCommand() {
  for (let i = 1; i < args.length; i += 1) {
    if (args[i].startsWith("--")) { i += 1; continue; }
    return args[i];
  }
  return undefined;
}

// ---------- recall：新会话一键召回（2026-08-11）----------
// 默认只拼接门禁、current-state 和已确认活跃记忆；daily/events/distilled 是受控证据层。
async function cmdRecall(query, days = 3, bytes = 3000) {  const parts = [];
  // 0. 门禁（回复规则，注入即生效）
  try {
    const p = JSON.parse(readFileSync(join(ROOT, "reply-policy.json"), "utf8"));
    if (p.opening) parts.push(`门禁: ${p.opening}`);
    if (Array.isArray(p.rules)) parts.push(p.rules.map((r, i) => `${i + 1}.${r}`).join(" "));
    if (Array.isArray(p.forbidden) && p.forbidden.length) parts.push(`禁用词: ${p.forbidden.join(" / ")}`);
  } catch { parts.push("门禁（读取失败）"); }
  try {
    const st = JSON.parse(readFileSync(join(ROOT, "current-state.json"), "utf8"));
    parts.push(`## 当前状态（revision ${st.revision}）`);
    if (st.objective) parts.push(`objective: ${st.objective}`);
    if (st.summary) parts.push(`summary: ${st.summary}`);
    if (Array.isArray(st.nextActions) && st.nextActions.length) parts.push(`nextActions: ${st.nextActions.map((x, i) => `${i + 1}.${x}`).join(" ")}`);
    if (Array.isArray(st.blockers) && st.blockers.length) parts.push(`blockers: ${st.blockers.join(" / ")}`);
  } catch { parts.push("## 当前状态（读取失败）"); }
  // 领域术语索引（读侧注入 2026-08-17）：新会话跑 recall 自动带 CONTEXT 术语名清单，
  //   低成本提示"存在领域语言"，细节按需读 .context/CONTEXT.md（F11 守卫盯回流新鲜度）
  try {
    const cp = join(ROOT, ".context", "CONTEXT.md");
    if (existsSync(cp)) {
      const terms = (readFileSync(cp, "utf8").match(/^- 术语：([^\n（]+)/gm) || []).map((t) => t.replace(/^- 术语：/, "").trim()).filter(Boolean);
      if (terms.length) {
        // 术语段子预算封顶（2026-09-01 优化 #2a）：术语数随共识线性增长，全量注入会挤爆 recall 预算——
        //   超 500B 只展示装得下的前 N 项 + 数量指针，全量仍在 CONTEXT.md（注入层纪律：低频轨不膨胀）
        const TERMS_BUDGET = 500;
        let shown = terms;
        while (Buffer.byteLength(shown.join(" / ")) > TERMS_BUDGET && shown.length > 3) shown = shown.slice(0, -1);
        const trimmed = shown.length < terms.length;
        parts.push(`## 领域术语（${terms.length} 项${trimmed ? `，前 ${shown.length} 项展示` : ""}，细节见 .context/CONTEXT.md）\n${shown.join(" / ")}${trimmed ? " / …" : ""}`);
      }
    }
  } catch {}
  // 当前工作不从 daily 推断；若要跨回合接力，请显式更新 current-state。
  if (query) {
    try {
      const opts = {
        memoryDir: MEM_DIR, top: 3, snippetBytes: 600,
        since: get("--since"), until: get("--until"), scope: get("--scope"),
      };
      let result = null;
      if (get("--bm25-only") === undefined) {
        try { result = await retrieveMemoriesHybrid(query, opts); } catch {}
      }
      if (!result) result = retrieveMemories(query, opts);
      if (result.results.length) parts.push(`## 相关记忆（${query}）`);
      for (const item of result.results) {
        const body = item.raw.replace(/^---[\s\S]*?---/, "").trim();
        parts.push(`- ${item.id}: ${truncateUtf8(body, 360)}${item.related ? `（+${item.related} 条同主题已折叠）` : ""}`);
      }
    } catch {}
  }
  let body = parts.join("\n");
  let truncated = false;
  if (Buffer.byteLength(body) > bytes) {
    const marker = "\n…(截断)";
    body = truncateUtf8(body, Math.max(0, bytes - Buffer.byteLength(marker))).replace(/\n[^\n]*$/, "") + marker;
    truncated = true;
  }
  if (truncated) {
    // 截断显式化（2026-08-17）：头部警告，Agent 一眼可见"丢了尾部"，不再静默
    body = `⚠️ 输出已达预算 ${bytes} 字节，尾部（最近工作/蒸馏速览等）未包含；需要更多用 --bytes 更大值\n\n` + body;
  }
  out({ recall: body, bytes: Buffer.byteLength(body), budget: bytes, truncated });
}

switch (cmd) {
  case "search": await cmdSearch(positionalAfterCommand(), positiveInt(get("--top"), 3, 50), { abstain: args.includes("--abstain") }); break;
  case "candidate": cmdCandidate(args.slice(1)); break;
  case "domains": cmdDomains(args.slice(1)); break;
  case "recall": await cmdRecall(positionalAfterCommand(), positiveInt(get("--days"), 3, 30), positiveInt(get("--bytes"), 3000, 20000)); break;
  case "add": cmdAdd(args[1], { scope: get("--scope"), tags: get("--tags"), type: get("--type"), source: get("--source"), epistemic: get("--epistemic"), sourceKind: get("--source-kind"), situation: get("--situation"), entities: get("--entities") }); break;
  case "log": cmdLog(get("--transcript"), get("--session")); break;
  case "inject": cmdInject(get("--hint"), Number(get("--top") || 3)); break;
  case "current": cmdCurrent(args[1] || "show", args.slice(2)); break;
  case "resume": cmdResume(args[1] || "check", args.slice(2)); break;
  case "reply-check": cmdReplyCheck(args.slice(1)); break;
  case "arrival-check": cmdArrival(args.slice(1)); break;
  case "index": cmdIndex(); break;
  case "vec-bin": {
    // 票 09：把浮点向量库压成二进制（1 位/维），并报告体积与指纹；不动原 vectors.json。
    const { buildBinaryStore } = await import("./lib/binary-vec.js");
    const src = join(ROOT, "embedding-db", "vectors.json");
    if (!existsSync(src)) { out({ ok: false, error: "缺 embedding-db/vectors.json（先跑 maintain 或 embed build）" }); break; }
    const store = JSON.parse(readFileSync(src, "utf8"));
    const { payload, sha256, bytes } = buildBinaryStore(store);
    const dst = join(ROOT, "embedding-db", "vectors.bin.json");
    writeFileSync(dst, JSON.stringify(payload), "utf8");
    const floatBytes = fsStatSize(src);
    out({ ok: true, file: dst, cards: Object.keys(payload.entries).length, dim: payload.dim, bytesPerCard: Math.ceil(payload.dim / 8), bytes, floatBytes, ratio: +(floatBytes / (bytes || 1)).toFixed(1), sha256 });
    break;
  }
  case "daily-index": cmdDailyIndex(); break;
  case "verify": cmdVerify(); break;
  case "project-version": out(cmdProjectVersion()); break;
  case "distill": cmdDistill(Number(get("--days") || (/^\d+$/.test(args[1] || "") ? args[1] : 30)), args.includes("--dry-run")); break;
  case "ref-hunt": cmdRefHunt(args.includes("--apply")); break;
  case "judge": cmdJudge(); break;
  case "view": cmdView(args.slice(1)); break;
  case "maintain": cmdMaintain(); break;
  case "stats": cmdStats(); break;
  case "compatibility":
    if (args[1] !== "report") out({ ok: false, error: "用法: compatibility report [--details]" });
    else cmdCompatibility(args.slice(2));
    break;
  case "quota": cmdQuota(); break;
  case "confirm": cmdConfirm(args.slice(args.indexOf("confirm") + 1)); break;
  case "dedup": cmdDedup(args.slice(args.indexOf("dedup") + 1)); break;
  case "organize": cmdOrganize(args.slice(args.indexOf("organize") + 1)); break;
  case "reject": cmdConfirm(["reject", ...args.slice(args.indexOf("reject") + 1)]); break;
  case "events": {
    // 原始事件层子命令（双轨：status/purge/export），转发 events.js（单实现原则）
    const sub = args[1] || "status";
    const evArgs = ["--experimental-sqlite", join(ENGINE_ROOT, "events.js"), sub, ...args.slice(2)];
    if (ROOT !== join(homedir(), ".cosmic-phantom")) evArgs.push("--root", ROOT);   // K26 同族：透传
    const child = spawnSync(NODE_BIN, evArgs, { encoding: "utf8", timeout: 60000 });
    process.stdout.write(child.stdout || "");
    break;
  }
  case "expand": {
    // 渐进展开（2026-08-31 实装）：L1 命中 → L2 会话上下文 → L3 逐字事件流。
    // 三入口：--memory <条目id|路径>（解析 source/created 锚点转 --date）| --session | --evt，核心在 events.js（单实现原则）。
    if (!get("--memory")) {
      const evArgs = ["--experimental-sqlite", join(ENGINE_ROOT, "events.js"), "expand", ...args.slice(1)];
      if (ROOT !== join(homedir(), ".cosmic-phantom")) evArgs.push("--root", ROOT);
      const child = spawnSync(NODE_BIN, evArgs, { encoding: "utf8", timeout: 60000 });
      process.stdout.write(child.stdout || "");
      break;
    }
    const q = get("--memory");
    // 月度分桶（2026-09-01）：按条目 id/路径解析（桶条目+遗留单卡通吃）
    const all = listMemoryEntries(MEM_DIR);
    const hit = all.find(e => e.id === q || basename(e.file) === `${q}.md` || basename(e.file) === q || q.endsWith(basename(e.file)) || (e.id && new RegExp(`^id: ${q}$`, "m").test(normalize(e.raw))));
    if (!hit) { out({ error: "记忆条目未命中", memory: q, hint: "传条目 id（如 20260807-0001）、文件名或路径" }); break; }
    if (all.filter(e => e.id === hit.id).length > 1) { out({ error: "同 id 条目多张（需唯一），人工裁决", id: hit.id }); break; }
    const meta = hit.meta;
    const sm = String(meta.source || "").match(/daily\/(\d{4}-\d{2}-\d{2})\.md/);
    const date = sm ? sm[1] : String(meta.created || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { out({ error: "条目无可用锚点（source 非 daily 指针且 created 无日期）", id: meta.id || q, source: meta.source || null, created: meta.created || null }); break; }
    const rest = args.slice(1).filter(a => a !== "--memory" && a !== q);
    const evArgs = ["--experimental-sqlite", join(ENGINE_ROOT, "events.js"), "expand", "--date", date, ...rest];
    if (ROOT !== join(homedir(), ".cosmic-phantom")) evArgs.push("--root", ROOT);
    const child = spawnSync(NODE_BIN, evArgs, { encoding: "utf8", timeout: 60000 });
    process.stdout.write(child.stdout || "");
    break;
  }
  case "import": cmdImport(get("--from")); break;
  case "tags": {
    if (args.includes("--normalize")) { cmdTagNormalize(args.includes("--apply"), args.includes("--confirm")); break; }
    const mod = await import("./tag-normalize.js");
    const rep = mod.tagReport(listMemoryEntries(MEM_DIR), mod.loadAlias(ROOT));
    if (args.includes("--write-baseline")) {
      const base = mod.readBaseline(ROOT);
      if (!args.includes("--confirm")) { out({ refused: "需 --confirm", ratio: rep.ratio }); break; }
      if (base && rep.ratio > base.ratio + 0.001) { out({ refused: "新比率高于基线，拒绝洗白", now: rep.ratio, baseline: base.ratio }); break; }
      rep.baseline = mod.writeBaseline(ROOT, rep);
    }
    out(rep);
    break;
  }
  case "tree": {
    // T04 表示层：构建主题树 + 结构摘要（派生，可删可重建）
    const { buildTree, writeTree, treeStats } = await import("./topic-tree.js");
    const entries = listMemoryEntries(MEM_DIR);
    const tree = buildTree(entries);
    const dir = writeTree(ROOT, tree);
    out({ ok: true, dir, nodes: tree.nodes.length, corpusHash: tree.corpusHash, ...treeStats(ROOT, entries) });
    break;
  }
  case "dream": {
    // T12 离线反思（只读第一版）：缺 situation / 作用域分布 / 重复组 / 无证据卡
    const { planReview, writeReport, proposePlan } = await import("./dream.js");
    const plan = planReview(ROOT);
    if (args.includes("--write")) plan.report = writeReport(ROOT, plan);
    // 逐条接受（票 12 v3）：只执行有明确目标值的操作；合并类一律拒绝。
    if (args.includes("--accept")) {
      const file = get("--accept");
      const index = Number(get("--index") || 0);
      if (!file || !existsSync(file)) { out({ ok: false, error: "用法: dream --accept <proposals.json> --index N [--situation 文本 | --to agent]" }); break; }
      const prop = JSON.parse(readFileSync(file, "utf8"));
      const op = (prop.ops || [])[index];
      const { acceptOp } = await import("./dream.js");
      const decision = acceptOp(ROOT, op, { situation: get("--situation"), to: get("--to") });
      if (!decision.ok) { out(decision); break; }
      const dlog = join(ROOT, "pro", "dream", "accepts-" + new Date().toISOString().slice(0, 10) + ".jsonl");
      if (decision.op === "set-situation") {
        const r = mutateEntryById(MEM_DIR, decision.id, (raw) => {
          const line = "situation: " + decision.situation;
          return /^situation:/m.test(raw) ? raw.replace(/^situation:.*$/m, line) : raw.replace(/^scope:.*$/m, (m) => line + String.fromCharCode(10) + m);
        });
        appendFileSync(dlog, JSON.stringify({ at: new Date().toISOString(), index, ...decision, write: r.ok ? "ok" : r.reason }) + String.fromCharCode(10));
        out({ ok: r.ok, ...decision, write: r.ok ? "ok" : r.reason });
        break;
      }
      if (decision.op === "scope-review") {
        let changed = 0;
        for (const id of decision.ids || []) {
          const r = mutateEntryById(MEM_DIR, id, (raw) => raw.replace(/^scope:.*$/m, "scope: " + decision.to));
          if (r.ok) changed += 1;
        }
        appendFileSync(dlog, JSON.stringify({ at: new Date().toISOString(), index, ...decision, changed }) + String.fromCharCode(10));
        out({ ok: true, ...decision, changed });
        break;
      }
      out(decision);
      break;
    }
    if (args.includes("--propose")) {
      const prop = proposePlan(ROOT, plan);
      // 2026-11-19（票 12 / 挑刺 B8）：提案产物写到 pro/dream/，随数据仓同步，不再落 .flags
      const dir = join(ROOT, "pro", "dream");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const f = join(dir, "proposals-" + prop.at.slice(0, 10) + ".json");
      writeFileSync(f, JSON.stringify(prop, null, 2) + String.fromCharCode(10));
      plan.proposals = { file: f, count: prop.count };
    }
    out(plan);
    break;
  }
  case "graph-build": {
    // T03：从卡片派生语义邻接（共享标签按 df 加权 / 同实体 / 手写 ref），写入 links.json 的 derived 段。
    const docs = loadMemoryDocs(MEM_DIR);
    const { buildEdges, loadEntities } = await import("./graph-edges.js");
    const entities = loadEntities(ROOT);
    const { edges, stats } = buildEdges(docs.map(d => ({ id: String(d.meta?.id || d.path), meta: d.meta, raw: d.raw })), entities);
    const lp = join(ROOT, "links.json");
    let j = {};
    try { j = JSON.parse(readFileSync(lp, "utf8")); } catch {}
    const derived = {};
    for (const [id, list] of edges) if (list.length) derived[id] = list;
    // T03 降级（2026-11-19）：只写候选，不写派生边 —— 词面/共现证据不足以直接建边
    j.candidates = derived;
    delete j.derived;
    j.candidateStats = { ...stats, builtAt: new Date().toISOString() };
    // 显式降级声明（2026-11-19）：不写 derived 是决定，不是遗漏。写在这里，verify 才能区分
    // 「有意关闭」和「写读口径断裂」——否则 F53 永久红灯，红灯常亮等于没有红灯。
    j.refineMode = 'candidates-only';
    j.refineModeReason = 'T03 降级 2026-11-19：词面/共现证据不足以直接建边；需要时显式 CP_REFINE_SOURCE=candidates';
    writeFileSync(lp, JSON.stringify(j, null, 2) + String.fromCharCode(10));
    out({ ok: true, ...j.candidateStats });
    break;
  }
  case "relink": { const r = backfillSupersedes(ROOT, { dryRun: args.includes("--dry-run") }); if (!r.dryRun) buildLinks(ROOT); out(r); break; }
  case "supersede": cmdSupersede(args[1], args[2], { preview: args.includes("--preview"), rollback: args.includes("--rollback"), asConflict: args.includes("--as-conflict") }); break;
  case "correct": cmdCorrect(args[1], get("--note")); break;
  case "links": out(queryLinks(ROOT, args[1])); break;
  case "refs": out(queryRefs(ROOT, args[1])); break;
  case "lineage": out(queryLineage(ROOT, args[1])); break;
  case "graph": {
    // 过滤 --root 及其值（K22 同族），实体取剩余全部参数
    const rest = args.slice(1);
    const ri = rest.indexOf("--root");
    if (ri >= 0) rest.splice(ri, 2);
    out(queryGraph(ROOT, rest.join(" ").trim()));
    break;
  }
  default: out({ usage: "search|add|log|inject|current|resume|reply-check|arrival-check|index|verify|distill|maintain|stats|quota|import|events|expand|relink|links|refs|lineage|graph|ref-hunt|judge|view" });
}
