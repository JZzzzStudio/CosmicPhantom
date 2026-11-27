// lib/memory-feedback.js — memory effect feedback: explicit marks + derived stats.
// Spec: work/cp-memory-feedback/spec.md. Truth source = events.db memory_feedback
// table (append-only, event_tombstones precedent); stats cache is rebuildable.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { recordCall, recordFallback } from "./failopen.js";
import { locateEntity, createCandidate } from "../memory-domains.js";

const VERDICTS = ["helped", "misled"];
const MARKERS = ["user", "agent"];

function fail(message, code = "FEEDBACK_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function text(value, field) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) fail(field + " 必须是非空单行文本");
  return value;
}
function eventsPath(root) { return join(root, "events.db"); }
function cachePath(root) { return join(root, "feedback-stats.json"); }

function openDb(root, { create = false } = {}) {
  const path = eventsPath(root);
  if (!create && !existsSync(path)) return null;
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  if (create) { try { db.exec("PRAGMA journal_mode = WAL;"); } catch {} }
  db.exec("CREATE TABLE IF NOT EXISTS memory_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, verdict TEXT NOT NULL, marker TEXT NOT NULL, task_ref TEXT, note TEXT, ts TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE)");
  return db;
}

function legacyIds(root) {
  const dir = join(root, "memories");
  const ids = new Set();
  if (!existsSync(dir)) return ids;
  for (const file of readdirSync(dir, { recursive: true })) {
    const name = String(file);
    if (!name.endsWith(".md") || basename(name).startsWith(".tmp-")) continue;
    try {
      const head = readFileSync(join(dir, name), "utf8").slice(0, 2000);
      const match = head.match(/^id:\s*(.+)$/m);
      if (match) ids.add(match[1].trim());
    } catch {}
  }
  return ids;
}

function resolveMemory(root, memoryId) {
  const id = text(memoryId, "memory_id");
  try { locateEntity(root, id); return { memory_id: id, lane: "domain" }; }
  catch (error) { if (error.code !== "MEMORY_NOT_FOUND") throw error; }
  if (legacyIds(root).has(id)) return { memory_id: id, lane: "legacy" };
  fail("记忆不存在: " + id, "MEMORY_NOT_FOUND");
}

function emptyEntry() {
  return { helped_user: 0, helped_agent: 0, misled_user: 0, misled_agent: 0, tasks: 0, last_ts: null };
}

function aggregate(db) {
  const memories = {}, taskSets = {};
  let rows = [];
  try { rows = db.prepare("SELECT memory_id, verdict, marker, task_ref, ts FROM memory_feedback").all(); } catch { return memories; }
  for (const row of rows) {
    const entry = memories[row.memory_id] || (memories[row.memory_id] = emptyEntry());
    const key = row.verdict + "_" + row.marker;
    if (key in entry) entry[key] += 1;
    if (row.ts && (!entry.last_ts || row.ts > entry.last_ts)) entry.last_ts = row.ts;
    if (row.task_ref) (taskSets[row.memory_id] || (taskSets[row.memory_id] = new Set())).add(row.task_ref);
  }
  for (const [id, set] of Object.entries(taskSets)) memories[id].tasks = set.size;
  return memories;
}

export function annotationFor(entry) {
  if (!entry) return null;
  const helped = entry.helped_user + entry.helped_agent;
  const misled = entry.misled_user + entry.misled_agent;
  if (helped + misled === 0) return null;
  return "历史标记：" + helped + " 帮到 / " + misled + " 误导（user " + (entry.helped_user + entry.misled_user) + " / agent " + (entry.helped_agent + entry.misled_agent) + "）";
}

function writeCache(root, payload) {
  try {
    const path = cachePath(root);
    const tmp = path + ".tmp-" + process.pid + "-" + randomUUID();
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    try { renameSync(tmp, path); } catch { try { unlinkSync(path); renameSync(tmp, path); } finally { try { unlinkSync(tmp); } catch {} } }
  } catch (error) {
    recordFallback("memory-feedback-cache", String(error.code || error.message || "unknown").slice(0, 60));
  }
}

function refreshCache(root, db) {
  writeCache(root, { schema_version: 1, built_at: new Date().toISOString(), memories: aggregate(db) });
}

