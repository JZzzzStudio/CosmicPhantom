#!/usr/bin/env node
/**
 * log_turn.js — 写强制手动入口 v2（2026-08-08 双轨化）
 *
 * 用法:
 *   node log_turn.js --transcript <JSONL路径> [--session <id>] [--force] [--root <r>]
 *
 * 双轨架构：本脚本是薄壳——提取/摄取/投影单实现在 events.js manual：
 *   transcript JSONL → events.db（原始事件层，instance="manual" + 自增 seq，不 trim）→ daily 投影（幂等）
 *
 * 幂等: 会话指纹 sha256(sessionId|date) 记入 fingerprints.db（非 force 时）
 * 失败语义: 任何异常只写 hook-errors.log，绝不影响宿主主流程
 */
import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// K17/K18/K22/K26 纪律：--root 透传链
const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const ENGINE_ROOT = dirname(fileURLToPath(import.meta.url));
const DAILY_DIR = join(ROOT, "daily");
const FP_DB = join(ROOT, "fingerprints.db");
const EVENTS = join(ENGINE_ROOT, "events.js");
const NODE = existsSync(join(ENGINE_ROOT, "tools", "node", "node.exe")) ? join(ENGINE_ROOT, "tools", "node", "node.exe") : process.execPath;

function today() {
  // 本地时区日期（K14：UTC 日期在凌晨会错位到前一天）
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function fp(sessionId) { return createHash("sha256").update(`${sessionId}|${today()}`).digest("hex").slice(0, 16); }
function seen(f) { return existsSync(FP_DB) && readFileSync(FP_DB, "utf8").split("\n").includes(f); }
function mark(f) { appendFileSync(FP_DB, f + "\n"); }
function logErr(m) { try { appendFileSync(join(ROOT, "hook-errors.log"), `[${new Date().toISOString()}] ${m}\n`); } catch {} }

function main() {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const tp = get("--transcript"), sid = get("--session") || "anon";
  const force = args.includes("--force");              // force：跳过幂等（调用方保证，如轮询器）
  if (!tp || !existsSync(tp)) { logErr("no transcript"); process.exit(0); }
  const f = fp(sid);
  if (!force && seen(f)) process.exit(0);              // 幂等：同会话同日不重复写
  // 委托 events.js manual（单实现原则：提取/摄取/投影/⭐标记/漏写标记全在 events.js）
  const evArgs = ["--experimental-sqlite", EVENTS, "manual", "--transcript", tp, "--session", sid];
  if (ROOT !== join(homedir(), ".cosmic-phantom")) evArgs.push("--root", ROOT);   // K26 同族
  const r = spawnSync(NODE, evArgs, { encoding: "utf8", timeout: 30000 });
  if (!force) mark(f);                                 // 先记账，防重复解析（force 时调用方保证幂等）
  if (r.status !== 0) { logErr(`log_turn: events manual 失败 status=${r.status} ${(r.stderr || "").slice(0, 150)}`); process.exit(0); }
  let logged = 0, empty = false;
  try {
    const j = JSON.parse((r.stdout || "").split("\n").filter(Boolean).pop() || "{}");
    logged = j.logged || 0; empty = !!j.empty;
  } catch {}
  if (empty) { process.stdout.write("empty"); process.exit(0); }  // 空轮标记（K19：poll 区分空轮与失败）
  const daily = join(DAILY_DIR, `${today()}.md`);
  process.stdout.write(`logged ${logged} entries -> ${daily}\n`);
}
main();
