#!/usr/bin/env node
/**
 * cp-exec.cjs — 「用代码算，别把 raw 灌进上下文」的执行器（2026-09-19 立）
 *
 * 动机（来源：context-mode 评估 pro/context-mode-eval-20260919.md 收获②）：
 *   CP 的注入预算只管"注入什么"，**完全不管工具输出往上下文里灌了多少**。
 *   实证：本会话反复把 raw 输出整段进上下文（读全文件、打印长列表、grep 大结果）。
 *   正解不是"少看"，是**换手段**：让脚本去消费 raw 数据，只把结论带回上下文。
 *
 * 用法：
 *   node cp-exec.cjs --code "<js>"            内联代码（stdout 即结论）
 *   node cp-exec.cjs --file <脚本路径>         跑一个脚本文件
 *   [--cap 4096]                              结论字节上限（默认 4096；超出则截断并显式标注）
 *   [--timeout 30000]                         超时（默认 30s）
 *
 * 契约（这就是"纪律"的机器化部分）：
 *   ① **只回结论**：脚本 stdout 是唯一回传内容；raw 数据应在脚本内被聚合/过滤掉
 *   ② **输出自限**：超过 --cap 即截断 + 显式标注（防止"结论"本身又变成一大坨）
 *   ③ **零依赖**：用 CP 自带便携 node；不引入任何外部包
 *   ④ 提供了 `ctx` 小抄：工作目录 = CP 根；可直接 require CP 的模块（memory-retrieval 等）
 *
 * 失败语义：脚本报错 → 把错误信息（截断后）返回，退出码非 0；不影响宿主。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { homedir, tmpdir } = require('node:os');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = process.env.CP_ROOT || join(homedir(), '.cosmic-phantom');
const NODE = process.env.CP_NODE || process.execPath;
const CODE = arg('--code');
const FILE = arg('--file');
const CAP = Number(arg('--cap') || 4096);
const TIMEOUT = Number(arg('--timeout') || 30000);

if (!CODE && !FILE) {
  console.log(JSON.stringify({ error: '用法: cp-exec.cjs --code "<js>" 或 --file <脚本路径> [--cap 4096]', note: '脚本 stdout = 回传结论；raw 数据应在脚本内消费掉' }));
  process.exit(1);
}
if (FILE && !existsSync(FILE)) { console.log(JSON.stringify({ error: `脚本不存在: ${FILE}` })); process.exit(1); }

// 运行环境：把 CP 根与常用模块路径暴露给脚本（小抄注在脚本头部注释里）
let scriptPath = FILE;
let tmpDir = null;
if (CODE) {
  tmpDir = mkdtempSync(join(tmpdir(), 'cp-exec-'));
  scriptPath = join(tmpDir, 'snippet.cjs');
  writeFileSync(scriptPath, CODE, 'utf8');
}

const r = spawnSync(NODE, ['--experimental-sqlite', scriptPath, '--root', ROOT], {
  encoding: 'utf8',
  timeout: TIMEOUT,
  env: { ...process.env, CP_ROOT: ROOT, CP_NODE: NODE },
});

if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }

const out = r.stdout || '';
const err = r.stderr || '';
const bytes = Buffer.byteLength(out);
const truncated = bytes > CAP;
const body = truncated
  ? out.slice(0, CAP) + `\n…[cp-exec] 输出被截断：共 ${bytes} 字节，上限 ${CAP}。把聚合再往前推一步（只 print 结论），别抬 --cap。`
  : out;

if (r.status === 0) {
  process.stdout.write(body);
  if (truncated) process.stderr.write(`[cp-exec] 截断 ${bytes}→${CAP} 字节\n`);
} else {
  process.stdout.write(body);
  process.stderr.write(`[cp-exec] 退出码 ${r.status}${r.error ? ' ' + r.error.message : ''}\n` + err.slice(0, 1000) + '\n');
  process.exit(r.status || 1);
}
