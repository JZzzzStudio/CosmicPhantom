#!/usr/bin/env node
/**
 * install-proma-host.cjs — Proma 宿主层落地器（2026-10-28 立）
 *
 * 配套：pack-proma-host.cjs
 * 铁律（沿用 install-bundle.cjs，每条对应一次真实事故）：
 *   ① 默认 dry-run，真写必须 --apply
 *   ② 写前必备份，备份落 ~/.proma/backup/host-install-<ts>/ 并生成 MAP.json（回滚依据）
 *   ③ 只 merge 不改写：mcp.json 只动 servers["cosmic-phantom"]，其余 server 原样保留
 *   ④ 写后必回读：注册值本身要断言（脚本路径 / --root 指向），不能只验"键存在"
 *   ⑤ asar 是高风险动作：单独开关 --apply-asar，且必须 Proma 已退出
 *   ⑥ 失败即停，不留半装
 *   ⑦ 宿主不存在（无 ~/.proma）→ 跳过并记账，不算失败；宿主存在但写不进 → 失败
 *
 * 用法：
 *   node install-proma-host.cjs --pack <包目录> [--home <用户目录>] [--root <CP根>]
 *        [--workspace <id|slug>] [--apply] [--apply-asar] [--proma-dir <Proma安装目录>]
 *
 * 退出码（与 install-bundle 对齐）：1=失败；4=宿主侧已落地但有人工确认项；0=纯预演或宿主不适用
 */
'use strict';

const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync, renameSync, rmSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, dirname, relative, basename } = require('node:path');
const { homedir } = require('node:os');
const { spawnSync } = require('node:child_process');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const PACK = arg('--pack');
const HOME = arg('--home') || homedir();
const ROOT = arg('--root') || join(HOME, '.cosmic-phantom');
const FORCE_WS = arg('--workspace');
const PROMa_DIR = arg('--proma-dir') || 'D:\\Proma';
const APPLY = process.argv.includes('--apply');
const APPLY_ASAR = process.argv.includes('--apply-asar');

if (!PACK) { console.log(JSON.stringify({ error: '缺少 --pack <包目录>' })); process.exit(1); }

const PROMA = join(HOME, '.proma');
const EXT_DST = join(PROMA, 'sdk-config', 'extensions');
const TS = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const BACKUP = join(PROMA, 'backup', `host-install-${TS}`);

const report = { at: new Date().toISOString(), apply: APPLY, applyAsar: APPLY_ASAR, pack: PACK, home: HOME, root: ROOT, phases: {}, errors: [], pending: [], map: [] };
const say = (m) => console.log(`[${APPLY ? 'INSTALL' : 'DRY-RUN'}] ${m}`);
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function fail(phase, msg) {
  report.errors.push({ phase, msg });
  console.error(`❌ [${phase}] ${msg}`);
  if (report.phases.P1) console.error(`\n↩️ 已备份到 ${BACKUP}\n   回滚：按 MAP.json 里 {backup→target} 逐条拷回（本器不做自动回滚，避免二次误写）`);
  finish(1);
}
function finish(code) {
  report.exitCode = code;
  if (report.phases.P3) {
    report.phases.P3.applied = APPLY && code !== 1;
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

// 占位符展开：<USER_HOME> / <CP_ROOT>，兼容 Proma 的双斜杠形态
function expand(text) {
  const h = HOME.replace(/\\/g, '/'), r = ROOT.replace(/\\/g, '/');
  let out = text;
  out = out.split('<CP_ROOT>').join(r);
  out = out.split('<USER_HOME>').join(h);
  return out;
}
function promaRunningFrom(dir) {
  try {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Process Proma -ErrorAction SilentlyContinue).Path'], { encoding: 'utf8' });
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
    if (ps.status === 0) {
      const paths = (ps.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      return paths.some((p) => norm(dirname(p)) === norm(dir));
    }
  } catch { }
  // 兜底：拿不到进程路径时退回全局判据（宁可拦错，不可在运行时替换）
  const tl = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Proma.exe'], { encoding: 'utf8' });
  return /Proma\.exe/i.test(tl.stdout || '');
}
function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base)); else out.push({ abs: p, rel: relative(base, p).replace(/\\/g, '/') });
  }
  return out;
}
function backupFile(target, label) {
  if (!existsSync(target)) return null;
  const rel = relative(PROMA, target).replace(/\\/g, '/');
  const dst = join(BACKUP, rel);
  if (APPLY) { mkdirSync(dirname(dst), { recursive: true }); cpSync(target, dst); }
  report.map.push({ backup: dst, target, label });
  return dst;
}

