import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { listCandidates, readCandidate, updateCandidateWithinLock, withCandidateLock, candidatePath } from "./candidates.js";

const REVIEW_STATUSES = ["pending", "deferred", "confirmed", "rejected", "conflict"];
const ENGINE_ROOT = dirname(fileURLToPath(import.meta.url));
const now = () => new Date().toISOString();
const statusOf = (candidate) => {
  if (candidate.state === "candidate") return candidate.review_status === "deferred" ? "deferred" : "pending";
  if (["confirmed", "rejected", "conflict"].includes(candidate.state)) return candidate.state;
  return candidate.review_status || candidate.state;
};
const digest = (value) => createHash("sha256").update(value).digest("hex");

function candidateSummary(candidate) {
  return {
    candidate_id: candidate.candidate_id,
    kind: candidate.kind,
    content: candidate.content,
    source_kind: candidate.source_kind,
    source_ref: candidate.source_ref,
    confidence: candidate.confidence,
    scope: candidate.scope,
    situation: candidate.situation || "",
    state: candidate.state,
    review_status: statusOf(candidate),
    created: candidate.created,
    updated: candidate.updated,
    active_memory_id: candidate.active_memory_id || null,
  };
}

export function reviewCandidates(root, options = {}) {
  const requested = options.status;
  if (requested && requested !== "all" && !REVIEW_STATUSES.includes(requested)) {
    const error = new Error(`review_status 不支持: ${requested}`);
    error.code = "REVIEW_STATUS_INVALID";
    throw error;
  }
  const items = listCandidates(root)
    .filter((candidate) => !requested || requested === "all" || statusOf(candidate) === requested)
    .map(candidateSummary);
  return { count: items.length, items };
}

export function setCandidateReviewStatus(root, candidateId, status, actor = "user") {
  if (!["deferred", "pending"].includes(status)) {
    const error = new Error("review_status 只能设置为 deferred/pending");
    error.code = "REVIEW_STATUS_INVALID";
    throw error;
  }
  return withCandidateLock(root, candidateId, () => updateCandidateWithinLock(root, candidateId, (current) => {
    if (current.state !== "candidate") {
      const error = new Error(`候选状态为 ${current.state}，不可${status === "deferred" ? "暂缓" : "恢复"}`);
      error.code = "CANDIDATE_STATE_INVALID";
      throw error;
    }
    const previous = statusOf(current);
    if (previous === status) return current;
    if (status === "pending" && previous !== "deferred") {
      const error = new Error("只有暂缓候选可以恢复");
      error.code = "CANDIDATE_NOT_DEFERRED";
      throw error;
    }
    current.review_status = status;
    current.history.push({ at: now(), action: status === "deferred" ? "deferred" : "resumed", actor, previous_review_status: previous });
    return current;
  }));
}

function parseSource(root, candidateId, expand, byteBudget = 4000) {
  const candidate = readCandidate(root, candidateId);
  if (!candidate) return { ok: false, error: "候选不存在或格式非法", code: "CANDIDATE_NOT_FOUND" };
  const match = String(candidate.source_ref || "").match(/^events\.db:cp-evt-v2:([a-f0-9]{32})$/i);
  if (!match) return {
    ok: true,
    candidate_id: candidateId,
    source_ref: candidate.source_ref,
    available: false,
    reason: "source_ref 不是受支持的 events.db 锚点",
  };
  const args = ["--experimental-sqlite", join(ENGINE_ROOT, "events.js"), "expand", "--evt", match[1], "--bytes", String(byteBudget), "--context", "1", "--anchor-first", "--root", root];
  const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  let result;
  try { result = JSON.parse((child.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1) || "{}"); }
  catch { return { ok: false, error: child.stderr || "来源查询返回了无法解析的结果", code: "SOURCE_LOOKUP_FAILED" }; }
  if (child.status !== 0 || result.error) return {
    ok: true,
    candidate_id: candidateId,
    source_ref: candidate.source_ref,
    available: false,
    reason: result.error || child.stderr || "source lookup failed",
    code: "SOURCE_UNAVAILABLE",
  };
  const source = {
    ok: true,
    candidate_id: candidateId,
    source_ref: candidate.source_ref,
    available: true,
    mode: result.mode,
    session: result.session,
    title: result.title,
    channel: result.channel,
    startedAt: result.startedAt,
    events: result.events,
    users: result.users,
    anchorSeq: result.anchorSeq,
    shown: result.shown,
    truncated: result.truncated,
    bytes: result.bytes,
    budget: result.budget,
  };
  if (expand) {
    const stream = (result.stream || []).map((event) => ({
      seq: event.seq,
      ts: event.ts,
      role: event.role,
      content: event.redacted ? "[REDACTED]" : event.sensitive ? "[SENSITIVE EVENT REDACTED]" : event.content,
      ...(event.sensitive ? { sensitive: true } : {}),
      ...(event.redacted ? { redacted: true } : {}),
      ...(event.anchor ? { anchor: true } : {}),
    }));
    const base = { ...source, stream: undefined };
    delete base.stream;
    const baseBytes = Buffer.byteLength(JSON.stringify({ ...base, stream: [] }), "utf8");
    const bounded = [];
    let truncated = false;
    const ordered = [...stream.filter((event) => event.anchor), ...stream.filter((event) => !event.anchor)];
    for (const event of ordered) {
      const candidateStream = [...bounded, event];
      if (Buffer.byteLength(JSON.stringify({ ...base, stream: candidateStream }), "utf8") <= byteBudget) {
        bounded.push(event);
        continue;
      }
      if (event.anchor) {
        const content = String(event.content || "");
        let end = content.length;
        while (end > 0 && Buffer.byteLength(JSON.stringify({ ...base, stream: [{ ...event, content: content.slice(0, end) }] }), "utf8") > byteBudget) end -= 1;
        const cropped = { ...event, content: content.slice(0, end) };
        if (Buffer.byteLength(JSON.stringify({ ...base, stream: [cropped] }), "utf8") > byteBudget) {
          return { ok: false, error: "来源锚点超过字节预算", code: "SOURCE_BUDGET_EXCEEDED" };
        }
        bounded.push(cropped);
      }
      truncated = true;
    }
    source.stream = bounded;
    source.truncated = Boolean(source.truncated || truncated || bounded.length < stream.length);
    // returned_bytes is part of the response, so calculate a fixed point rather
    // than measuring the object before that field exists.
    source.returned_bytes = 0;
    for (let i = 0; i < 4; i += 1) {
      const measured = Buffer.byteLength(JSON.stringify(source), "utf8");
      if (measured === source.returned_bytes) break;
      source.returned_bytes = measured;
    }
    if (Buffer.byteLength(JSON.stringify(source), "utf8") > byteBudget) {
      return { ok: false, error: "来源展开超过字节预算", code: "SOURCE_BUDGET_EXCEEDED" };
    }
  }
  return source;
}

