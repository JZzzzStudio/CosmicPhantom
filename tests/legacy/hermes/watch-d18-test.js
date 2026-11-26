// tests/watch-d18-test.js — D18 守护生命周期验收测试 v3（隔离副本，2026-08-08 晚 最终版）
// 覆盖工程师 S1-S11 状态验证 + ended_at 最终同步（不退出）+ 单实例 5 场景 + 路径拒绝（含相对真实文件）
// 用法：node --experimental-sqlite tests/legacy/hermes/watch-d18-test.js（仅历史复现）
// 说明：被测代码 = R2（原隔离副本 review2；2026-08-12 起隔离副本未随迁本机且 REVIEW2 未授权，
//       无独立代码快照 → 被测代码改用当前生产根，见 R2 定义）；生产根（REAL）仅用于零污染断言；全部沙箱化
const { spawnSync, spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R2 = path.join(os.homedir(), '.cosmic-phantom'); // 原 .cosmic-phantom-review2（8-08 评审隔离副本，本机未随迁；REVIEW2 未授权无独立快照 → 用当前生产根）
const REAL = path.join(os.homedir(), '.cosmic-phantom');
const NODE = path.join(REAL, 'tools', 'node', 'node.exe');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-wd18-'));
const SB_ROOT = path.join(SB, 'root');
// 2026-08-12：进程列举脚本（wmic 在 Win11 24H2 移除；cscript+WMI 不创建 PowerShell）
const VBS_PATH = path.join(SB, 'watch-pids.vbs');
fs.writeFileSync(VBS_PATH, [
  'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
  "Set procs = wmi.ExecQuery(\"SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'\")",
  'For Each p In procs',
  '  WScript.Echo p.ProcessId & "|" & p.CommandLine',
  'Next',
].join('\r\n'));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail || ''}`); }
}
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
// 生产零污染快照（T10 用；K40 教训：涉及生产路径的测试必须内置零污染断言）
const sha256 = (f) => { try { return require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return 'missing'; } };
const prodGuardFiles = () => {
  // 用户红线：测试前后检查生产 hook-errors.log、memories、MCP 配置（events.db/daily 允许合法增长，单独断言）
  const h = {};
  const hel = path.join(REAL, 'hook-errors.log');
  h.hookErrors = fs.existsSync(hel) ? sha256(hel) : 'missing';
  const memDir = path.join(REAL, 'memories');
  h.memories = fs.existsSync(memDir) ? fs.readdirSync(memDir).sort().map(n => `${n}:${sha256(path.join(memDir, n))}`).join(',') : 'missing';
  h.mcpConfig = sha256(path.join(REAL, 'resources', 'mcp-server', 'index.js'));
  return h;
};
const prodGuardBefore = prodGuardFiles();
const prodBefore = (() => {
  try {
    const d = new (require('node:sqlite').DatabaseSync)(path.join(REAL, 'events.db'), { readOnly: true });
    const m = {}; for (const r of d.prepare('SELECT key,value FROM meta').all()) m[r.key] = r.value;
    const c = d.prepare('SELECT COUNT(*) c FROM events').get().c; d.close();
    return { ...m, events: c };
  } catch { return null; }
})();
function watchPids() {
  // 2026-08-12：wmic 在 Win11 24H2 已移除 → 改用 cscript + WMI（同源，不创建 PowerShell，遵守弹窗红线）
  // VBS 临时脚本在 SB 创建时写入（见上）；WMI CommandLine 含完整命令行
  try {
    const out = execFileSync('cscript', ['//nologo', VBS_PATH], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const i = line.indexOf('|');
      if (i < 0) continue;
      const cmd = line.slice(i + 1);
      if (cmd.includes('watch-state.js') && cmd.includes('cp-wd18')) pids.push(Number(line.slice(0, i)));
    }
    return pids;
  } catch { return []; }
}
function killPids(pids) { for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch {} } }
function waitFor(fn, timeoutMs, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fn()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 300);
  });
}
function prodMeta() {
  try {
    const d = new (require('node:sqlite').DatabaseSync)(path.join(REAL, 'events.db'), { readOnly: true });
    const m = {}; for (const r of d.prepare('SELECT key,value FROM meta').all()) m[r.key] = r.value;
    const c = d.prepare('SELECT COUNT(*) c FROM events').get().c; d.close();
    return { ...m, events: c };
  } catch { return null; }
}

(async () => {
  console.log('=== T0 前置状态（S1 初始无 watcher / S10 任务计划 / S3 静态路径校验）===');
  const pids0 = watchPids();
  check('S1 初始没有 watcher', pids0.length === 0, `触发: 测试开始 | 观察: ${JSON.stringify(pids0)} | 失败条件: 有残留 watcher`);
  // 2026-08-09：任务查询改用 schtasks.exe（非 PowerShell；用户指令 #9）
  const verifyTask = spawnSync('schtasks', ['/query', '/tn', 'CosmicPhantom-Verify', '/fo', 'csv'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const watchTask = spawnSync('schtasks', ['/query', '/tn', 'CosmicPhantom-Watch', '/fo', 'csv'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  // S10 语义修订（2026-09-01 用户拍板方案 b）：禁 Watch（轮询类违事件驱动铁律，必须不存在）；
  //   Verify 允许缺席（verify 已事件驱动全覆盖：wrap-up 六步 + maintain，定时兜底不再是必需品）
  const watchAbsent = watchTask.status !== 0;
  const tasks = watchAbsent ? (verifyTask.status === 0 ? 'CosmicPhantom-Verify(事件驱动为主)' : 'Verify=缺席(允许)') : 'Watch=存在(违规)';
  check('S10 禁 Watch（无轮询任务；Verify 允许缺席）', watchAbsent, `触发: schtasks 查询 | 观察: ${tasks} | 失败条件: Watch 任务存在`);
  // Hermes 已退役；当前版本不再携带 state-db-path.txt。保留路径校验为显式跳过，避免把历史配置当生产能力。
  console.log('  [SKIP·退役] S3 state-db-path.txt：Hermes 已退役，当前版本不携带该机器配置');

  console.log('=== T1 语法与机制存在性 ===');
  let r = spawnSync(NODE, ['--check', path.join(R2, 'scripts', 'legacy', 'hermes', 'watch-state.js')], { encoding: 'utf8' });
  check('watch-state.js 语法', r.status === 0, r.stderr.slice(0, 120));
  r = spawnSync(NODE, ['--check', path.join(R2, 'resources', 'mcp-server', 'index.js')], { encoding: 'utf8' });
  check('mcp-server/index.js 语法', r.status === 0, r.stderr.slice(0, 120));
  const ws = fs.readFileSync(path.join(R2, 'scripts', 'legacy', 'hermes', 'watch-state.js'), 'utf8');
  check('ended_at 最终同步机制存在（finalizeSync，不退出）', ws.includes('finalizeSync') && ws.includes('endedNew') && ws.includes('watcher 保持运行') && !ws.includes('finalizeAndExit'), '失败条件: 缺最终同步逻辑或残留退出逻辑');
  check('单实例锁为 PID+活性验证（wx 原子 + fd 写 PID）', ws.includes('pidAlive') && ws.includes('僵尸锁') && ws.includes('openSync(LOCK, "wx")') && ws.includes('writeSync(fd'), '失败条件: 锁无活性验证或未用 fd 写 PID');
  check('最终同步确认（游标一致+无待投影；失败保留原始事件）', ws.includes('Number(st.cursor) === maxId') && ws.includes('projected') && ws.includes('未完全追平'), '失败条件: 同步前无追平确认');
  check('语义词只整理不停止', ws.includes('endedSemantic') && ws.includes('runMaintain()'), '失败条件: 语义词触发停止');

  console.log('=== T2 沙箱准备 ===');
  for (const d of ['memories', 'daily', 'backup', 'topics', 'distilled', 'pro', 'resources/mcp-server']) fs.mkdirSync(path.join(SB_ROOT, d), { recursive: true });
  fs.mkdirSync(path.join(SB_ROOT, 'scripts', 'legacy', 'hermes'), { recursive: true });
  fs.copyFileSync(path.join(R2, 'scripts', 'legacy', 'hermes', 'poll-state.js'), path.join(SB_ROOT, 'scripts', 'legacy', 'hermes', 'poll-state.js'));
  fs.copyFileSync(path.join(R2, 'scripts', 'legacy', 'hermes', 'watch-state.js'), path.join(SB_ROOT, 'watch-state.js'));
  for (const f of ['events.js', 'log_turn.js', 'link-graph.js', 'skills-sync.js', 'memory-cli.js', 'memory-retrieval.js', 'package.json']) fs.copyFileSync(path.join(R2, f), path.join(SB_ROOT, f));
  execFileSync('cmd', ['/c', 'mklink', '/J', path.join(SB_ROOT, 'tools'), path.join(REAL, 'tools')], { stdio: 'ignore' });
  const sbDb = path.join(SB, 'state.db');   // 必须叫 state.db：watcher 只响应 state.db 家族（S6/E1 的 fs.watch 触发依赖）
  const d = new (require('node:sqlite').DatabaseSync)(sbDb);
  d.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, tool_calls TEXT); CREATE TABLE sessions(id TEXT, ended_at TEXT);");
  for (const [i, c] of [[1, '补漏消息1'], [2, '补漏消息2']]) d.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(i, 'sA', 'user', c, null, null);
  d.close();
  check('沙箱就绪（db + 引擎拷贝）', fs.existsSync(sbDb) && fs.existsSync(path.join(SB_ROOT, 'watch-state.js')), '失败条件: 沙箱缺件');

  console.log('=== T3 单实例 5 场景 ===');
  // T3a: A 持有锁，B 退出（场景①②）
  const wA = spawn(NODE, ['--experimental-sqlite', path.join(SB_ROOT, 'watch-state.js'), '--db', sbDb, '--root', SB_ROOT], { detached: true, stdio: 'ignore', windowsHide: true });
  wA.unref();
  await new Promise(res => setTimeout(res, 1500));
  const pidsA = watchPids();
  check('场景① A 启动并持有实例锁', pidsA.length === 1, `触发: 启动 A | 观察: ${JSON.stringify(pidsA)} | 失败条件: A 未启动或锁冲突`);
  const wB = spawnSync(NODE, ['--experimental-sqlite', path.join(SB_ROOT, 'watch-state.js'), '--db', sbDb, '--root', SB_ROOT], { encoding: 'utf8', timeout: 30000 });
  const pidsB = watchPids();
  check('场景② B 识别 A 存活并自行退出', pidsB.length === 1 && wB.status === 0, `触发: 启动 B | 观察: B status=${wB.status} watcher=${JSON.stringify(pidsB)} | 失败条件: B 存活或 A 消失`);
  check('B 退出原因已记录（单实例保护）', fs.existsSync(path.join(SB_ROOT, 'hook-errors.log')) && fs.readFileSync(path.join(SB_ROOT, 'hook-errors.log'), 'utf8').includes('持有锁'), '失败条件: 无退出原因记录');
  // T3b: A 被强杀 → 僵尸锁清除 → C 可启动（场景④）——C 是长驻 watcher，必须异步启动（spawnSync 会等退出超时）
  killPids(pidsA);
  await new Promise(res => setTimeout(res, 800));
  const lockLeft = fs.existsSync(path.join(SB_ROOT, '.watch.lock'));
  const wC = spawn(NODE, ['--experimental-sqlite', path.join(SB_ROOT, 'watch-state.js'), '--db', sbDb, '--root', SB_ROOT], { detached: true, stdio: 'ignore', windowsHide: true });
  wC.unref();
  const cUp = await waitFor(() => watchPids().length === 1, 6000);
  const pidsC = watchPids();
  check('场景④ A 被强杀后 C 不被僵尸锁阻塞（可启动且唯一）', lockLeft && cUp && pidsC.length === 1, `触发: 强杀 A(${pidsA.join(',')}) 后异步启动 C | 观察: 锁残留=${lockLeft} C 就绪=${cUp} watcher=${JSON.stringify(pidsC)} | 失败条件: C 未启动或双实例`);
  check('僵尸锁清除已记录', fs.readFileSync(path.join(SB_ROOT, 'hook-errors.log'), 'utf8').includes('清除僵尸锁'), '失败条件: 无僵尸锁清除记录');
  // T3c: 并发首次启动 → 唯一获胜者（场景⑤）
  killPids(pidsC);
  await new Promise(res => setTimeout(res, 500));
  const db2 = path.join(SB, 's2.db');
  const d2 = new (require('node:sqlite').DatabaseSync)(db2);
  d2.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, tool_calls TEXT); CREATE TABLE sessions(id TEXT, ended_at TEXT);");
  d2.close();
  const ROOT2 = path.join(SB, 'root2');
  for (const ddir of ['memories', 'daily', 'backup', 'topics', 'distilled', 'pro', 'resources/mcp-server']) fs.mkdirSync(path.join(ROOT2, ddir), { recursive: true });
  fs.mkdirSync(path.join(ROOT2, 'scripts', 'legacy', 'hermes'), { recursive: true });
  fs.copyFileSync(path.join(R2, 'scripts', 'legacy', 'hermes', 'poll-state.js'), path.join(ROOT2, 'scripts', 'legacy', 'hermes', 'poll-state.js'));
  fs.copyFileSync(path.join(R2, 'scripts', 'legacy', 'hermes', 'watch-state.js'), path.join(ROOT2, 'watch-state.js'));
  for (const f of ['events.js', 'log_turn.js', 'memory-cli.js', 'memory-retrieval.js', 'package.json']) fs.copyFileSync(path.join(R2, f), path.join(ROOT2, f));
  execFileSync('cmd', ['/c', 'mklink', '/J', path.join(ROOT2, 'tools'), path.join(REAL, 'tools')], { stdio: 'ignore' });
  const kids = [];
  await new Promise((resolve) => {
    let closed = 0;
    for (let i = 0; i < 4; i++) {
      const k = spawn(NODE, ['--experimental-sqlite', path.join(ROOT2, 'watch-state.js'), '--db', db2, '--root', ROOT2], { stdio: 'ignore' });
      kids.push(k);
      // 并发 4 进程：3 个锁冲突退出，1 个获胜者长驻（永不退出）——等 3 个关闭即可
      k.on('close', () => { closed++; if (closed >= 3) resolve(); });
    }
  });
  const pidsRace = watchPids();
  check('场景⑤ 并发首次启动最终只有一个 watcher', pidsRace.length === 1, `触发: 4 个并发首次启动 | 观察: ${JSON.stringify(pidsRace)} | 失败条件: 多 watcher 或零 watcher`);
  killPids(pidsRace);

  console.log('=== T4 MCP 拉起（S2）+ 路径使用（S3 动态）+ 启动补漏（S5）===');
  const mcp1 = spawn(NODE, [path.join(R2, 'resources', 'mcp-server', 'index.js'), '--root', SB_ROOT], {
    env: { ...process.env, CP_WATCH_SCRIPT: path.join(SB_ROOT, 'watch-state.js'), CP_WATCH_DB: sbDb, CP_WATCH_ROOT: SB_ROOT, CP_LOG_DIR: SB },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  mcp1.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
  await new Promise(res => setTimeout(res, 2500));
  const pidsM1 = watchPids();
  check('S2 MCP server 启动后 watcher 自动出现', pidsM1.length === 1, `触发: 启动 MCP(env 指向沙箱) | 观察: ${JSON.stringify(pidsM1)} | 失败条件: 无 watcher`);
  const dailyF = path.join(SB_ROOT, 'daily', `${localToday()}.md`);
  const daily1 = fs.existsSync(dailyF) ? fs.readFileSync(dailyF, 'utf8') : '';
  check('S5 启动补漏摄入并投影已有消息', daily1.includes('补漏消息1') && daily1.includes('补漏消息2'), `触发: watcher 启动补漏 | 观察: daily 含补漏消息=${daily1.includes('补漏消息1')} | 失败条件: 未摄入或未投影`);

  console.log('=== T5 新消息触发（S6）===');
  const d3 = new (require('node:sqlite').DatabaseSync)(sbDb);
  d3.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(3, 'sA', 'user', '新消息触发测试', null, null);
  d3.close();
  const gotNew = await waitFor(() => fs.existsSync(dailyF) && fs.readFileSync(dailyF, 'utf8').includes('新消息触发测试'), 20000);
  check('S6 新消息产生的 state.db 事件触发 daily 更新', gotNew, `触发: INSERT 新消息(写 db) | 观察: daily 含新消息=${gotNew} | 失败条件: fs.watch 未触发或未投影`);

  console.log('=== T6 MCP 重连不产生第二个 watcher（S4）===');
  const mcp2 = spawn(NODE, [path.join(R2, 'resources', 'mcp-server', 'index.js'), '--root', SB_ROOT], {
    env: { ...process.env, CP_WATCH_SCRIPT: path.join(SB_ROOT, 'watch-state.js'), CP_WATCH_DB: sbDb, CP_WATCH_ROOT: SB_ROOT, CP_LOG_DIR: SB },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  mcp2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }) + '\n');
  await new Promise(res => setTimeout(res, 2500));
  const pidsM2 = watchPids();
  check('S4 MCP 重连/重复启动不产生第二个 watcher', pidsM2.length === 1, `触发: 第二个 MCP 启动 | 观察: ${JSON.stringify(pidsM2)} | 失败条件: watcher 数 > 1`);
  // 2026-10-28：S4 清理两个 MCP 后，确保沙箱 watcher 仍存活（detached 不应被带走；
  //   若被环境清理，重新拉起再测 S6，避免把“watcher 不在”误报成 fs.watch 丢事件）。
  if (watchPids().length === 0) {
    const wFix = spawn(NODE, ['--experimental-sqlite', path.join(SB_ROOT, 'watch-state.js'), '--db', sbDb, '--root', SB_ROOT], { detached: true, stdio: 'ignore', windowsHide: true });
    wFix.unref();
    await waitFor(() => watchPids().length >= 1, 8000);
  }
  mcp1.stdin.end(); mcp1.kill(); mcp2.stdin.end(); mcp2.kill();

  console.log('=== T7 ended_at 最终同步（E1 不退出 / E2 游标追平 / E3 语义词不停止 / E4 后续落盘）===');
  // E3 先测：语义词不停止
  const d4 = new (require('node:sqlite').DatabaseSync)(sbDb);
  d4.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(4, 'sA', 'user', '今天就到这吧', null, null);
  d4.close();
  await new Promise(res => setTimeout(res, 4000));
  const pidsSem = watchPids();
  check('E3 语义词（"今天就到这吧"）不停止 watcher', pidsSem.length === 1, `触发: INSERT 语义词消息 | 观察: watcher=${JSON.stringify(pidsSem)} | 失败条件: watcher 退出`);
  // E1：ended_at → 最终同步，watcher 保持存活（D18 最终语义：不因 ended_at 退出）
  const d5 = new (require('node:sqlite').DatabaseSync)(sbDb);
  d5.prepare("INSERT INTO sessions(id, ended_at) VALUES('sA', ?)").run(new Date().toISOString());
  d5.close();
  await new Promise(res => setTimeout(res, 4000));
  const pidsEnd = watchPids();
  check('E1 ended_at 触发最终同步且 watcher 保持运行（不退出）', pidsEnd.length === 1, `触发: INSERT sessions.ended_at | 观察: watcher=${JSON.stringify(pidsEnd)} | 失败条件: watcher 退出（D18 语义：不退出）`);
  // E4：ended_at 后活跃会话新消息仍可落盘
  const d7 = new (require('node:sqlite').DatabaseSync)(sbDb);
  d7.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(5, 'sB', 'user', 'ended_at 后新会话消息', null, null);
  d7.close();
  const gotE4 = await waitFor(() => fs.existsSync(dailyF) && fs.readFileSync(dailyF, 'utf8').includes('ended_at 后新会话消息'), 20000);
  check('E4 ended_at 后活跃会话消息仍可落盘', gotE4, `触发: INSERT 新会话消息 | 观察: daily 含新消息=${gotE4} | 失败条件: watcher 停止后新消息丢失`);
  // E2：最终同步后游标追平（events cursor == 真源 MAX(id) 且无待投影）
  const evD = new (require('node:sqlite').DatabaseSync)(path.join(SB_ROOT, 'events.db'), { readOnly: true });
  const cur = evD.prepare("SELECT value FROM meta WHERE key='cursor'").get().value;
  const evCount = evD.prepare('SELECT COUNT(*) c FROM events').get().c;
  const projCount = evD.prepare('SELECT COUNT(*) c FROM projection').get().c;
  evD.close();
  const d6 = new (require('node:sqlite').DatabaseSync)(sbDb, { readOnly: true });
  const maxId = d6.prepare('SELECT MAX(id) m FROM messages').get().m; d6.close();
  check('E2 最终同步后游标与真源一致且无待投影', Number(cur) === maxId && evCount === projCount, `触发: ended_at 后核查 | 观察: cursor=${cur} 真源=${maxId} events=${evCount} projected=${projCount} | 失败条件: 游标落后或待投影非空`);

  console.log('=== T8 路径拒绝（S8）===');
  const before8 = watchPids().length;   // 基线：T7 后应为 1（watcher 保持运行）——断言"不增加"
  const mcp3 = spawn(NODE, [path.join(R2, 'resources', 'mcp-server', 'index.js'), '--root', SB_ROOT], {
    env: { ...process.env, CP_WATCH_SCRIPT: path.join(SB_ROOT, 'watch-state.js'), CP_WATCH_DB: path.join(SB, '不存在.db'), CP_WATCH_ROOT: SB_ROOT, CP_LOG_DIR: SB },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  mcp3.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }) + '\n');
  await new Promise(res => setTimeout(res, 2000));
  const pidsBad = watchPids();
  check('S8a 不存在的数据库路径拒绝启动（watcher 数不增加）', pidsBad.length === before8, `触发: CP_WATCH_DB=不存在路径 | 观察: 前=${before8} 后=${JSON.stringify(pidsBad)} | 失败条件: watcher 被新拉起`);
  mcp3.stdin.end(); mcp3.kill();
  // S8b/S8c：相对路径拒绝——S8c 用**真实存在**的相对路径文件（评审小修 2：绝对路径显式检查）
  // spawn cwd 指向 SB（使相对路径 'state.db' 真实存在），CP_WATCH_DB='state.db' 仍必须被拒绝
  const mcp4 = spawn(NODE, [path.join(R2, 'resources', 'mcp-server', 'index.js'), '--root', SB_ROOT], {
    cwd: SB,
    env: { ...process.env, CP_WATCH_SCRIPT: path.join(SB_ROOT, 'watch-state.js'), CP_WATCH_DB: 'state.db', CP_WATCH_ROOT: SB_ROOT, CP_LOG_DIR: SB },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  mcp4.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} }) + '\n');
  await new Promise(res => setTimeout(res, 2000));
  const relPathReal = fs.existsSync(path.join(SB, 'state.db'));   // 相对路径文件真实存在
  check('S8b 相对路径拒绝启动（watcher 数不增加）', relPathReal && watchPids().length === before8, `触发: CP_WATCH_DB=相对路径'state.db'（cwd=SB，文件真实存在=${relPathReal}） | 观察: watcher=${JSON.stringify(watchPids())} | 失败条件: 相对路径被接受（isAbsolute 检查缺失）`);
  mcp4.stdin.end(); mcp4.kill();

  console.log('=== T9 杀进程后下一 MCP 会话重新拉起（S7）===');
  const mcp5 = spawn(NODE, [path.join(R2, 'resources', 'mcp-server', 'index.js'), '--root', SB_ROOT], {
    env: { ...process.env, CP_WATCH_SCRIPT: path.join(SB_ROOT, 'watch-state.js'), CP_WATCH_DB: sbDb, CP_WATCH_ROOT: SB_ROOT, CP_LOG_DIR: SB },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  mcp5.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'initialize', params: {} }) + '\n');
  await new Promise(res => setTimeout(res, 2500));
  const pidsK = watchPids();
  killPids(pidsK);
  await new Promise(res => setTimeout(res, 800));
  const pidsAfterKill = watchPids();
  check('S7a watcher 被杀后进程消失', pidsAfterKill.length === 0, `触发: kill watcher | 观察: ${JSON.stringify(pidsAfterKill)} | 失败条件: watcher 仍存活`);
  const mcp6 = spawn(NODE, [path.join(R2, 'resources', 'mcp-server', 'index.js'), '--root', SB_ROOT], {
    env: { ...process.env, CP_WATCH_SCRIPT: path.join(SB_ROOT, 'watch-state.js'), CP_WATCH_DB: sbDb, CP_WATCH_ROOT: SB_ROOT, CP_LOG_DIR: SB },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  mcp6.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'initialize', params: {} }) + '\n');
  const rel = await waitFor(() => watchPids().length === 1, 6000);
  check('S7b 下一次 MCP 会话重新拉起 watcher', rel, `触发: 再启 MCP | 观察: watcher 恢复=${rel} | 失败条件: 未重新拉起（僵尸锁阻塞？）`);
  mcp5.stdin.end(); mcp5.kill(); mcp6.stdin.end(); mcp6.kill();
  killPids(watchPids());

  console.log('=== T10 生产用户数据零污染（S9）+ 清理（S11）===');
  const prodAfter = prodMeta();
  // S9 语义化（2026-08-08 修复）：生产身份（instance/signature）不变 + 无测试特征数据；cursor/events 允许增长（生产合法活动）
  check('S9 生产身份未变（instance/signature 不被测试改写）', prodBefore && prodAfter && prodBefore.instance_id === prodAfter.instance_id && prodBefore.instance_short === prodAfter.instance_short && prodBefore.source_signature === prodAfter.source_signature, `触发: 全程测试 | 观察: instance 不变=${prodBefore && prodAfter && prodBefore.instance_id === prodAfter.instance_id} | 失败条件: 生产身份被测试改写`);
  const prodEvC = new (require('node:sqlite').DatabaseSync)(path.join(REAL, 'events.db'), { readOnly: true });
  // S9c 精确判据（v3 修正）：污染 = 非生产实例的事件（cp-wd18 字样会经"工具输出"合法进入生产事件——不能以字样判污染）
  // 2026-08-12 扩展：proma-*/wb-*/session-* 为合法归巢实例前缀（多宿主吸收/落盘，见 20260812 逆向检查），白名单排除
  // 2026-11-19 扩展：purge-audit / redact 是系统审计行（票 10：purge 留痕、脱敏墓碑），属设计内事件，不算测试污染
  const testCnt = prodEvC.prepare("SELECT COUNT(*) c FROM events WHERE instance NOT LIKE '06966896%' AND instance <> 'manual' AND instance NOT LIKE 'proma-%' AND instance NOT LIKE 'wb-%' AND instance NOT LIKE 'session-%' AND instance NOT LIKE 'zcode-msg:%' AND instance NOT IN ('purge-audit','redact')").get().c;
  prodEvC.close();
  check('S9c 生产 events 无非生产实例事件（精确污染判据）', testCnt === 0, `非生产实例事件 ${testCnt} 条`);
  const prodDailyPath = path.join(REAL, 'daily', `${localToday()}.md`);
  const prodDaily = fs.existsSync(prodDailyPath) ? fs.readFileSync(prodDailyPath, 'utf8') : '';   // 跨天时今日文件可能未创建——视为空
  check('S9b 生产 daily 无测试特征串', !prodDaily.includes('补漏消息1') && !prodDaily.includes('D18 测试消息'), '失败条件: 生产 daily 出现测试内容');
  const prodGuardAfter = prodGuardFiles();
  check('S9d 生产 hook-errors.log 未变（测试不写生产日志）', prodGuardBefore.hookErrors === prodGuardAfter.hookErrors, `before=${prodGuardBefore.hookErrors.slice(0, 12)} after=${prodGuardAfter.hookErrors.slice(0, 12)}`);
  check('S9e 生产 memories 未变', prodGuardBefore.memories === prodGuardAfter.memories, '失败条件: 测试写入生产记忆');
  check('S9f 生产 MCP 配置未变', prodGuardBefore.mcpConfig === prodGuardAfter.mcpConfig, '失败条件: 测试改动生产 MCP 配置');
  // 表述修正（工程师确认）：测试调用生产 MCP 会写 hook-errors.log——结论为"生产用户数据零污染"，不称"生产零接触"
  // S11：killPids 后 waitFor 确认真正清理（kill 与查询的时序竞态曾导致假 PASS + 残留 watcher）
  let leftover = watchPids();
  if (leftover.length) { killPids(leftover); await waitFor(() => watchPids().length === 0, 6000); }
  leftover = watchPids();
  check('S11 测试结束 watcher 全部清理', leftover.length === 0, `触发: killPids+waitFor 确认 | 观察: ${JSON.stringify(leftover)} | 失败条件: 残留 watcher`);
  fs.rmSync(SB, { recursive: true, force: true });
  check('S11b 临时根已清理', !fs.existsSync(SB), '失败条件: 临时根残留');

  console.log(`\n===== watch-d18-test v3（D18 生命周期验收，最终版）：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); killPids(watchPids()); process.exit(1); });
