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

const REAL = path.join(os.homedir(), '.cosmic-phantom');
const NODE = path.join(REAL, 'tools', 'node', 'node.exe');
const SRC_USER = path.basename(os.homedir());   // 源机用户名（用于“漏网残留”判据）
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
const run = (args, opts = {}) => spawnSync(NODE, args, { encoding: 'utf8', timeout: 600000, ...opts });
const rd = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const rj = (f) => { try { return JSON.parse(rd(f)); } catch { return null; } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lander-'));
process.on('exit', () => { try { fs.rmSync(SB, { recursive: true, force: true }); } catch {} });
const BUNDLE = path.join(SB, 'bundle');

// ── 打一个轻量测试包（假外部包 + --no-model，几秒完成）────────────────────
console.log('=== 准备：打轻量测试包 ===');
for (const [id, files] of [['fake-client', ['Claude Code Haha.exe', 'resources/app.asar']], ['fake-sts', ['hooks/stop-that-shit-claude.cjs']]]) {
  for (const f of files) {
    fs.mkdirSync(path.join(SB, id, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(SB, id, f), 'FAKE-' + id);
  }
}
// ⚠️ 安全：**必须用 --home 指向一个假 home**，否则 packer 会读真实 `~/.claude/cc-haha/providers.json`
//   → **把真 API 密钥打进临时目录**。测试绝不该碰真密钥。
const SRC_HOME = path.join(SB, 'src-home');
fs.mkdirSync(path.join(SRC_HOME, '.claude', 'cc-haha'), { recursive: true });
// ⚠️ 教训（2026-09-19 实测踩到）：这三件是 **CP 自己的接入件**，必须**从真源拷**，不能造假 ——
//   我一开始图省事写成 `{mcpServers:{}}`，把 CP 自己的 MCP 注册也"假掉"了 →
//   落地器回读断言正确地报"注册里没有 cosmic-phantom" → **13 条测试假红**，看着像产品坏了。
//   **脚手架造假也会把真依赖一起假掉**（与早先 setup.cjs 删自身目录那次同族）。
const HOMEDIR = os.homedir();
const HOMEDIR_FWD = HOMEDIR.replace(/\\/g, '/');
const SRC_FWD = SRC_HOME.replace(/\\/g, '/');
for (const rel of ['.claude.json', '.claude/settings.json', '.claude/CLAUDE.md']) {
  try {
    let t = fs.readFileSync(path.join(HOMEDIR, rel), 'utf8');
    // ⚠️ 关键：packer 的占位符表 = `--home` 的取值（此处是 SRC_HOME）。
    //   从真源拷来的文件里写的是**真实**家目录路径 → 不在占位符表里 → **不会被替换成 `<USER_HOME>`**
    //   → payload 带着源机绝对路径旅行（实测表现为"MCP 注册指向源机 CP 根"）。
    //   所以必须先把真路径改写成 SRC_HOME，占位符才生效。
    t = t.split(HOMEDIR_FWD).join(SRC_FWD).split(HOMEDIR).join(SRC_HOME);
    const dst = path.join(SRC_HOME, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, t);
  } catch {}
}
fs.writeFileSync(path.join(SRC_HOME, '.claude', 'cc-haha', 'providers.json'), JSON.stringify({
  schemaVersion: 5, activeId: 'FAKE-SRC', providers: [{ id: 'FAKE-SRC', name: 'fakeSrc', apiKey: FAKE_SOURCE_KEY, baseUrl: 'https://fake.invalid' }],
}, null, 2));
fs.writeFileSync(path.join(SRC_HOME, '.claude', 'cc-haha', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'fake-src-model' } }, null, 2));

const pk = run([path.join(REAL, 'scripts', 'packaging', 'pack-bundle.cjs'), '--out', BUNDLE, '--no-model', '--home', SRC_HOME,
  '--client-src', path.join(SB, 'fake-client'), '--sts-src', path.join(SB, 'fake-sts')]);
if (pk.status !== 0) { console.error('打包失败，无法继续：\n' + String(pk.stdout || '').slice(-400) + String(pk.stderr || '').slice(-400)); process.exit(1); }
const man = rj(path.join(BUNDLE, 'MANIFEST.json'));
check('打包成功且清单条数 == CHECKSUMS 行数',
  !!man && rd(path.join(BUNDLE, 'CHECKSUMS.sha256')).split('\n').filter(Boolean).length === man.checksumCount,
  man ? `声明 ${man.checksumCount}` : '无 MANIFEST');

const install = (home, extra = []) => run([path.join(REAL, 'scripts', 'packaging', 'install-bundle.cjs'), '--bundle', BUNDLE,
  '--home', home, '--root', path.join(home, '.cosmic-phantom'), '--apply', '--no-shortcuts', ...extra]);

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
  const st = rj(path.join(H, '.claude', 'settings.json')) || {};
  check('退出 4（包侧全通）', r.status === 4, `status=${r.status}`);
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
  check('加 --allow-claude-md-skip 后 exit 4', r2.status === 4, `status=${r2.status}`);
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
  const pkArgs = (out) => [path.join(REAL, 'scripts', 'packaging', 'pack-bundle.cjs'), '--out', path.join(SB, out), '--no-model', '--home', SRCH,
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
