#!/usr/bin/env node
/**
 * proma-adapter.js — Proma 宿主写强制适配器（2026-08-10 Proma 还原）
 *
 * 用途：无 Hermes 环境下，把 Proma 会话存储（agent-sessions/*.jsonl）增量摄取到
 *       Cosmic Phantom 原始事件层（events.db）→ daily 投影（复用 events.js project）。
 *
 * 用法（--experimental-sqlite）:
 *   node --experimental-sqlite proma-adapter.js --sessions-dir <Proma agent-sessions 目录> \
 *        [--root <cosmic根>] [--session-id <过滤单个会话>] [--dry-run] [--cursor <游标文件>]
 *
 * 幂等设计（重放安全，不依赖游标正确性）:
 *   instance = "proma-" + 会话文件 ID 前缀；mid = 内容 hash(P1-5,2026-08-29 实装:
 *     sha256(role+"\n"+content) 前 12 位 hex 转 48bit 整数;弃用行号——Proma 流式重写
 *     打破"行号=mid"假设,事故 drifted=2/extra=46/missing=101)
 *   events 表 UNIQUE(instance, mid) + INSERT OR IGNORE → 重跑/丢游标均不重复
 *   游标文件（默认 .proma-cursor.json）仅作信息记录;摄取为全文件重扫(hash 幂等兜底)
 *
 * 提取语义（保真铁律，与 events.js extractText 一致）:
 *   user 消息：content[].type==="text" 全量提取（原话逐字，不 trim 不改写）
 *   assistant 消息：仅 text 块（不含 thinking/tool_use）
 *   tool_result / tool_use / thinking：不记录
 *   空内容跳过；sensitive 命中（key/secret/token 等）标记 sensitive=1（保留不删）
 *
 * 生命周期：无时钟、不常驻。每次会话开始由 Agent 手动执行一次增量摄取
 * （等价原系统"下一次 MCP 会话补漏追平"语义）。fail-open：任何异常记
 * hook-errors.log，退出码 0，绝不影响宿主。
 */
import { existsSync, appendFileSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// 恢复文件识别：首行含 _recovered 溯源标记（CP 抢救回写件）→ 摄取/对账豁免
function isRecoveredFile(file) {
  try {
    const head = readFileSync(file, "utf8").slice(0, 600);
    return head.includes('"_recovered"');
  } catch { return false; }
}
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
// 解释器直接用 process.execPath（adapter 由便携 node 启动；隔离根测试时也能正确调用 events.js）
const NODE = process.env.CP_NODE || process.execPath;
const EVENTS = join(ROOT, "events.js");
const EVENTS_DB = join(ROOT, "events.db");
const LOG = join(ROOT, "hook-errors.log");
const DEFAULT_CURSOR = join(ROOT, ".proma-cursor.json");
const SENSITIVE = /(api[_-]?key|secret|passw(or)?d|token|cookie|authorization|bearer\s+\S)/i;

function logErr(m) { try { appendFileSync(LOG, `[${new Date().toISOString()}] proma-adapter: ${m}\n`); } catch {} }
function get(k) { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; }

function extractText(msg) {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(c => c && c.type === "text" && c.text)
      .map(c => c.text).join("\n");
  }
  return "";
}

function parseLine(ln) {
  try { return JSON.parse(ln); } catch { return null; }
}

// P1-5(2026-08-29 实装):幂等键 mid = 内容 hash——sha256(role+"\n"+content) hex 前 12 位转 48bit 整数。
//   弃用行号:Proma 流式重写打破"行号=mid"假设(2026-08-29 事故 drifted=2/extra=46/missing=101),
//   内容 hash 对重写/重排/插行免疫——同内容恒同 mid,重扫幂等(INSERT OR IGNORE)。
//   口径镜像:events.js coverageInternal 的 midCheck 用同款 hashMid,两处规格逐字一致,漂移由 midCheck 对账自动暴露。
function hashMid(role, content) {
  return parseInt(createHash("sha256").update(`${role}\n${content || ""}`).digest("hex").slice(0, 12), 16);
}

// 单文件增量扫描：返回 [{instance, mid, role, content, ts}]（仅新行）
export function scanFile(file, knownLines) {
  if (!existsSync(file)) return { rows: [], totalLines: 0 };
  const raw = readFileSync(file, "utf8");
  const lines = raw.replace(/^\uFEFF/, "").split("\n");
  // 游标只推进到最后一个完整 JSON 行；写入中的尾部半行下次重试（防丢数据）。
  let total = 0;
  const rows = [];
  let lineNo = 0;
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    lineNo += 1;
    // P1-5:全文件重扫,不再按 knownLines 跳过——mid=内容 hash 后重扫幂等,流式重写/行号漂移无影响
    const rec = parseLine(trimmed);
    if (!rec) continue;
    total = lineNo;
    const msg = rec.message || {};
    let role = null;
    if (rec.type === "user") {
      const text = extractText(msg);
      if (text !== "") role = "user";
    } else if (rec.type === "assistant") {
      const text = extractText(msg);
      if (text !== "") role = "assistant";
    }
    if (!role) continue;
    // 幂等键：instance = proma-<短ID>（文件 UUID 前 8 位），mid = 内容 hash(P1-5)
    const idPart = basename(file).replace(/\.jsonl$/i, "").slice(0, 8);
    const text = extractText(msg);
    rows.push({
      instance: "proma-" + idPart,
      mid: hashMid(role, text),
      role,
      content: text,
      ts: rec._createdAt ? new Date(rec._createdAt).toISOString() : new Date().toISOString(),
    });
  }
  return { rows, totalLines: total };
}

