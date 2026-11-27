// tests/lander-bundle-test.js — 继承包落地器对抗回归（2026-09-19 立）
//
// 动机：落地器（`install-bundle.cjs`）是**新机上跑一次、错了不好回头**的唯一入口，
//   而它此前**没有任何自动化测试** —— 2026-09-19 那轮 7 条缺陷全靠手工实验挖出来。
//   本件把那些实验固化下来：**每次改落地器/打包器，跑它一遍**。
//
// 覆盖 4 组实验（每组都有"修复前会红"的实证背景，见 pro/audit-2026-09-19.md）：
//   A. 目标机已有自己的 hooks  → CP 追加而非整组替换（用户原有 hook 必须存活）+ 幂等
//   B. 目标机已有自己的 CLAUDE.md（无快照段）→ 默认**硬失败**，不许报"包侧全通"
//   C. 目标机的游标/机器登记 → 不被源机版本覆盖（含靠**形态**保护的新宿主游标）
//   D. 换用户名 / 换盘符落地 → 注册值全指新 home，代码/配置无"非预期"源机用户名残留
//
// 用法：CP_LANDER_TEST=1 node --experimental-sqlite tests/legacy/packaging/lander-bundle-test.js
//   （**默认跳过**：本件要打一个 ~110MB 轻量包 + 跑几次安装，不进常规测试链，避免拖慢门7）
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CANDIDATE = path.resolve(__dirname, '..', '..', '..');
const NODE = process.execPath;
const FAKE_SOURCE_KEY = ["sk", "FAKE", "NOT-A-REAL-KEY-000"].join("-");
const FAKE_TARGET_KEY = ["sk", "TARGET-OWN", "xxxx"].join("-");

