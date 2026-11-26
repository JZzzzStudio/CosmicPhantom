#!/usr/bin/env node
/**
 * verify-handoff.js — 接力交付质检器（A 完整性 / B 保真 / C 质量）
 *
 * A 完整性：JSONL 会话行 ⇄ events.db（instance+mid）逐行对账，missing/extra 应为 0
 * B 保真：用户原话逐字 === 抽样 + daily 用户行覆盖 + 决策标记计数
 * C 质量：current-state revision/字段覆盖 + memories 增长 + --baseline 对比（improved 判定）
 *
 * 用法（--experimental-sqlite）:
 *   node --experimental-sqlite verify-handoff.js --root <根> [--sessions-dir <目录>] \
 *        [--date YYYY-MM-DD] [--json] [--baseline <基线.json>] [--sample N]
 *
 * 基线纪律（13:35 教训）：交付前 cp delivery/verify-handoff-*.json delivery/baseline-*.json
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { loadCurrentState } from "../../../current-state.js";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const EVENTS_DB = join(ROOT, "events.db");
const DECISION = /(记住|以后|决定|不要|必须|改成|改为|偏好|禁止|每次|一律|规则|记一下)/;

function get(key) { const i = process.argv.indexOf(key); return i >= 0 ? process.argv[i + 1] : undefined; }

function extractText(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(part => part && part.type === "text" && part.text).map(part => part.text).join("\n");
  }
  return "";
}

function listSessionRows(sessionsDir, date) {
  if (!sessionsDir || !existsSync(sessionsDir)) return { rows: [], files: 0 };
  const files = readdirSync(sessionsDir).filter(file => file.endsWith(".jsonl"));
  const rows = [];
  for (const file of files) {
    const absolute = join(sessionsDir, file);
    let lineNo = 0;
    for (const line of readFileSync(absolute, "utf8").replace(/^\uFEFF/, "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lineNo += 1;
      let record;
      try { record = JSON.parse(trimmed); } catch { continue; }
      if (record.type !== "user" && record.type !== "assistant") continue;
      const text = extractText(record.message || {});
      if (!text) continue;
      const instance = "proma-" + file.replace(/\.jsonl$/i, "").slice(0, 8);
      const ts = record._createdAt ? new Date(record._createdAt).toISOString().slice(0, 10) : "";
      if (date && ts !== date) continue;
      rows.push({ instance, mid: lineNo, role: record.type, content: text, date: ts });
    }
  }
  return { rows, files: files.length };
}

function checkCompleteness(rows, db) {
  const expectedRows = rows.length;
  const missingRows = [];
  const extraRows = [];
  const eventsInDb = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  const seen = new Set();
  const stmt = db.prepare("SELECT 1 AS found FROM events WHERE instance=? AND mid=?");
  for (const row of rows) {
    seen.add(`${row.instance}:${row.mid}`);
    if (!stmt.get(row.instance, row.mid)) missingRows.push(`${row.instance}:${row.mid}[${row.role}]`);
  }
  for (const event of db.prepare("SELECT instance, mid, role FROM events WHERE instance LIKE 'proma-%'").all()) {
    const key = `${event.instance}:${event.mid}`;
    if (!seen.has(key)) extraRows.push(`${event.instance}:${event.mid}[${event.role}]`);
  }
  return { sessionFiles: 0, expectedRows, eventsInDb, missingRows, extraRows, pass: missingRows.length === 0 && extraRows.length === 0 };
}

function checkFidelity(rows, db, date, sampleSize) {
  const userRows = rows.filter(row => row.role === "user");
  const sampled = userRows.slice(0, sampleSize);
  const verbatimFailures = [];
  const dbRows = new Map();
  for (const row of sampled) {
    const found = db.prepare("SELECT content FROM events WHERE instance=? AND mid=?").get(row.instance, row.mid);
    const stored = found ? found.content : null;
    if (stored !== row.content) verbatimFailures.push(`${row.instance}:${row.mid}`);
    dbRows.set(`${row.instance}:${row.mid}`, stored);
  }
  const dailyPath = join(ROOT, "daily", `${date || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}.md`);
  let dailyText = "";
  if (existsSync(dailyPath)) dailyText = readFileSync(dailyPath, "utf8");
  const dailyUserLines = (dailyText.match(/^- 👤 用户[:：]/gm) || []).length + (dailyText.match(/^- ⭐👤 用户（决策）[:：]/gm) || []).length;
  const decisionFlags = (dailyText.match(/⭐👤/g) || []).length;
  const dailyBlocks = (dailyText.match(/^## 会话 /gm) || []).length;
  const dailyCoverage = userRows.every(row => dailyText.includes(row.content.slice(0, 40)) || dailyText.includes(`${row.instance.split("-")[1]}:${row.mid}`));
  return {
    userRowsToday: userRows.length,
    sampled: sampled.length,
    verbatimHit: sampled.length - verbatimFailures.length,
    verbatimRate: sampled.length ? Math.round(((sampled.length - verbatimFailures.length) / sampled.length) * 100) : 100,
    verbatimFailures,
    dailyBlocks,
    dailyUserLines,
    decisionFlags,
    dailyCoverage,
    pass: verbatimFailures.length === 0 && dailyCoverage,
  };
}

function checkQuality(db, baseline) {
  const state = loadCurrentState(ROOT);
  const memoriesDir = join(ROOT, "memories");
  const memoryGrowthToday = existsSync(memoriesDir)
    ? readdirSync(memoriesDir).filter(file => /^2026/.test(file) && file.endsWith(".md")).length
    : 0;
  const current = {
    revision: state.revision,
    status: state.status,
    objective: String(state.objective || "").length,
    summary: String(state.summary || "").length,
    completed: Array.isArray(state.completed) ? state.completed.length : 0,
    nextActions: Array.isArray(state.nextActions) ? state.nextActions.length : 0,
    blockers: Array.isArray(state.blockers) ? state.blockers.length : 0,
    decisions: Array.isArray(state.decisions) ? state.decisions.length : 0,
    workingFiles: Array.isArray(state.workingFiles) ? state.workingFiles.length : 0,
    verification: Array.isArray(state.verification) ? state.verification.length : 0,
  };
  let baselineComparison = null;
  if (baseline && baseline.checks && baseline.checks.C_quality && baseline.checks.C_quality.state) {
    const previous = baseline.checks.C_quality.state;
    baselineComparison = {
      revisionImproved: current.revision >= previous.revision,
      previousRevision: previous.revision,
      currentRevision: current.revision,
      improved: current.revision >= previous.revision && current.completed >= previous.completed,
    };
  }
  const pass = state.revision > 0 && (baselineComparison ? baselineComparison.improved : true);
  return { state: current, memoryGrowthToday, baselineComparison, pass };
}

function main() {
  const sessionsDir = get("--sessions-dir");
  const date = get("--date");
  const baselinePath = get("--baseline");
  const sampleSize = Number(get("--sample") || 10);
  const gate = process.argv.includes("--gate");
  const baseline = baselinePath && existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;

  const { rows, files } = listSessionRows(sessionsDir, date);
  const db = existsSync(EVENTS_DB) ? new DatabaseSync(EVENTS_DB, { readOnly: true }) : null;
  try {
    const checks = {
      A_completeness: db ? checkCompleteness(rows, db) : { expectedRows: rows.length, pass: false, error: "events.db missing" },
      B_fidelity: db ? checkFidelity(rows, db, date, sampleSize) : { pass: false, error: "events.db missing" },
      C_quality: checkQuality(db, baseline),
    };
    checks.A_completeness.sessionFiles = files;
    const pass = checks.A_completeness.pass && checks.B_fidelity.pass && checks.C_quality.pass;
    const result = { date: date || "today", generatedAt: new Date().toISOString(), checks, pass };
    if (gate) {
      // 交付门禁（Memorix 门控借鉴）：A/B/C 全绿 + baseline 存在且 improved 才放行
      const comparison = checks.C_quality.baselineComparison;
      const baselineOk = comparison ? comparison.improved : false;
      result.gate = { passed: pass && baselineOk, mode: "required", reason: !pass ? "checks failed" : !comparison ? "missing baseline (deliver with --baseline)" : comparison.improved ? "" : `baseline not improved (rev ${comparison.previousRevision} -> ${comparison.currentRevision})` };
      process.exitCode = result.gate.passed ? 0 : 2;
    } else {
      process.exitCode = pass ? 0 : 1;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    if (db) try { db.close(); } catch {}
  }
}

main();