function ingestRows(rows, dryRun) {
  if (!rows.length) return { added: 0, projected: 0 };
  if (dryRun) return { added: rows.length, projected: 0 };
  // 自建表（与 events.js openDb DDL 一致）：events.db 不存在时也能正确建库
  const db = new DatabaseSync(EVENTS_DB);
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
      const ins = db.prepare("INSERT OR IGNORE INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive) VALUES(?,?,?,?,?,?,?,?,?)");
      for (const r of rows) {
        const info = ins.run(r.instance, r.mid, r.instance, r.role, r.content, null, null, r.ts, SENSITIVE.test(r.content || "") ? 1 : 0);
        added += Number(info.changes);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      logErr(`摄取事务回滚: ${e.message}`);
      return { added: 0, error: e.message };
    }
  } finally { try { db.close(); } catch {} }
  // 段2：投影复用 events.js project（幂等）
  let projected = 0;
  if (added > 0) {
    const pr = spawnSync(NODE, ["--experimental-sqlite", EVENTS, "project", "--root", ROOT], { encoding: "utf8", timeout: 60000 });
    if (pr.status === 0) {
      try { projected = JSON.parse((pr.stdout || "").split("\n").filter(Boolean).pop()).projected || 0; } catch {}
    } else { logErr(`project 调用失败 status=${pr.status} stderr=${(pr.stderr || "").slice(0, 200)}`); }
  }
  return { added, projected };
}

export function runPromaAdapter(options = {}) {
  const sessionsDir = options.sessionsDir || get("--sessions-dir");
  const sessionFilter = options.sessionFilter || get("--session-id");
  const cursorFile = options.cursorFile || get("--cursor") || DEFAULT_CURSOR;
  const dryRun = options.dryRun !== undefined ? options.dryRun : process.argv.includes("--dry-run");
  const root = options.root || ROOT;
  if (!sessionsDir || !existsSync(sessionsDir)) {
    process.stdout.write(JSON.stringify({ source: "proma", error: `sessions-dir 不存在: ${sessionsDir}` }) + "\n");
    return;
  }
  // 游标：{ "<absPath>": lineCount }；丢失/损坏 → 空对象（UNIQUE 幂等兜底，仅性能影响）
  let cursor = {};
  try { if (existsSync(cursorFile)) cursor = JSON.parse(readFileSync(cursorFile, "utf8")); } catch { cursor = {}; }

  // _recovered 豁免（2026-08-29）：恢复文件行号与原文件不同，mid 幂等键全乱——
  //   重扫会以新 mid 重复插入同内容（验收实测 midCheck extra=449）。恢复文件对摄取器透明（数据已在库）。
  const files = readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl") && !isRecoveredFile(join(sessionsDir, f)));
  const seen = new Set(Object.keys(cursor));
  let totalAdded = 0, totalProjected = 0, scanned = 0;
  const details = [];

  for (const f of files) {
    if (sessionFilter && !f.startsWith(sessionFilter)) continue;
    const abs = join(sessionsDir, f);
    const known = Number(cursor[abs] || 0);
    const { rows, totalLines } = scanFile(abs, known);
    scanned += rows.length;
    if (rows.length) {
      const r = ingestRows(rows, dryRun);
      totalAdded += r.added || 0;
      totalProjected += r.projected || 0;
      details.push({ file: f, newRows: rows.length, added: r.added || 0, totalLines, error: r.error || undefined });
      // 失败不推进游标（失败行下次重试）；dry-run 不写
      if (!dryRun && !r.error) {
        if (!seen.has(abs) || totalLines > Number(cursor[abs] || 0)) cursor[abs] = totalLines;
      }
    } else {
      details.push({ file: f, newRows: 0, added: 0, totalLines });
      if (!dryRun) {
        if (!seen.has(abs) || totalLines > Number(cursor[abs] || 0)) cursor[abs] = totalLines;
      }
    }
  }

  if (!dryRun) {
    try {
      const tmp = cursorFile + ".tmp";
      writeFileSync(tmp, JSON.stringify(cursor, null, 2));
      renameSync(tmp, cursorFile);
    } catch (e) { logErr(`游标写入失败（不影响本次摄取）: ${e.message}`); }
    // P1-6(2026-08-29):决策卡自动同步覆盖非 ZCode 通道——摄取后 --all 全量扫 daily(幂等),
    //   Proma 历史会话决策行散布多天;与 zcode-flush 同款"断不了档"哲学。
    if (totalAdded > 0) {
      try {
        spawnSync(NODE, ["--experimental-sqlite", join(ROOT, "decision-cards.js"), "--all", "--root", ROOT], { encoding: "utf8", timeout: 120000 });
      } catch (e) { logErr(`decision-cards sync failed: ${e.message}`); }
      // 可选面板数据刷新：调用方显式提供路径时才触发外部构建器。
      try {
        const builder = process.env.CP_PANEL_BUILDER;
        if (builder && existsSync(builder)) spawnSync(NODE, ["--experimental-sqlite", builder], { encoding: "utf8", timeout: 20000 });
      } catch (e) { logErr(`state-builder sync failed: ${e.message}`); }
    }
  }

  process.stdout.write(JSON.stringify({
    source: "proma", dryRun, files: files.length, scanned, added: totalAdded, projected: totalProjected,
    cursorFile: dryRun ? null : cursorFile, at: new Date().toISOString(), details,
  }, null, 2) + "\n");
}

try { runPromaAdapter(); } catch (e) { logErr(`异常: ${e.message}`); process.stdout.write(JSON.stringify({ source: "proma", error: e.message }) + "\n"); }
