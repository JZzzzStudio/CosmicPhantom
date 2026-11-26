#!/usr/bin/env node
/**
 * mcp-smoke.cjs — MCP 通道冒烟探针（2026-09-16 立）
 *
 * 用途：把「L3【我能读】」里**可由机器验证的那一半**验掉。
 *
 * 为什么需要它（2026-09-16 修正）：原先把 L3 整体判为"必须靠真机会话，验不了"——**不准确**。
 *   L3 应拆两半：
 *     (a) **MCP server 在指定 root 上能否应答工具调用** ← 本探针实测，与宿主做的事完全一样
 *         （MCP = 标准 stdio JSON-RPC：initialize → tools/list → tools/call）
 *     (b) 宿主能否连上它 ← 真宿主行为，探针验不了（只能靠"源机同构配置 + A-002 已证宿主读该配置"推）
 *   同理 L4 拆两半：(a) hook 脚本能否真落盘 ← 可验（喂真 payload）；(b) 宿主会否触发 ← 源机已有实证。
 *
 * 用法: node mcp-smoke.cjs [--root <CP根>] [--node <node可执行>] [--query <词>] [--timeout 25000]
 * 输出: { ok, protocolVersion, toolCount, hasRecall, callOk, resultPreview, stderr }
 * 退出码: 0 = (a) 通过 ｜ 1 = 失败
 */
'use strict';

const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { existsSync } = require('node:fs');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg('--root') || join(homedir(), '.cosmic-phantom');
const CONFIG = arg('--config') || join(homedir(), '.claude.json');
const QUERY = arg('--query') || '继承包';
const TIMEOUT = Number(arg('--timeout') || 25000);

// ── 2026-09-16 审计 F1 修复：**读注册值，并按注册值 spawn** ──
//   原实现硬编码 `spawn(NODE, [join(ROOT,'resources','mcp-server/index.js'), '--root', ROOT])` ——
//   它验的是"我能按自己想象的形态跑起来"，不是"写进配置的那份值能跑"。后果：一份 args 写错的
//   注册能同时通过 P3 回读 + L3a + L4a 的全部 ✅（与 G1「格式正确≠指向的东西在」同族）。
//   现在：默认从 --config 读 mcpServers["cosmic-phantom"] 的 command/args，逐字按它 spawn；
//   读不到才退化为硬编码形态，并在输出里**显式标注 source=fallback**（不掩盖降级）。
const out = { ok: false, root: ROOT, config: CONFIG };
// 状态声明必须**早于任何 finish() 调用**（TDZ：`let` 在声明前访问会抛 ReferenceError，
//   而失败路径恰好可能先于声明执行 —— 2026-09-16 负例测试实测抓到，正例永远发现不了）
let done = false;
let NODE, ARGS, SERVER = null;
try {
  const cfg = JSON.parse(require('node:fs').readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  const s = cfg && cfg.mcpServers && cfg.mcpServers['cosmic-phantom'];
  if (s && s.command && Array.isArray(s.args) && s.args.length) {
    NODE = s.command; ARGS = s.args; out.source = `config:${CONFIG}`;
  }
} catch { /* 配置缺失/不可解析 → 走 fallback */ }
if (!ARGS) {
  NODE = arg('--node') || process.execPath;
  SERVER = join(ROOT, 'resources', 'mcp-server', 'index.js');
  ARGS = [SERVER, '--root', ROOT];
  out.source = 'fallback（硬编码形态 —— **未验注册值**，结论不可用于"配置生效"判定）';
}
out.registered = { command: NODE, args: ARGS };

// 引用可解析：按注册值 spawn 之前，先确认 command 与 args 里的盘符路径在磁盘上存在
const refPaths = [NODE, ...ARGS].filter((a) => typeof a === 'string' && /^[A-Za-z]:[\\/]/.test(a));
const missingRefs = refPaths.filter((p) => !existsSync(p));
if (missingRefs.length) {
  out.error = `注册值指向的文件不存在（引用不可解析）: ${missingRefs.join(' ; ')}`;
  out.missingRefs = missingRefs;
  finish(1);
}

const send = (proc, obj) => proc.stdin.write(JSON.stringify(obj) + '\n');

let buf = '';
const seen = { init: null, tools: null, call: null };

function finish(code) {
  if (done) return;
  done = true;
  try { proc && proc.kill(); } catch {}
  out.ok = code === 0;
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(code);
}

let proc;
try {
  proc = spawn(NODE, ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });   // ← 逐字用注册值
} catch (e) {
  out.error = `spawn 失败: ${e.message}`;
  finish(1);
}

const timer = setTimeout(() => { out.error = `超时 ${TIMEOUT}ms（已收: init=${!!seen.init} tools=${!!seen.tools} call=${!!seen.call}）`; finish(1); }, TIMEOUT);

proc.stderr.on('data', (d) => { out.stderr = (out.stderr || '') + String(d).slice(0, 400); });

proc.stdout.on('data', (chunk) => {
  buf += String(chunk);
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1) {
      seen.init = msg.result || msg.error;
      out.protocolVersion = msg.result && msg.result.protocolVersion;
      out.serverInfo = msg.result && msg.result.serverInfo;
      send(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });
      send(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    } else if (msg.id === 2) {
      seen.tools = msg.result || msg.error;
      const names = ((msg.result && msg.result.tools) || []).map((t) => t.name);
      out.toolCount = names.length;
      out.hasRecall = names.includes('recall_memory');
      if (!out.hasRecall) { out.error = `工具表里没有 recall_memory（拿到 ${names.slice(0, 5).join(',')}…）`; clearTimeout(timer); finish(1); }
      send(proc, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall_memory', arguments: { query: QUERY, top: 2 } } });
    } else if (msg.id === 3) {
      seen.call = msg.result || msg.error;
      const content = (msg.result && msg.result.content) || [];
      const text = content.map((c) => c.text || '').join(' ').trim();
      const isErr = !!(msg.result && msg.result.isError) || !!msg.error;
      out.callOk = !isErr && text.length > 0;
      out.resultPreview = text.slice(0, 300);
      if (isErr) out.error = text.slice(0, 300) || JSON.stringify(msg.error);
      clearTimeout(timer);
      finish(out.callOk ? 0 : 1);
    }
  }
});

proc.on('error', (e) => { out.error = `进程错误: ${e.message}`; clearTimeout(timer); finish(1); });
proc.on('exit', (code) => { if (!done) { out.error = `server 提前退出 code=${code}`; clearTimeout(timer); finish(1); } });

send(proc, {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cp-mcp-smoke', version: '1.0' } },
});
