#!/usr/bin/env node
/**
 * candidate-distill.js — events.db -> candidates/ 的保守提纯入口。
 *
 * 只识别用户原话里的显式记忆意图；不读取 daily，不调用模型，不确认候选。
 * 默认 dry-run，--apply 才写候选。原始正文不复制进证据字段，候选只保存派生内容和稳定 source_ref。
 */
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { makeCandidate, readCandidate, saveCandidate, withCandidateLock, candidatePath } from "./candidates.js";

const DEFAULT_LIMIT = 5000;
const MAX_CONTENT_BYTES = 4000;

function userText(value) {
  const raw = String(value ?? "").replace(/\r\n/g, "\n").trim();
  // 宿主注入的 system-reminder 不是用户原话；只解包明确的 user_query 区段。
  const wrapped = raw.match(/^<system-reminder\b[\s\S]*?<user_query>([\s\S]*?)<\/user_query>[\s\S]*<\/system-reminder>$/i);
  return wrapped ? wrapped[1].trim() : raw;
}

function parseExplicitIntent(value) {
  const text = userText(value);
  if (!text) return { ok: false, reason: "empty" };

  const patterns = [
    { kind: "preference", re: /^(?:请)?(?:我的)?偏好\s*(?:是|为|[:：])\s*([\s\S]+)$/u },
    { kind: "rule", re: /^(?:请)?(?:禁止|一律)\s*[:：]?\s*([\s\S]+)$/u },
    { kind: "decision", re: /^(?:请)?(?:改成|改为)\s*[:：]?\s*([\s\S]+)$/u },
    { kind: "decision", re: /^(?:我(?:们)?\s*)?(?:决定|拍板|约定)\s*[:：]\s*([\s\S]+)$/u },
    { kind: "decision", re: /^(?:请)?(?:记住|记一下|长期记住)\s*[:：]?\s*([\s\S]+)$/u },
  ];
  const match = patterns.find((item) => item.re.test(text));
  if (!match) return { ok: false, reason: "no_explicit_intent" };

  let content = text.match(match.re)[1].trim().replace(/^[：:，,]\s*/u, "");
  if (!content || content.length < 4) return { ok: false, reason: "content_too_short" };
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) return { ok: false, reason: "content_too_long" };
  // 明确记忆指令后仍是疑问句时，宁可不出候选，避免把待回答问题记成事实。
  if (/[?？]\s*$/u.test(content) || /^(?:什么|为何|为什么|怎么|如何|哪些|哪项)/u.test(content)) {
    return { ok: false, reason: "question_like" };
  }
  return { ok: true, kind: match.kind, content };
}

function sourceRef(event) {
  const anchor = createHash("sha256").update(`${event.instance}\0${event.mid}`).digest("hex").slice(0, 32);
  return `events.db:cp-evt-v2:${anchor}`;
}

function sourceIdentity(event) {
  return event.source_id != null && String(event.source_id) !== ""
    ? `${event.instance}\0${event.session}\0${event.source_id}\0${Number(event.source_revision || 1)}`
    : `${event.instance}\0${event.session}\0event:${event.mid}`;
}

function isSensitive(event) {
  if (Number(event.sensitive) === 1) return true;
  return /(?:api[\s_-]?key|secret|passw(?:or)?d|token|cookie|authorization|bearer\s+\S|密码|密钥|私钥|口令|验证码|授权码|访问令牌)/iu.test(String(event.content || ""));
}

function candidateId(event) {
  return createHash("sha256").update(`event-candidate-v1\0${sourceIdentity(event)}`).digest("hex");
}

function eventTableColumns(db) {
  return new Set(db.prepare("PRAGMA table_info(events)").all().map((row) => row.name));
}

function readEvents(root, options) {
  const dbFile = join(root, "events.db");
  if (!existsSync(dbFile)) return { ok: false, error: "events.db 不存在", code: "EVENTS_DB_MISSING" };

  let db;
  try {
    db = new DatabaseSync(dbFile);
    db.exec("PRAGMA busy_timeout = 5000;");
    const columns = eventTableColumns(db);
    const required = ["id", "instance", "mid", "role", "content", "ts"];
    const missing = required.filter((name) => !columns.has(name));
    if (missing.length) return { ok: false, error: `events.db schema 不支持候选提纯，缺少字段：${missing.join(", ")}`, code: "SCHEMA_UNSUPPORTED", missing };

    const optional = (name, fallback) => columns.has(name) ? `e.${name}` : `${fallback} AS ${name}`;
    const tombstones = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_tombstones'").all().length > 0;
    const where = ["e.role = 'user'"];
    const params = [];
    if (tombstones) where.push("NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge')");
    if (options.scope) { where.push("COALESCE(e.scope, 'workspace') = ?"); params.push(options.scope); }
    if (options.since) { where.push("e.ts >= ?"); params.push(`${options.since}T00:00:00.000Z`); }
    if (options.until) { where.push("e.ts < ?"); params.push(`${options.until}T00:00:00.000Z`); }
    if (options.afterId) { where.push("e.id > ?"); params.push(options.afterId); }
    const sql = `SELECT ${[
      "e.id", "e.instance", "e.mid", optional("session", "''"), "e.role", "e.content", "e.ts",
      optional("sensitive", "0"), optional("source_id", "NULL"), optional("source_revision", "1"),
      optional("source_kind", "NULL"), optional("source_ref", "NULL"), optional("scope", "'workspace'"),
    ].join(", ")} FROM events e WHERE ${where.join(" AND ")} ORDER BY e.id ASC LIMIT ?`;
    params.push(options.limit + 1);
    const fetched = db.prepare(sql).all(...params);
    const truncated = fetched.length > options.limit;
    return { ok: true, rows: fetched.slice(0, options.limit), truncated };
  } catch (error) {
    return { ok: false, error: `读取 events.db 失败：${String(error.message || error)}`, code: "EVENTS_DB_READ_FAILED" };
  } finally {
    try { db?.close(); } catch {}
  }
}

