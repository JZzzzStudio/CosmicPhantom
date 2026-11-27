#!/usr/bin/env node
// ci.cjs — 本地 CI（票 08）：一条命令跑「脱敏体检 → 自检 → 全量测试」。
// 为什么不用 GitHub Actions：推送 .github/workflows/* 需要带 workflow scope 的凭据；
//   本脚本让任何机器都能复跑同一套闸，不依赖 CI 服务。GitHub Actions 版本见 docs/ci.yml。
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = process.cwd();
const steps = [];

function run(name, args, opts = {}) {
  const t = Date.now();
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: opts.timeout || 1800000, cwd: ROOT });
  const ok = opts.optional ? true : r.status === 0;
  steps.push({ name, ok, ms: Date.now() - t, optional: !!opts.optional, code: r.status });
  const out = (r.stdout || '').trim().split('\n').slice(-3).join(' | ');
  console.log(`${ok ? '✅' : '❌'} ${name} (${Date.now() - t}ms)${out ? ' — ' + out.slice(0, 160) : ''}`);
  if (!ok) process.exitCode = 1;
  return { ok, r };
}

run('sanitize（无个人路径/密钥）', ['scripts/check-sanitize.cjs']);
run('public surface（公开入口无私有接线）', ['scripts/check-public-surface.cjs']);
run('engine consistency（根↔plugin 同步 + 无宿主品牌文件）', ['scripts/check-engine-consistency.cjs']);

// 自检：有数据仓/事件库才跑 verify，纯代码仓跳过（不算失败）
if (existsSync(join(ROOT, 'events.db'))) {
  run('verify（实例自检）', ['--experimental-sqlite', 'memory-cli.js', 'verify'], { optional: false });
} else {
  console.log('⏭️ verify 跳过（当前是纯代码仓，没有 events.db）');
}

// Windows 下用 shell 调 npm（npm.cmd），避免 npm-cli.js 路径因安装方式不同而找不到
const npmRun = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: 2400000, cwd: ROOT, shell: true });
steps.push({ name: 'npm test（全量测试）', ok: npmRun.status === 0, ms: 0, optional: false, code: npmRun.status });
console.log((npmRun.status === 0 ? '✅' : '❌') + ' npm test（全量测试）');
if (npmRun.status !== 0) process.exitCode = 1;

const failed = steps.filter((s) => !s.ok);
console.log('\n' + JSON.stringify({ ok: failed.length === 0, steps }, null, 1));
process.exit(failed.length === 0 ? 0 : 1);
