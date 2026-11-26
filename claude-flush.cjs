#!/usr/bin/env node
/**
 * claude-flush.cjs — Claude Code Stop hook 落盘适配器（2026-09-15 新增宿主）
 *
 * 背景：CP 原有宿主适配器只覆盖 zcode（SQLite 读取）/ proma / wb。
 *   Claude Code 的会话 transcript 是 JSONL（~/.claude/projects/<proj>/<sessionId>.jsonl），
 *   其行格式（{type, message:{content:[{type:"text",text}]}}）与 events.js manual 契约兼容，
 *   2026-09-15 沙箱实测直解通过（915KB 真实会话 → logged 4 / projected 4）。
 *
 * 职责：从 Stop payload 取 transcript_path + session_id，委托 events.js manual 摄取
 *   → events.db（instance=manual）→ daily 投影。
 *
 * 幂等：不使用 log_turn.js 的 (session|date) 指纹——那会阻止同一会话当日后续轮次追加。
 *   改用 events.js manual 的内置内容级去重（session+role+content 相同即跳过），
 *   因此每轮 Stop 都跑是安全的，新内容追加、旧内容跳过。
 *
 * 超时预算（2026-09-16 M2 收缩）：内层上限合计 15+20+15+10 = **60s = 宿主 timeout**。
 *   宁可内层单步早退（fail-open 记日志）也不能让宿主整链被 kill —— 后者会静默断档。
 * 失败语义：fail-open——任何异常只写 hook-errors.log，绝不影响宿主主流程。
 */
'use strict';

const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = process.env.CP_ROOT || join(homedir(), '.cosmic-phantom');
const NODE = process.env.CP_NODE || join(ROOT, 'tools', 'node', 'node.exe');
const LOG = join(ROOT, 'hook-errors.log');

function logErr(message) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] claude-flush: ${message}\n`, 'utf8');
  } catch {}
}

function main() {
  let payload = {};
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim()) payload = JSON.parse(raw);
  } catch (error) {
    logErr(`Stop payload parse failed: ${error.message}`);
  }

  const transcript = payload.transcript_path || payload.transcriptPath;
  const sessionId = payload.session_id || payload.sessionId || 'claude';

  if (!transcript || !existsSync(transcript)) {
    logErr(`no transcript path in payload (got: ${String(transcript)})`);
    process.stdout.write('{}');
    return;
  }

  const nodeExe = existsSync(NODE) ? NODE : process.execPath;
  const result = spawnSync(
    nodeExe,
    ['--experimental-sqlite', join(ROOT, 'events.js'), 'manual', '--transcript', transcript, '--session', sessionId, '--root', ROOT],
    {
      encoding: 'utf8',
      timeout: 15000,
      // M1 同族修复：hook 子进程不继承宿主 env 的 CP_HOST，显式传递宿主标识。
      env: { ...process.env, CP_HOST: process.env.CP_HOST || 'claude-code' },
    },
  );

  if (result.status !== 0) {
    logErr(`events manual failed status=${result.status} ${(result.stderr || result.stdout || '').slice(0, 200)}`);
  }

  // 决策卡自动同步（2026-09-15 补挂；与 zcode-flush.cjs 同款"断不了档"哲学）。
  // P1-6 同源：用 --all 全量扫 daily（幂等），覆盖非 ZCode 通道——单日模式会漏历史会话散落多天的决策行。
  try {
    spawnSync(nodeExe, ['--experimental-sqlite', join(ROOT, 'decision-cards.js'), '--all', '--root', ROOT], {
      encoding: 'utf8',
      timeout: 20000,
    });
  } catch (e) {
    logErr(`decision-cards sync failed: ${e.message}`);
  }

  // 状态快照刷新（2026-09-15 补挂）：与 decision-cards 同理的"断不了档"。
  // 痛点：收尾协议要求"先状态更新 → 后 update-snapshot"，但 Agent 更新完状态后
  //   屡屡忘记跑快照 → verify 反复报「AGENTS.md 快照 revision X ≠ 状态 Y」。
  //   挂进 Stop 链后永不落后。该脚本内部会连带调 sync-reply-policy.mjs（多宿主门禁段自动跟随真源）。
  try {
    spawnSync(nodeExe, [join(ROOT, 'update-snapshot.js'), '--root', ROOT], {
      encoding: 'utf8',
      timeout: 15000,
    });
  } catch (e) {
    logErr(`update-snapshot failed: ${e.message}`);
  }

  // 重大改动待查验 flag（2026-09-16，I-007 机器强制）：Stop 时侦测关键文件改动 → 落 .flags/audit-due.json，
  //   由 verify 守卫 F24 强制（改了机制而没挑刺 → 收尾自检必红）。fail-open，不影响落盘主链。
  // 注：本改动属宿主适配器，已按铁律报备并经用户授权（"做啊"）。
  try {
    spawnSync(nodeExe, [join(ROOT, 'audit-due.cjs'), '--root', ROOT], {
      encoding: 'utf8',
      timeout: 10000,
    });
  } catch (e) {
    logErr(`audit-due failed: ${e.message}`);
  }

  process.stdout.write('{}');
}

try {
  main();
} catch (error) {
  logErr(`unhandled: ${error.message}`);
  process.stdout.write('{}');
}