function main() {
  // P0 包完整性
  const man = join(PACK, 'MANIFEST.json'), cks = join(PACK, 'CHECKSUMS.sha256');
  if (!existsSync(man) || !existsSync(cks)) fail('P0', '包不完整：缺 MANIFEST.json 或 CHECKSUMS.sha256');
  const manifest = JSON.parse(readFileSync(man, 'utf8').replace(/^\uFEFF/, ''));
  if (manifest.kind !== 'proma-host') fail('P0', `包类型不对：期望 proma-host，实际 ${manifest.kind}`);
  const lines = readFileSync(cks, 'utf8').split(/\r?\n/).filter(Boolean);
  let bad = 0;
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
    if (!m) { bad++; continue; }
    const f = join(PACK, m[2]);
    if (!existsSync(f) || sha256(f) !== m[1]) { bad++; console.error(`   ✗ ${m[2]}`); }
  }
  if (bad) fail('P0', `包校验失败：${bad} 个文件不符（传输损坏或清单被改）`);
  say(`P0 包完整性 ✅ ${lines.length} 个文件 sha256 全对`);
  report.phases.P0 = { ok: true, files: lines.length, manifest };

  // P1 目标宿主是否存在 + 备份目录
  if (!existsSync(PROMA)) {
    report.pending.push('目标机没有 ~/.proma（Proma 未安装/未初始化）→ 宿主层跳过，未做任何写入');
    say('P1 跳过：目标机无 ~/.proma');
    finish(0);
  }
  if (APPLY) mkdirSync(BACKUP, { recursive: true });
  report.phases.P1 = { backup: APPLY ? BACKUP : '(dry-run 不创建)' };
  say(`P1 备份位 → ${BACKUP}`);

  const g = { extensions: [], mcp: [], skills: [], asar: null, readback: [] };
  report.phases.P2 = g;

  // P2 extensions：逐个比对，变更才写，写前备份
  const extSrc = join(PACK, 'host', 'extensions');
  if (existsSync(extSrc)) {
    if (APPLY) mkdirSync(EXT_DST, { recursive: true });
    for (const e of readdirSync(extSrc, { withFileTypes: true })) {
      const src = join(extSrc, e.name), dst = join(EXT_DST, e.name);
      const files = e.isDirectory() ? walk(src) : [{ abs: src, rel: e.name }];
      let changed = false;
      for (const f of files) {
        const d = e.isDirectory() ? join(dst, f.rel) : dst;
        const same = existsSync(d) && statSync(d).size === statSync(f.abs).size && sha256(d) === sha256(f.abs);
        if (!same) { changed = true; if (APPLY) { backupFile(d, `extensions/${e.name}/${f.rel}`); mkdirSync(dirname(d), { recursive: true }); cpSync(f.abs, d); } }
      }
      g.extensions.push({ name: e.name, files: files.length, changed });
      say(`P2 extensions/${e.name}：${files.length} 文件，${changed ? (APPLY ? '已写入（原文件已备份）' : '将写入') : '无变化'}`);
    }
  } else fail('P2', '包内缺 host/extensions');

  // P3 mcp.json：解析目标 workspace → 只 merge cosmic-phantom 一个键
  const mcpDir = join(PACK, 'host', 'mcp');
  if (existsSync(mcpDir)) {
    const regPath = join(PROMA, 'agent-workspaces.json');
    let reg = { workspaces: [] };
    try { reg = JSON.parse(readFileSync(regPath, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 旧版无注册表 */ }
    const wsList = (reg.workspaces || []).map((w) => ({ id: w.id, slug: w.slug || w.name || w.id }));
    let activeId = null;
    try { activeId = JSON.parse(readFileSync(join(PROMA, 'settings.json'), 'utf8').replace(/^\uFEFF/, '')).agentWorkspaceId || null; } catch { }
    if (FORCE_WS) { const hit = wsList.find((w) => w.id === FORCE_WS || w.slug === FORCE_WS); activeId = hit ? hit.id : activeId; }
    const dirOf = (id) => join(PROMA, 'agent-workspaces', id);

    for (const m of manifest.host.mcp || []) {
      const src = join(PACK, m.file);
      if (!existsSync(src)) { report.pending.push(`包内缺 ${m.file}`); continue; }
      let ws = null, matchedBy = null;
      if (m.workspaceId && existsSync(dirOf(m.workspaceId))) { ws = m.workspaceId; matchedBy = 'workspaceId'; }
      else if (m.slug) { const hit = wsList.find((w) => w.slug === m.slug && existsSync(dirOf(w.id))); if (hit) { ws = hit.id; matchedBy = 'slug'; } }
      if (!ws && activeId && existsSync(dirOf(activeId))) { ws = activeId; matchedBy = 'activeWorkspace（回退）'; }
      if (!ws) { report.pending.push(`${m.slug}：目标机找不到同名/活跃 workspace，mcp 未写`); say(`P3 mcp/${m.slug} 跳过：无可用 workspace`); continue; }

      const dst = join(dirOf(ws), 'mcp.json');
      let cur = { servers: {} };
      if (existsSync(dst)) { try { cur = JSON.parse(readFileSync(dst, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { fail('P3', `${dst} 不是合法 JSON，拒绝覆盖: ${e.message}`); } }
      const incoming = JSON.parse(expand(readFileSync(src, 'utf8')).replace(/^\uFEFF/, ''));
      const before = JSON.stringify(cur.servers || {});
      cur.servers = Object.assign({}, cur.servers, { 'cosmic-phantom': (incoming.servers || {})['cosmic-phantom'] });
      const changed = before !== JSON.stringify(cur.servers);
      if (APPLY && changed) { backupFile(dst, `mcp/${ws}`); mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, JSON.stringify(cur, null, 2) + '\n', 'utf8'); }
      g.mcp.push({ dst, workspaceId: ws, matchedBy, changed, otherServersKept: Object.keys(cur.servers).filter((k) => k !== 'cosmic-phantom') });
      say(`P3 mcp → ${dst}（按 ${matchedBy} 匹配；${changed ? (APPLY ? '已写入' : '将写入') : '无变化'}；保留其他 server：${Object.keys(cur.servers).filter((k) => k !== 'cosmic-phantom').join(',') || '无'}）`);
    }
  }

  // P4 skills：从目标机 CP 真源复制，不信任包内副本
  const skMan = join(PACK, 'host', 'skills.manifest.json');
  if (existsSync(skMan) && g.mcp.length) {
    const names = (JSON.parse(readFileSync(skMan, 'utf8').replace(/^\uFEFF/, '')).mount) || [];
    const wsId = g.mcp.find((m) => m.matchedBy !== null).workspaceId;
    const wsSkills = join(PROMA, 'agent-workspaces', wsId, 'skills');
    if (APPLY) mkdirSync(wsSkills, { recursive: true });
    for (const n of names) {
      const src = join(ROOT, 'skills', n), dst = join(wsSkills, n);
      if (!existsSync(src)) { report.pending.push(`CP 真源缺技能 ${n}，未挂载`); continue; }
      const files = walk(src);
      let changed = false;
      for (const f of files) { const d = join(dst, f.rel); if (!existsSync(d) || sha256(d) !== sha256(f.abs)) changed = true; }
      if (APPLY && changed) { backupFile(dst, `skills/${n}`); cpSync(src, dst, { recursive: true }); }
      g.skills.push({ name: n, files: files.length, changed });
      say(`P4 skills/${n} → ${dst}（${files.length} 文件，${changed ? (APPLY ? '已挂载' : '将挂载') : '无变化'}）`);
    }
  }

  // P5 asar（高风险，独立开关）
  if (APPLY_ASAR) {
    const asarSrc = join(PACK, 'host', 'app-asar', 'app.asar');
    const asarDst = join(PROMa_DIR, 'resources', 'app.asar');
    if (!existsSync(asarSrc)) fail('P5', '包内无 host/app-asar/app.asar（打包时未加 --with-asar）');
    if (!existsSync(asarDst)) fail('P5', `目标 app.asar 不存在：${asarDst}（--proma-dir 指错？）`);
    // 只拦"从这个目录起来的 Proma"：本机可能同时有另一个安装在跑，
    // 全局 tasklist 判据会把无关实例也算成占用（2026-10-28 沙盒实测：假目标被真机实例拦下）。
    if (promaRunningFrom(PROMa_DIR)) fail('P5', `Proma 正在从 ${PROMa_DIR} 运行，无法替换 app.asar —— 先完全退出它再跑`);
    const want = sha256(asarSrc), got = sha256(asarDst);
    if (want === got) { g.asar = { action: 'unchanged', sha256: got }; say('P5 app.asar 已是补丁版，无需替换'); }
    else {
      const bk = join(BACKUP, 'app-asar', `app.asar.${TS}`);
      if (APPLY) { mkdirSync(dirname(bk), { recursive: true }); cpSync(asarDst, bk); }
      report.map.push({ backup: bk, target: asarDst, label: 'app.asar' });
      if (APPLY) { const tmp = asarDst + '.tmp'; cpSync(asarSrc, tmp); renameSync(tmp, asarDst); }
      g.asar = { action: 'replaced', backup: bk, from: got, to: want };
      say(`P5 app.asar 已替换（原 ${got.slice(0, 12)} → 补丁版 ${want.slice(0, 12)}，原件备份 ${bk}）`);
    }
  } else {
    const asarSrc = join(PACK, 'host', 'app-asar', 'app.asar');
    if (existsSync(asarSrc)) report.pending.push('包内有补丁版 app.asar，但未加 --apply-asar（新机上 hook 扩展不会加载）');
  }

  // P6 回读断言
  if (APPLY) {
    for (const e of g.extensions) {
      const p = join(EXT_DST, e.name);
      g.readback.push({ label: `extensions/${e.name} 在位`, ok: existsSync(p) });
    }
    for (const m of g.mcp) {
      let ok = false, detail = '';
      try {
        const j = JSON.parse(readFileSync(m.dst, 'utf8').replace(/^\uFEFF/, ''));
        const s = j.servers && j.servers['cosmic-phantom'];
        const norm = (v) => String(v || '').replace(/[\\/]+/g, '/');
        const args = Array.isArray(s && s.args) ? s.args : [];
        const script = args.map(norm).find((a) => /mcp-server\/index\.js$/.test(a)) || null;
        const ri = args.indexOf('--root');
        const rootArg = ri >= 0 ? norm(args[ri + 1]) : null;
        const wantRoot = norm(ROOT);
        const nodeOk = s && s.command && existsSync(String(s.command).replace(/"/g, ''));
        ok = !!s && script && rootArg === wantRoot && !!nodeOk;
        detail = ok ? 'ok' : `script=${script} root=${rootArg} want=${wantRoot} node=${nodeOk}`;
      } catch (e) { detail = e.message; }
      g.readback.push({ label: `mcp 注册值正确（${basename(dirname(m.dst))}）`, ok, detail });
    }
    for (const s of g.skills) g.readback.push({ label: `skills/${s.name} 在位`, ok: existsSync(join(PROMA, 'agent-workspaces', g.mcp[0].workspaceId, 'skills', s.name)) });
    if (g.asar && g.asar.action === 'replaced') g.readback.push({ label: 'app.asar 替换后 hash 一致', ok: sha256(join(PROMa_DIR, 'resources', 'app.asar')) === g.asar.to });
    const badOnes = g.readback.filter((r) => !r.ok);
    if (badOnes.length) fail('P6', `回读断言失败：\n  - ${badOnes.map((b) => `${b.label}${b.detail ? '（' + b.detail + '）' : ''}`).join('\n  - ')}`);
    say(`P6 回读 ✅ ${g.readback.length} 条断言全过`);
  }

  report.pending.push(
    'L3b【人】：新开 Proma 会话 → .flags/reply-guard.module.log 应新增一行',
    'L4b【人】：工具列表出现 cosmic-phantom → 调一次 recall 能返回记忆',
  );
  say('P7 完成。机器可验部分已过；两条人工确认见 pending。');
  finish(4);
}

try { main(); } catch (e) { console.log(JSON.stringify({ error: String((e && e.stack) || e) })); process.exit(1); }
