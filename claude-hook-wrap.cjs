#!/usr/bin/env node
/**
 * claude-hook-wrap.cjs — Claude Code 宿主 hook 包装层（2026-09-15 新增）
 *
 * 背景：CP 的各 hook 脚本（compaction-inject.cjs / flush-reminder.cjs 等）输出的是
 *   ZCode 契约的裸 JSON —— {"additionalContext": "..."}。
 *   Claude Code 要求 {"hookSpecificOutput": {"hookEventName": "<事件名>", "additionalContext": "..."}}。
 *
 * 本层职责：执行 CP 原始脚本 → 取 stdout → 转成 Claude Code schema → 输出。
 *   设计取舍：**CP 脚本零改动**（跨宿主复用），宿主差异收敛在宿主层。
 *   同理：Claude Code 侧无 ZCode SQLite，脚本内 ZCode 专属分支自然跳过（fail-open）。
 *
 * 用法：node claude-hook-wrap.cjs --script <脚本名> --event <HookEventName> [--root <根>]
 *   --script 取值见 SCRIPTS 映射表。
 * 失败语义：fail-open —— 任何异常输出 {}（Claude Code 视为无操作），错误写 hook-errors.log。
 */
'use strict';

const { appendFileSync, existsSync, readFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { spawnSync } = require('node:child_process');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const ROOT = arg('--root') || join(homedir(), '.cosmic-phantom');
const EVENT = arg('--event') || '';
const NODE = process.env.CP_NODE || join(ROOT, 'tools', 'node', 'node.exe');
const LOG = join(ROOT, 'hook-errors.log');

// CP hook 脚本登记表（新增脚本在此追加）
const SCRIPTS = {
  'compaction-inject': { file: 'compaction-inject.cjs', sqlite: false, timeout: 20000 },
  'flush-reminder':    { file: 'flush-reminder.cjs',    sqlite: true,  timeout: 20000 },
  'task-card-gate':    { file: 'task-card-gate.cjs',    sqlite: false, timeout: 10000 },
};

function logErr(message) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] claude-hook-wrap: ${message}\n`, 'utf8');
  } catch {}
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function main() {
  const name = arg('--script');
  const meta = SCRIPTS[name];
  if (!meta) { logErr(`未知 --script: ${name}`); emit({}); return; }
  if (!EVENT) { logErr('缺少 --event'); emit({}); return; }

  const scriptPath = join(ROOT, meta.file);
  if (!existsSync(scriptPath)) { logErr(`脚本不存在: ${scriptPath}`); emit({}); return; }

  // 原始 hook payload 透传给目标脚本（部分脚本会读 stdin）
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch {}

  // ── H1 修复（2026-09-15）：SessionStart 改为「全匹配挂载 + 此处按 payload.source 过滤」──
  // 原因：cc-haha 是否支持 settings.json 的 matcher:"compact" 无法静态证实（app.asar 已压缩，
  //   grep 连 "SessionStart" 都 0 命中）。若宿主不认该 matcher，hook 会静默永不触发，
  //   而症状（什么都不发生）与"根本没装"完全不可区分——ZCode 的 matcher:"*" 非法正则即同类前科。
  // 对策：settings.json 去掉 matcher（全匹配，保证能触发），过滤逻辑下移到本层；
  //   同时把首次见到的 source 值记入日志，用于探明宿主真实行为（只记新值，不产生噪音）。
  const onlySource = arg('--only-source');
  if (onlySource) {
    let src;
    try { src = JSON.parse(raw || '{}').source; } catch {}
    const hit = src === onlySource;
    try {
      const seenFile = join(ROOT, '.flags', 'session-sources.txt');
      let seen = '';
      try { seen = readFileSync(seenFile, 'utf8'); } catch {}
      if (!seen.includes(String(src))) {
        logErr(`[probe] 首次见到 SessionStart source=${JSON.stringify(src)}（期望 "${onlySource}"）`);
        mkdirSync(join(ROOT, '.flags'), { recursive: true });
        appendFileSync(seenFile, String(src) + '\n', 'utf8');
      }
    } catch {}
    if (!hit) { emit({}); return; }
  }

  const nodeExe = existsSync(NODE) ? NODE : process.execPath;
  const args = [];
  if (meta.sqlite) args.push('--experimental-sqlite');
  args.push(scriptPath, '--root', ROOT);

  const r = spawnSync(nodeExe, args, {
    input: raw,
    encoding: 'utf8',
    timeout: meta.timeout,
    env: { ...process.env, CP_HOST: process.env.CP_HOST || 'claude-code' },
  });

  if (r.status !== 0) {
    logErr(`${name} 退出码 ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  }

  const stdout = (r.stdout || '').trim();
  if (!stdout) { emit({}); return; }

  let parsed = null;
  try { parsed = JSON.parse(stdout.split('\n').filter(Boolean).pop()); } catch (e) {
    logErr(`${name} 输出非 JSON: ${stdout.slice(0, 120)}`);
    emit({});
    return;
  }

  // 已是 Claude Code schema（含 hookSpecificOutput）→ 原样透出
  if (parsed && parsed.hookSpecificOutput) { emit(parsed); return; }

  // ZCode 裸契约 → Claude Code schema
  const ctx = parsed && parsed.additionalContext;
  if (typeof ctx === 'string' && ctx.trim()) {
    emit({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: ctx } });
    return;
  }

  emit({});
}

try { main(); } catch (error) { logErr(`unhandled: ${error.message}`); emit({}); }
