import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listMemoryEntries } from "./memory-retrieval.js";

export const MEMORY_DOMAINS = ["project", "preference", "knowledge"];
const VALID_SCOPES = ["global", "workspace"];

function rel(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function frontmatter(raw) {
  const match = String(raw || "").match(/^---\n([\s\S]*?)\n---/);
  const values = {};
  if (!match) return values;
  for (const line of match[1].split("\n")) {
    const item = line.match(/^([^:]+):\s*(.*)$/);
    if (item) values[item[1].trim()] = item[2].trim();
  }
  return values;
}

function parseDomains(meta) {
  const raw = meta.domains;
  if (!raw) return [];
  const value = String(raw).trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map(item => item.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
  }
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

function domainInfo(raw) {
  const meta = frontmatter(raw);
  const primary = String(meta.primary_domain || "").trim() || null;
  const domains = parseDomains(meta);
  const invalid = [...(primary && !MEMORY_DOMAINS.includes(primary) ? [primary] : []), ...domains.filter(domain => !MEMORY_DOMAINS.includes(domain))];
  if (!primary) return { primary_domain: null, domains, classification: "unclassified", blockers: ["PRIMARY_DOMAIN_REQUIRED"] };
  if (invalid.length) return { primary_domain: primary, domains, classification: "invalid-domain", blockers: ["INVALID_DOMAIN_METADATA"] };
  if (!domains.length) return { primary_domain: primary, domains, classification: "incomplete-domain-metadata", blockers: ["DOMAINS_REQUIRED"] };
  if (!domains.includes(primary)) return { primary_domain: primary, domains, classification: "invalid-domain", blockers: ["PRIMARY_DOMAIN_NOT_IN_DOMAINS"] };
  if (new Set(domains).size !== domains.length) return { primary_domain: primary, domains, classification: "invalid-domain", blockers: ["DUPLICATE_DOMAINS"] };
  return { primary_domain: primary, domains, classification: "classified", blockers: [] };
}

function memoryLifecycle(meta) {
  const status = String(meta.status || "");
  if (status.includes("待验证")) return "pending";
  if (status.includes("当前")) return "active";
  if (status.includes("过去")) return "historical";
  return "unknown";
}

function inspectLegacyMemories(root) {
  const memoryDir = join(root, "memories");
  if (!existsSync(memoryDir)) return [];
  return listMemoryEntries(memoryDir).map(entry => {
    const meta = entry.meta || {};
    const domains = domainInfo(entry.raw);
    const blockers = [...domains.blockers];
    if (!String(meta.id || "").trim()) blockers.push("MISSING_ID");
    if (!String(meta.source || "").trim()) blockers.push("MISSING_SOURCE");
    if (!VALID_SCOPES.includes(meta.scope)) blockers.push("INVALID_SCOPE");
    return {
      kind: "memory",
      id: meta.id || entry.id || null,
      path: rel(root, entry.file),
      lifecycle: memoryLifecycle(meta),
      status: meta.status || null,
      scope: meta.scope || null,
      source_present: Boolean(String(meta.source || "").trim()),
      ...domains,
      action: "retain-in-place",
      blockers: [...new Set(blockers)],
    };
  });
}

function inspectLegacyCandidates(root) {
  const candidateDir = join(root, "candidates");
  if (!existsSync(candidateDir)) return [];
  return readdirSync(candidateDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^[a-f0-9-]+\.json$/.test(entry.name))
    .map(entry => {
      const path = join(candidateDir, entry.name);
      let candidate = null;
      let parseError = null;
      try { candidate = JSON.parse(readFileSync(path, "utf8")); }
      catch (error) { parseError = String(error.message || error); }
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return {
          kind: "candidate",
          id: entry.name.slice(0, -5),
          path: rel(root, path),
          state: null,
          primary_domain: null,
          domains: [],
          classification: "invalid",
          action: "retain-in-place",
          blockers: ["INVALID_CANDIDATE_JSON"],
        };
      }
      const primary = String(candidate.primary_domain || "").trim() || null;
      const domainsFieldPresent = Object.hasOwn(candidate, "domains");
      const domainsValidType = Array.isArray(candidate.domains);
      const domains = domainsValidType ? candidate.domains.map(String) : [];
      const invalid = [...(primary && !MEMORY_DOMAINS.includes(primary) ? [primary] : []), ...domains.filter(domain => !MEMORY_DOMAINS.includes(domain))];
      const blockers = [];
      let classification = "unclassified";
      if (!primary) blockers.push("PRIMARY_DOMAIN_REQUIRED");
      else if (domainsFieldPresent && !domainsValidType) { classification = "invalid-domain"; blockers.push("INVALID_DOMAINS_FORMAT"); }
      else if (invalid.length) { classification = "invalid-domain"; blockers.push("INVALID_DOMAIN_METADATA"); }
      else if (!domains.length) { classification = "incomplete-domain-metadata"; blockers.push("DOMAINS_REQUIRED"); }
      else if (!domains.includes(primary)) { classification = "invalid-domain"; blockers.push("PRIMARY_DOMAIN_NOT_IN_DOMAINS"); }
      else if (new Set(domains).size !== domains.length) { classification = "invalid-domain"; blockers.push("DUPLICATE_DOMAINS"); }
      else classification = "classified";
      if (!VALID_SCOPES.includes(candidate.scope)) blockers.push("INVALID_SCOPE");
      if (!String(candidate.source_ref || "").trim()) blockers.push("MISSING_SOURCE");
      return {
        kind: "candidate",
        id: candidate.candidate_id || entry.name.slice(0, -5),
        path: rel(root, path),
        state: candidate.state || null,
        primary_domain: primary,
        domains,
        classification,
        action: "retain-in-place",
        blockers: [...new Set(blockers)],
      };
    });
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = item[key] || "unknown";
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

export function inspectLegacyLayout(root, options = {}) {
  const memories = inspectLegacyMemories(root);
  const candidates = inspectLegacyCandidates(root);
  const all = [...memories, ...candidates];
  const details = options.details === true ? { memories, candidates } : undefined;
  const summary = {
    legacy_memory_cards: memories.length,
    memory_by_lifecycle: countBy(memories, "lifecycle"),
    memory_by_classification: countBy(memories, "classification"),
    memory_with_missing_source: memories.filter(item => !item.source_present).length,
    root_candidates: candidates.length,
    candidate_by_state: countBy(candidates, "state"),
    candidate_by_classification: countBy(candidates, "classification"),
    candidate_without_primary_domain: candidates.filter(item => !item.primary_domain).length,
    blocked_records: all.filter(item => item.blockers.length > 0).length,
  };
  return {
    report_version: "legacy-memory-compat-v1",
    root,
    read_only: true,
    instance_data_changed: false,
    compatibility_mode: "legacy-root-observed",
    summary,
    migration_gate: {
      spec_status: "draft",
      apply_supported: false,
      requires_explicit_user_approval: true,
      requires_backup_manifest: true,
      requires_per_record_primary_domain: true,
      requires_rollback_plan: true,
      requires_same_set_validation: true,
      default_primary_domain: null,
      classification_policy: "每条旧实体必须由用户明确指定 primary_domain 和 domains；不得按 type、scope 或目录名推断",
      lifecycle_policy: "保留旧 lifecycle；待验证候选不得激活；历史卡的去向须单独明确",
      source_policy: "缺失或非法 source 的记录阻塞迁移，不补造来源",
      backup_policy: "切换前建立实例外备份和逐文件 SHA-256 清单，记录 ID、路径、状态与字节数",
      rollback_policy: "采用显式根路径/读入口切换；失败时切回旧根，保留新旧数据供核对，不自动删除",
    },
    migration_steps: [
      { step: "inventory", action: "read-only", gate: "记录完整 ID 集合、状态、scope、来源完整性和内容哈希；不得输出正文" },
      { step: "classify", action: "user-approved-per-record", gate: "逐条指定主域与适用域；未分类候选留在中央队列；缺来源项停止" },
      { step: "stage", action: "copy-to-separate-staging-root", gate: "保留旧根原样；不在原目录移动、覆盖或激活数据" },
      { step: "verify", action: "same-set-and-retrieval-comparison", gate: "核对 ID/状态/scope/source/hash/候选引用，并跑固定检索集前后对比" },
      { step: "cutover", action: "explicit-user-triggered", gate: "全部硬闸通过后显式切换；失败可切回旧根；备份不参与检索" },
    ],
    plan: [
      { source: "memories/", action: "retain-in-place", reason: "报告不移动或改写旧 Markdown 卡；旧 CLI 的既有读写行为不变" },
      { source: "candidates/*.json", action: "retain-in-place", reason: "报告不移动或改写旧候选；缺少主域的记录不得由报告自动归类" },

      { source: "domains/", action: "not-created", reason: "报告命令不创建三域目录，也不把旧卡复制到域目录" },
    ],
    writes: [],
    ...(details ? { details } : {}),
  };
}
