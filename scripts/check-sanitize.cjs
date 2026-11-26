#!/usr/bin/env node
// check-sanitize.cjs — 发布前体检：仓库里不得残留个人路径/主机名/凭据（票 08）
// 用法：node scripts/check-sanitize.cjs [--fix-hint]
// 退出码：0=干净 / 1=发现问题
const { execSync } = require('node:child_process');
const fs = require('node:fs');

const RULES = [
  { name: '绝对路径(C:/Users)', re: /C:[\\/]Users[\\/][A-Za-z0-9._-]+/i },
  { name: '绝对路径(/c/Users)', re: /\/c\/Users\/[A-Za-z0-9._-]+/i },
  { name: '绝对路径(/Users)', re: /\/Users\/[A-Za-z0-9._-]+\/(Desktop|Documents|Downloads|\.cosmic)/ },
  { name: '主机名(旧用户名)', re: new RegExp('\\bAdmin' + 'istrator\\b') },
  { name: 'GitHub PAT', re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'OpenAI key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
];

let files = [];
try {
  files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  console.error('不是 git 仓库，跳过');
  process.exit(0);
}

// 已知历史残留：显式登记（路径 + 原因），不算“意外残留”。新增白名单必须在 .sanitizeignore 里写原因。
const IGNORE = (() => {
  try {
    return fs.readFileSync(".sanitizeignore", "utf8").split("\n")
      .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/\s+/)[0]);
  } catch { return []; }
})();
const ignored = (f) => IGNORE.some((p) => f === p || f.startsWith(p.replace(/\*$/, "")));

const hits = [];
for (const f of files) {
  if (/\.(png|jpg|jpeg|webp|gif|onnx|db|zip|gz|webm|pdf)$/i.test(f)) continue;
  if (ignored(f)) continue;
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const r of RULES) {
    if (r.re.test(text)) hits.push({ file: f, rule: r.name });
  }
}

if (!hits.length) {
  console.log(JSON.stringify({ ok: true, scanned: files.length }, null, 1));
  process.exit(0);
}
console.log(JSON.stringify({ ok: false, scanned: files.length, hits: hits.slice(0, 30), count: hits.length }, null, 1));
process.exit(1);