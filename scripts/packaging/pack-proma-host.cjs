#!/usr/bin/env node
/**
 * pack-proma-host.cjs — Proma 宿主层打包器（2026-10-28 立）
 *
 * 为什么单独成包：
 *   CP 继承包（pack-bundle.cjs）只覆盖用户级客户端配置；而 Proma 宿主的接线件位于 CP 根之外，
 *   其接线件全在 CP 根之外（用户配置目录下的宿主扩展、各 workspace 的 `mcp.json`、宿主安装目录中的 `resources/app.asar`），
 *   主包带不走 → 新机上装完 CP 却没有任何一条链路是通的。
 *   本包只负责**宿主接线层**，与主包独立版本化、独立校验，符合「跨宿主差异在宿主层解决，CP 引擎零改动」。
 *
 * 带走什么（四类）：
 *   ① extensions/  hook 扩展（4 个 mjs + sts-src 依赖）——CP 的门禁/巡检/清洗全靠它
 *   ② mcp/         每个已注册 cosmic-phantom 的 workspace 的 mcp.json（占位符化）
 *   ③ skills 清单  只带"该挂哪几个"，内容仍从 CP 真源 skills/ 取，避免双真源
 *   ④ app-asar/    （可选）已打补丁的 app.asar + 原始备份——补丁是唯一没有脚本化的资产
 *
 * 用法：
 *   node pack-proma-host.cjs --out <目录> [--root <CP根>] [--home <用户目录>]
 *        [--with-asar <Proma安装目录>] [--dry-run] [--allow-unregistered]
 *
 * 产出：
 *   <out>/host/extensions/**        <out>/host/mcp/<slug>.json
 *   <out>/host/skills.manifest.json <out>/host/app-asar/**（可选）
 *   <out>/HOST-PROMA-README.md      <out>/MANIFEST.json  <out>/CHECKSUMS.sha256
 */
'use strict';

const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, relative, sep, basename } = require('node:path');
const { homedir } = require('node:os');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg('--root') || join(homedir(), '.cosmic-phantom');
const HOME = arg('--home') || homedir();
const OUT = arg('--out');
const ASAR_DIR = arg('--with-asar');
const DRY = process.argv.includes('--dry-run');
const ALLOW_UNREG = process.argv.includes('--allow-unregistered');

if (!OUT) { console.log(JSON.stringify({ error: '缺少 --out <目录>' })); process.exit(1); }
const PROMA = join(HOME, '.proma');
const EXT_DIR = join(PROMA, 'sdk-config', 'extensions');

// 登记制：新增扩展必须显式登记，否则拒打（同 pack-bundle 的"清单不许靠回忆列"）
const EXT_TAKEN = new Set(['cp-autopilot.mjs', 'reply-guard.mjs', 'sts-guard.mjs', 'thinking-sanitizer.mjs', 'sts-src']);
const EXT_SKIP = { 'hook-errors.log': '运行日志，不旅行' };

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const isBak = (n) => /\.bak(-|$)/i.test(n);

// 占位符：先长后短（CP 根在 home 之内，必须先替换）
const PLACEHOLDERS = [
  { name: '<CP_ROOT>', from: [ROOT.replace(/\\/g, '/'), ROOT] },
  { name: '<USER_HOME>', from: [HOME.replace(/\\/g, '/'), HOME] },
];
function toPortable(text) {
  let out = text, hits = 0;
  for (const p of PLACEHOLDERS) {
    for (const f of p.from) {
      if (!f) continue;
      // 兼容宿主写出的双斜杠路径形态
      const segs = f.replace(/\\/g, '/').split('/').filter(Boolean);
      const re = new RegExp(segs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+'), 'g');
      const before = out; out = out.replace(re, p.name);
      if (out !== before) hits++;
    }
  }
  return { text: out, hits };
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, base));
    else out.push({ abs: p, rel: relative(base, p).split(sep).join('/') });
  }
  return out;
}

// 从 asar 头读 package.json 里的 version（只读 16 字节头 + 头部 JSON，不解析全包）
function asarVersion(asarPath) {
  try {
    const fd = require('node:fs').openSync(asarPath, 'r');
    const head = Buffer.alloc(16); require('node:fs').readSync(fd, head, 0, 16, 0);
    const jsonSize = head.readUInt32LE(12);
    const jbuf = Buffer.alloc(jsonSize); require('node:fs').readSync(fd, jbuf, 0, jsonSize, 16);
    require('node:fs').closeSync(fd);
    const header = JSON.parse(jbuf.toString('utf8'));
    const ent = header.files && header.files['package.json'];
    if (!ent) return null;
    const off = 16 + jsonSize + Number(ent.offset);
    const fd2 = require('node:fs').openSync(asarPath, 'r');
    const buf = Buffer.alloc(ent.size); require('node:fs').readSync(fd2, buf, 0, ent.size, off);
    require('node:fs').closeSync(fd2);
    return JSON.parse(buf.toString('utf8')).version || null;
  } catch { return null; }
}

