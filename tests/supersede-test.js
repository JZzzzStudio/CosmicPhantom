// tests/supersede-test.js — 票 21：冲突态 / 预览不改盘 / 回滚复原
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REAL = path.join(os.homedir(), '.cosmic-phantom');
const NODE = path.join(REAL, 'tools', 'node', 'node.exe');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-supersede-'));
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  [PASS] ' + n); } else { fail++; console.log('  [FAIL] ' + n + ' -- ' + d); } };
const run = (args) => {
  const r = spawnSync(NODE, ['--experimental-sqlite', path.join(REAL, 'memory-cli.js'), ...args, '--root', SB], { encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(r.stdout); } catch { return { raw: String(r.stdout || r.stderr).slice(0, 200) }; }
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

fs.mkdirSync(path.join(SB, 'memories'), { recursive: true });
for (const f of ['reply-policy.json', 'inject.config.json']) { try { fs.copyFileSync(path.join(REAL, f), path.join(SB, f)); } catch {} }
for (const f of fs.readdirSync(REAL)) if (/\.(js|cjs|mjs)$/.test(f)) { try { fs.copyFileSync(path.join(REAL, f), path.join(SB, f)); } catch {} }
for (const d of ['lib', 'core']) { try { fs.cpSync(path.join(REAL, d), path.join(SB, d), { recursive: true }); } catch {} }

console.log('=== 冲突态与回滚（票 21） ===');
const a = run(['add', '冲突测试卡甲：这条规则说发布前先跑测试', '--scope', 'workspace', '--type', '规则']);
const b = run(['add', '冲突测试卡乙：这条规则说发布前先跑构建', '--scope', 'workspace', '--type', '规则']);
check('前置：两张卡落库', a.added === true && b.added === true, JSON.stringify({ a, b }).slice(0, 160));

const mapFile = path.join(SB, 'memories', '2026-11.md');
const before = sha(mapFile);
const preview = run(['supersede', a.id, b.id, '--preview']);
const afterPreview = sha(mapFile);
check('1. 预览不改盘（前后 sha 相同）', preview.preview === true && before === afterPreview, `${before.slice(0, 12)} vs ${afterPreview.slice(0, 12)}`);

const applied = run(['supersede', a.id, b.id, '--as-conflict']);
const text = fs.readFileSync(mapFile, 'utf8');
check('2. 冲突态写入（status ⚠️冲突 + conflicts_with）', applied.conflict === a.id && /status: ⚠️冲突/.test(text) && new RegExp('conflicts_with: ' + b.id).test(text), JSON.stringify(applied).slice(0, 120));

const rolled = run(['supersede', a.id, '--rollback']);
const afterRollback = fs.readFileSync(mapFile, 'utf8');
const linesAfter = (afterRollback.match(/^(status|conflicts_with|superseded_by):.*$/gm) || []).join(' ; ');
check('3. 回滚复原（状态回当前、冲突字段清除）', rolled.rollback === a.id && /status: 🟢当前/.test(afterRollback) && !/conflicts_with:/.test(afterRollback), JSON.stringify(rolled).slice(0, 120) + ' | ' + linesAfter);

fs.rmSync(SB, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);