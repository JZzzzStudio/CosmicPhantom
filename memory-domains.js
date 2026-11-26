import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MEMORY_DOMAINS = ["project", "preference", "knowledge"];
export const MEMORY_SCOPES = ["global", "workspace"];
const REVIEW_STATUSES = ["pending", "deferred", "rejected", "confirmed"];
const SENSITIVE_RE = /(?:api[_ -]?key|secret|password|token|cookie|authorization)\s*[:=]|\bbearer\s+\S|\bprivate\s+key\b/i;
const README = {
  root: "# 三域记忆数据\n\n## P0 首次必读\n这里保存候选和用户确认后的三域记忆。中央 events.db 仍是原始事件真源；旧 memories/ 与根级 candidates/ 不会被本模块迁移。\n\n## P1 日常使用\n候选必须由用户明确归类并确认。没有主域的候选留在 candidates/unclassified/。默认 search 和 inject 不读取本目录。\n\n## P2 查阅排障\n使用 memory-cli.js domains status 检查数据；必须显式选择单域或跨域检索。\n",
  candidates: "# 候选\n\n## P0 首次必读\n本目录仅保存尚未激活的候选，不是活跃记忆。\n\n## P1 日常使用\n未归类候选位于 unclassified/；只有用户明确选择主域后才进入对应 domains/<domain>/candidates/。\n\n## P2 查阅排障\n候选状态和审阅状态分离；确认操作需要显式授权。\n",
  unclassified: "# 待归类候选\n\n## P0 首次必读\n没有用户明确选择 primary_domain 的候选只能进入这里，不参与检索或注入。\n\n## P1 日常使用\n使用 domains candidate classify 明确归类，再单独确认候选。\n\n## P2 查阅排障\n候选仍保持 state=candidate；unclassified 不是活跃状态。\n",
  domain: {
    project: "# 项目记忆\n\n## P0 首次必读\n保存长期项目目标、约束和决策；不收跨项目稳定偏好，也不把过程日志当长期决策。domain 与 global/workspace scope 正交。\n\n## P1 日常使用\n新内容先进入候选，由用户归类和确认；正文只在 primary domain 保存一份。\n\n## P2 查阅排障\n用 `memory-cli.js domains search --domain project` 显式检索；默认旧 search/inject 不读取本目录。\n",
    preference: "# 个人偏好记忆\n\n## P0 首次必读\n保存跨 Agent 可复用的个人偏好和稳定工作习惯；不收只对单个项目成立的目标、约束或临时决定。domain 与 global/workspace scope 正交。\n\n## P1 日常使用\n新内容先进入候选，由用户归类和确认；正文只在 primary domain 保存一份。\n\n## P2 查阅排障\n用 `memory-cli.js domains search --domain preference` 显式检索；默认旧 search/inject 不读取本目录。\n",
    knowledge: "# 知识记忆\n\n## P0 首次必读\n保存用户确认的事实、概念和方法；不把原始资料、未经确认的摘录或引用本身当作活跃知识卡。domain 与 global/workspace scope 正交。\n\n## P1 日常使用\n新内容先进入候选，由用户归类和确认；正文只在 primary domain 保存一份。\n\n## P2 查阅排障\n用 `memory-cli.js domains search --domain knowledge` 显式检索；默认旧 search/inject 不读取本目录。\n",
  },
  memories: "# 活跃记忆\n\n## P0 首次必读\n只保存经过用户确认的记忆实体；每个实体在本目录只有一个文件。\n\n## P1 日常使用\n当前版本参与三域显式检索；纠错将旧版本标记为 superseded 并追加新版本。\n\n## P2 查阅排障\nsource_ref 是短来源指针，不在记忆文件中复制原始事件正文。\n",
  domainRoot: "# 三域记忆\n\n## P0 首次必读\n保存三域产品记忆；原始事件仍以实例根 events.db 为唯一真源，旧 memories/ 和根级 candidates/ 不由本模块修改。\n\n## P1 日常使用\n候选须用户确认后才激活；默认旧 search/inject 不读取 domains/。检索要指定单域或显式跨域。\n\n## P2 查阅排障\n查看各域 README 和 `memory-cli.js domains status`；真实旧数据迁移仍关闭。\n",
  auditRoot: "# 三域记忆审计\n\n## P0 首次必读\n此处只保存候选拒绝/确认所需的最小审计字段，不保存拒绝正文；events.db 才是原始事件真源。\n\n## P1 日常使用\n审计记录按候选 ID 保存，内容以 SHA-256 和短来源指针关联。\n\n## P2 查阅排障\n审计记录不是活跃记忆，不参与检索或注入。\n",
  auditCandidates: "# 候选审计\n\n## P0 首次必读\n保存确认或拒绝后的最小生命周期审计，不保存正文。\n\n## P1 日常使用\n记录包含状态、域、scope、来源指针、内容哈希和操作者/时间。\n\n## P2 查阅排障\n该目录不参与检索；原始证据仍由 events.db 管理。\n",
};