export function addFeedback(root, input = {}) {
  recordCall("memory-feedback-add");
  const memoryId = text(input.memory_id, "memory_id");
  const verdict = text(input.verdict, "verdict");
  if (!VERDICTS.includes(verdict)) fail("verdict 必须是 " + VERDICTS.join("/"));
  const marker = input.marker === undefined ? "user" : text(input.marker, "marker");
  if (!MARKERS.includes(marker)) fail("marker 必须是 " + MARKERS.join("/"));
  const taskRef = input.task_ref == null ? null : text(input.task_ref, "task_ref");
  const note = input.note == null ? null : text(input.note, "note");
  resolveMemory(root, memoryId);
  if (process.env.CP_TEST_FAIL_FEEDBACK_ADD === "1") {
    recordFallback("memory-feedback-add", "test-injection");
    fail("测试注入：反馈标记写入失败", "FEEDBACK_TEST_INJECTED");
  }
  const fingerprint = createHash("sha256").update([memoryId, taskRef || "", verdict, marker].join("|")).digest("hex");
  let db = null;
  try {
    db = openDb(root, { create: true });
    const result = db.prepare("INSERT OR IGNORE INTO memory_feedback(memory_id, verdict, marker, task_ref, note, ts, fingerprint) VALUES(?,?,?,?,?,?,?)").run(memoryId, verdict, marker, taskRef, note, new Date().toISOString(), fingerprint);
    const inserted = Number(result.changes) > 0;
    refreshCache(root, db);
    return { ok: true, idempotent: !inserted, memory_id: memoryId, verdict, marker };
  } catch (error) {
    if (error.code !== "FEEDBACK_TEST_INJECTED") recordFallback("memory-feedback-add", String(error.code || error.message || "unknown").slice(0, 60));
    throw error;
  } finally { try { if (db) db.close(); } catch {} }
}

export function feedbackStats(root, options = {}) {
  recordCall("memory-feedback-stats");
  const db = openDb(root);
  const memories = db ? aggregate(db) : {};
  if (db) { refreshCache(root, db); try { db.close(); } catch {} }
  const selected = options.memory_id ? { [options.memory_id]: memories[options.memory_id] || emptyEntry() } : memories;
  for (const entry of Object.values(selected)) entry.annotation = annotationFor(entry);
  return { ok: true, memories: selected, total: Object.keys(memories).length };
}

export function listFeedback(root, options = {}) {
  recordCall("memory-feedback-list");
  const memoryId = text(options.memory_id, "memory_id");
  const db = openDb(root);
  let marks = [];
  if (db) {
    try { marks = db.prepare("SELECT memory_id, verdict, marker, task_ref, note, ts FROM memory_feedback WHERE memory_id=? ORDER BY ts, id").all(memoryId); } catch {}
    try { db.close(); } catch {}
  }
  return { ok: true, memory_id: memoryId, marks };
}

export function suggestReview(root, options = {}) {
  recordCall("memory-feedback-suggest");
  const db = openDb(root);
  const memories = db ? aggregate(db) : {};
  if (db) { try { db.close(); } catch {} }
  const created = [], existing = [];
  for (const [memoryId, entry] of Object.entries(memories)) {
    if (!(entry.misled_user >= 1 || entry.misled_agent >= 2)) continue;
    const candidateId = "fb-review-" + createHash("sha256").update(memoryId).digest("hex").slice(0, 16) + "-u" + entry.misled_user + "a" + entry.misled_agent;
    const content = "审阅记忆 " + memoryId + "：误导标记 user " + entry.misled_user + " / agent " + entry.misled_agent + "（帮到 user " + entry.helped_user + " / agent " + entry.helped_agent + "）。本候选不预设结论；核实后决定纠正、废止或保留。";
    try {
      const result = createCandidate(root, {
        candidate_id: candidateId, content,
        source_ref: "memory-feedback:" + memoryId, source_kind: "memory_feedback",
        explicit_user_confirmation: options.explicit_user_confirmation, actor: options.actor,
      });
      created.push({ candidate_id: result.candidate.candidate_id, memory_id: memoryId });
    } catch (error) {
      if (error.code === "CANDIDATE_EXISTS_CONFLICT") { existing.push({ candidate_id: candidateId, memory_id: memoryId }); continue; }
      recordFallback("memory-feedback-suggest", String(error.code || error.message || "unknown").slice(0, 60));
      throw error;
    }
  }
  return { ok: true, created, existing };
}