function main() {
  const manifest = {
    schemaVersion: 1, kind: 'proma-host', packedAt: new Date().toISOString(),
    sourceHome: HOME, sourceRoot: ROOT, placeholders: PLACEHOLDERS.map((p) => p.name),
    host: { extensions: [], mcp: [], skills: null, asar: null },
    excluded: [], totals: { files: 0, bytes: 0 },
  };

  if (!existsSync(PROMA)) { console.log(JSON.stringify({ error: `Proma 配置根不存在: ${PROMA}` })); process.exit(1); }
  if (DRY) console.log('[pack-host] DRY-RUN：只盘点，不写盘');

  // ① extensions：登记制挡板 + 全量带走
  if (!existsSync(EXT_DIR)) { console.log(JSON.stringify({ error: `扩展目录不存在: ${EXT_DIR}` })); process.exit(1); }
  const unreg = [];
  for (const e of readdirSync(EXT_DIR, { withFileTypes: true })) {
    const n = e.name;
    if (EXT_TAKEN.has(n) || Object.prototype.hasOwnProperty.call(EXT_SKIP, n) || isBak(n)) continue;
    unreg.push(n + (e.isDirectory() ? '/' : ''));
  }
  if (unreg.length && !ALLOW_UNREG) {
    console.log(JSON.stringify({
      error: '发现未登记的扩展条目 —— 拒绝打包', unregistered: unreg,
      fix: '判定该带 → 加进 EXT_TAKEN；判定不带（备份/日志）→ 加进 EXT_SKIP 并写理由。临时放行 --allow-unregistered（会写进 MANIFEST）',
    }, null, 2));
    process.exit(1);
  }
  if (unreg.length) manifest.unregistered = unreg;
  for (const n of EXT_TAKEN) {
    const src = join(EXT_DIR, n);
    if (!existsSync(src)) { manifest.excluded.push({ item: `extensions/${n}`, reason: '源不存在' }); continue; }
    const dst = join(OUT, 'host', 'extensions', n);
    if (!DRY) cpSync(src, dst, { recursive: true, filter: (s) => !isBak(basename(s)) });
    const files = statSync(src).isDirectory() ? walkFiles(src) : [{ abs: src, rel: n }];
    manifest.host.extensions.push({ name: n, dir: statSync(src).isDirectory(), files: files.length });
    console.log(`[pack-host] extensions/${n}（${files.length} 文件）`);
  }

  // ② 各 workspace 的 mcp.json：只挑真正注册了 cosmic-phantom 的
  const wsFile = join(PROMA, 'agent-workspaces.json');
  let slugs = {};
  try {
    const reg = JSON.parse(readFileSync(wsFile, 'utf8').replace(/^\uFEFF/, ''));
    for (const w of (reg.workspaces || [])) { slugs[w.id] = w.slug || w.name || w.id; slugs[w.slug || w.name || w.id] = w.slug || w.name || w.id; }
  } catch { /* 旧版无注册表时按目录名兜底 */ }
  const wsRoot = join(PROMA, 'agent-workspaces');
  if (existsSync(wsRoot)) {
    for (const d of readdirSync(wsRoot, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      // 只打**注册表里存在**的 workspace：磁盘上残留的旧目录（如 workspace-1786420913794）不是活工作区，
      // 带上它只会在新机上多一次"按 id 找不到 → 回退活跃工作区"的重复写入。
      if (!slugs[d.name]) { manifest.excluded.push({ item: `agent-workspaces/${d.name}`, reason: '未在 agent-workspaces.json 注册（历史残留）' }); continue; }
      const mcp = join(wsRoot, d.name, 'mcp.json');
      if (!existsSync(mcp)) continue;
      const raw = readFileSync(mcp, 'utf8');
      if (!/cosmic-phantom/.test(raw)) continue;
      const { text, hits } = toPortable(raw);
      const slug = slugs[d.name] || d.name;
      const name = String(slug).replace(/[^\w.-]+/g, '_') + '.json';
      if (!DRY) { mkdirSync(join(OUT, 'host', 'mcp'), { recursive: true }); writeFileSync(join(OUT, 'host', 'mcp', name), text, 'utf8'); }
      manifest.host.mcp.push({ file: `host/mcp/${name}`, source: mcp, workspaceId: d.name, slug, placeholderHits: hits });
      console.log(`[pack-host] mcp/${name} ← ${d.name}（占位符 ${hits} 处）`);
    }
  }
  if (!manifest.host.mcp.length) console.log('[pack-host] ⚠️ 没找到任何注册了 cosmic-phantom 的 mcp.json');

  // ③ skills 清单：只记名字，内容从 CP 真源取
  const skillSrc = join(ROOT, 'skills');
  const mount = existsSync(skillSrc) ? readdirSync(skillSrc, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  manifest.host.skills = { mount, source: 'cosmic-phantom/skills', note: '内容随主包走，本包只声明挂载清单' };
  if (!DRY) writeFileSync(join(OUT, 'host', 'skills.manifest.json'), JSON.stringify(manifest.host.skills, null, 2) + '\n', 'utf8');
  console.log(`[pack-host] skills 挂载清单：${mount.length} 个（${mount.join(', ')}）`);

  // ④ asar（可选）：补丁是唯一没有脚本化的资产，必须整文件带走
  if (ASAR_DIR) {
    const res = join(ASAR_DIR, 'resources');
    const pair = [
      { name: 'app.asar', note: '已打补丁版（可直接替换）' },
      { name: 'app.asar.pre-patch-backup', note: '原始版（补丁失效时回退/重打基准）' },
      { name: 'app-update.yml', note: '更新通道声明' },
    ];
    const packed = [];
    for (const f of pair) {
      const src = join(res, f.name);
      if (!existsSync(src)) { manifest.excluded.push({ item: `app-asar/${f.name}`, reason: '源不存在' }); continue; }
      const dst = join(OUT, 'host', 'app-asar', f.name);
      if (!DRY) { mkdirSync(join(OUT, 'host', 'app-asar'), { recursive: true }); cpSync(src, dst); }
      packed.push({ name: f.name, bytes: statSync(src).size, sha256: sha256(src), note: f.note });
      console.log(`[pack-host] app-asar/${f.name}（${(statSync(src).size / 1048576).toFixed(1)} MB）`);
    }
    manifest.host.asar = { promaDir: ASAR_DIR, version: asarVersion(join(res, 'app.asar')), files: packed };
  } else {
    manifest.excluded.push({ item: 'app-asar/', reason: '未传 --with-asar（新机上 Proma 不会加载 hook 扩展）' });
    console.log('[pack-host] ⚠️ 未打包 asar：新机上 Proma 的 hook 扩展不会加载（CP 门禁/巡检全静默）');
  }

  // ⑤ 自解释说明
  if (!DRY) {
    writeFileSync(join(OUT, 'HOST-PROMA-README.md'), [
      '# Proma 宿主层接线包',
      '',
      `- 打包于：${manifest.packedAt}`,
      `- 源机：${HOME}`,
      `- 主包（CP 引擎+真源）请先用 install-bundle.cjs 落好，再装本包。`,
      '',
      '## 本包含什么',
      `- extensions/：${manifest.host.extensions.length} 项（hook 扩展，CP 门禁/巡检/清洗的执行体）`,
      `- mcp/<slug>.json：${manifest.host.mcp.length} 份（已占位符化，安装时按 workspace 落位）`,
      '- skills.manifest.json：挂载清单，内容从目标机 CP 真源复制，不在包内',
      manifest.host.asar ? `- app-asar/：Proma ${manifest.host.asar.version || '未知版本'}，含补丁版与原版（${manifest.host.asar.files.length} 文件）` : '- app-asar/：未包含（无 hook 加载能力）',
      '',
      '## 怎么装',
      '```',
      'node install-proma-host.cjs --pack "<本目录>" --home "<用户目录>" --root "<CP根>"            # 预演',
      'node install-proma-host.cjs --pack "<本目录>" --home "<用户目录>" --root "<CP根>" --apply    # 真装',
      '加 --apply-asar --proma-dir "<Proma安装目录>" 才会替换 app.asar（需先关闭宿主）',
      '```',
      '',
      '## 装完必须人工确认的两条（机器验不了）',
      '1. 新开一个 Proma 会话，发一句话 → `.flags/reply-guard.module.log` 应新增一行',
      '2. 工具列表应出现 cosmic-phantom 的记忆工具 → 调一次 recall 能返回内容',
      '',
      '## 已知边界',
      '- asar 补丁与 Proma 版本绑定：换版本必须重打补丁，不能跨版本沿用',
      '- extensions 依赖 Pi 的 hook 契约；宿主升级后先看 `.flags/*.log` 有无新行再谈功能',
      '',
    ].join('\n'), 'utf8');
  }

  // ⑥ 体积 / MANIFEST / CHECKSUMS
  if (!DRY) {
    for (const f of walkFiles(OUT)) { manifest.totals.files++; manifest.totals.bytes += statSync(f.abs).size; }
    manifest.totals.mb = +(manifest.totals.bytes / 1048576).toFixed(1);
    manifest.checksumCount = walkFiles(OUT).filter((f) => f.rel !== 'CHECKSUMS.sha256' && f.rel !== 'MANIFEST.json').length + 1;
    writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const lines = walkFiles(OUT).filter((f) => f.rel !== 'CHECKSUMS.sha256')
      .map((f) => `${sha256(f.abs)}  ${f.rel}`).sort();
    writeFileSync(join(OUT, 'CHECKSUMS.sha256'), lines.join('\n') + '\n', 'utf8');
    console.log(`[pack-host] 完整性清单：${lines.length} 文件（含 MANIFEST.json）`);
  }

  console.log(JSON.stringify({ ok: true, dryRun: DRY, out: OUT, extensions: manifest.host.extensions.length, mcp: manifest.host.mcp.length, asar: !!manifest.host.asar, totals: manifest.totals }, null, 2));
}

try { main(); } catch (e) { console.log(JSON.stringify({ error: String((e && e.stack) || e) })); process.exit(1); }