function validateOptions(options) {
  const result = { ...options };
  if (result.scope && !["global", "workspace"].includes(result.scope)) return { error: "scope 只能是 global/workspace", code: "INVALID_SCOPE" };
  for (const key of ["since", "until"]) {
    if (result[key] && !/^\d{4}-\d{2}-\d{2}$/.test(result[key])) return { error: `${key} 需要 YYYY-MM-DD`, code: "INVALID_DATE" };
  }
  result.limit = Number(result.limit || DEFAULT_LIMIT);
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 50000) return { error: "limit 需要是 1~50000 的整数", code: "INVALID_LIMIT" };
  result.afterId = Number(result.afterId || 0);
  if (!Number.isSafeInteger(result.afterId) || result.afterId < 0) return { error: "after-id 需要是非负安全整数", code: "INVALID_AFTER_ID" };
  return result;
}

export function distillEvents(root, input = {}) {
  const options = validateOptions({ apply: false, ...input });
  if (options.error) return { ok: false, error: options.error, code: options.code };
  const scan = readEvents(root, options);
  if (!scan.ok) return scan;

  const details = [];
  for (const event of scan.rows) {
    const base = { source_ref: sourceRef(event) };
    if (isSensitive(event)) {
      details.push({ ...base, action: "skip", reason: "sensitive_event" });
      continue;
    }
    const parsed = parseExplicitIntent(event.content);
    if (!parsed.ok) {
      details.push({ ...base, action: "skip", reason: parsed.reason });
      continue;
    }
    const scope = String(event.scope || "workspace");
    if (!["global", "workspace"].includes(scope)) {
      details.push({ ...base, action: "skip", reason: "unsupported_scope", scope });
      continue;
    }

    const id = candidateId(event);
    const detail = {
      ...base,
      candidate_id: id,
      kind: parsed.kind,
      content: parsed.content,
      scope,
      confidence: 1,
      action: "would_create",
    };
    const existing = readCandidate(root, id);
    if (existing) {
      detail.action = existing.source_ref === detail.source_ref && existing.content === parsed.content
        ? "already_exists"
        : "conflict";
      if (detail.action === "conflict") detail.reason = "candidate_id 已存在但来源或内容不一致";
      details.push(detail);
      continue;
    }
    if (existsSync(candidatePath(root, id))) {
      details.push({ ...detail, action: "conflict", reason: "candidate 文件存在但格式非法，拒绝覆盖" });
      continue;
    }
    if (options.apply) {
      try {
        let result = null;
        withCandidateLock(root, id, () => {
          const raced = readCandidate(root, id);
          if (raced) {
            result = raced.source_ref === detail.source_ref && raced.content === parsed.content
              ? { action: "already_exists" }
              : { action: "conflict", reason: "并发写入的 candidate_id 来源或内容不一致" };
            return;
          }
          const candidate = makeCandidate({
            candidate_id: id,
            kind: parsed.kind,
            content: parsed.content,
            source_kind: "user_said",
            source_ref: detail.source_ref,
            confidence: detail.confidence,
            scope,
          }, "event-distill");
          saveCandidate(root, candidate);
          result = { action: "created" };
        });
        detail.action = result?.action || "created";
        if (result?.reason) detail.reason = result.reason;
      } catch (error) {
        detail.action = "failed";
        detail.reason = String(error.message || error);
      }
    }
    details.push(detail);
  }

  const count = (action) => details.filter((item) => item.action === action).length;
  return {
    ok: !details.some((item) => item.action === "failed"),
    dryRun: !options.apply,
    source: "events.db",
    scanned: scan.rows.length,
    created: count("created"),
    wouldCreate: count("would_create"),
    alreadyExists: count("already_exists"),
    conflicts: count("conflict"),
    skipped: details.filter((item) => item.action === "skip").length,
    failed: count("failed"),
    truncated: scan.truncated,
    ...(scan.truncated && scan.rows.length ? { nextAfterId: scan.rows.at(-1).id } : {}),
    details,
    note: options.apply
      ? "只生成候选；仍需 candidate confirm 才能进入活跃记忆"
      : "dry-run 未写入 candidates/；确认后加 --apply",
  };
}

function get(args, key) {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const root = get(args, "--root");
  const result = distillEvents(root || process.cwd(), {
    apply: args.includes("--apply"),
    scope: get(args, "--scope"),
    since: get(args, "--since"),
    until: get(args, "--until"),
    limit: get(args, "--limit"),
    afterId: get(args, "--after-id"),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}

if (basename(process.argv[1] || "").toLowerCase() === "candidate-distill.js") main();