function fail(message, code = "MEMORY_ERROR") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function baseOf(root) { return resolve(root || process.cwd()); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value) { return JSON.stringify(value); }
function now() { return new Date().toISOString(); }
function text(value, field) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) fail(`${field} 必须是非空单行文本`, "MEMORY_INVALID");
  return value;
}
function content(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail("content 必须是非空文本", "MEMORY_INVALID");
  if (SENSITIVE_RE.test(value)) fail("疑似敏感凭据内容不能进入记忆候选", "SENSITIVE_CONTENT_REJECTED");
  return value;
}
function id(value, field = "id") {
  const result = text(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) fail(`${field} 格式非法`, "MEMORY_ID_INVALID");
  return result;
}
function domain(value, field = "domain") {
  const result = text(value, field);
  if (!MEMORY_DOMAINS.includes(result)) fail(`${field} 不支持: ${result}`, "DOMAIN_INVALID");
  return result;
}
function scope(value = "workspace") {
  const result = text(value, "scope");
  if (!MEMORY_SCOPES.includes(result)) fail(`记忆 scope 不支持: ${result}`, "MEMORY_SCOPE_INVALID");
  return result;
}
function authorized(options, action) {
  if (options.explicit_user_confirmation !== true) fail(`${action} 必须由调用方提供明确的用户确认`, "USER_AUTHORIZATION_REQUIRED");
  return text(options.actor, "actor");
}
function normalizeDomains(primary, values) {
  const main = domain(primary, "primary_domain");
  const input = values === undefined ? [main] : values;
  if (!Array.isArray(input) || input.length === 0) fail("domains 必须是非空数组", "DOMAINS_INVALID");
  const result = [];
  for (const value of [main, ...input]) {
    const item = domain(value, "domains");
    if (!result.includes(item)) result.push(item);
  }
  return result;
}
function ensureDir(path) { mkdirSync(path, { recursive: true }); }
function writeReadme(path, value) { if (!existsSync(path)) writeFileSync(path, value, "utf8"); }
function atomicWrite(path, value) {
  ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}
function withWriteLock(root, action) {
  const base = baseOf(root);
  ensureDir(base);
  const lock = join(base, ".memory-domains.lock");
  let fd;
  try {
    fd = openSync(lock, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
      try { unlinkSync(lock); } catch {}
    }
    let owner = "unknown";
    try { owner = readFileSync(lock, "utf8").trim() || "unknown"; } catch {}
    fail(`三域记忆写锁已占用（PID ${owner}）；确认进程已退出后可手动移除 .memory-domains.lock`, "MEMORY_BUSY");
  }
  try { return action(base); }
  finally {
    try { if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock); } catch {}
  }
}

