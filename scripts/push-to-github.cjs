#!/usr/bin/env node
// push-to-github.cjs — 一次性把双仓推到 GitHub（2026-11-18）
//
// 用法（在引擎仓根目录执行）：
//   set GH_TOKEN=github_pat_xxx
//   node tools/push-to-github.cjs --engine https://github.com/<你>/cosmic-phantom.git --data https://github.com/<你>/cp-memory.git
//   可选：--data-dir <路径>  默认 %USERPROFILE%\cp-memory
//
// 行为：
//   1. 校验两个仓本地都有 .git 和至少一次提交
//   2. 用临时凭据 URL 推送（默认不带 --force；首推空仓无需 force），**推完立刻把 remote 改回不含 token 的干净 URL**
//   3. 用 `git ls-remote` 回读确认远端真的有提交
//   4. 不创建仓（要先在 GitHub 网页建空仓，别带 README）
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = process.cwd();
const GIT = [process.env.CP_GIT, path.join(ROOT, 'tools', 'git', 'cmd', 'git.exe'), 'git'].filter(Boolean).find((p) => p === 'git' || fs.existsSync(p));
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const ENGINE = arg('--engine');
const DATA = arg('--data');
const DATA_DIR = arg('--data-dir', path.join(os.homedir(), 'cp-memory'));

const die = (m) => { console.error('❌ ' + m); process.exit(1); };
const say = (m) => console.log(m);
function git(cwd, args, quiet) {
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf8', timeout: 600000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (!quiet) say(out);
  return { ok: r.status === 0, out };
}
function withToken(url, token) {
  try { const u = new URL(url); u.username = 'x-access-token'; u.password = token; return u.toString(); } catch { return url; }
}
function cleanUrl(url) {
  try { const u = new URL(url); u.username = ''; u.password = ''; return u.toString(); } catch { return url; }
}

if (!GIT) die('找不到 git（tools/git 缺失且 PATH 无 git）');
if (!TOKEN) die('缺少 GH_TOKEN（fine-grained PAT，需 Contents: Read and write）');
if (!ENGINE || !DATA) die('用法：node tools/push-to-github.cjs --engine <url> --data <url>');

for (const [label, dir] of [['engine', ROOT], ['data', DATA_DIR]]) {
  if (!fs.existsSync(path.join(dir, '.git'))) die(`${label} 不是 git 仓：${dir}`);
  const has = git(dir, ['rev-parse', '--verify', 'HEAD'], true);
  if (!has.ok) die(`${label} 没有任何提交：${dir}`);
}

function push(label, dir, url) {
  say(`\n=== ${label} → ${cleanUrl(url)} ===`);
  const remotes = git(dir, ['remote'], true).out.split(/\s+/).filter(Boolean);
  if (remotes.includes('origin')) git(dir, ['remote', 'remove', 'origin'], true);
  git(dir, ['remote', 'add', 'origin', withToken(url, TOKEN)], true);
  const force = process.argv.includes('--force');
  const p = git(dir, ['push', '-u', 'origin', 'HEAD', ...(force ? ['--force'] : [])], false);
  // 立刻洗掉 token
  git(dir, ['remote', 'set-url', 'origin', cleanUrl(url)], true);
  if (!p.ok) die(`${label} 推送失败（见上面输出）`);
  const ls = git(dir, ['ls-remote', 'origin', 'HEAD'], true);
  if (!ls.ok || !ls.out.trim()) die(`${label} 推送后回读失败`);
  say(`✅ ${label} 已推送，远端 HEAD：${ls.out.split(/\s+/)[0]}`);
}

push('engine', ROOT, ENGINE);
push('data', DATA_DIR, DATA);
say('\n全部完成。下一步（可选）：把大件传到 Releases —— 见 GITHUB-PUSH.md 第 4 节。');