if (process.env.CP_LANDER_TEST !== '1') {
  console.log('⏭️  lander-bundle-test **默认跳过**（要打 ~110MB 轻量包 + 多次安装，不进常规链）。');
  console.log('   要跑：CP_LANDER_TEST=1 node --experimental-sqlite tests/lander-bundle-test.js');
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name} -- ${String(detail === undefined ? '' : detail).slice(0, 240)}`); }
};
const rd = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const rj = (f) => { try { return JSON.parse(rd(f)); } catch { return null; } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lander-'));
process.on('exit', () => { try { fs.rmSync(SB, { recursive: true, force: true }); } catch {} });
const ENGINE = path.join(SB, 'engine');
const SRC_HOME = path.join(SB, 'source-home');
const SRC_USER = path.basename(SRC_HOME);
const SOURCE_ROOT = path.join(SRC_HOME, '.cosmic-phantom');
const BUNDLE = path.join(SB, 'bundle');
const TARGET_BASE = path.join(SB, 'targets');
const copyTree = (src, dst, skip = () => false) => {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name, entry, src)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to, skip);
    else fs.copyFileSync(from, to);
  }
};
const SKIP_ENGINE = new Set(['.git', 'node_modules', 'backup', 'delivery', 'docs', 'embedding-db', 'eval', 'tests']);
copyTree(CANDIDATE, ENGINE, (name) => SKIP_ENGINE.has(name));
fs.mkdirSync(path.join(ENGINE, 'tools', 'node'), { recursive: true });
fs.copyFileSync(NODE, path.join(ENGINE, 'tools', 'node', 'node.exe'));
fs.mkdirSync(path.join(SOURCE_ROOT, 'tools', 'node'), { recursive: true });
fs.copyFileSync(NODE, path.join(SOURCE_ROOT, 'tools', 'node', 'node.exe'));

const run = (args, opts = {}) => spawnSync(NODE, args, { encoding: 'utf8', timeout: 600000, ...opts });
const runEngine = (script, args = [], opts = {}) => run(['--experimental-sqlite', path.join(ENGINE, script), ...args], {
  ...opts,
  env: { ...process.env, CP_ROOT: SOURCE_ROOT, CP_NODE: NODE, ...opts.env },
});
const engineScript = (rel) => path.join(ENGINE, rel);

// ── 在隔离源实例中生成真实事件/投影和合法 P4 运行时 ─────────────────────
console.log('=== 准备：构造隔离源实例 ===');
for (const dir of ['memories', 'daily', 'distilled', 'backup', 'topics', 'core', '.context', 'lib', 'resources/mcp-server', 'scripts/legacy/hermes']) {
  fs.mkdirSync(path.join(SOURCE_ROOT, dir), { recursive: true });
}
for (const rel of ['current-state.js', 'memory-cli.js', 'memory-retrieval.js', 'validate.js', 'events.js', 'inject.js', 'inject-config.js', 'inject.config.json', 'reply-policy.json', 'resume-context.js', 'link-graph.js', 'skills-sync.js', 'identity-card.js', 'resources/mcp-server/index.js', 'scripts/legacy/hermes/watch-state.js', 'lib/failopen.js', 'package.json', 'claude-flush.cjs', 'compaction-inject.cjs', 'flush-reminder.cjs', 'decision-cards.js', 'update-snapshot.js', 'sync-reply-policy.mjs', 'audit-due.cjs', 'session-adapter.js', 'mcp-smoke.cjs', 'hook-smoke.cjs']) {
  const target = path.join(SOURCE_ROOT, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(engineScript(rel), target);
}
fs.copyFileSync(path.join(ENGINE, 'core', 'rules.md'), path.join(SOURCE_ROOT, 'core', 'rules.md'));
fs.copyFileSync(path.join(ENGINE, 'core', 'reply-style.md'), path.join(SOURCE_ROOT, 'core', 'reply-style.md'));
fs.writeFileSync(path.join(SOURCE_ROOT, '.context', 'CONTEXT.md'), '# Public synthetic context\n\n- Source instance is isolated for packaging tests.\n', 'utf8');
fs.writeFileSync(path.join(SOURCE_ROOT, 'MEMORY.md'), '# Public synthetic memory index\n', 'utf8');
fs.writeFileSync(path.join(SOURCE_ROOT, 'sources.json'), JSON.stringify({
  schemaVersion: 1,
  sources: [
    { name: 'synthetic-source', kind: 'jsonl', dir: path.join(SRC_HOME, 'transcripts'), instancePrefix: 'synthetic-', enabled: true },
    { name: 'manual', kind: 'session', dir: null, instancePrefix: 'manual-', enabled: true },
  ],
}, null, 2) + '\n', 'utf8');
fs.mkdirSync(path.join(SRC_HOME, 'transcripts'), { recursive: true });
fs.writeFileSync(path.join(SRC_HOME, 'transcripts', 'session.jsonl'), JSON.stringify({ type: 'user', message: { content: 'PUBLIC_SYNTHETIC_LANDER_EVENT' } }) + '\n', 'utf8');
fs.writeFileSync(path.join(SOURCE_ROOT, 'current-state.json'), JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: '2099-01-01T00:00:00.000Z', updatedBy: 'lander-test', source: 'synthetic', status: 'active', objective: 'Public packaging fixture', summary: 'Synthetic source instance', completed: [], nextActions: ['Run isolated lander'], blockers: [], decisions: [], workingFiles: [], verification: [] }, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(SOURCE_ROOT, 'memories', '20990101-lander.md'), ['---', 'id: 20990101-lander', 'created: 2099-01-01T00:00:00.000Z', 'status: 🟢当前', 'type: 规则', 'tags: [synthetic, lander]', 'scope: global', '---', 'PUBLIC_SYNTHETIC_LANDER_MEMORY'].join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(SOURCE_ROOT, 'index.json'), JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2) + '\n', 'utf8');
const transcript = path.join(SB, 'source-transcript.jsonl');
fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'PUBLIC_SYNTHETIC_LANDER_EVENT' }] } }) + '\n', 'utf8');
const ev = runEngine('events.js', ['manual', '--transcript', transcript, '--session', 'synthetic-lander', '--root', SOURCE_ROOT]);
if (ev.status !== 0) { console.error('合成事件写入失败：\n' + String(ev.stdout || '') + String(ev.stderr || '')); process.exit(1); }
const checkpoint = run(NODE === process.execPath ? [ '--experimental-sqlite', '-e', "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();", path.join(SOURCE_ROOT, 'events.db')] : []);
if (checkpoint.status !== 0) { console.error('events.db checkpoint 失败：\n' + String(checkpoint.stderr || '')); process.exit(1); }
check('隔离源实例有非空 events.db', fs.existsSync(path.join(SOURCE_ROOT, 'events.db')) && fs.statSync(path.join(SOURCE_ROOT, 'events.db')).size > 0);
check('隔离源实例有 daily 投影', fs.readdirSync(path.join(SOURCE_ROOT, 'daily')).some((name) => name.endsWith('.md')));
const stats = runEngine('memory-cli.js', ['stats', '--root', SOURCE_ROOT]);
const verify = runEngine('memory-cli.js', ['verify', '--root', SOURCE_ROOT]);
check('隔离源实例 stats 有活跃记忆', stats.status === 0 && /total[^0-9]*[1-9]/.test(stats.stdout || ''), stats.stdout);
check('隔离源实例 verify 可运行', verify.status === 0, verify.stderr || verify.stdout);

// ── 打一个轻量测试包（假外部包 + --no-model，几秒完成）────────────────────
console.log('=== 准备：打轻量测试包 ===');
for (const [id, files] of [['fake-client', ['Claude Code Haha.exe', 'resources/app.asar']], ['fake-sts', ['hooks/stop-that-shit-claude.cjs']]]) {
  for (const f of files) {
    fs.mkdirSync(path.join(SB, id, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(SB, id, f), 'FAKE-' + id);
  }
}
// 安全边界：源机 home 也必须是 SB 内的合成目录；此处不读取 os.homedir() 或真实宿主配置。
fs.mkdirSync(path.join(SRC_HOME, '.claude', 'cc-haha'), { recursive: true });
const SRC_FWD = SRC_HOME.replace(/\\/g, '/');
const ROOT_FWD = SOURCE_ROOT.replace(/\\/g, '/');
const sourceNode = path.join(SOURCE_ROOT, 'tools', 'node', 'node.exe');
const sourceMcp = path.join(SOURCE_ROOT, 'resources', 'mcp-server', 'index.js');
const sourceFlush = path.join(SOURCE_ROOT, 'claude-flush.cjs');
const sourceMcpConfig = {
  type: 'stdio',
  command: sourceNode,
  args: [sourceMcp, '--root', SOURCE_ROOT],
  env: { CP_ROOT: SOURCE_ROOT },
  disabled: false,
};
fs.writeFileSync(path.join(SRC_HOME, '.claude.json'), JSON.stringify({
  userID: 'PUBLIC-SYNTHETIC-USER',
  mcpServers: { 'cosmic-phantom': sourceMcpConfig },
}, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(SRC_HOME, '.claude', 'settings.json'), JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `"${sourceNode}" --experimental-sqlite "${path.join(SOURCE_ROOT, 'compaction-inject.cjs')}" --root "${SOURCE_ROOT}"` }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `"${sourceNode}" --experimental-sqlite "${path.join(SOURCE_ROOT, 'flush-reminder.cjs')}" --root "${SOURCE_ROOT}"` }] }],
    Stop: [{ hooks: [{ type: 'command', command: `"${sourceNode}" --experimental-sqlite "${sourceFlush}" --root "${SOURCE_ROOT}"` }] }],
  },
  syntheticSourceHome: SRC_USER,
}, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(SRC_HOME, '.claude', 'CLAUDE.md'), [
  '# Public synthetic Claude host',
  '',
  '<!-- snapshot-start -->',
  `- source root: ${ROOT_FWD}`,
  '<!-- snapshot-end -->',
  '',
].join('\n'), 'utf8');
fs.writeFileSync(path.join(SRC_HOME, '.claude', 'cc-haha', 'providers.json'), JSON.stringify({
  schemaVersion: 5, activeId: 'FAKE-SRC', providers: [{ id: 'FAKE-SRC', name: 'fakeSrc', apiKey: FAKE_SOURCE_KEY, baseUrl: 'https://fake.invalid' }],
}, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(SRC_HOME, '.claude', 'cc-haha', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'fake-src-model' } }, null, 2) + '\n', 'utf8');

const pk = run([path.join(CANDIDATE, 'scripts', 'packaging', 'pack-bundle.cjs'), '--out', BUNDLE, '--no-model', '--home', SRC_HOME,
  '--root', SOURCE_ROOT, '--client-src', path.join(SB, 'fake-client'), '--sts-src', path.join(SB, 'fake-sts')]);
if (pk.status !== 0) { console.error('打包失败，无法继续：\n' + String(pk.stdout || '').slice(-400) + String(pk.stderr || '').slice(-400)); process.exit(1); }
const man = rj(path.join(BUNDLE, 'MANIFEST.json'));
check('打包成功且清单条数 == CHECKSUMS 行数',
  !!man && rd(path.join(BUNDLE, 'CHECKSUMS.sha256')).split('\n').filter(Boolean).length === man.checksumCount,
  man ? `声明 ${man.checksumCount}` : '无 MANIFEST');

const install = (home, extra = []) => run([path.join(CANDIDATE, 'scripts', 'packaging', 'install-bundle.cjs'), '--bundle', BUNDLE,
  '--home', home, '--root', path.join(home, '.cosmic-phantom'), '--client-dir', path.join(home, 'Claude Code Haha'), '--apply', '--no-shortcuts', ...extra], {
  env: { ...process.env, CP_ROOT: path.join(home, '.cosmic-phantom'), CP_NODE: NODE },
});

const mkHome = (name) => { const h = path.join(SB, name); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; };

// ── 实验 A：目标机已有自己的 hooks（追加而非替换）+ 幂等 ────────────────────
console.log('\n=== A. 目标机已有自己的 hooks ===');
{
  const H = mkHome('a');
  const userHooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo USER-OWN-SESSIONSTART' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo USER-OWN-STOP' }] }],
  };
  fs.writeFileSync(path.join(H, '.claude', 'settings.json'), JSON.stringify({ userOwnTopKey: 'MUST-SURVIVE', hooks: userHooks }, null, 2));
  fs.writeFileSync(path.join(H, '.claude.json'), JSON.stringify({ userID: 'MUST-SURVIVE', mcpServers: { myOwn: { command: 'x' } } }, null, 2));
  const r = install(H);
  if (r.status !== 4) fs.writeFileSync(path.join(os.tmpdir(), 'cp-install-a-out.json'), String(r.stdout || '') + '\n===STDERR===\n' + String(r.stderr || ''));
  const st = rj(path.join(H, '.claude', 'settings.json')) || {};
  check('退出 4（包侧全通）', r.status === 4, `status=${r.status} out=${String(r.stdout || '').slice(-500)} err=${String(r.stderr || '').slice(-300)}`);
  check('用户原有的 SessionStart hook 存活', JSON.stringify(st.hooks && st.hooks.SessionStart || []).includes('USER-OWN-SESSIONSTART'));
  check('用户原有的 Stop hook 存活', JSON.stringify(st.hooks && st.hooks.Stop || []).includes('USER-OWN-STOP'));
  check('CP 的 hook 也装上了', JSON.stringify(st.hooks || {}).includes('claude-flush'));
  check('顶层自有键存活', st.userOwnTopKey === 'MUST-SURVIVE');
  const dj = rj(path.join(H, '.claude.json')) || {};
  check('用户自有 MCP server 存活', !!(dj.mcpServers && dj.mcpServers.myOwn));
  check('CP MCP 注册在位', !!(dj.mcpServers && dj.mcpServers['cosmic-phantom']));
  const n1 = (st.hooks && st.hooks.SessionStart || []).length;
  install(H); const st2 = rj(path.join(H, '.claude', 'settings.json')) || {};
  const n2 = (st2.hooks && st2.hooks.SessionStart || []).length;
  check('幂等：重跑不重复追加', n1 === n2, `${n1} → ${n2}`);
}

// ── 实验 B：目标机已有自己的 CLAUDE.md（无快照段）→ 默认硬失败 ───────────────
console.log('\n=== B. 目标机已有自己的 CLAUDE.md ===');
{
  const H = mkHome('b');
  fs.writeFileSync(path.join(H, '.claude', 'CLAUDE.md'), '# 我自己的全局指令\n\n- 不要动我这条\n');
  const r = install(H);
  check('默认**硬失败**（不许报"包侧全通"）', r.status === 1, `status=${r.status}（4=把半装读成全通）`);
  const md = rd(path.join(H, '.claude', 'CLAUDE.md')) || '';
  check('用户原句未被覆盖', md.includes('不要动我这条'));
  const r2 = install(H, ['--allow-claude-md-skip']);
  const rep = rj(path.join(BUNDLE, 'INSTALL-REPORT.json')) || {};
  check('加 --allow-claude-md-skip 后 exit 4', r2.status === 4, `status=${r2.status} out=${String(r2.stdout || '').slice(-500)} err=${String(r2.stderr || '').slice(-300)}`);
  check('但 verdict 必须带出"注入层未装"', /注入层未装/.test(String(rep.verdict || '')), String(rep.verdict || '').slice(0, 120));
  check('且 pending 里有这条', (rep.pending || []).some((x) => String(x).startsWith('注入层未装')));
}

// ── 实验 C：目标机的游标/机器登记不被覆盖（含形态保护）────────────────────
console.log('\n=== C. 目标机游标/机器登记受保护 ===');
{
  const H = mkHome('c');
  install(H);
  const R = path.join(H, '.cosmic-phantom');
  const items = ['.proma-cursor.json', '.wb-cursor.json', 'state-db-path.txt', '.newhost-cursor.json'];
  for (const f of items) fs.writeFileSync(path.join(R, f), 'TARGET-OWN-' + f);
  const r = install(H);
  check('升级退出 4', r.status === 4, `status=${r.status}`);
  for (const f of items) check(`受保护：${f}`, (rd(path.join(R, f)) || '').includes('TARGET-OWN'));
}

// ── 实验 D：换用户名 / 换盘符 ────────────────────────────────────────────
console.log('\n=== D. 换用户名 / 换盘符 ===');
for (const [tag, home] of [['换用户名', path.join(os.tmpdir(), 'CpLanderTestUser')], ['换盘符', path.resolve('CpLanderTestUser')]]) {
  let made = false;
  try { fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true }); made = true; } catch { /* 盘符不可用则跳过 */ }
  if (!made) { console.log(`  [SKIP] ${tag}：${home} 不可写`); continue; }
  try {
    const r = install(home);
    const R = path.join(home, '.cosmic-phantom');
    check(`${tag}：exit 4`, r.status === 4, `status=${r.status}`);
    const dj = rj(path.join(home, '.claude.json')) || {};
    const s = dj.mcpServers && dj.mcpServers['cosmic-phantom'];
    check(`${tag}：MCP 注册指新 home`, !!s && String(s.command).replace(/\\/g, '/').startsWith(home.replace(/\\/g, '/')), s && s.command);
    // 漏网源机用户名（排除历史记录目录与三方包；正控=sources.json 必含源机路径）
    const pos = (rd(path.join(R, 'sources.json')) || '').includes(SRC_USER);
    check(`${tag}：判据正控会响`, pos, 'sources.json 应含源机路径');
    const SKIP = new Set(['node_modules', 'daily', 'distilled', 'memories', 'pro', 'docs', 'delivery', 'client', 'tools-src', 'views', 'topics', 'backup', 'embedding-db', '.git', 'eval']);
    const EXPECTED = new Set(['sources.json', 'current-state.json', 'scripts/packaging/pack-bundle.cjs', 'scripts/legacy/packaging/upgrade-prepare.js']);
    const hits = [];
    (function walk(d, depth) {
      if (depth > 3) return;
      let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { if (SKIP.has(e.name) === false) walk(fp, depth + 1); continue; }
        if (/\.(js|cjs|mjs|json|txt|yml|sh)$/.test(e.name) === false) continue;
        const t = rd(fp); if (t && t.includes(SRC_USER)) hits.push(path.relative(R, fp).split(path.sep).join('/'));
      }
    })(R, 0);
    const unexpected = hits.filter((h) => EXPECTED.has(h) === false);
    check(`${tag}：无"非预期"源机用户名残留`, unexpected.length === 0, unexpected.slice(0, 4).join(', '));
    check(`${tag}：宿主游标未被带入`, fs.existsSync(path.join(R, '.proma-cursor.json')) === false);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

// ── 实验 E：客户端模型配置随包落地 + **fresh 模式也要备份目标机原有的** ──────────
// 背景（2026-09-19 用户实机拷打）：
//   ① 原清单只带"CP 接入件"，**没带客户端自己的模型配置** → 新机上客户端起来后要求重新配模型（「开袋即食」的缺口）
//   ② 原备份整块被 `cpMode`（=非 fresh）关着，而 fresh 只代表"没有 CP"，**不代表"宿主是干净的"**
//      → 真新机上用户早装好的配置会被覆盖却**无备份**（实测：报告写"已备份"、备份里根本没文件）
console.log('\n=== E. 客户端模型配置（随包带 + fresh 也备份）===');
{
  const H = mkHome('e');
  fs.mkdirSync(path.join(H, '.claude', 'cc-haha'), { recursive: true });
  fs.writeFileSync(path.join(H, '.claude', 'cc-haha', 'providers.json'), JSON.stringify({ schemaVersion: 5, activeId: 'TARGET-OWN', providers: [{ id: 'TARGET-OWN', name: '目标机自配', apiKey: FAKE_TARGET_KEY }] }, null, 2));
  fs.writeFileSync(path.join(H, '.claude', 'cc-haha', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'target-own-model' } }, null, 2));
  fs.writeFileSync(path.join(H, '.claude', 'settings.json'), JSON.stringify({ userOwnKey: 'MUST-SURVIVE' }, null, 2));
  fs.writeFileSync(path.join(H, '.claude.json'), JSON.stringify({ userID: 'MUST-SURVIVE' }, null, 2));
  fs.writeFileSync(path.join(H, '.claude', 'CLAUDE.md'), '# 我自己的全局指令\n');

  const r = install(H, ['--allow-claude-md-skip']);
  check('E-1 退出 4（无快照段的 CLAUDE.md 已显式放行）', r.status === 4, `status=${r.status}`);

  const pv = rj(path.join(H, '.claude', 'cc-haha', 'providers.json'));
  check('E-2 源机的模型配置被带过来了', !!pv && Array.isArray(pv.providers) && pv.providers.some((x) => x.id === 'FAKE-SRC'), pv && pv.activeId);
  const cs = rj(path.join(H, '.claude', 'cc-haha', 'settings.json'));
  check('E-3 源机的 cc-haha/settings.json 也带过来了', !!cs && cs.env && cs.env.ANTHROPIC_MODEL === 'fake-src-model', cs && cs.env && cs.env.ANTHROPIC_MODEL);

  // **本实验的要害**：fresh 模式下，目标机原有的宿主配置必须**真的**进了备份
  const bkRoot = path.join(H, '.cosmic-phantom', 'backup');
  let map = null;
  try {
    const dirs = fs.readdirSync(bkRoot).filter((x) => /^install-/.test(x)).sort();
    map = JSON.parse(fs.readFileSync(path.join(bkRoot, dirs[dirs.length - 1], 'MAP.json'), 'utf8'));
  } catch {}
  const targets = (map && map.files ? map.files.map((f) => String(f.target).replace(/\\/g, '/')) : []);
  check('E-4 【fresh 模式】目标机原有 .claude.json 进了备份', targets.some((t) => t.endsWith('.claude.json')), `备份 ${targets.length} 条`);
  check('E-5 【fresh 模式】目标机原有 .claude/settings.json 进了备份', targets.some((t) => t.endsWith('.claude/settings.json')));
  check('E-6 【fresh 模式】目标机原有 providers.json 进了备份', targets.some((t) => t.endsWith('cc-haha/providers.json')));
  // 备份文件必须**真的在盘上**（原缺陷正是"报告说有、实际没有"）
  let onDisk = 0;
  if (map) { const dir = path.join(bkRoot, fs.readdirSync(bkRoot).filter((x) => /^install-/.test(x)).sort().pop()); for (const f of map.files) if (fs.existsSync(path.join(dir, f.backup))) onDisk += 1; }
  check('E-7 备份映射里的文件**真的在盘上**', map !== null && onDisk === map.files.length, `${onDisk}/${map ? map.files.length : 0}`);
}

// ── 实验 F：换机/重装**不会双 hook** ────────────────────────────────────────
// 背景（2026-09-19 一次误装事故里挖出，属**换机必踩**）：
//   原去重判据是「命令字符串完全相等」—— 而**换了机器，CP 的绝对路径必然变**
//   ⇒ 同一个 hook 被当成"新的"→ **再追加一条** ⇒ 双 hook（实测把 settings.json 从 1629 撑到 2872 字节）。
//   新判据：按**脚本名**认出"这是同一个 hook 的不同路径版本" → **原地更新**，不追加。
console.log('\n=== F. 换机/重装不产生双 hook ===');
{
  const H1 = mkHome('f1');
  install(H1);
  const H2 = mkHome('f2');
  // 把 H1（旧路径）的宿主配置整体搬到 H2 → 模拟"目标机已装过一次 CP，现在换机重装"
  for (const rel of ['.claude/settings.json', '.claude.json', '.claude/CLAUDE.md']) {
    const src = path.join(H1, rel), dst = path.join(H2, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { fs.copyFileSync(src, dst); } catch {}
  }
  install(H2, ['--allow-claude-md-skip']);
  const st = rj(path.join(H2, '.claude', 'settings.json')) || {};
  const events = Object.keys(st.hooks || {});
  const dup = events.filter((ev) => (st.hooks[ev] || []).length !== 1);
  check('F-1 每个事件仍只有 1 组 hook（没被追加成 2 组）', dup.length === 0, dup.map((ev) => `${ev}=${st.hooks[ev].length}`).join(', ') || `事件 {${events.join(',')}} 各 1 组`);
  const txt = JSON.stringify(st.hooks || {});
  const oldFwd = H1.replace(/\\/g, '/');
  check('F-2 旧机器路径已从 hook 里清掉（原地更新而非并存）', txt.includes(oldFwd) === false, txt.includes(oldFwd) ? '仍含旧路径' : '无旧路径残留');
  check('F-3 新机器路径在位', txt.replace(/\\\\/g, '/').includes(H2.replace(/\\/g, '/')));
}

// ── 实验 G：未登记项挡板（**清单不许靠回忆列**）─────────────────────────────
// 背景（一次真实事故）：打包清单靠回忆列 → 整个 `~/.claude/cc-haha/`（模型/密钥真源）被漏掉
//   → 新机上要重配模型。⇒ 打包器改为**机械枚举 + 显式登记表**，未登记即拒绝打包。
// 本实验用**假 home** 安全验证（挡板检查的是 `--home` 指向的目录，不动真配置）。
console.log('\n=== G. 未登记项挡板 ===');
{
  const SRCH = path.join(SB, 'guard-home');
  fs.mkdirSync(path.join(SRCH, '.claude', 'cc-haha'), { recursive: true });
  fs.writeFileSync(path.join(SRCH, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(SRCH, '.claude.json'), '{}');
  fs.writeFileSync(path.join(SRCH, '.claude', 'CLAUDE.md'), '# x\n');
  fs.writeFileSync(path.join(SRCH, '.claude', 'cc-haha', 'providers.json'), '{}');
  fs.writeFileSync(path.join(SRCH, '.claude', 'cc-haha', 'settings.json'), '{}');
  const pkArgs = (out) => [path.join(CANDIDATE, 'scripts', 'packaging', 'pack-bundle.cjs'), '--out', path.join(SB, out), '--no-model', '--home', SRCH,
    '--root', SOURCE_ROOT,
    '--client-src', path.join(SB, 'fake-client'), '--sts-src', path.join(SB, 'fake-sts')];

  const ok = run(pkArgs('g-ok'));
  check('G-1 全登记时打包放行', ok.status === 0, `status=${ok.status}`);

  fs.mkdirSync(path.join(SRCH, '.claude', 'SIM-NEW-THING'), { recursive: true });
  fs.writeFileSync(path.join(SRCH, '.claude', 'SIM-NEW-THING', 'x.txt'), 'x');
  fs.mkdirSync(path.join(SRCH, '.claude', 'cc-haha', 'sim-store'), { recursive: true });
  fs.writeFileSync(path.join(SRCH, '.claude', 'cc-haha', 'sim-store', 'y.json'), 'y');
  const bad = run(pkArgs('g-bad'));
  let parsed = null;
  try { parsed = JSON.parse(String(bad.stdout || '').replace(/^[\s\S]*?(\{)/, '$1')); } catch {}
  check('G-2 有未登记项 → **拒绝打包**', bad.status !== 0, `status=${bad.status}`);
  const un = (parsed && parsed.unregistered) || [];
  check('G-3 精确指出是哪两个未登记项', un.length === 2 && un.some((x) => /SIM-NEW-THING/.test(x)) && un.some((x) => /sim-store/.test(x)), un.join(', '));
  fs.rmSync(path.join(SRCH, '.claude', 'SIM-NEW-THING'), { recursive: true, force: true });
  fs.rmSync(path.join(SRCH, '.claude', 'cc-haha', 'sim-store'), { recursive: true, force: true });
  check('G-4 清掉未登记项后恢复放行', run(pkArgs('g-ok2')).status === 0);
}

console.log(`\n===== lander-bundle-test: ${pass} passed / ${fail} failed =====`);
process.exit(fail ? 1 : 0);