function candidatePath(root, candidate) {
  const base = baseOf(root);
  const folder = candidate.primary_domain
    ? join(base, "domains", candidate.primary_domain, "candidates")
    : join(base, "candidates", "unclassified");
  return join(folder, `${candidate.candidate_id}.json`);
}
function auditCandidatePath(root, candidateId) { return join(baseOf(root), "data", "memory-audit", "candidates", `${candidateId}.json`); }
function entityPath(root, entity) { return join(baseOf(root), "domains", entity.primary_domain, "memories", `${entity.entity_id}.json`); }
function jsonFiles(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => join(folder, entry.name));
}
function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { fail(`产品记忆文件损坏: ${path}: ${error.message}`, "MEMORY_CORRUPT"); }
}
function candidateFiles(root) {
  const base = baseOf(root);
  return [join(base, "candidates", "unclassified"), ...MEMORY_DOMAINS.map(value => join(base, "domains", value, "candidates"))].flatMap(jsonFiles);
}
function candidateRecords(root) { return [...candidateFiles(root), ...jsonFiles(join(baseOf(root), "data", "memory-audit", "candidates"))]; }
function locateCandidate(root, candidateId) {
  const candidateIdValue = id(candidateId, "candidate_id");
  const matches = candidateRecords(root).filter(path => readJson(path).candidate_id === candidateIdValue);
  if (matches.length > 1) fail(`候选存在多个副本: ${candidateIdValue}`, "CANDIDATE_DUPLICATE");
  if (!matches.length) fail(`候选不存在: ${candidateIdValue}`, "CANDIDATE_NOT_FOUND");
  return { path: matches[0], candidate: readJson(matches[0]) };
}
function entityFiles(root) {
  const base = baseOf(root);
  return MEMORY_DOMAINS.flatMap(value => jsonFiles(join(base, "domains", value, "memories")));
}
function locateEntity(root, memoryId) {
  const wanted = text(memoryId, "memory_id");
  const found = entityFiles(root).map(path => ({ path, entity: readJson(path) }))
    .filter(item => item.entity.entity_id === wanted || item.entity.versions?.some(version => version.memory_id === wanted));
  if (!found.length) fail(`记忆不存在: ${wanted}`, "MEMORY_NOT_FOUND");
  if (found.length > 1) fail(`实体存在多个副本: ${wanted}`, "MEMORY_DUPLICATE");
  return found[0];
}
function reviewStatus(candidate) { return candidate.review_status || (candidate.state === "candidate" ? "pending" : candidate.state); }
function safeSource(input = {}) {
  const sourceRef = text(input.source_ref || `manual:${randomUUID()}`, "source_ref");
  const sourceKind = input.source_kind === undefined ? "manual" : text(input.source_kind, "source_kind");
  if (sourceRef.length > 500 || sourceKind.length > 80) fail("source 超出长度限制", "SOURCE_INVALID");
  return { kind: sourceKind, source_ref: sourceRef };
}
function moveCandidate(root, located, candidate) {
  const target = candidate.review_status === "rejected" ? auditCandidatePath(root, candidate.candidate_id) : candidatePath(root, candidate);
  if (target !== located.path && existsSync(target)) fail(`目标候选已存在: ${candidate.candidate_id}`, "CANDIDATE_EXISTS_CONFLICT");
  atomicWrite(target, candidate);
  if (target !== located.path && existsSync(located.path)) unlinkSync(located.path);
  return target;
}

export function ensureProductLayout(root) {
  const base = baseOf(root);
  ensureDir(join(base, "candidates", "unclassified"));
  writeReadme(join(base, "README-memory-data.md"), README.root);
  writeReadme(join(base, "candidates", "unclassified", "README.md"), README.unclassified);
  ensureDir(join(base, "domains"));
  writeReadme(join(base, "domains", "README.md"), README.domainRoot);
  const auditRoot = join(base, "data", "memory-audit");
  ensureDir(join(auditRoot, "candidates"));
  writeReadme(join(base, "data", "README.md"), README.auditRoot);
  writeReadme(join(auditRoot, "README.md"), README.auditRoot);
  writeReadme(join(auditRoot, "candidates", "README.md"), README.auditCandidates);
  for (const value of MEMORY_DOMAINS) {
    const rootPath = join(base, "domains", value);
    const candidateDir = join(rootPath, "candidates");
    const memoryDir = join(rootPath, "memories");
    ensureDir(candidateDir); ensureDir(memoryDir);
    writeReadme(join(rootPath, "README.md"), README.domain[value]);
    writeReadme(join(candidateDir, "README.md"), README.candidates);
    writeReadme(join(memoryDir, "README.md"), README.memories);
  }
  return { ok: true, root: base };
}

