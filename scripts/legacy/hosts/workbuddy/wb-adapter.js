#!/usr/bin/env node
/**
 * wb-adapter.js — WorkBuddy（腾讯 CodeBuddy）宿主写强制适配器
 *
 * 从 CodeBuddy 会话 JSONL（CLI ~/.codebuddy/projects + GUI ~/.workbuddy/projects）
 * 增量摄取到 Cosmic Phantom 原始事件层（events.db）→ daily 投影（复用 events.js project）。
 * 与 proma-adapter.js 使用同一写入契约：UNIQUE(instance, mid) + INSERT OR IGNORE；
 * 游标仅性能优化；失败不推进游标；尾部半行不推进游标；fail-open。
 *
 * 用法（--experimental-sqlite）:
 *   node --experimental-sqlite wb-adapter.js --sessions-dir <目录> [--sessions-dir <目录2>] \
 *        [--root <cosmic根>] [--dry-run] [--cursor <游标文件>]
 *
 * 行结构（v2.115.0 实测）:
 *   {"type":"message","role":"user","content":[{"type":"input_text","text":"..."}],"sessionId":"...","cwd":"..."}
 *   {"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}],...}
 *   幂等键：instance = "wb-" + sessionId 前 8 位；mid = JSONL 行号（append-only 稳定）
 */
import { existsSync, appendFileSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const NODE = process.env.CP_NODE || process.execPath;
const EVENTS = join(ROOT, "events.js");
const EVENTS_DB = join(ROOT, "events.db");
const LOG = join(ROOT, "hook-errors.log");
const DEFAULT_CURSOR = join(ROOT, ".wb-cursor.json");
const SENSITIVE = /(api[_-]?key|secret|passw(or)?d|token|cookie|authorization|bearer\s+\S)/i;

function logErr(message) { try { appendFileSync(LOG, `[${new Date().toISOString()}] wb-adapter: ${message}\n`); } catch {} }
function get(key) { const i = process.argv.indexOf(key); return i >= 0 ? process.argv[i + 1] : undefined; }

// CodeBuddy 消息文本：input_text/output_text 全量逐字（不 trim 不改写）
function extractText(record) {
  if (!record || typeof record !== "object") return "";
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part && (part.type === "input_text" || part.type === "output_text") && part.text)
      .map(part => part.text)
      .join("\n");
  }
  return "";
}

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// 单文件增量扫描：游标只推进到最后一个完整 JSON 行（尾部半行下次重试）
export function scanWbFile(file, knownLines) {
  if (!existsSync(file)) return { rows: [], totalLines: 0 };
  const raw = readFileSync(file, "utf8");
  const lines = raw.replace(/^\uFEFF/, "").split("\n");
  let total = 0;
  const rows = [];
  let lineNo = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineNo += 1;
    if (lineNo <= knownLines) continue;
    const record = parseLine(trimmed);
    if (!record || record.type !== "message") continue;
    total = lineNo;
    const text = extractText(record);
    const role = record.role === "user" ? "user" : record.role === "assistant" ? "assistant" : null;
    if (!role || !text) continue;
    const idPart = String(record.sessionId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || (file.match(/([0-9a-f]{8})/i) || [])[1] || "unknown";
    rows.push({
      instance: "wb-" + idPart,
      mid: lineNo,
      role,
      content: text,
      ts: record.timestamp ? new Date(record.timestamp).toISOString() : new Date().toISOString(),
    });
  }
  return { rows, totalLines: total };
}

