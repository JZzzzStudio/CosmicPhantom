#!/usr/bin/env node
// install-host-extensions.cjs — 把仓内的宿主扩展装到 Proma 扩展目录（2026-11-19）
// 由来：这 4 个 mjs 是 CP 的自动摄取/门禁/守卫/清洗，之前只存在于 ~/.proma/sdk-config/extensions，
//       不在任何 git 仓 —— 换机必丢，且表现为「工具在、自动记录全不生效」。
// 用法：
//   node scripts/install-host-extensions.cjs --check     只比对，不写（默认）
//   node scripts/install-host-extensions.cjs --apply     备份后覆盖
const { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, renameSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { homedir } = require('node:os');

const SRC = join(__dirname, '..', 'host-extensions');
const DST = join(homedir(), '.proma', 'sdk-config', 'extensions');
const APPLY = process.argv.includes('--apply');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
const walk = (base, rel = '') => {
  const out = [];
  for (const e of readdirSync(join(base, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(base, r));
    else out.push(r);
  }
  return out;
};
if (!existsSync(SRC)) { console.log(JSON.stringify({ ok: false, error: 'host-extensions/ 不存在' })); process.exit(1); }
const files = walk(SRC);
const rows = files.map((f) => {
  const a = join(SRC, f), b = join(DST, f);
  const same = existsSync(b) && statSync(a).size === statSync(b).size && sha(a) === sha(b);
  return { file: f, exists: existsSync(b), same, src: sha(a), dst: existsSync(b) ? sha(b) : null };
});
if (APPLY) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = join(homedir(), '.proma', 'backup', 'ext-' + ts);
  for (const r of rows) {
    const a = join(SRC, r.file), b = join(DST, r.file);
    mkdirSync(join(DST, r.file.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    if (existsSync(b)) { mkdirSync(join(backup, r.file.split('/').slice(0, -1).join('/') || '.'), { recursive: true }); renameSync(b, join(backup, r.file)); }
    copyFileSync(a, b);
  }
  console.log(JSON.stringify({ ok: true, applied: rows.length, backup, note: '重启宿主后生效' }, null, 2));
} else {
  console.log(JSON.stringify({ ok: rows.every((r) => r.same), checked: rows.length, needInstall: rows.filter((r) => !r.same).map((r) => r.file), rows }, null, 2));
}