export function createCandidate(root, input = {}) {
  const actor = authorized(input, "候选创建");
  const textContent = content(input.content);
  const itemScope = scope(input.scope || "workspace");
  const source = safeSource({ source_ref: input.source_ref, source_kind: input.source_kind });
  return withWriteLock(root, base => {
    ensureProductLayout(base);
    const candidateId = input.candidate_id === undefined ? `cand-${randomUUID()}` : id(input.candidate_id, "candidate_id");
    if (candidateRecords(base).some(path => readJson(path).candidate_id === candidateId)) fail(`candidate_id 已存在: ${candidateId}`, "CANDIDATE_EXISTS_CONFLICT");
    const at = now();
    const candidate = {
      schema_version: 1, candidate_id: candidateId, state: "candidate", review_status: "pending",
      content: textContent, content_sha256: sha256(textContent), primary_domain: null, domains: [], scope: itemScope,
      source, created_at: at, updated_at: at, audit: [{ event: "created", at, actor }],
    };
    const path = candidatePath(base, candidate);
    atomicWrite(path, candidate);
    return { ok: true, idempotent: false, candidate, path };
  });
}

export function listCandidates(root, options = {}) {
  const requested = options.review_status;
  if (requested !== undefined && requested !== "all" && !REVIEW_STATUSES.includes(requested)) fail(`review_status 不支持: ${requested}`, "REVIEW_STATUS_INVALID");
  const records = new Map();
  for (const path of candidateRecords(root)) {
    const candidate = readJson(path), status = reviewStatus(candidate);
    if (requested && requested !== "all" && requested !== status) continue;
    if (!requested && !["pending", "deferred"].includes(status)) continue;
    records.set(candidate.candidate_id, {
      candidate_id: candidate.candidate_id, state: candidate.state, review_status: status,
      primary_domain: candidate.primary_domain, domains: [...(candidate.domains || [])], scope: candidate.scope,
      summary: candidate.content ? candidate.content.replace(/\s+/g, " ").slice(0, 160) : null,
      source_ref: candidate.source?.source_ref || null, created_at: candidate.created_at,
    });
  }
  return [...records.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.candidate_id.localeCompare(b.candidate_id));
}

export function getCandidate(root, candidateId) { return locateCandidate(root, candidateId).candidate; }

export function classifyCandidate(root, options = {}) {
  const actor = authorized(options, "候选归类");
  return withWriteLock(root, base => {
    const located = locateCandidate(base, options.candidate_id), candidate = located.candidate;
    if (candidate.state !== "candidate" || reviewStatus(candidate) !== "pending") fail("只有待审候选可以归类", "CANDIDATE_NOT_PENDING");
    const primary = domain(options.primary_domain, "primary_domain");
    const domains = normalizeDomains(primary, options.domains);
    if (candidate.primary_domain) {
      if (candidate.primary_domain === primary && canonical(candidate.domains) === canonical(domains)) return { ok: true, idempotent: true, candidate, path: located.path };
      fail("已归类候选不能直接改域；请先编辑并重新归类", "CANDIDATE_ALREADY_CLASSIFIED");
    }
    const at = now();
    const updated = { ...candidate, primary_domain: primary, domains, updated_at: at, audit: [...candidate.audit, { event: "classified", at, actor, primary_domain: primary, domains }] };
    const path = moveCandidate(base, located, updated);
    return { ok: true, idempotent: false, candidate: updated, path };
  });
}

