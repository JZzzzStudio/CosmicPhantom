// tests/insufficient-gate-test.js — 票 16：查不到就直说查不到
// 判据（三档）：
//   1) 垃圾查询 → verdict=no_evidence、结果为空
//   2) 正常查询 → verdict=answerable、结果非空
//   3) 回归集（golden 10 + heldout 8）在弃权模式下不得被误杀（原有命中不得变空）
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL = path.join(os.homedir(), '.cosmic-phantom');
const NODE = path.join(REAL, 'tools', 'node', 'node.exe');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + ' -- ' + detail); }
};

function search(q, extra = []) {
  const r = spawnSync(NODE, ['--experimental-sqlite', path.join(REAL, 'memory-cli.js'), 'search', q, '--abstain', '--top', '5', ...extra], { encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(r.stdout); } catch { return { parseFailed: String(r.stdout || r.stderr).slice(0, 200) }; }
}

console.log('=== 弃权闸（票 16） ===');
const junk = search('那个怎么弄的');
check('1. 垃圾查询 → no_evidence 且 0 条', junk.verdict === 'no_evidence' && junk.count === 0, JSON.stringify(junk).slice(0, 160));

const normal = search('门禁 13 条');
// 2026-11-19 校准后：answerable 与 low_coverage 都属于「有证据」，只有 no_evidence 才弃权
check('2. 正常查询 → 有证据（answerable 或 low_coverage）且非空', normal.verdict !== 'no_evidence' && normal.count > 0, JSON.stringify(normal).slice(0, 160));

// 3) 回归集误杀检查：直接调用检索内核（快，不用 fork 23 次）
(async () => {
  const { retrieveMemories } = await import('file://' + path.join(REAL, 'memory-retrieval.js').replace(/\\/g, '/'));
  const sets = [
    { file: 'golden-set.json', name: 'golden' },
    { file: 'golden-heldout.json', name: 'heldout' },
  ];
  let killed = 0, total = 0;
  const killedList = [];
  for (const s of sets) {
    const p = path.join(REAL, 'eval', s.file);
    if (!fs.existsSync(p)) continue;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cases = Array.isArray(data) ? data : (data.cases || []);
    for (const c of cases) {
      total += 1;
      const base = retrieveMemories(c.query || c.question, { memoryDir: path.join(REAL, 'memories'), top: 5 });
      const gated = retrieveMemories(c.query || c.question, { memoryDir: path.join(REAL, 'memories'), top: 5, abstain: true });
      if ((base.results || []).length > 0 && (gated.results || []).length === 0) { killed += 1; killedList.push(c.id || c.query); }
    }
  }
  check(`3. 回归集 ${total} 题：原本有结果的被误杀 = ${killed}（要求 0）`, killed === 0, killedList.join(','));

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + '/' + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})();