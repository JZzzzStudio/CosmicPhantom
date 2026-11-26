#!/usr/bin/env node
/**
 * current-state.js - structured handoff state for context compression and new agents.
 *
 * The JSON file is the single source of truth. Updates are explicit, validated,
 * revision-checked, and atomically committed. inject.js only reads this state.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const STATE_FILE = "current-state.json";
export const STATUS_VALUES = ["active", "blocked", "paused", "completed"];
const ARRAY_FIELDS = ["completed", "nextActions", "blockers", "decisions", "workingFiles", "verification"];
const STRING_FIELDS = ["status", "objective", "summary"];
const MAX_STRING = 4000;
const MAX_ITEMS = 50;
// 内容纪律(2026-08-17 定,2026-08-29 实装字节级硬校验;2026-09-09 summary 改字符制 ≤100 字):防注入膨胀。
//   只校验 patch 传入的字段——存量超标不阻塞不相关字段的 update。
//   单位:summary 按字符(中英同权,100 字≈300B,用户拍板放宽);objective 按字节(250B)。
const DISCIPLINE = {
  summary: { unit: "chars", max: 100 },
  objective: { unit: "bytes", max: 250 },
};
const NEXT_ACTIONS_MAX = 3;
const byteLen = (s) => Buffer.byteLength(s, "utf8");

export function emptyState() {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    source: null,
    status: "paused",
    objective: "",
    summary: "",
    completed: [],
    nextActions: [],
    blockers: [],
    decisions: [],
    workingFiles: [],
    verification: [],
  };
}

function statePath(root) { return join(root, STATE_FILE); }
function lockPath(root) { return join(root, ".current-state.lock"); }
function isText(value) { return typeof value === "string" && value.length <= MAX_STRING; }

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function acquireLock(root) {
  const file = lockPath(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return file;
    } catch {
      let owner = 0;
      try { owner = Number(readFileSync(file, "utf8").trim()); } catch {}
      if (owner && pidAlive(owner)) {
        const error = new Error(`current state is being updated by PID ${owner}`);
        error.code = "STATE_BUSY";
        throw error;
      }
      try { unlinkSync(file); } catch {}
    }
  }
  const error = new Error("unable to acquire current-state lock");
  error.code = "STATE_BUSY";
  throw error;
}
function cleanText(value) { return value.replace(/\r\n/g, "\n"); }

export function validateState(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["state must be an object"] };
  if (value.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (!Number.isInteger(value.revision) || value.revision < 0) errors.push("revision must be a non-negative integer");
  if (!STATUS_VALUES.includes(value.status)) errors.push(`status must be one of ${STATUS_VALUES.join(", ")}`);
  for (const field of ["objective", "summary"]) if (!isText(value[field])) errors.push(`${field} must be a string <= ${MAX_STRING} characters`);
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(value[field])) { errors.push(`${field} must be an array`); continue; }
    if (value[field].length > MAX_ITEMS) errors.push(`${field} exceeds ${MAX_ITEMS} items`);
    if (value[field].some(item => !isText(item))) errors.push(`${field} items must be strings <= ${MAX_STRING} characters`);
  }
  for (const field of ["updatedAt", "updatedBy", "source"]) {
    if (value[field] !== null && !isText(value[field])) errors.push(`${field} must be null or a bounded string`);
  }
  return { ok: errors.length === 0, errors };
}

export function loadCurrentState(root) {
  const file = statePath(root);
  if (!existsSync(file)) return emptyState();
  try {
    const state = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const checked = validateState(state);
    return checked.ok ? state : { ...emptyState(), invalid: checked.errors };
  } catch (error) {
    return { ...emptyState(), invalid: [String(error.message || error)] };
  }
}

function normalizePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch must be an object");
  const allowed = new Set([...STRING_FIELDS, ...ARRAY_FIELDS]);
  const unknown = Object.keys(patch).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`unknown patch fields: ${unknown.join(", ")}`);
  const normalized = {};
  for (const field of STRING_FIELDS) if (field in patch) normalized[field] = cleanText(String(patch[field]));
  for (const field of ARRAY_FIELDS) {
    if (!(field in patch)) continue;
    if (!Array.isArray(patch[field])) throw new Error(`${field} must be an array`);
    normalized[field] = patch[field].map(item => cleanText(String(item)));
  }
  for (const [field, rule] of Object.entries(DISCIPLINE)) {
    if (field in normalized) {
      const size = rule.unit === "bytes" ? byteLen(normalized[field]) : Array.from(normalized[field]).length;
      const limitLabel = rule.unit === "bytes" ? `${rule.max}B` : `${rule.max} 字`;
      if (size > rule.max) throw new Error(`content discipline: ${field} is ${size} ${rule.unit} > ${limitLabel} limit (one-line conclusion + pointer, details go to memories/daily)`);
    }
  }
  if (Array.isArray(normalized.nextActions) && normalized.nextActions.length > NEXT_ACTIONS_MAX) {
    throw new Error(`content discipline: nextActions has ${normalized.nextActions.length} items > ${NEXT_ACTIONS_MAX} (merge similar pending items, move done ones to completed)`);
  }
  return normalized;
}

export function updateCurrentState(root, patch, options = {}) {
  const lock = acquireLock(root);
  try {
    const current = loadCurrentState(root);
    if (current.invalid) throw new Error(`current state is invalid: ${current.invalid.join("; ")}`);
    if (options.expectedRevision !== undefined && Number(options.expectedRevision) !== current.revision) {
      const error = new Error(`revision conflict: expected ${options.expectedRevision}, current ${current.revision}`);
      error.code = "REVISION_CONFLICT";
      throw error;
    }
    const next = {
      ...current,
      ...normalizePatch(patch),
      schemaVersion: 1,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: options.actor || "unknown",
      source: options.source || "explicit update",
    };
    const checked = validateState(next);
    if (!checked.ok) throw new Error(checked.errors.join("; "));
    syncTimestamps(root, patch, next);   // TTL（2026-08-28）：时间戳语义=最后确认（patch 含该字段=主动保留→刷新）
    const file = statePath(root);
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", "utf8");
    try { renameSync(temp, file); }
    catch (error) { try { unlinkSync(temp); } catch {} throw error; }
    return next;
  } finally {
    try { unlinkSync(lock); } catch {}
  }
}

// TTL 时间戳映射（2026-08-28 P2）：不改 current-state schema（宿主兼容优先），
//   项内容 SHA 前 16 位 → 首次出现时间，落 state-timestamps.json；verify F15 读它报过期。
function syncTimestamps(root, patch, next) {
  try {
    const tsFile = join(root, "state-timestamps.json");
    let map = {};
    try { map = JSON.parse(readFileSync(tsFile, "utf8")); } catch {}
    const keyOf = (item) => createHash("sha256").update(String(item)).digest("hex").slice(0, 16);
    const now = new Date().toISOString();
    const touched = new Set(Object.keys(normalizePatch(patch || {})));   // patch 显式给出的字段 = 主动确认保留
    const nextMap = {};
    for (const field of ["nextActions", "blockers"]) {
      const confirmed = touched.has(field);
      for (const item of (next[field] || [])) {
        const k = field + ":" + keyOf(item);
        nextMap[k] = confirmed ? now : (map[k] || now);   // 语义=最后确认时间：重述同文也算确认（进行中任务不被误报过期）
      }
    }
    writeFileSync(tsFile, JSON.stringify(nextMap, null, 2), "utf8");
  } catch { /* fail-open：时间戳失败不阻塞状态更新 */ }
}

