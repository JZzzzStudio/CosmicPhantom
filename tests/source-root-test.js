// tests/source-root-test.js — 票 19：来源根独立性
// 判据：同一会话里，同一 root 重复摄取算 1 个独立来源；不同 root 算 2 个。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL = path.join(os.homedir(), '.cosmic-phantom');
const NODE = path.join(REAL, 'tools', 'node', 'node.exe');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-srcroot-'));
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  [PASS] ' + n); } else { fail++; console.log('  [FAIL] ' + n + ' -- ' + d); } };

function writeTranscript(name, texts) {
  const p = path.join(SB, name);
  const lines = texts.map((t) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: t }] } }));
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}
const tpA = writeTranscript('a.jsonl', ['第一条测试消息', '第二条测试消息']);
const tpB = writeTranscript('b.jsonl', ['另一台机器的消息 A']);

function run(args, env = {}) {
  const r = spawnSync(NODE, ['--experimental-sqlite', path.join(REAL, 'events.js'), ...args, '--root', SB], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { raw: String(r.stdout || r.stderr).slice(0, 200) }; }
}

console.log('=== 来源根独立性（票 19） ===');
run(['manual', '--transcript', tpA, '--session', 's1'], { CP_SOURCE_ROOT: 'boxA:aaaa1111' });
run(['manual', '--transcript', tpA, '--session', 's1'], { CP_SOURCE_ROOT: 'boxA:aaaa1111' });
const same = run(['independence', '--session', 's1']);
check('1. 同一 root 重复摄取 → 独立来源 1', same.distinct === 1 && same.independent === false, JSON.stringify(same).slice(0, 160));

run(['manual', '--transcript', tpB, '--session', 's1'], { CP_SOURCE_ROOT: 'boxB:bbbb2222' });
const cross = run(['independence', '--session', 's1']);
check('2. 跨 root → 独立来源 2', cross.distinct === 2 && cross.independent === true, JSON.stringify(cross).slice(0, 160));

const status = run(['status']);
check('3. status 输出 sourceRoots（distinct/legacyCount）', !!(status.sourceRoots && status.sourceRoots.distinct >= 2), JSON.stringify(status.sourceRoots || {}).slice(0, 160));

fs.rmSync(SB, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);