export function editCandidate(root, options = {}) {
  const actor = authorized(options, "候选编辑"), updatedContent = content(options.content);
  return withWriteLock(root, base => {
    const located = locateCandidate(base, options.candidate_id), candidate = located.candidate;
    if (candidate.state !== "candidate" || ["confirmed", "rejected"].includes(reviewStatus(candidate))) fail("候选当前不可编辑", "CANDIDATE_NOT_EDITABLE");
    if (updatedContent === candidate.content) return { ok: true, idempotent: true, candidate, path: located.path };
    const at = now(), digest = sha256(updatedContent);
    const updated = {
      ...candidate, content: updatedContent, content_sha256: digest, primary_domain: null, domains: [],
      review_status: "pending", reconfirmation_required: true, updated_at: at,
      audit: [...candidate.audit, { event: "edited_reconfirmation_required", at, actor, previous_content_sha256: candidate.content_sha256, content_sha256: digest }],
    };
    const path = moveCandidate(base, located, updated);
    return { ok: true, idempotent: false, candidate: updated, path };
  });
}

function updateReview(root, options, next, event) {
  const actor = authorized(options, event === "deferred" ? "候选暂缓" : "候选恢复");
  return withWriteLock(root, base => {
    const located = locateCandidate(base, options.candidate_id), candidate = located.candidate;
    if (candidate.state !== "candidate" || ["rejected", "confirmed"].includes(reviewStatus(candidate))) fail("候选当前不可更新审阅状态", "CANDIDATE_NOT_PENDING");
    if (reviewStatus(candidate) === next) return { ok: true, idempotent: true, candidate, path: located.path };
    if (event === "resumed" && reviewStatus(candidate) !== "deferred") fail("只有暂缓候选可以恢复", "CANDIDATE_NOT_DEFERRED");
    const at = now(), updated = { ...candidate, review_status: next, updated_at: at, audit: [...candidate.audit, { event, at, actor }] };
    const path = moveCandidate(base, located, updated);
    return { ok: true, idempotent: false, candidate: updated, path };
  });
}
export function deferCandidate(root, options = {}) { return updateReview(root, options, "deferred", "deferred"); }
export function resumeCandidate(root, options = {}) { return updateReview(root, options, "pending", "resumed"); }

function archiveCandidate(root, located, candidate) {
  const destination = auditCandidatePath(root, candidate.candidate_id);
  if (destination !== located.path && existsSync(destination)) fail(`候选审计记录已存在: ${candidate.candidate_id}`, "CANDIDATE_EXISTS_CONFLICT");
  atomicWrite(destination, candidate);
  if (located.path !== destination && existsSync(located.path)) unlinkSync(located.path);
  return destination;
}

export function rejectCandidate(root, options = {}) {
  const actor = authorized(options, "候选拒绝");
  const reason = options.reason === undefined ? null : content(options.reason);
  return withWriteLock(root, base => {
    const located = locateCandidate(base, options.candidate_id), candidate = located.candidate;
    if (reviewStatus(candidate) === "rejected") return { ok: true, idempotent: true, candidate, path: located.path };
    if (candidate.state !== "candidate" || reviewStatus(candidate) === "confirmed") fail("候选当前不可拒绝", "CANDIDATE_NOT_REJECTABLE");
    const at = now(), digest = candidate.content_sha256 || sha256(candidate.content);
    const rejected = {
      schema_version: candidate.schema_version, candidate_id: candidate.candidate_id, state: "candidate", review_status: "rejected",
      content_sha256: digest, primary_domain: candidate.primary_domain, domains: [...candidate.domains], scope: candidate.scope,
      source: candidate.source ? { kind: candidate.source.kind, source_ref: candidate.source.source_ref } : null,
      created_at: candidate.created_at, updated_at: at, rejected_at: at, rejection_reason: reason,
      audit: [...candidate.audit, { event: "rejected", at, actor, reason, content_sha256: digest }],
    };
    const path = archiveCandidate(base, located, rejected);
    return { ok: true, idempotent: false, candidate: rejected, path };
  });
}

