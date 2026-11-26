// tests/migrate-prod-copy-test.js — 生产 events.db 副本兼容性测试（永久资产，2026-08-09 固化）
// 来源：Temp/cp-mig-prod.js（16/16 实测后固化）
// 用途：证明 v4 代码可安全升级"生产库的临时副本"；**只允许对副本运行，拒绝原生产 events.db**
// 用法：node --experimental-sqlite tests/migrate-prod-copy-test.js（在系统根运行）
// 保护：脚本自检——被测 events.db 若与生产原库同路径则拒绝运行（防误伤）
// ⚠️ 2026-09-19 用户裁决：**判废 12 条断言**（文件保留不删，逐条显式标注 [SKIP·判废]，不计失败）。
//   实测 **6 通过 / 12 失败**（不是原记载的 6 条红）—— 原文件头**少记一半**，两类原因都补记如下：
//   A. 依赖 REVIEW2 十项的 `text`/`day` schema（**6 条**：M1a/M1b/M1c/M1e/M3b/M3c）
//      —— HANDOVER-v4 记「**未授权**」；且开发它的隔离副本 `cosmic-phantom-review2` 已不存在（WHERE.txt）→ 无法彩排、无法复现。
//   B. 依赖**已废弃或从未实现**的能力（**6 条**，原文未记）：
//      · M2a/M2b —— 走 `state-db-path.txt` 指向的 state.db，而该链已废弃（WHERE.txt §已废弃机制台账）
//      · M4a/M4b/M5a —— 走 `events.js` 的 `rebuild`/`check-daily`/`rebind` 子命令，**从未实现**
//        （`events.js` 实际 usage = `poll|ingest|project|status|expand|coverage|purge|export`，无这三个）= REVIEW2 意见 3/5「计划中」
//      · M5b —— 依赖 M5a 的 rebind 结果
//   保留仍有效的 6 条：M0a 被测库守卫 / M1d 数据完整 / M2c 副本 daily 含块 / M3a manual 成功 / M5c 投影不重复 / M6 生产原库未变。
//   ⚠️ 注意「判废」≠「已通过」：**这些能力一个都不存在**，本条只是停止让它们伪装成回归信号。
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL = path.join(os.homedir(), '.cosmic-phantom');
const R2 = path.join(os.homedir(), '.cosmic-phantom'); // 原 .cosmic-phantom-review2（8-08 评审隔离副本未随迁本机；REVIEW2 未授权无独立快照 → 用当前生产根，2026-08-12）
const NODE = path.join(REAL, 'tools', 'node', 'node.exe');
const PROD_DB = path.join(REAL, 'events.db');
const PROD_STATE = '';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail || ''}`); }
}
// 判废项（2026-09-19 用户裁）：**显式记录，不静默删、也不伪装成通过**。
let skipped = 0;
function deprecated(name, why) { skipped++; console.log(`  [SKIP·判废] ${name}\n              └ ${why}`); }
const DEP_TEXTDAY = 'REVIEW2 text/day schema：从未授权实施，且其隔离副本 cosmic-phantom-review2 已不存在（WHERE.txt）→ 无法彩排';
const DEP_STATEDB = '依赖 state-db-path.txt 的 state.db：该链已废弃（WHERE.txt §已废弃机制台账）';
const DEP_UNIMPL = '依赖 events.js 的 rebuild/check-daily/rebind 子命令：从未实现（usage 里没有；REVIEW2 意见 3/5「计划中」）';
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

// ---- 保护 1：拒绝原生产 events.db（用户红线：不得直接迁移/重演生产原库）----
const targetArg = process.argv.find(a => a.startsWith('--target='));
const target = targetArg ? targetArg.split('=')[1] : null;
if (target && path.resolve(target) === path.resolve(PROD_DB)) {
  console.error('[REFUSED] 目标路径是生产原 events.db——本测试只允许对生产库的临时副本运行（cp 一份到临时根再传 --target=<副本>）');
  process.exit(3);
}

// ---- 准备副本根（默认自建临时副本；--target=<已有副本> 可复用）----
const SB = target ? path.dirname(path.dirname(target)) : fs.mkdtempSync(path.join(os.tmpdir(), 'cp-mig-'));
const SB_ROOT = path.join(SB, 'root');
for (const d of ['memories', 'daily', 'backup', 'topics', 'distilled', 'pro', 'resources/mcp-server']) fs.mkdirSync(path.join(SB_ROOT, d), { recursive: true });
for (const f of ['poll-state.js', 'watch-state.js']) fs.copyFileSync(path.join(R2, 'scripts', 'legacy', 'hermes', f), path.join(SB_ROOT, f));
for (const f of ['events.js', 'log_turn.js', 'link-graph.js', 'skills-sync.js', 'memory-cli.js', 'memory-retrieval.js', 'package.json']) fs.copyFileSync(path.join(R2, f), path.join(SB_ROOT, f));
execFileSync('cmd', ['/c', 'mklink', '/J', path.join(SB_ROOT, 'tools'), path.join(REAL, 'tools')], { stdio: 'ignore' });
if (!target) fs.copyFileSync(PROD_DB, path.join(SB_ROOT, 'events.db'));
const prodDailyPath = path.join(REAL, 'daily', `${localToday()}.md`);
if (fs.existsSync(prodDailyPath)) fs.copyFileSync(prodDailyPath, path.join(SB_ROOT, 'daily', `${localToday()}.md`));

const runEv = (args) => spawnSync(NODE, ['--experimental-sqlite', path.join(SB_ROOT, 'events.js'), ...args, '--root', SB_ROOT], { encoding: 'utf8', timeout: 60000 });
const evQ = (sql) => { const d = new (require('node:sqlite').DatabaseSync)(path.join(SB_ROOT, 'events.db'), { readOnly: true }); const r = d.prepare(sql).all(); d.close(); return r; };
const cols = (tbl) => evQ(`PRAGMA table_info(${tbl})`).map(c => c.name).join(',');

console.log('=== M0 保护检查 ===');
check('M0a 被测库不是生产原库', path.resolve(path.join(SB_ROOT, 'events.db')) !== path.resolve(PROD_DB), `被测=${path.join(SB_ROOT, 'events.db')}`);
const prodMeta = JSON.parse(spawnSync(NODE, ['--experimental-sqlite', path.join(REAL, 'events.js'), 'status'], { encoding: 'utf8', timeout: 30000 }).stdout.trim());
console.log(`  生产原库状态（观察快照 ${new Date().toISOString()}）: instance=${prodMeta.instance} cursor=${prodMeta.cursor} events=${prodMeta.events}`);

console.log('=== M1 migration 前后表列清单 ===');
console.log(`  events 前: ${cols('events')}`);
console.log(`  projection 前: ${cols('projection')}`);
const statusBefore = JSON.parse(runEv(['status']).stdout.trim());
const colsAfter = `events: ${cols('events')} | projection: ${cols('projection')}`;
console.log(`  migration 后: ${colsAfter}`);
deprecated('M1a events 表含 text 列', DEP_TEXTDAY);
deprecated('M1b projection 表含 day 列', DEP_TEXTDAY);
const hasDay = cols('projection').split(',').includes('day');
const dayBackfilled = hasDay ? evQ("SELECT COUNT(*) c FROM projection WHERE day IS NOT NULL")[0].c : -1;
const projTotal = evQ("SELECT COUNT(*) c FROM projection")[0].c;
deprecated('M1c 既有 projection 全部回填 day', DEP_TEXTDAY + `（实测回填 ${dayBackfilled}/${projTotal}）`);
check('M1d 数据完整（events 计数不变）', Number(evQ("SELECT COUNT(*) c FROM events")[0].c) === Number(statusBefore.events), `${statusBefore.events} -> ${evQ("SELECT COUNT(*) c FROM events")[0].c}`);
runEv(['status']);
deprecated('M1e migration 幂等（重复执行列不变）', DEP_TEXTDAY);

console.log('=== M2 poll + project（副本上，真源只读）===');
const pj = JSON.parse(runEv(['poll', '--db', PROD_STATE]).stdout.trim());
deprecated('M2a poll 正常', DEP_STATEDB + `（实测 ${JSON.stringify(pj).slice(0, 80)}）`);
deprecated('M2b project 正常', DEP_STATEDB + `（实测 ${JSON.stringify(pj).slice(0, 80)}）`);
const dailyTxt = fs.readFileSync(path.join(SB_ROOT, 'daily', `${localToday()}.md`), 'utf8');
check('M2c 副本 daily 含事件块', dailyTxt.includes('<!-- cp-evt:'), `len=${dailyTxt.length}`);

console.log('=== M3 manual（content=原始 / text=视图）===');
const tj = path.join(SB, 'm.jsonl');
fs.writeFileSync(tj, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '副本 manual 文本' }, { type: 'image_url', url: 'http://x/y.png' }] } }) + '\n');
const mj = JSON.parse(runEv(['manual', '--transcript', tj, '--session', 'mig1']).stdout.trim());
check('M3a manual 成功', !mj.error && mj.logged === 1, JSON.stringify(mj).slice(0, 150));
const hasText = cols('events').split(',').includes('text');
const mRow = hasText ? evQ("SELECT content, text FROM events WHERE instance='manual' AND session='mig1'") : null;
deprecated('M3b content 保留原始数组结构', DEP_TEXTDAY);
deprecated('M3c text 列为投影文本视图', DEP_TEXTDAY);

console.log('=== M4 rebuild（副本 daily 重建）===');
const rb = JSON.parse(runEv(['rebuild', '--day', localToday()]).stdout.trim());
deprecated('M4a rebuild 成功', DEP_UNIMPL + `（实测 ${JSON.stringify(rb).slice(0, 80)}）`);
const ck = JSON.parse(runEv(['check-daily', '--day', localToday()]).stdout.trim());
deprecated('M4b check-daily 一致', DEP_UNIMPL + `（实测 ${JSON.stringify(ck).slice(0, 80)}）`);

console.log('=== M5 rebind --baseline（marked>0 + 重放不重复）===');
const dClear = new (require('node:sqlite').DatabaseSync)(path.join(SB_ROOT, 'events.db'));
dClear.exec("DELETE FROM projection"); dClear.close();
const cursorBefore = Number(statusBefore.cursor);
const rbind = JSON.parse(runEv(['rebind', '--baseline', String(cursorBefore)]).stdout.trim());
deprecated('M5a rebind 基线基于旧实例且 marked>0', DEP_UNIMPL + `（实测 ${JSON.stringify(rbind).slice(0, 80)}）`);
const eventsBeforeReplay = Number(evQ("SELECT COUNT(*) c FROM events")[0].c);
const projBeforeReplay = Number(evQ("SELECT COUNT(*) c FROM projection")[0].c);
const pj2 = JSON.parse(runEv(['poll', '--db', PROD_STATE]).stdout.trim());
const eventsAfterReplay = Number(evQ("SELECT COUNT(*) c FROM events")[0].c);
const projAfterReplay = Number(evQ("SELECT COUNT(*) c FROM projection")[0].c);
deprecated('M5b 重放后事件数不增', DEP_UNIMPL + ' / ' + DEP_STATEDB + `（实测 before=${eventsBeforeReplay} after=${eventsAfterReplay} wrote=${pj2.wrote}）`);
check('M5c 投影不重复（projection 行数 <= 事件数）', projAfterReplay <= Number(evQ("SELECT COUNT(*) c FROM events")[0].c), `proj=${projAfterReplay} events=${evQ("SELECT COUNT(*) c FROM events")[0].c}`);

// ---- 保护 2：测试后确认生产原库未变（身份快照）----
const prodMetaAfter = JSON.parse(spawnSync(NODE, ['--experimental-sqlite', path.join(REAL, 'events.js'), 'status'], { encoding: 'utf8', timeout: 30000 }).stdout.trim());
check('M6 生产原库身份未变（instance/signature）', prodMetaAfter.instance === prodMeta.instance && prodMetaAfter.sourceSignature === prodMeta.sourceSignature, `before=${prodMeta.instance} after=${prodMetaAfter.instance}`);

console.log(`\n===== migrate-prod-copy-test（生产库副本兼容性）：${pass} 通过 / ${fail} 失败 / ${skipped} 判废跳过 =====`);
console.log(`副本根: ${SB_ROOT}（${target ? '复用外部副本' : '自建临时副本'}；生产原库未触碰）`);
if (skipped) console.log(`（${skipped} 条判废项不计失败：它们依赖 REVIEW2 未授权 schema / 已废弃 state.db / 从未实现的 rebuild·check-daily·rebind —— 不再构成回归信号。注意：判废 ≠ 已通过，这些能力一个都不存在。）`);
process.exit(fail ? 1 : 0);
