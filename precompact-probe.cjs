#!/usr/bin/env node
/**
 * precompact-probe.cjs — PreCompact 宿主支持探针（2026-09-19 立）
 *
 * 目的（对应 context-mode 评估里的收获 ①）：
 *   CP 在 R2 里把 PreCompact 判成"非阻断 → 拦不住压缩 → 用不上"，因此长期**只做压缩后恢复**。
 *   但 context-mode 的用法（README:671「PreCompact builds the resume snapshot **before** compaction」）说明：
 *   非阻断恰恰意味着"能挂上去做事、不妨碍压缩"——**它是压缩前的挂点，不是拦压工具**。
 *   本探针要回答两件事：
 *     ① cc-haha（999.0.0-local 魔改版）到底**会不会**触发 PreCompact（静态查不到：app.asar 里
 *        PreCompact 与 SessionStart 都是 0 命中，而 SessionStart 实测会触发 → 静态查无意义）
 *     ② 触发时 payload 长什么样（有哪些字段、有没有 transcript_path / trigger）
 *   方法论：I-005（不赌不可静态证实的宿主行为 → 挂上 + 记录首次观测 + fail-open）。
 *
 * 顺带产物：`precompact-snapshot.json` —— 压缩前把**现场**（在飞任务/最近改动的关键文件/接力状态）
 *   落一份到磁盘。若将来 PreCompact 确认可用，这份快照就是"压缩后按需拉回"的数据源；
 *   现在先落盘**不注入**（先证会触发，再谈注入）。
 *
 * 失败语义：fail-open —— 任何异常只写 hook-errors.log，输出 {}（宿主视为无操作）。
 */
'use strict';

const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const ROOT = process.env.CP_ROOT || join(homedir(), '.cosmic-phantom');
const FLAGS = join(ROOT, '.flags');
const PROBES = join(FLAGS, 'precompact-probes.jsonl');
const SNAP = join(FLAGS, 'precompact-snapshot.json');
const LOG = join(ROOT, 'hook-errors.log');

function logErr(m) { try { appendFileSync(LOG, `[${new Date().toISOString()}] precompact-probe: ${m}\n`, 'utf8'); } catch {} }
function readJson(p, d = null) { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } }
// 注意：readJson 的入参是**文件路径**。stdin 拿到的是 JSON 字符串，必须直接 JSON.parse ——
//   首版把 payload 字符串当路径传给 readJson → 永远解析失败 → 探针会误报"触发了但 payload 为空"。
function parseStr(s, d = {}) { try { return JSON.parse(String(s).replace(/^\uFEFF/, '')); } catch { return d; } }

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch {}
  const payload = raw.trim() ? parseStr(raw, {}) : {};

  // ── 观测记录（每次触发追加一行；这是"会不会触发"的唯一硬证据）──
  const rec = {
    at: new Date().toISOString(),
    stdinBytes: raw.length,
    keys: Object.keys(payload || {}).sort(),
    trigger: payload && (payload.trigger || payload.source || payload.reason) || null,
    hasTranscript: !!(payload && (payload.transcript_path || payload.transcriptPath)),
    transcriptBytes: null,
    sessionId: (payload && (payload.session_id || payload.sessionId)) || null,
  };
  try {
    const tp = payload && (payload.transcript_path || payload.transcriptPath);
    if (tp && existsSync(tp)) rec.transcriptBytes = statSync(tp).size;
  } catch {}
  try { mkdirSync(FLAGS, { recursive: true }); appendFileSync(PROBES, JSON.stringify(rec) + '\n', 'utf8'); } catch (e) { logErr(`探针写入失败: ${e.message}`); }

  // ── 现场快照（压缩前落盘；若 PreCompact 确认可用，就是"压缩后按需拉回"的数据源）──
  try {
    const st = readJson(join(ROOT, 'current-state.json'), {}) || {};
    const due = readJson(join(FLAGS, 'audit-due.json'), {}) || {};
    const recent = [];
    try {
      const d = join(ROOT, 'daily');
      const files = readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-1);
      for (const f of files) {
        const lines = readFileSync(join(d, f), 'utf8').split('\n').filter((l) => /^- \*\*🛠️ Agent（成果）\*\*/.test(l));
        if (lines.length) recent.push({ file: f, last: lines[lines.length - 1].slice(0, 300) });
      }
    } catch {}
    writeFileSync(SNAP, JSON.stringify({
      at: rec.at,
      revision: st.revision,
      objective: st.objective,
      summary: st.summary,
      nextActions: st.nextActions || [],
      pendingAuditChanged: due.changed || [],
      recentAchievement: recent,
      note: 'PreCompact 探针产物：压缩前现场。若宿主支持 PreCompact，此文件即"压缩后按需拉回"的数据源。',
    }, null, 2) + '\n', 'utf8');
  } catch (e) { logErr(`快照写入失败: ${e.message}`); }

  process.stdout.write('{}\n');   // 不注入、不阻断：只观测
}

try { main(); } catch (e) { logErr(`unhandled: ${e.message}`); process.stdout.write('{}\n'); }