export function confirmCandidate(root, options = {}) {
  const actor = authorized(options, "候选确认");
  return withWriteLock(root, base => {
    const located = locateCandidate(base, options.candidate_id), candidate = located.candidate;
    if (candidate.review_status === "confirmed" && candidate.confirmed_memory_id) {
      const { entity, path } = locateEntity(base, candidate.confirmed_memory_id);
      return { ok: true, idempotent: true, candidate, memory: currentVersion(entity), path };
    }
    if (candidate.state !== "candidate" || reviewStatus(candidate) !== "pending") fail("只有待审候选可以确认", "CANDIDATE_NOT_PENDING");
    if (!candidate.primary_domain) fail("候选必须先由用户明确选择 primary_domain", "PRIMARY_DOMAIN_REQUIRED");
    const domains = normalizeDomains(candidate.primary_domain, candidate.domains);
    if (canonical(domains) !== canonical(candidate.domains)) fail("候选 domains 与 primary_domain 不一致", "DOMAINS_INVALID");
    const entityId = `ent-${sha256(candidate.candidate_id).slice(0, 24)}`;
    const memoryId = `${entityId}-v1`, at = now();
    const existing = entityFiles(base).map(path => ({ path, entity: readJson(path) })).find(item => item.entity.candidate_id === candidate.candidate_id);
    const entity = existing?.entity || {
      schema_version: 1, entity_id: entityId, primary_domain: candidate.primary_domain, domains: [...candidate.domains],
      scope: candidate.scope, candidate_id: candidate.candidate_id, source: candidate.source,
      current_memory_id: memoryId, created_at: at, updated_at: at,
      versions: [{ memory_id: memoryId, version: 1, state: "active", content: candidate.content, content_sha256: sha256(candidate.content), created_at: at, updated_at: at, confirmation: { actor, confirmed_at: at }, supersedes_memory_id: null, superseded_by: null }],
      audit: [{ event: "confirmed", at, actor, candidate_id: candidate.candidate_id }],
    };
    const path = entityPath(base, entity);
    if (!existing && existsSync(path)) fail(`memory entity 已存在: ${entityId}`, "MEMORY_EXISTS_CONFLICT");
    atomicWrite(path, entity);
    const confirmed = {
      schema_version: candidate.schema_version, candidate_id: candidate.candidate_id, state: "confirmed", review_status: "confirmed",
      content_sha256: candidate.content_sha256 || sha256(candidate.content), primary_domain: candidate.primary_domain, domains: [...candidate.domains],
      scope: candidate.scope, source: candidate.source, created_at: candidate.created_at, updated_at: at,
      confirmed_memory_id: entity.current_memory_id, confirmed_at: entity.versions.find(item => item.memory_id === entity.current_memory_id)?.confirmation?.confirmed_at || at,
      audit: [...candidate.audit, { event: "confirmed", at, actor, memory_id: entity.current_memory_id }],
    };
    const auditPath = archiveCandidate(base, located, confirmed);
    return { ok: true, idempotent: Boolean(existing), candidate: confirmed, memory: currentVersion(entity), path, candidate_audit: auditPath };
  });
}

function currentVersion(entity) { return entity.versions.find(version => version.memory_id === entity.current_memory_id) || null; }
function normalizeQuery(value) { return String(value || "").trim().toLocaleLowerCase(); }
function matches(query, body) {
  if (!query) return true;
  const textValue = String(body || "").toLocaleLowerCase();
  if (textValue.includes(query)) return true;
  const tokens = query.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(token => textValue.includes(token));
}