function xml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderList(label, values) {
  if (!values.length) return `${label}: none`;
  return `${label}:\n${values.map(item => `- ${xml(item)}`).join("\n")}`;
}

export function renderCurrentState(root, maxBytes = 3072) {
  const state = loadCurrentState(root);
  if (state.invalid) return `<current-state available="false" error="${xml(state.invalid.join("; "))}" />\n`;
  if (state.revision === 0 && !state.objective && !state.summary) return `<current-state available="false" />\n`;
  const body = [
    `status: ${xml(state.status)}`,
    `objective: ${xml(state.objective)}`,
    `summary: ${xml(state.summary)}`,
    renderList("completed", state.completed),
    renderList("nextActions", state.nextActions),
    renderList("blockers", state.blockers),
    renderList("decisions", state.decisions),
    renderList("workingFiles", state.workingFiles),
    renderList("verification", state.verification),
  ].join("\n");
  const head = `<current-state source="cosmic-phantom" revision="${state.revision}" updated-at="${xml(state.updatedAt)}">\n`;
  const tail = "\n</current-state>\n";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(head + tail));
  let text = body;
  while (Buffer.byteLength(text) > budget && text.length) text = text.slice(0, Math.floor(text.length * 0.9));
  if (text.length < body.length) text += "\n[truncated; run current-state.js show for full state]";
  return head + text + tail;
}

function output(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
function parseArgs(argv) {
  const get = key => { const index = argv.indexOf(key); return index >= 0 ? argv[index + 1] : undefined; };
  return { command: argv[0] || "show", get };
}

function main() {
  const argv = process.argv.slice(2);
  const { command, get } = parseArgs(argv);
  const root = get("--root") || join(homedir(), ".cosmic-phantom");
  try {
    if (command === "show") output(loadCurrentState(root));
    else if (command === "render") process.stdout.write(renderCurrentState(root, Number(get("--bytes") || 3072)));
    else if (command === "validate") {
      const file = get("--file");
      if (!file || !existsSync(file)) throw new Error("validate requires --file");
      output(validateState(JSON.parse(readFileSync(file, "utf8"))));
    } else if (command === "update") {
      const file = get("--file");
      const raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
      const next = updateCurrentState(root, JSON.parse(raw), {
        expectedRevision: get("--expected-revision"),
        actor: get("--actor"),
        source: get("--source"),
      });
      output({ updated: true, state: next });
    } else output({ usage: "show|render|validate --file <json>|update [--file <patch.json>] [--expected-revision N] [--actor A] [--source S]" });
  } catch (error) {
    output({ error: String(error.message || error), code: error.code || "CURRENT_STATE_ERROR" });
    process.exitCode = error.code === "REVISION_CONFLICT" ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) main();
