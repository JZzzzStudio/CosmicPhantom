// tests/write-fields-test.js — 票 18 / 28：写卡字段的硬约束
// 判据：
//   1) 非法 epistemic → 拒绝落卡
//   2) 非法 source_kind → 拒绝落卡
//   3) 合法值写入卡面（epistemic / source_kind / situation / entities）
//   4) 流程类查询下，type=规则 的卡排在 type=事件 前面（相同正文）
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL = path.resolve(__dirname, '..');
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-fields-'));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + ' -- ' + detail); }
};
function run(args) {
  const r = spawnSync(NODE, ['--experimental-sqlite', path.join(REAL, 'memory-cli.js'), ...args, '--root', SB], { encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(r.stdout); } catch { return { raw: String(r.stdout || r.stderr).slice(0, 200) }; }
}

fs.mkdirSync(path.join(SB, 'memories'), { recursive: true });
for (const f of ['reply-policy.json', 'inject.config.json']) {
  try { fs.copyFileSync(path.join(REAL, f), path.join(SB, f)); } catch {}
}
// 引擎脚本与依赖（沙箱要能独立跑）
for (const f of fs.readdirSync(REAL)) if (/\.(js|cjs|mjs)$/.test(f)) { try { fs.copyFileSync(path.join(REAL, f), path.join(SB, f)); } catch {} }
for (const d of ['lib', 'core']) {
  try { fs.cpSync(path.join(REAL, d), path.join(SB, d), { recursive: true }); } catch {}
}

console.log('=== 写卡字段约束（票 18/28） ===');
const badEpi = run(['add', '非法分级测试', '--scope', 'workspace', '--type', '事件', '--epistemic', 'nonsense']);
check('1. 非法 epistemic 被拒', badEpi.added === false && /非法 epistemic/.test(JSON.stringify(badEpi)), JSON.stringify(badEpi).slice(0, 120));

const badKind = run(['add', '非法来源测试', '--scope', 'workspace', '--type', '事件', '--source-kind', 'device']);
check('2. 非法 source_kind 被拒', badKind.added === false && /非法 source_kind/.test(JSON.stringify(badKind)), JSON.stringify(badKind).slice(0, 120));

const ok = run(['add', '流程测试卡：发布前先跑 verify 再推数据仓', '--scope', 'workspace', '--type', '规则',
  '--epistemic', 'fact', '--source-kind', 'user_said', '--situation', '当准备推送发布时', '--entities', 'verify,数据仓']);
const bucket = path.join(SB, 'memories', '2026-11.md');
const text = fs.existsSync(bucket) ? fs.readFileSync(bucket, 'utf8') : '';
check('3. 合法值写入卡面', ok.added === true && /epistemic: fact/.test(text) && /source_kind: user_said/.test(text) && /situation: 当准备推送发布时/.test(text) && /entities: \[verify, 数据仓\]/.test(text), text.slice(0, 200));

// 4) 规则类提权：同正文两张卡，一张规则一张事件
const twinBody = '发布前先跑 verify 检查，再同步数据仓，最后推送远端';
run(['add', twinBody, '--scope', 'global', '--type', '事件']);
run(['add', twinBody, '--scope', 'global', '--type', '规则']);
const s = run(['search', '发布前先做什么步骤流程', '--top', '5']);
const first = (s.results || [])[0];
const firstType = first && first.snippet ? (/type: (规则|事件)/.exec(first.snippet) || [])[1] : null;
check('4. 流程类查询下规则卡排前', !!first && firstType === '规则', `first=${first && first.id} type=${firstType}`);

fs.rmSync(SB, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);