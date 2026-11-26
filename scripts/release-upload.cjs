#!/usr/bin/env node
// release-upload.cjs — 用 PAT 建 Release 并上传资产（A 路线，2026-11-18）
// 网络前提：本机 DNS 对 api/uploads.github.com 返回错误 IP → 统一用 --resolve 指到真实 IP。
// 用法：
//   set GH_TOKEN=github_pat_xxx && node scripts/release-upload.cjs --tag v3.0.0 --dry-run
//   ... --tag v3.0.0 --files "<path1>,<path2>"       真正上传
const { spawnSync } = require('node:child_process');
const { readFileSync, existsSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { basename, join } = require('node:path');
const ROOT = join(__dirname, '..');
const REPO = 'JZzzzzStudio/cosmic-phantom'.replace('JZzzzz', 'JZzzz');
const API_IP = process.env.CP_API_IP || '140.82.112.6';
const UPLOAD_IP = process.env.CP_UPLOAD_IP || '140.82.112.6';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry-run');
const TAG = arg('--tag', 'v3.0.0');
const FILES = (arg('--files', '') || '').split(',').map(s => s.trim()).filter(Boolean);

function api(method, path, { body, upload = false, file } = {}) {
  const host = upload ? 'uploads.github.com' : 'api.github.com';
  const ip = upload ? UPLOAD_IP : API_IP;
  const url = `https://${host}${path}`;
  const args = ['-sS', '--max-time', '1800', '--resolve', `${host}:443:${ip}`, '-X', method, url,
    '-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (body) { args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body)); }
  if (file) { args.push('-H', 'Content-Type: application/octet-stream', '--data-binary', `@${file}`); }
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let json = null; try { json = JSON.parse(r.stdout || 'null'); } catch {}
  return { ok: r.status === 0 && !!json && !json.message, status: r.status, json, raw: (r.stdout || '').slice(0, 400), err: (r.stderr || '').slice(0, 200) };
}
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

if (!TOKEN && !DRY) { console.log(JSON.stringify({ ok: false, error: '缺 GH_TOKEN（只从环境变量读，不落盘）' })); process.exit(1); }
if (!FILES.length) { console.log(JSON.stringify({ ok: false, error: '缺 --files' })); process.exit(1); }
const assets = FILES.map(f => ({ file: f, name: basename(f), bytes: existsSync(f) ? readFileSync(f).length : null, sha256: existsSync(f) ? sha256(f) : null }));
if (DRY) { console.log(JSON.stringify({ ok: true, dryRun: true, tag: TAG, assets, apiIp: API_IP }, null, 2)); process.exit(0); }

const rel = api('GET', `/repos/${REPO}/releases/tags/${TAG}`);
let release = rel.ok ? rel.json : null;
if (!release) {
  const created = api('POST', `/repos/${REPO}/releases`, { body: { tag_name: TAG, name: TAG, draft: false, prerelease: false, generate_release_notes: true } });
  if (!created.ok) { console.log(JSON.stringify({ ok: false, step: 'create-release', detail: created }, null, 2)); process.exit(1); }
  release = created.json;
}
const uploaded = [];
for (const a of assets) {
  const r = api('POST', `/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(a.name)}`, { upload: true, file: a.file });
  uploaded.push({ name: a.name, ok: r.ok, bytes: a.bytes, sha256: a.sha256, id: r.json && r.json.id, detail: r.ok ? undefined : r.raw });
}
console.log(JSON.stringify({ ok: uploaded.every(u => u.ok), release: { id: release.id, html_url: release.html_url }, uploaded }, null, 2));
