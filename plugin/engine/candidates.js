import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, rmSync, statSync, linkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const CANDIDATE_STATES = ["candidate", "confirmed", "rejected", "conflict"];
export const CANDIDATE_KINDS = ["term", "decision", "preference", "rule", "correction", "tool_fact", "checkpoint"];
export const SOURCE_KINDS = ["user_said", "assistant_said", "told", "imagined", "inferred", "tool"];
const CANDIDATE_ID_RE = /^[a-f0-9-]{8,80}$/;

function dir(root) { return join(root, "candidates"); }
function file(root, id) { return join(dir(root), `${id}.json`); }
function now() { return new Date().toISOString(); }
function clean(value) { return String(value ?? "").replace(/\r\n/g, "\n").trim(); }
function atomicWrite(path, value, { exclusive = false } = {}) {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  if (exclusive) {
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmp, serialized, "utf8");
    try {
      // link() is an exclusive directory entry creation: an existing candidate
      // cannot be replaced between the existence check and the final publish.
      linkSync(tmp, path);
      unlinkSync(tmp);
      return;
    } catch (error) {
      try { unlinkSync(tmp); } catch {}
      throw error;
    }
  }
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, serialized, "utf8");
  try { renameSync(tmp, path); } catch (error) { try { unlinkSync(tmp); } catch {} throw error; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writeCandidate(root, candidate) {
  const checked = validateCandidate(candidate);
  if (!checked.ok) { const error = new Error(checked.errors.join("；")); error.code = "INVALID_CANDIDATE"; throw error; }
  mkdirSync(dir(root), { recursive: true });
  atomicWrite(file(root, candidate.candidate_id), candidate);
}

export function withCandidateLock(root, id, action) {
  if (!CANDIDATE_ID_RE.test(String(id || ""))) {
    const error = new Error("candidate_id 非法");
    error.code = "INVALID_CANDIDATE_ID";
    throw error;
  }
  const lock = join(dir(root), `.${clean(id)}.lock`);
  mkdirSync(dir(root), { recursive: true });
  const owner = `${process.pid}:${randomUUID()}`;
  const temp = `${lock}.tmp-${owner.replace(/:/g, "-")}`;
  writeFileSync(temp, owner, "utf8");
  try {
    // Publish the complete owner record exclusively; no observer can see an
    // empty lock between file creation and writing the PID/token.
    linkSync(temp, lock);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    if (error?.code !== "EEXIST") throw error;
    let pid = 0;
    try { pid = Number(readFileSync(lock, "utf8").trim().split(":", 1)[0]); } catch {}
    const stale = pid > 0 && !pidAlive(pid);
    const busy = new Error(stale
      ? `候选锁记录 PID ${pid} 已退出；核实后手动移除锁文件再重试`
      : pid ? `候选正在被 PID ${pid} 确认` : "候选锁存在但无法读取所有者；请检查锁文件后重试");
    busy.code = stale ? "CANDIDATE_LOCK_STALE" : "CANDIDATE_BUSY";
    throw busy;
  }
  try { return action(); }
  finally {
    try {
      if (readFileSync(lock, "utf8") === owner) unlinkSync(lock);
    } catch {}
    try { unlinkSync(temp); } catch {}
  }
}

export function withCandidateLocks(root, ids, action) {
  if (!Array.isArray(ids) || ids.some((id) => !CANDIDATE_ID_RE.test(String(id || "")))) {
    const error = new Error("candidate_id 非法");
    error.code = "INVALID_CANDIDATE_ID";
    throw error;
  }
  const ordered = [...new Set(ids.map(String))].sort();
  const acquire = (index) => index >= ordered.length
    ? action()
    : withCandidateLock(root, ordered[index], () => acquire(index + 1));
  return acquire(0);
}

function validateCandidate(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { ok: false, errors: ["candidate must be an object"] };
  if (!candidate.candidate_id || !CANDIDATE_ID_RE.test(candidate.candidate_id)) errors.push("candidate_id 非法");
  if (!CANDIDATE_KINDS.includes(candidate.kind)) errors.push(`kind 必须是 ${CANDIDATE_KINDS.join("/")}`);
  if (!clean(candidate.content) || clean(candidate.content).length < 4) errors.push("content 为空或过短");
  if (!SOURCE_KINDS.includes(candidate.source_kind)) errors.push(`source_kind 必须是 ${SOURCE_KINDS.join("/")}`);
  if (!clean(candidate.source_ref)) errors.push("source_ref 不能为空");
  if (/[\r\n]/.test(String(candidate.source_ref))) errors.push("source_ref 不得包含换行");
  if (/[\r\n]/.test(String(candidate.situation || ""))) errors.push("situation 不得包含换行");
  if (!Number.isFinite(Number(candidate.confidence)) || Number(candidate.confidence) < 0 || Number(candidate.confidence) > 1) errors.push("confidence 必须是 0~1 的数字");
  if (!["global", "workspace"].includes(candidate.scope)) errors.push("scope 必须是 global/workspace");
  if (!CANDIDATE_STATES.includes(candidate.state)) errors.push(`state 必须是 ${CANDIDATE_STATES.join("/")}`);
  if (!Array.isArray(candidate.history)) errors.push("history 必须是数组");
  if (candidate.state === "confirmed") {
    if (!clean(candidate.active_memory_id)) errors.push("confirmed 候选必须有 active_memory_id");
    if (!clean(candidate.confirmed_by) || /[\r\n]/.test(String(candidate.confirmed_by))) errors.push("confirmed 候选必须有合法 confirmed_by");
    if (!clean(candidate.confirmed_at) || !Number.isFinite(Date.parse(candidate.confirmed_at))) errors.push("confirmed 候选必须有合法 confirmed_at");
  }
  return { ok: errors.length === 0, errors };
}

export function makeCandidate(input, actor = "unknown") {
  const candidate = {
    candidate_id: input.candidate_id || randomUUID(),
    created: now(),
    updated: now(),
    kind: input.kind || "decision",
    content: clean(input.content),
    source_kind: input.source_kind || "user_said",
    source_ref: clean(input.source_ref),
    confidence: Number(input.confidence),
    scope: input.scope === "workspace" ? "workspace" : input.scope === "global" ? "global" : input.scope,
    situation: clean(input.situation || ""),
    state: "candidate",
    history: [{ at: now(), action: "created", actor: clean(actor) || "unknown", content: clean(input.content), source_ref: clean(input.source_ref) }],
  };
  const checked = validateCandidate(candidate);
  if (!checked.ok) { const error = new Error(checked.errors.join("；")); error.code = "INVALID_CANDIDATE"; throw error; }
  return candidate;
}

export function saveCandidate(root, candidate) {
  const checked = validateCandidate(candidate);
  if (!checked.ok) { const error = new Error(checked.errors.join("；")); error.code = "INVALID_CANDIDATE"; throw error; }
  mkdirSync(dir(root), { recursive: true });
  const target = file(root, candidate.candidate_id);
  try {
    atomicWrite(target, candidate, { exclusive: true });
  } catch (error) {
    if (error?.code === "EEXIST") {
      const conflict = new Error("候选 ID 已存在，拒绝覆盖原候选");
      conflict.code = "CANDIDATE_EXISTS_CONFLICT";
      throw conflict;
    }
    throw error;
  }
  return candidate;
}

export function readCandidate(root, id) {
  if (!id || /[\\/]/.test(String(id))) return null;
  const path = file(root, clean(id));
  if (!CANDIDATE_ID_RE.test(clean(id))) return null;
  if (!existsSync(path)) return null;
  try {
    const candidate = JSON.parse(readFileSync(path, "utf8"));
    const checked = validateCandidate(candidate);
    return checked.ok && candidate.candidate_id === clean(id) ? candidate : null;
  } catch { return null; }
}

export function inspectCandidateFiles(root) {
  const base = dir(root);
  if (!existsSync(base)) return [];
  return readdirSync(base).filter(name => /^[a-f0-9-]+\.json$/.test(name)).map(name => {
    const candidateId = name.slice(0, -5);
    const path = join(base, name);
    try {
      const candidate = JSON.parse(readFileSync(path, "utf8"));
      const checked = validateCandidate(candidate);
      const errors = [...checked.errors];
      if (candidate.candidate_id !== candidateId) errors.push("文件名与 candidate_id 不一致");
      return errors.length === 0
        ? { file: path, candidate, valid: true, errors: [] }
        : { file: path, candidate, valid: false, errors, code: candidate.candidate_id !== candidateId ? "CANDIDATE_FILENAME_MISMATCH" : undefined };
    } catch (error) {
      return { file: path, candidate: { candidate_id: candidateId }, valid: false, errors: [String(error.message || error)] };
    }
  });
}

export function listCandidates(root, options = {}) {
  return inspectCandidateFiles(root).filter(record => record.valid).map(record => record.candidate)
    .filter(candidate => !options.state || candidate.state === options.state)
    .sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

export function updateCandidateWithinLock(root, id, mutator) {
  const current = readCandidate(root, id);
  if (!current) return { ok: false, error: "候选不存在或格式非法" };
  let next;
  try { next = mutator({ ...current, history: [...current.history] }); }
  catch (error) { return { ok: false, error: String(error.message || error), ...(error.code ? { code: error.code } : {}) }; }
  next.updated = now();
  const checked = validateCandidate(next);
  if (!checked.ok) return { ok: false, error: checked.errors.join("；") };
  // Test-only fault injection lets the activation recovery path be exercised
  // deterministically without weakening normal candidate persistence.
  if (process.env.CP_TEST_FAIL_CANDIDATE_UPDATE === id) {
    const error = new Error("测试注入：候选状态保存失败");
    error.code = "CANDIDATE_ACTIVATION_STATE_SAVE_FAILED";
    return { ok: false, error: error.message, code: error.code };
  }
  try { writeCandidate(root, next); }
  catch (error) { return { ok: false, error: String(error.message || error), ...(error.code ? { code: error.code } : {}) }; }
  return { ok: true, candidate: next };
}

export function updateCandidate(root, id, mutator) {
  try { return withCandidateLock(root, id, () => updateCandidateWithinLock(root, id, mutator)); }
  catch (error) { return { ok: false, error: String(error.message || error), ...(error.code ? { code: error.code } : {}) }; }
}

export function candidatePath(root, id) { return file(root, id); }
export { validateCandidate };
