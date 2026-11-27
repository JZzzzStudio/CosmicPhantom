#!/usr/bin/env node
// bootstrap.cjs — 按 binaries.manifest.json 拉取大件资产（2026-11-18）
// 用法：
//   node bootstrap.cjs                 只装 required 且缺失的
//   node bootstrap.cjs --all           连可选的一起装（模型 / asar 补丁）
//   node bootstrap.cjs --only node-runtime,git-portable
//   node bootstrap.cjs --force         已存在也重下
// 设计：不引第三方依赖；下载用 https 跟随 301/302；解压用系统 tar.exe（Win10 1803+ 自带，可解 zip）；
//       校验顺序 sha256（清单里有就必须对）→ 落地文件存在性/最小字节数 → 可执行文件跑版本命令。
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = __dirname;
const MANIFEST = path.join(ROOT, 'binaries.manifest.json');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

function say(m) { console.log(m); }
function fail(m) { console.error('❌ ' + m); process.exit(1); }

function download(url, out, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('重定向过多'));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'cosmic-phantom-bootstrap' }, timeout: 300000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return resolve(download(res.headers.location, out, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0, last = 0;
      const f = fs.createWriteStream(out);
      res.on('data', (c) => {
        got += c.length;
        if (total && got - last > total * 0.1) { last = got; process.stdout.write(`    ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB\n`); }
      });
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve(out)));
      f.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('下载超时')); });
    req.on('error', reject);
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function extractZip(zip, dest, stripTop) {
  const tmp = dest + '.tmp-extract';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const r = spawnSync('tar.exe', ['-xf', zip, '-C', tmp], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('tar 解压失败: ' + (r.stderr || r.stdout || ''));
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(tmp);
  const base = stripTop && entries.includes(stripTop) ? path.join(tmp, stripTop) : tmp;
  for (const e of fs.readdirSync(base)) fs.cpSync(path.join(base, e), path.join(dest, e), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

function verify(a) {
  const v = a.verify;
  if (!v) return true;
  const p = path.join(ROOT, a.dest, v.file);
  if (!fs.existsSync(p)) return `缺少 ${v.file}`;
  if (v.minBytes) {
    const sz = fs.statSync(p).size;
    if (sz < v.minBytes) return `${v.file} 仅 ${sz} 字节（< ${v.minBytes}）`;
  }
  if (v.args) {
    const r = spawnSync(p, v.args, { encoding: 'utf8', timeout: 60000 });
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    if (r.status !== 0) return `${v.file} 执行失败: ${out}`;
    if (v.expect && !out.includes(v.expect)) return `${v.file} 版本不符：期望含 ${v.expect}，实际 ${out}`;
  }
  return true;
}

async function main() {
  if (!fs.existsSync(MANIFEST)) fail('缺少 binaries.manifest.json');
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
  const only = val('--only') ? val('--only').split(',').map((s) => s.trim()) : null;
  const list = (m.assets || []).filter((a) => {
    if (only) return only.includes(a.name);
    return has('--all') ? true : a.required === true;
  });
  if (!list.length) { say('没有要处理的内置资产'); return; }
  const skipped = [];

  for (const a of list) {
    say(`\n=== ${a.name} ===`);
    const dest = path.join(ROOT, a.dest);
    const okNow = verify(a);
    if (okNow === true && !has('--force')) { say(`✓ 已就绪（${a.dest}）`); continue; }
    if (okNow !== true) say(`  需安装：${okNow}`);
    if (String(a.url).includes('<OWNER>')) {
      say(`⚠️ 未安装：清单里 url 还是占位符（<OWNER>）—— 这个资产不会被拉取`);
      skipped.push(a.name + '（url 占位符）');
      continue;
    }

    const tmp = path.join(ROOT, `.dl-${a.name}.bin`);
    say(`  下载 ${a.url}`);
    await download(a.url, tmp);
    if (a.sha256 && !String(a.sha256).includes('<')) {
      const h = await sha256(tmp);
      if (h !== a.sha256) { fs.rmSync(tmp, { force: true }); fail(`sha256 不符：期望 ${a.sha256} 实际 ${h}`); }
      say('  sha256 ✓');
    } else { say('  ⚠️ sha256 未强制：清单里没有有效 sha256，下载内容未被校验'); skipped.push(a.name + '（未校验）'); }
    if (a.kind === 'zip') { say('  解压 → ' + a.dest); extractZip(tmp, dest, a.stripTop); }
    else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(tmp, dest); }
    fs.rmSync(tmp, { force: true });

    const v = verify(a);
    if (v !== true) fail(`安装后校验失败：${v}`);
    say(`✓ 完成（${a.dest}）`);
  }
  say('\n全部处理完毕。');
  if (skipped.length) { say('\n⚠️ 未完成/未校验项：'); for (const x of skipped) say('  - ' + x); say('  → hybrid 检索与宿主 hook 可能因此静默降级，见 docs/AGENT-CONFIG.md §2.2'); }
}

main().catch((e) => fail(String(e && e.message || e)));