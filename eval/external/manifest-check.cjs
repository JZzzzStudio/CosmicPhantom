#!/usr/bin/env node
// Verify external evaluation datasets against eval/external/manifest.json.
// Missing files are reported explicitly; a null sha256 is not treated as verified.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : path.join(__dirname, '..', '..'));
const manifestPath = path.join(root, 'eval', 'external', 'manifest.json');

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: `manifest 读取失败: ${error.message}` }, null, 2));
  process.exit(1);
}

const datasets = Array.isArray(manifest.datasets) ? manifest.datasets : [];
const checks = datasets.map((dataset) => {
  const file = path.join(root, dataset.path);
  const exists = fs.existsSync(file);
  if (!exists) return { name: dataset.name, path: dataset.path, status: 'missing', ok: false, requiredForReproducibility: Boolean(dataset.sha256) };
  const actual = hash(file);
  const expected = dataset.sha256;
  return {
    name: dataset.name,
    path: dataset.path,
    bytes: fs.statSync(file).size,
    expectedSha256: expected,
    actualSha256: actual,
    status: expected ? (actual === expected ? 'verified' : 'mismatch') : 'unverified',
    ok: Boolean(expected) && actual === expected,
  };
});

const required = checks.filter((check) => check.requiredForReproducibility !== false);
const result = {
  ok: checks.length > 0 && required.every((check) => check.ok),
  reproducible: checks.length > 0 && checks.every((check) => check.ok),
  manifest: path.relative(root, manifestPath).replace(/\\/g, '/'),
  checks,
  note: '外部数据不入代码仓；必需数据缺失或哈希不匹配会失败；未提供 sha256 的可选数据只会标记为不可复现。',
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