export function ingestWbRows(rows, dryRun, eventsDb = EVENTS_DB) {
  if (!rows.length) return { added: 0, projected: 0 };
  if (dryRun) return { added: rows.length, projected: 0 };
  const db = new DatabaseSync(eventsDb);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance TEXT NOT NULL,
      mid INTEGER NOT NULL,
      session TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      tool_calls TEXT,
      ts TEXT NOT NULL,
      sensitive INTEGER DEFAULT 0,
      UNIQUE(instance, mid)
    );
    CREATE TABLE IF NOT EXISTS projection (event_id INTEGER PRIMARY KEY);
  `);
  let added = 0;
  try {
    db.exec("BEGIN");
    try {
      const insert = db.prepare("INSERT OR IGNORE INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive) VALUES(?,?,?,?,?,?,?,?,?)");
      for (const row of rows) {
        const info = insert.run(row.instance, row.mid, row.instance, row.role, row.content, null, null, row.ts, SENSITIVE.test(row.content || "") ? 1 : 0);
        added += Number(info.changes);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      logErr(`ingest transaction rolled back: ${error.message}`);
      return { added: 0, error: error.message };
    }
  } finally {
    try { db.close(); } catch {}
  }
  let projected = 0;
  if (added > 0) {
    const projection = spawnSync(NODE, ["--experimental-sqlite", EVENTS, "project", "--root", ROOT], { encoding: "utf8", timeout: 60000 });
    if (projection.status === 0) {
      try { projected = JSON.parse((projection.stdout || "").split("\n").filter(Boolean).pop()).projected || 0; } catch {}
    } else {
      logErr(`project call failed status=${projection.status} stderr=${(projection.stderr || "").slice(0, 200)}`);
    }
  }
  return { added, projected };
}

export function runWbAdapter(options = {}) {
  const sessionsDirs = options.sessionsDirs && options.sessionsDirs.length
    ? options.sessionsDirs
    : process.argv.reduce((dirs, value, index, argv) => {
        if (value === "--sessions-dir" && argv[index + 1]) dirs.push(argv[index + 1]);
        return dirs;
      }, []);
  const cursorFile = options.cursorFile || get("--cursor") || DEFAULT_CURSOR;
  const dryRun = options.dryRun !== undefined ? options.dryRun : process.argv.includes("--dry-run");
  if (!sessionsDirs.length) {
    process.stdout.write(JSON.stringify({ source: "wb", error: "缺少 --sessions-dir" }) + "\n");
    return;
  }
  let cursor = {};
  try { if (existsSync(cursorFile)) cursor = JSON.parse(readFileSync(cursorFile, "utf8")); } catch { cursor = {}; }

  const files = [];
  for (const dir of sessionsDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true })) {
      if (typeof entry === "string" && entry.endsWith(".jsonl")) files.push(join(dir, entry));
    }
  }

  const seen = new Set(Object.keys(cursor));
  let totalAdded = 0, totalProjected = 0, scanned = 0;
  const details = [];

  for (const absolute of files) {
    const known = Number(cursor[absolute] || 0);
    const { rows, totalLines } = scanWbFile(absolute, known);
    scanned += rows.length;
    if (rows.length) {
      const result = ingestWbRows(rows, dryRun);
      totalAdded += result.added || 0;
      totalProjected += result.projected || 0;
      details.push({ file: absolute, newRows: rows.length, added: result.added || 0, totalLines, error: result.error || undefined });
      if (!dryRun && !result.error && (!seen.has(absolute) || totalLines > Number(cursor[absolute] || 0))) cursor[absolute] = totalLines;
    } else {
      details.push({ file: absolute, newRows: 0, added: 0, totalLines });
      if (!dryRun && (!seen.has(absolute) || totalLines > Number(cursor[absolute] || 0))) cursor[absolute] = totalLines;
    }
  }

  if (!dryRun) {
    try {
      const temp = `${cursorFile}.tmp`;
      writeFileSync(temp, JSON.stringify(cursor, null, 2));
      renameSync(temp, cursorFile);
    } catch (error) { logErr(`cursor write failed: ${error.message}`); }
  }

  process.stdout.write(JSON.stringify({
    source: "wb", dryRun, files: files.length, scanned, added: totalAdded, projected: totalProjected,
    cursorFile: dryRun ? null : cursorFile, at: new Date().toISOString(), details,
  }, null, 2) + "\n");
}

try { runWbAdapter(); } catch (error) { logErr(`unexpected error: ${error.message}`); process.stdout.write(JSON.stringify({ source: "wb", error: error.message }) + "\n"); }
