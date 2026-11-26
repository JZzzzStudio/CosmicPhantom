#!/usr/bin/env node
/**
 * poll-state.js — 写强制适配器 v3：Hermes state.db → 原始事件层 → daily 投影（双轨，2026-08-08）
 *
 * 用法（需 --experimental-sqlite）:
 *   node --experimental-sqlite poll-state.js --db <hermes-home/state.db> [--root <cosmic根>]
 *
 * 两段契约（委托 events.js）：
 *   段1 ingest：state.db → events.db（单事务：事件 INSERT + 游标 UPDATE 原子提交）
 *   段2 project：events.db → daily（幂等：projection 表 + daily 事件标记双查）
 * 游标权威 = events.db meta.cursor（state-poll.json 已停用，2026-08-08 起）
 *
 * 保留：K25 进程互斥锁 + K25b 锁老化；K20/K24 结束信号检测；fail-open；
 *       输出契约 {source, wrote, endedNew, endedSemantic, at}（watch-state 依赖）
 *
 * 机制:
 *   1. 只读打开 state.db，按 events.db 游标增量摄取（事务保证：失败不越过游标）
 *   2. 事件唯一键 = sourceInstanceId + message id（换库自动换实例，防 id 重号）
 *   3. 投影 daily（幂等去重）；daily 失败不影响原始事件
 *   4. fail-open：任何异常记 hook-errors.log，不影响宿主
 */
import { existsSync, appendFileSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const EVENTS = join(ROOT, "events.js");
const NODE = join(ROOT, "tools", "node", "node.exe");

function logErr(m) { try { appendFileSync(join(ROOT, "hook-errors.log"), `[${new Date().toISOString()}] ${m}\n`); } catch {} }

function poll(dbPath) {
  // K25：进程互斥锁——防并发双写；K25b：锁老化——进程被强杀时 finally 不执行会残留锁，
  // 残留超过 2 分钟视为僵尸锁自动清除（否则写强制永久停摆）
  const LOCK = join(ROOT, ".poll.lock");
  const LOCK_STALE_MS = 2 * 60 * 1000;
  const tryLock = () => { const fd = openSync(LOCK, "wx"); closeSync(fd); };
  try {
    tryLock();
  } catch {
    try {
      const st = statSync(LOCK);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) unlinkSync(LOCK);
    } catch (e) { logErr(`poll 锁老化检查异常（不静默，K25b）: ${e.message}`); }
    try { tryLock(); }
    catch {
      process.stdout.write(JSON.stringify({ source: "state.db", skipped: "locked" }) + "\n");
      return;
    }
  }
  try {
    pollInner(dbPath);
  } finally {
    try { unlinkSync(LOCK); } catch {}
  }
}

function pollInner(dbPath) {
  if (!existsSync(dbPath)) { logErr(`poll-state: db missing ${dbPath}`); return; }
  // 两段契约委托 events.js poll（--experimental-sqlite + --root 透传，K17/K18/K22/K26 纪律）
  const evArgs = ["--experimental-sqlite", EVENTS, "poll", "--db", dbPath];
  if (ROOT !== join(homedir(), ".cosmic-phantom")) evArgs.push("--root", ROOT);
  const r = spawnSync(NODE, evArgs, { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) { logErr(`poll-state: events 调用失败 status=${r.status} stderr=${(r.stderr || "").slice(0, 200)}`); return; }
  const line = (r.stdout || "").split("\n").filter(Boolean).pop();
  try {
    const j = JSON.parse(line);
    if (j.error) { logErr(`poll-state: ${j.error}`); return; }
    // 输出契约（watch-state 依赖）：wrote/endedNew/endedSemantic/at
    process.stdout.write(JSON.stringify({ source: "state.db", wrote: j.wrote || 0, endedNew: j.endedNew || 0, endedSemantic: !!j.endedSemantic, at: j.at || new Date().toISOString() }) + "\n");
  } catch (e) { logErr(`poll-state: 解析 events 输出失败: ${e.message}（输出：${line.slice(0, 120)}）`); }
}

const dbPath = process.argv[process.argv.indexOf("--db") + 1];
if (!dbPath) { process.stdout.write(JSON.stringify({ error: "缺 --db" }) + "\n"); process.exit(0); }
poll(dbPath);
