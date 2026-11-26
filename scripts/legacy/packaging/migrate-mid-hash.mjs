#!/usr/bin/env node
/**
 * migrate-mid-hash.cjs — P1-5 存量迁移(2026-08-29,一次性,可重跑幂等)。
 *
 * 背景:proma 源 mid 原为 JSONL 行号,被 Proma 流式重写打破(事故 drifted=2/extra=46/missing=101)。
 * 修法:mid 改内容 hash(proma-adapter.js/events.js hashMid 已同步实装)。本脚本把库内存量
 * proma-% 事件的 mid 从行号重算为内容 hash,并清理 hash 后同键重复(同内容多行号历史遗留)。
 *
 * 用法:
 *   node --experimental-sqlite migrate-mid-hash.cjs --root <root> [--apply]
 *   默认 dry-run 只报告;--apply 实跑(先自动备份 events.db → backup/)。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const APPLY = process.argv.includes("--apply");
const DB = join(ROOT, "events.db");
const hashMid = (role, content) => parseInt(createHash("sha256").update(`${role}\n${content || ""}`).digest("hex").slice(0, 12), 16);

const db = new DatabaseSync(DB);
try {
  const rows = db.prepare("SELECT id, instance, session, role, content, tool_name, tool_calls, ts, sensitive FROM events WHERE instance LIKE 'proma-%' ORDER BY instance, id").all();
  if (!rows.length) { console.log(JSON.stringify({ migrate: "nothing to do (no proma events)" })); process.exit(0); }

  const plan = [];      // {id, instance, newMid}
  const dupDrop = [];   // 重复行 id(同 instance+newMid 且 content 相同,保留最小 id)
  const conflicts = []; // hash 冲突(同键不同内容)——需人工
  const seen = new Map();
  for (const r of rows) {
    const nm = hashMid(r.role, r.content);
    const key = `${r.instance}\0${nm}`;
    const prev = seen.get(key);
    if (prev) {
      if (prev.content === r.content) dupDrop.push(r.id);
      else conflicts.push({ key, keepId: prev.id, dropId: r.id });
      continue;
    }
    seen.set(key, { id: r.id, content: r.content });
    plan.push({ id: r.id, instance: r.instance, newMid: nm });
  }
  const changed = plan.filter(p => true); // 全部需 UPDATE(行号→hash)
  const report = { total: rows.length, toUpdate: changed.length, dupDrop: dupDrop.length, conflicts: conflicts.length, apply: APPLY };
  if (conflicts.length) { console.log(JSON.stringify({ ...report, error: "hash 冲突,需人工处理", conflicts: conflicts.slice(0, 5) }, null, 2)); process.exit(1); }
  if (!APPLY) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

  const backupDir = join(ROOT, "backup");
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `events-pre-midhash-${Date.now()}.db`);
  db.close();
  copyFileSync(DB, backup);
  const wdb = new DatabaseSync(DB);
  try {
    wdb.exec("BEGIN IMMEDIATE");
    try {
      const upd = wdb.prepare("UPDATE events SET mid=? WHERE id=?");
      for (const p of changed) upd.run(p.newMid, p.id);
      const delP = wdb.prepare("DELETE FROM projection WHERE event_id=?");
      const delE = wdb.prepare("DELETE FROM events WHERE id=?");
      for (const id of dupDrop) { delP.run(id); delE.run(id); }
      wdb.exec("COMMIT");
    } catch (e) { wdb.exec("ROLLBACK"); console.log(JSON.stringify({ error: `迁移回滚: ${e.message}` })); process.exit(1); }
  } finally { try { wdb.close(); } catch {} }
  console.log(JSON.stringify({ ...report, backup }, null, 2));
} finally { try { db.close(); } catch {} }
