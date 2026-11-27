// tests/instance-loop-test.js — 实例模式真实闭环（2026-11-27 挑刺审计补证）
// 隔离临时根跑真实 CLI 入口：摄取→候选→确认门→激活→检索→verify(instance)→幂等→失败出口。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const REAL = path.resolve(__dirname, '..');
const NODE = process.execPath;
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-instance-loop-'));
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('[PASS] ' + n); } else { fail++; console.log('[FAIL] ' + n + ' -- ' + String(d).slice(0, 200)); } };
const ev = (a) => spawnSync(NODE, ['--experimental-sqlite', path.join(REAL, 'events.js'), ...a, '--root', R], { encoding: 'utf8', timeout: 60000 });
const cli = (a) => spawnSync(NODE, ['--experimental-sqlite', path.join(REAL, 'memory-cli.js'), ...a, '--root', R], { encoding: 'utf8', timeout: 60000 });
const j = (r) => { const s = (r.stdout || '').trim(); try { return JSON.parse(s); } catch { try { return JSON.parse(s.split('\n').pop()); } catch { return {}; } } };
try {
  const tp = path.join(R, 'transcript.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', id: 'inst-1', message: { content: '请记住：实例模式验证用临时根，部署默认每周三发布' } }) + '\n', 'utf8');
  const ing = ev(['manual', '--transcript', tp, '--session', 'inst-session']);
  check('ingest event', ing.status === 0 && j(ing).logged === 1, ing.stdout + ing.stderr);
  const proj = ev(['project']);
  check('project daily', proj.status === 0 && fs.existsSync(path.join(R, 'daily')), proj.stdout);
  const add = cli(['candidate', 'add', '部署默认每周三发布', '--kind', 'decision', '--source-kind', 'user_said', '--source-ref', 'manual:inst-1', '--confidence', '1', '--scope', 'workspace']);
  const cid = j(add).candidate_id;
  check('candidate created pending', j(add).added === true && !!cid, add.stdout);
  const sb = cli(['search', '每周三发布', '--top', '5']);
  check('unconfirmed NOT in default search', !JSON.stringify(sb.stdout).includes('部署默认每周三发布'), sb.stdout.slice(0, 150));
  const prev = cli(['candidate', 'preview', cid]); const hash = j(prev).previewHash;
  check('preview ready hash', j(prev).ready === true && (hash || '').length === 64, prev.stdout);
  const conf = cli(['candidate', 'confirm', cid, '--preview-hash', hash]);
  check('confirm activates', j(conf).confirmed === 1, conf.stdout);
  const sa = cli(['search', '每周三发布', '--top', '5']);
  check('approved memory retrievable', sa.status === 0 && JSON.stringify(sa.stdout).includes('每周三发布'), sa.stdout.slice(0, 150));
  const vj = j(cli(['verify']));
  check('verify reports INSTANCE mode', vj.mode === 'instance', JSON.stringify(vj).slice(0, 200));
  const dup = ev(['manual', '--transcript', tp, '--session', 'inst-session']);
  check('duplicate idempotent', dup.status === 0 && j(dup).logged === 0 && j(dup).skipped >= 1, dup.stdout);
  const bad = ev(['manual', '--transcript', path.join(R, 'missing.jsonl'), '--session', 'x']);
  check('error path non-zero', bad.status !== 0, 'status=' + bad.status);
} finally { fs.rmSync(R, { recursive: true, force: true }); }
console.log('instance-loop-test: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
