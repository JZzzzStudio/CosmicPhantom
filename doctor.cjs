// doctor.cjs — T02 双仓体检与数据目录归一（2026-11-18）
// 用途：一条离线命令回答「两仓是否对齐、身份配了没、数据目录是不是两份副本」；并支持把
//      ROOT 的数据目录做成指向数据仓的 junction（不动数据本体，rmdir 即可回退）。
// 纪律：不做破坏性动作；--apply 前先判「两边内容一致」才替换，冲突一律拒绝并报出。

const { createHash } = require("node:crypto");
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const DATA_ITEMS = ['memories', 'daily', 'distilled', 'pro', '.context', 'work', 'views',
  'AGENTS.md', 'MEMORY.md', 'current-state.json', 'state-timestamps.json', 'resume-manifest.json',
  'hosts.json', 'change-log.jsonl', 'change-baseline.json', 'coverage-history.json',
  'event-index.json', 'links.json', '.proma-cursor.json', 'processed.json'];

function git(gitBin, cwd, args) {
  const r = spawnSync(gitBin || 'git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15000 });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function repoState(gitBin, dir) {
  if (!dir || !existsSync(join(dir, '.git'))) return { dir, present: false, ok: null };
  const br = git(gitBin, dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(gitBin, dir, ['rev-parse', '--short', 'HEAD']);
  const up = git(gitBin, dir, ['rev-parse', '--short', 'origin/' + (br.out || 'master')]);
  const dirty = git(gitBin, dir, ['status', '--porcelain']);
  const n = dirty.out ? dirty.out.split(String.fromCharCode(10)).filter(Boolean).length : 0;
  return {
    dir, present: true,
    head: head.out, upstream: up.ok ? up.out : null, dirty: n,
    ok: dirty.ok && n === 0 && up.ok && head.out === up.out,
  };
}

function isJunction(p) {
  try {
    const r = spawnSync('cmd', ['/c', 'dir', '/a:l', p], { encoding: 'utf8' });
    return /JUNCTION|SYMLINK/i.test(r.stdout || '');
  } catch { return false; }
}

function manifestOf(base) {
  const out = [];
  const rec = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) rec(join(d, e.name), r);
      else out.push(r + ':' + createHash("sha256").update(readFileSync(join(d, e.name))).digest("hex").slice(0, 12));
    }
  };
  rec(base, '');
  return out.sort().join('|');
}

function sameContent(a, b) {
  try { return manifestOf(a) === manifestOf(b); } catch { return false; }
}

function doctor({ root, dataDir, gitBin }) {
  const engine = repoState(gitBin, root);
  const data = repoState(gitBin, dataDir);
  const name = git(gitBin, root, ['config', 'user.name']).out;
  const email = git(gitBin, root, ['config', 'user.email']).out;
  const links = [], diverged = [], missing = [];
  for (const it of DATA_ITEMS) {
    const a = join(root, it), b = join(dataDir, it);
    if (!existsSync(b)) { missing.push(it); continue; }
    if (isJunction(a)) links.push(it);
    else if (existsSync(a) && !sameContent(a, b)) diverged.push(it);
  }
  const ok = engine.ok !== false && data.ok !== false && !!name && !!email && diverged.length === 0;
  return {
    ok, engine, data, identity: { name: name || null, email: email || null },
    linked: links.length, diverged, missingInData: missing,
    hint: diverged.length
      ? '两份目录内容不一致：先确认以哪边为准（doctor link 会拒绝自动替换冲突项）'
      : (links.length >= DATA_ITEMS.length - missing.length ? '数据目录已归一为链接' : undefined),
  };
}

function link({ root, dataDir, apply }) {
  const plan = [];
  for (const it of DATA_ITEMS) {
    const a = join(root, it), b = join(dataDir, it);
    if (!existsSync(b)) { plan.push({ item: it, action: 'skip', reason: '数据仓无此项' }); continue; }
    if (isJunction(a)) { plan.push({ item: it, action: 'already', reason: '已是链接' }); continue; }
    if (existsSync(a)) {
      if (!sameContent(a, b)) { plan.push({ item: it, action: 'conflict', reason: '两边内容不一致，拒绝自动改' }); continue; }
      plan.push({ item: it, action: apply ? 'replace' : 'would-replace', reason: '内容一致，可替换为链接' });
    } else {
      plan.push({ item: it, action: apply ? 'create' : 'would-create', reason: '本地缺失，直接建链接' });
    }
  }
  if (apply) {
    for (const p of plan) {
      if (p.action !== 'replace' && p.action !== 'create') continue;
      const a = join(root, p.item), b = join(dataDir, p.item);
      try {
        if (p.action === 'replace') {
          const bak = a + '.pre-link-' + Date.now();
          spawnSync('cmd', ['/c', 'move', a, bak], { encoding: 'utf8' });
          const r = spawnSync('cmd', ['/c', 'mklink', '/J', a, b], { encoding: 'utf8' });
          if (r.status !== 0) { spawnSync('cmd', ['/c', 'move', bak, a]); p.action = 'failed'; p.reason = (r.stderr || r.stdout || 'mklink 失败').slice(0, 120); }
          else p.backup = bak;
        } else {
          const r = spawnSync('cmd', ['/c', 'mklink', '/J', a, b], { encoding: 'utf8' });
          if (r.status !== 0) { p.action = 'failed'; p.reason = (r.stderr || r.stdout || 'mklink 失败').slice(0, 120); }
        }
      } catch (e) { p.action = 'failed'; p.reason = String(e.message || e).slice(0, 120); }
    }
  }
  return { apply, plan, hint: apply ? '回退：对每个链接执行 rmdir <路径>（不要 del /s）' : '演练模式；加 --apply 才动手' };
}

module.exports = { doctor, link, DATA_ITEMS, repoState, isJunction, sameContent };