export function candidateSource(root, candidateId) {
  return parseSource(root, candidateId, false);
}

export function expandCandidateSource(root, candidateId, requestedBytes = 4000) {
  const bytes = requestedBytes === undefined || requestedBytes === null || requestedBytes === "" ? 4000 : Number(requestedBytes);
  if (!Number.isInteger(bytes) || bytes < 2000 || bytes > 8000) {
    const error = new Error("bytes 必须是 2000~8000 的整数");
    error.code = "SOURCE_BUDGET_INVALID";
    throw error;
  }
  return parseSource(root, candidateId, true, bytes);
}

export function previewCandidateConfirmation(root, candidateIds) {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    const error = new Error("candidateIds 不能为空");
    error.code = "CANDIDATE_IDS_REQUIRED";
    throw error;
  }
  if (candidateIds.length > 100 || new Set(candidateIds).size !== candidateIds.length) {
    const error = new Error("候选确认集合最多 100 项且不得重复");
    error.code = "CANDIDATE_BATCH_INVALID";
    throw error;
  }
  const items = candidateIds.map((id) => {
    const candidate = readCandidate(root, id);
    if (!candidate) {
      return { candidate_id: id, valid: false, state: existsSync(candidatePath(root, id)) ? "invalid" : "missing", review_status: "invalid", reason: "候选不存在或格式非法" };
    }
    const reviewStatus = statusOf(candidate);
    const canConfirm = candidate.state === "candidate" && reviewStatus === "pending";
    const alreadyConfirmed = candidate.state === "confirmed" && reviewStatus === "confirmed";
    return {
      candidate_id: id,
      valid: canConfirm || alreadyConfirmed,
      action: alreadyConfirmed ? "already_confirmed" : canConfirm ? "confirm" : "reject",
      state: candidate.state,
      review_status: reviewStatus,
      kind: candidate.kind,
      content: candidate.content,
      source_ref: candidate.source_ref,
      scope: candidate.scope,
      content_sha256: digest(candidate.content),
      reason: canConfirm || alreadyConfirmed ? null : `状态 ${candidate.state}/${reviewStatus} 不可确认`,
    };
  });
  const ready = items.every((item) => item.valid);
  const manifest = items.map(({ candidate_id, state, review_status, content_sha256 }) => ({ candidate_id, state, review_status, content_sha256 }));
  const previewHash = ready ? digest(JSON.stringify(manifest)) : null;
  return {
    ok: true,
    ready,
    count: items.length,
    confirmable: items.filter((item) => item.action === "confirm").length,
    alreadyConfirmed: items.filter((item) => item.action === "already_confirmed").length,
    rejected: items.filter((item) => !item.valid).length,
    previewHash,
    items,
    note: ready ? "预览绑定候选 ID、状态与正文摘要；确认前若候选变化，预览将失效" : "预检未通过；没有候选会被激活",
  };
}

export function validateCandidateConfirmationPreview(root, candidateIds, expectedHash) {
  const preview = previewCandidateConfirmation(root, candidateIds);
  if (!preview.ready) return { ok: false, code: "CANDIDATE_PREFLIGHT_FAILED", error: "候选预检未通过；没有候选会被激活", preview };
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    return { ok: false, code: "CANDIDATE_PREVIEW_HASH_INVALID", error: "确认预览指纹必须是 64 位十六进制字符串", preview };
  }
  if (preview.previewHash !== expectedHash) return { ok: false, code: "CANDIDATE_PREVIEW_STALE", error: "确认预览缺失或已失效；请重新预览", preview };
  return { ok: true, preview };
}

export function candidateFileFingerprint(root, candidateId) {
  const path = candidatePath(root, candidateId);
  return existsSync(path) ? digest(readFileSync(path)) : null;
}
