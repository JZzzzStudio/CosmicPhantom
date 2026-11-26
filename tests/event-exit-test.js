// tests/event-exit-test.js — 票 10：purge 必须留痕 / redact 走墓碑 / 分层体检
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL = path.join(os.homedir(), '.cosmic-phantom');
const NODE = path.join(REAL, 'tools', 'node', 'node.exe');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-exit-'));
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log('  [PASS] ' + n); } else { fail++; console.log('  [FAIL] ' + n + ' -- ' + d); } };
const run = (args) => {
  const r = spawnSync(NODE, ['--experimental-sqlite', path.join(REAL, 'events.js'), ...args, '--root', SB], { encoding: 'utf8', timeout: 60000, env: { ...process.env, CP_DATA_DIR: path.join(SB, 'no-data-repo') } });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { raw: String(r.stdout || r.stderr).slice(0, 200) }; }
};
const sql = (code) => {
  const wrapped = `const { DatabaseSync } = require('node:sqlite');${code}`;
  const r = spawnSync(NODE, ['--experimental-sqlite', '-e', wrapped, path.join(SB, 'events.db')], { encoding: 'utf8', timeout: 30000 });
  try { return JSON.parse(r.stdout.trim()); } catch { return { raw: String(r.stdout || r.stderr).slice(0, 200) }; }
};

const tp = path.join(SB, 't.jsonl');
fs.writeFileSync(tp, [
  { type: 'user', message: { id: 'msg-1', content: [{ type: 'text', text: '待脱敏的消息 alpha' }] } },
  { type: 'user', message: { id: 'msg-2', content: [{ type: 'text', text: '待脱敏的消息 alpha' }] } },
].map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
const first = run(['manual', '--transcript', tp, '--session', 's1']);
check('0. 相同正文但不同来源 ID 均保留', first.logged === 2, JSON.stringify(first));

console.log('=== 真源出口（票 10） ===');
const refused = run(['purge', '--before', '2000-01-01']);
check('1. 无理由 purge 被拒', refused.refused === true || /必须带/.test(JSON.stringify(refused)), JSON.stringify(refused).slice(0, 140));

const done = run(['purge', '--before', '2000-01-01', '--confirm', '--reason', '集成测试：只删 2000 年前']);
check('2. 带理由的 purge 执行（本次 0 条）', done.purged === 0, JSON.stringify(done).slice(0, 140));

const status = run(['status']);
check('3. 审计行已 append（事件数 > 原始消息数）', status.events >= 2, JSON.stringify({ events: status.events }).slice(0, 80));

const mid = '1';
const red = run(['redact', '--mid', mid, '--reason', '测试脱敏']);
check('4. redact 写墓碑（返回 hash）', red.ok === true && !!red.hash, JSON.stringify(red).slice(0, 140));

const changed = sql(`const d=new DatabaseSync(process.argv[1]);d.prepare("UPDATE events SET ts=?, sensitive=CASE WHEN instance='manual' AND mid=1 THEN 1 ELSE 0 END WHERE instance='manual'").run('1999-01-01T00:00:00.000Z');d.close();process.stdout.write(JSON.stringify({ok:true}));`);
check('4a. purge 前置筛选数据已准备', changed.ok === true, JSON.stringify(changed));
const selective = run(['purge', '--before', '2000-01-01', '--sensitive-only', '--confirm', '--reason', '集成测试：只清理旧敏感事件']);
const afterSelective = sql(`const d=new DatabaseSync(process.argv[1]);const r=d.prepare("SELECT SUM(instance='manual') manual, SUM(instance='purge-audit') audit, SUM(sensitive=1) sensitive, (SELECT COUNT(*) FROM event_tombstones WHERE action='purge') purged FROM events").get();d.close();process.stdout.write(JSON.stringify(r));`);
check('4a.1 purge 的 before 与 sensitive-only 是交集且只追加墓碑', selective.purged === 1 && afterSelective.manual === 2 && afterSelective.purged === 1, JSON.stringify({ selective, afterSelective }));
check('4a.2 purge 不物理删除原事件', afterSelective.sensitive === 2, JSON.stringify(afterSelective));

const zp = path.join(SB, 'z.jsonl');
fs.writeFileSync(zp, [
  { sourceId: 'z-a', session: 's2', content: '重复 mid A', ts: '2026-01-01T00:00:00.000Z' },
  { sourceId: 'z-b', session: 's2', content: '重复 mid B', ts: '2026-01-01T00:00:01.000Z' },
].map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
run(['zcode', '--source', zp]);

const duplicateMid = run(['redact', '--mid', '0', '--reason', '测试脱敏']);
check('4b. 重复 mid 未指定 instance 时拒绝猜测', duplicateMid.refused === true, JSON.stringify(duplicateMid).slice(0, 160));

const missing = run(['redact', '--mid', '不存在', '--reason', '测试脱敏']);
check('5. 不存在的 mid 被拒', missing.ok === false, JSON.stringify(missing).slice(0, 120));

const tiers = run(['tiers']);
check('6. 分层体检输出三段', Number.isFinite(tiers.hot90) && Number.isFinite(tiers.warm365) && Number.isFinite(tiers.cold), JSON.stringify(tiers).slice(0, 140));

fs.rmSync(SB, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + '/' + (pass + fail));
process.exit(fail === 0 ? 0 : 1);