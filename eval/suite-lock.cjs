#!/usr/bin/env node
// suite-lock.cjs — 验收题集冻结锁（S0-1，2026-11-18）
// 目的：golden / heldout / adversarial 三套题集的 sha256 一旦冻结，任何改动都必须显式 accept，
//       防止"改完检索再用验证集给自己打分"（F17 会检查本锁）。
// 用法：
//   node eval/suite-lock.cjs check                     比较当前文件与锁，退出码 0=一致 / 1=有变更
//   node eval/suite-lock.cjs accept --reason "为什么改"  重新冻结并写审计记录
//   node eval/suite-lock.cjs status                    打印锁内容与接受历史条数
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = __dirname;
const SETS = ['golden-set.json', 'golden-heldout.json', 'golden-adversarial.json'];
const LOCK = path.join(DIR, 'suite.lock.json');
const ACCEPTS = path.join(DIR, 'suite-accepts.jsonl');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function current() {
  const out = {};
  for (const f of SETS) {
    const p = path.join(DIR, f);
    out[f] = fs.existsSync(p) ? sha(p) : null;
  }
  return out;
}

function diff(lockSets, cur) {
  const changed = [];
  for (const f of SETS) {
    const a = lockSets[f] ?? null;
    const b = cur[f] ?? null;
    if (a !== b) changed.push({ file: f, locked: a, current: b });
  }
  return changed;
}

const cmd = process.argv[2] || 'check';
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

if (cmd === 'check') {
  if (!fs.existsSync(LOCK)) {
    console.log(JSON.stringify({ ok: false, error: 'suite.lock.json 不存在，先跑 accept 冻结' }, null, 1));
    process.exit(1);
  }
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const changed = diff(lock.sets || {}, current());
  console.log(JSON.stringify({ ok: changed.length === 0, lockedAt: lock.at, changed }, null, 1));
  process.exit(changed.length === 0 ? 0 : 1);
}

if (cmd === 'accept') {
  const reason = arg('--reason') || '(未填写理由)';
  const at = new Date().toISOString();
  const sets = current();
  fs.writeFileSync(LOCK, JSON.stringify({ at, reason, sets }, null, 2) + '\n', 'utf8');
  fs.appendFileSync(ACCEPTS, JSON.stringify({ at, reason, sets }) + '\n', 'utf8');
  console.log(JSON.stringify({ ok: true, at, reason, sets }, null, 1));
  process.exit(0);
}

if (cmd === 'status') {
  const lock = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : null;
  const accepts = fs.existsSync(ACCEPTS)
    ? fs.readFileSync(ACCEPTS, 'utf8').trim().split(/\r?\n/).filter(Boolean).length
    : 0;
  console.log(JSON.stringify({ lock, accepts }, null, 1));
  process.exit(0);
}

console.error('usage: node eval/suite-lock.cjs <check|accept|status> [--reason "..."]');
process.exit(2);