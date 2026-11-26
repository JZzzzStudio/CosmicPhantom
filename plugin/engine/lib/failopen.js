// lib/failopen.js — fail-open 计数（2026-11-19）
//
// 为什么要它：fail-open 的本意是「出错不崩」，副作用是「没生效也显示正常」。
//   2026-11-19 实例：graph-build 写 links.json 的 candidates 段，applyRefine 读 derived 段（被 delete），
//   2093 条边一次都没被消费；verify 看 candidateStats 报绿灯 —— 三道关没有一道问"它到底生效了没有"。
// 口径：每个兜底点一个名字。rate = fallbacks / calls。
//   calls ≥ MIN_CALLS 且 rate ≥ DEAD_RATE → 判定「死机制」（每次调用都在兜底 = 从未真正生效）。
// 纪律：计数器本身绝不抛错、绝不阻塞；写盘批量+退出钩子兜住。
// 关闭：评测/沙箱跑分时设 CP_FAILOPEN_DISABLE=1，避免污染生产统计。

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const MIN_CALLS = Number(process.env.CP_FAILOPEN_MIN_CALLS || 20);
const DEAD_RATE = 0.99;
const DISABLED = () => process.env.CP_FAILOPEN_DISABLE === "1";

let stats = null;
let hookInstalled = false;

function filePath() {
  const root = process.env.CP_ROOT || process.cwd();
  return join(root, "failopen-stats.json");
}

function lockPath() { return filePath() + ".lock"; }

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

// 计数发生在多个 hook/MCP 进程之间；读改写 JSON 必须在同一把跨进程锁内完成。
function withLock(fn) {
  const lock = lockPath();
  try { mkdirSync(dirname(lock), { recursive: true }); } catch { return null; }
  // 计数不能因为短暂竞争而静默丢失；这是观测分母，丢一次就会制造假绿。
  const deadline = Date.now() + 30000;
  let fd = null;
  while (Date.now() < deadline) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120000) unlinkSync(lock);
      } catch {}
      sleep(10);
    }
  }
  if (fd === null) return null;
  try { return fn(); }
  finally { try { closeSync(fd); } catch {} try { unlinkSync(lock); } catch {} }
}

function readStats() {
  try {
    const p = filePath();
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j && typeof j === "object" && !Array.isArray(j)) return j;
    }
  } catch {}
  return {};
}

function writeStats(value) {
  const p = filePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  try { renameSync(tmp, p); }
  catch {
    try { unlinkSync(p); renameSync(tmp, p); } finally { try { unlinkSync(tmp); } catch {} }
  }
}

function load() {
  if (!stats) stats = readStats();
  return stats;
}

function install() {
  if (hookInstalled) return;
  hookInstalled = true;
  try { process.on("exit", () => flush()); } catch { /* 装不上钩子也不许抛 */ }
}

function bump(name, field, reason) {
  if (DISABLED()) return;
  // 锁竞争、Windows 原子替换瞬态失败都重试；观测分母/分子不能静默少记一次。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const next = withLock(() => {
        const s = readStats();
        if (!s[name]) s[name] = { calls: 0, fallbacks: 0, reasons: {} };
        const e = s[name];
        if (field === "call") e.calls += 1;
        else {
          e.fallbacks += 1;
          const k = String(reason || "unknown").slice(0, 60);
          e.reasons = e.reasons || {};
          e.reasons[k] = (e.reasons[k] || 0) + 1;
        }
        e.updatedAt = new Date().toISOString();
        writeStats(s);
        return s;
      });
      if (next) { stats = next; install(); return; }
    } catch {}
    sleep(25 * (attempt + 1));
  }
  // 计数器仍不得阻断主链路；verify 会通过计数异常/基线检查暴露持续写入失败。
}

/** 机制被调用一次（即使成功也要记，否则算不出触发率） */
export function recordCall(name) { bump(name, "call"); }

/** 兜底生效一次（= 本次调用机制没起作用），reason 写清为什么 */
export function recordFallback(name, reason) { bump(name, "fallback", reason); }

export function flush() {
  // bump 已经在锁内立即落盘；保留此入口兼容旧调用方。
  if (DISABLED()) return;
  try { stats = withLock(() => { const s = readStats(); writeStats(s); return s; }) || stats; } catch {}
}

/** 汇总：按触发率降序 */
export function summarize() {
  const s = readStats();
  stats = s;
  return Object.entries(s)
    .filter(([name, e]) => !name.startsWith("_") && e && typeof e === "object")
    .map(([name, e]) => {
    const recordedCalls = Number(e.calls) || 0;
    const fallbacks = Number(e.fallbacks) || 0;
    const inconsistent = fallbacks > recordedCalls;
    const calls = Math.max(recordedCalls, fallbacks);
    const rate = calls ? +(fallbacks / calls).toFixed(3) : null;
    return {
      name,
      calls,
      recordedCalls,
      fallbacks,
      inconsistent,
      rate,
      dead: !inconsistent && calls >= MIN_CALLS && rate !== null && rate >= DEAD_RATE,
      topReasons: Object.entries(e.reasons || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([r, n]) => `${r}×${n}`),
      updatedAt: e.updatedAt,
      ...(e.baselineReset ? { baselineReset: {
        at: e.baselineReset.at,
        reason: e.baselineReset.reason,
        previousCalls: Number(e.baselineReset.previousCalls) || 0,
        previousFallbacks: Number(e.baselineReset.previousFallbacks) || 0,
      } } : {}),
    };
  }).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
}

export function deadMechanisms() { return summarize().filter((x) => x.dead); }

export const FAILOPEN_THRESHOLDS = { MIN_CALLS, DEAD_RATE };