export function searchMemories(root, options = {}) {
  const crossDomain = options.cross_domain === true;
  const requested = options.domain === undefined || options.domain === null ? null : domain(options.domain);
  if (!requested && !crossDomain) fail("检索必须指定 domain，或显式使用 cross_domain", "DOMAIN_REQUIRED");
  if (requested && crossDomain) fail("domain 与 cross_domain 不能同时指定", "INVALID_ARGS");
  const itemScope = scope(options.scope === undefined ? "workspace" : options.scope);
  const query = normalizeQuery(options.query);
  const results = [];
  for (const path of entityFiles(root)) {
    const entity = readJson(path), version = currentVersion(entity);
    if (!version || version.state !== "active" || entity.scope !== itemScope) continue;
    if (requested && !entity.domains.includes(requested)) continue;
    if (!matches(query, `${version.content} ${entity.primary_domain} ${entity.domains.join(" ")}`)) continue;
    results.push({
      memory_id: version.memory_id, entity_id: entity.entity_id, version: version.version,
      content: version.content, primary_domain: entity.primary_domain, domains: [...entity.domains],
      scope: entity.scope, state: version.state, source: entity.source, score: query ? query.split(/\s+/).filter(token => version.content.toLocaleLowerCase().includes(token)).length : 0,
    });
  }
  results.sort((a, b) => Number(b.primary_domain === requested) - Number(a.primary_domain === requested) || b.score - a.score || a.memory_id.localeCompare(b.memory_id));
  return { ok: true, domain: requested, cross_domain: crossDomain, scope: itemScope, query: options.query || "", results };
}

export function correctMemory(root, options = {}) {
  const actor = authorized(options, "记忆纠错"), nextContent = content(options.content);
  return withWriteLock(root, base => {
    const located = locateEntity(base, options.memory_id || options.entity_id), entity = located.entity;
    const old = currentVersion(entity);
    if (!old || old.state !== "active") fail("记忆当前不可纠正", "MEMORY_NOT_ACTIVE");
    if (nextContent === old.content) return { ok: true, idempotent: true, memory: old, path: located.path };
    const versionNumber = Math.max(...entity.versions.map(item => Number(item.version) || 0)) + 1;
    const at = now(), memoryId = `${entity.entity_id}-v${versionNumber}`;
    const oldVersion = { ...old, state: "superseded", superseded_by: memoryId, updated_at: at };
    const nextVersion = {
      memory_id: memoryId, version: versionNumber, state: "active", content: nextContent, content_sha256: sha256(nextContent),
      created_at: at, updated_at: at, confirmation: { actor, confirmed_at: at }, supersedes_memory_id: old.memory_id, superseded_by: null,
    };
    const updatedEntity = {
      ...entity, current_memory_id: memoryId, updated_at: at,
      versions: [...entity.versions.filter(item => item.memory_id !== old.memory_id), oldVersion, nextVersion],
      audit: [...entity.audit, { event: "corrected", at, actor, from: old.memory_id, to: memoryId }],
    };
    atomicWrite(located.path, updatedEntity);
    const oldProbe = searchMemories(base, { domain: entity.primary_domain, scope: entity.scope, query: old.content });
    const newProbe = searchMemories(base, { domain: entity.primary_domain, scope: entity.scope, query: nextContent });
    const verification = {
      old_version_stopped: !oldProbe.results.some(item => item.memory_id === old.memory_id),
      new_version_retrievable: newProbe.results.some(item => item.memory_id === memoryId),
    };
    const verified = verification.old_version_stopped && verification.new_version_retrievable;
    return { ok: verified, ...(verified ? {} : { code: "VERIFICATION_FAILED" }), idempotent: false, old: oldVersion, memory: nextVersion, verification, path: located.path };
  });
}

export function inspectProduct(root) {
  const candidates = candidateRecords(root).map(path => readJson(path));
  const entities = entityFiles(root).map(path => readJson(path));
  return {
    ok: true,
    counts: {
      candidates: candidates.length,
      candidate_by_review_status: candidates.reduce((result, candidate) => { const key = reviewStatus(candidate); result[key] = (result[key] || 0) + 1; return result; }, {}),
      entities: entities.length,
      active_memories: entities.filter(entity => currentVersion(entity)?.state === "active").length,
      memories_by_primary_domain: entities.reduce((result, entity) => { result[entity.primary_domain] = (result[entity.primary_domain] || 0) + 1; return result; }, {}),
    },
  };
}
