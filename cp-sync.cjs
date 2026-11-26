#!/usr/bin/env node
// cp-sync.cjs — CP 双仓同步器（2026-11-18）
//   引擎仓：本目录（cosmic-phantom），只放代码/技能/测试
//   数据仓：默认 ~/cp-memory，镜像 memories/daily/distilled/pro/.context/work/views + 状态文件
//
// 用法：
//   node cp-sync.cjs engine status            看引擎仓改动
//   node cp-sync.cjs engine commit [-m 说明]  提交引擎仓（带 Made-with: Proma）
//   node cp-sync.cjs engine push              推送引擎仓（需已配 origin）
//   node cp-sync.cjs data push [-m 说明]      把数据镜像到 ~/cp-memory 并提交+推送
//   node cp-sync.cjs data pull                从 ~/cp-memory 拉回（换机恢复用）
//   node cp-sync.cjs all                      引擎提交+推送，然后数据提交+推送
//
// 设计约束：
//   - 只用本机便携 git（tools/git），不依赖 PATH
//   - 推送前校验 remote 存在，否则显式报错（不静默吞）
//   - 数据仓没有 .git 时自动 init 并生成 .gitignore（只允许数据路径）
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync } = require('node:fs');
const { join, dirname, basename } = require('node:path');
const { homedir } = require('node:os');

const ROOT = __dirname;
const GIT = [
  process.env.CP_GIT,
  join(ROOT, 'tools', 'git', 'cmd', 'git.exe'),
  join(ROOT, 'tools', 'git', 'mingw64', 'bin', 'git.exe'),
  'git',
].filter(Boolean).find((p) => p === 'git' || existsSync(p));

const DATA_DIR = process.env.CP_DATA_DIR || join(homedir(), 'cp-memory');
const TRAILER = 'Made-with: Proma';

// 2026-11-19：推送前把 WAL 落盘。events.db-wal/-shm 不进版本库，
//   若推时 WAL 里还有未 checkpoint 的事务，远端拿到的是残缺库。
function checkpointWal(dbPath) {
  if (!existsSync(dbPath)) return { ok: true, skipped: true };
  const code = 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA wal_checkpoint(TRUNCATE)");d.close();';
  const r = spawnSync(process.execPath, ["--experimental-sqlite", "-e", code, dbPath], { encoding: "utf8", timeout: 30000 });
  return { ok: r.status === 0, err: (r.stderr || "").split(String.fromCharCode(10))[0] };
}

const DATA_ITEMS = [
  "events.db",   // 真源逐字事件库（2026-11-19 用户决定纳入接管：它是唯一无法重建的东西）
  'memories', 'candidates', 'daily', 'distilled', 'pro', '.context', 'work', 'views',
  'AGENTS.md', 'MEMORY.md', 'current-state.json', 'state-timestamps.json', 'resume-manifest.json',
  'hosts.json', 'change-log.jsonl', 'change-baseline.json', 'coverage-history.json',
  'failopen-stats.json',   // fail-open 计数（2026-11-19）：换机保留才有跨机对比基线
  'event-index.json', 'links.json', 'tags-baseline.json', 'embedding-db/vectors.json', '.proma-cursor.json', 'processed.json',
  'eval/heldout-baseline.json', 'eval/baseline-history.jsonl', 'eval/suite-accepts.jsonl',
  'eval/last-result.json',   // 2026-11-19：基线闸读它；入镜像，否则换机后 F17/基线闸直接失效
];

const DATA_GITIGNORE = `# cp-memory：只放 CP 的数据层（由 cp-sync.cjs 镜像写入）
node_modules/
tools/
delivery/
embedding-db/models/
backup/
.flags/
events.db-wal
events.db-shm
memory-index.db
fingerprints.db
hook-errors.log
*.tmp
*.log
`;

const say = (m) => console.log(m);
const die = (m) => { console.error('❌ ' + m); process.exit(1); };

function git(cwd, args, { quiet = false } = {}) {
  if (!GIT) die('找不到 git（tools/git 缺失且 PATH 无 git）');
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf8', timeout: 120000 });
  if (!quiet && r.stdout) process.stdout.write(r.stdout);
  if (!quiet && r.stderr) process.stderr.write(r.stderr);
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

function commitMessage(explicit) {
  if (explicit) return `${explicit}\n\n${TRAILER}`;
  const at = new Date().toISOString();
  return `sync: CP 自动同步 ${at}\n\n${TRAILER}`;
}

function hasRemote(cwd) {
  const r = git(cwd, ['remote'], { quiet: true });
  return r.ok && r.out.trim().length > 0;
}

// 身份兜底（2026-11-18 实案：引擎仓缺 user.name/email → 每次 commit 静默失败，
// 而旧版提示把它写成「无改动或提交失败」，人根本看不出仓已经脏了三天）。
// 新机器 clone 后必然没有身份 → 这里自动补本地身份，保证「clone 就能提交」。
function ensureIdentity(cwd, name = 'cosmic-phantom') {
  const has = (k) => { const r = git(cwd, ['config', k], { quiet: true }); return r.ok && r.out.trim().length > 0; };
  let fixed = false;
  if (!has('user.name')) { git(cwd, ['config', 'user.name', name], { quiet: true }); fixed = true; }
  if (!has('user.email')) { git(cwd, ['config', 'user.email', 'cp@local'], { quiet: true }); fixed = true; }
  if (fixed) say(`[sync] 已补本机 git 身份（${name} <cp@local>）`);
}

function ensureDataRepo() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(join(DATA_DIR, '.git'))) {
    say(`[data] 初始化数据仓 ${DATA_DIR}`);
    git(DATA_DIR, ['init', '-q']);
    git(DATA_DIR, ['config', 'user.name', 'cp-memory']);
    git(DATA_DIR, ['config', 'user.email', 'cp@local']);
  }
  const gi = join(DATA_DIR, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, DATA_GITIGNORE, 'utf8');
  else {
    // 旧仓曾把整个 embedding-db 忽略，导致可重建的 vectors.json 也无法同步；只修正本工具管理的规则。
    const current = readFileSync(gi, 'utf8');
    const repaired = current.replace(/^embedding-db\/$/m, 'embedding-db/models/');
    if (repaired !== current) writeFileSync(gi, repaired, 'utf8');
  }
  ensureIdentity(DATA_DIR, 'cp-memory');
}

function mirrorToData() {
  let n = 0;
  for (const item of DATA_ITEMS) {
    const src = join(ROOT, item);
    if (!existsSync(src)) continue;
    const dst = join(DATA_DIR, item);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, force: true });
    n++;
  }
  say(`[data] 已镜像 ${n} 项 → ${DATA_DIR}`);
}

function mirrorFromData() {
  let n = 0;
  for (const item of DATA_ITEMS) {
    const src = join(DATA_DIR, item);
    if (!existsSync(src)) continue;
    const dst = join(ROOT, item);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, force: true });
    n++;
  }
  say(`[data] 已从 ${DATA_DIR} 拉回 ${n} 项`);
}

function cmdPull(opt) {
  // 2026-11-19：跨机协作的「开工前拉取」。之前只有 push，没有 pull —— 别的机器推过之后，
  //   本机 origin 引用是旧的，F50 会误报「已同步」。这里显式 fetch 再快进。
  const repos = [{ name: "engine", dir: ROOT }, { name: "data", dir: DATA_DIR }];
  const out = [];
  for (const r of repos) {
    if (!existsSync(join(r.dir, ".git"))) { out.push({ repo: r.name, skipped: "不是 git 仓" }); continue; }
    git(r.dir, ["fetch", "--prune", "origin"], { quiet: true });
    const br = git(r.dir, ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true }).out.trim();
    const up = "origin/" + br;
    const lr = git(r.dir, ["rev-list", "--left-right", "--count", up + "...HEAD"], { quiet: true });
    const parts = lr.out.trim().split(String.fromCharCode(9));
    const nums = (parts.length >= 2 ? parts : lr.out.trim().split(" ")).map(Number);
    const behind = lr.ok ? (Number.isFinite(nums[0]) ? nums[0] : 0) : 0;
    const ahead = lr.ok ? (Number.isFinite(nums[1]) ? nums[1] : 0) : 0;
    const dirty = git(r.dir, ["status", "--porcelain"], { quiet: true }).out.trim();
    const row = { repo: r.name, branch: br, behind, ahead, dirty: dirty ? dirty.split(String.fromCharCode(10)).length : 0 };
    if (!opt.dryRun && dirty) { row.action = "skipped-dirty"; }
    else if (!opt.dryRun && behind > 0 && ahead > 0) { row.action = "diverged"; }
    else if (!opt.dryRun && behind > 0) {
      const p = git(r.dir, ["pull", "--ff-only", "origin", br], { quiet: true });
      row.action = p.ok ? "pulled" : "pull-failed";
      if (!p.ok) row.err = p.out.split(String.fromCharCode(10))[0];
    } else { row.action = ahead > 0 ? "local-ahead" : "up-to-date"; }
    out.push(row);
  }
  out.push({ note: "events.db 是二进制：多主允许写入，但两边同时产生新提交时 Git 无法合并；此时按数据库指纹和事件级来源定位分叉" });
  return out;
}
function cmdEngine(sub, opt) {
  if (sub === 'status') return git(ROOT, ['status', '--short']);
  if (sub === 'commit') {
    ensureIdentity(ROOT);
    git(ROOT, ['add', '-A']);
    const dirty = git(ROOT, ['status', '--porcelain'], { quiet: true }).out.trim();
    if (!dirty) { say('[engine] 无改动'); return { ok: true, skipped: true }; }
    const r = git(ROOT, ['commit', '-m', commitMessage(opt.msg)], { quiet: true });
    if (!r.ok) die('引擎仓提交失败（仓里有改动但提交不了）：' + r.out.trim().split('\n')[0]);
    say('[engine] 已提交');
    return r;
  }
  if (sub === 'push') {
    if (!hasRemote(ROOT)) die('引擎仓未配置 remote：git remote add origin <url>');
    const r = git(ROOT, ['push', '-u', 'origin', 'HEAD']);
    if (!r.ok) die('引擎仓推送失败（见上面输出）');
    say('[engine] 已推送');
    return r;
  }
  die('用法: engine status|commit|push');
}

function cmdData(sub, opt) {
  ensureDataRepo();
  if (sub === 'push') {
    const ck = checkpointWal(join(ROOT, "events.db"));
    if (!ck.ok) die('[data] WAL checkpoint 失败，已停止同步：' + (ck.err || '未知错误'));
    say("[data] WAL 已 checkpoint（推送前落盘）");
    mirrorToData();
    const tracked = git(DATA_DIR, ['ls-files', '--error-unmatch', 'events.db'], { quiet: true });
    if (!tracked.ok && existsSync(join(DATA_DIR, 'events.db'))) die('[data] events.db 未被数据仓跟踪，拒绝继续推送');
    git(DATA_DIR, ['add', '-A']);
    const dirty = git(DATA_DIR, ['status', '--porcelain'], { quiet: true }).out.trim();
    if (!dirty) {
      say('[data] 无改动');
    } else {
      const r = git(DATA_DIR, ['commit', '-m', commitMessage(opt.msg)], { quiet: true });
      if (!r.ok) die('数据仓提交失败（有改动但提交不了）：' + r.out.trim().split('\n')[0]);
      say('[data] 已提交');
    }
    if (!hasRemote(DATA_DIR)) {
      say('[data] ⚠️ 未配置 remote，仅本地提交。配置：');
      say(`       cd "${DATA_DIR}" && "${GIT}" remote add origin https://github.com/<你>/cp-memory.git`);
      return { ok: true, noRemote: true };
    }
    const p = git(DATA_DIR, ['push', '-u', 'origin', 'HEAD']);
    if (!p.ok) die('数据仓推送失败（见上面输出）');
    say('[data] 已推送');
    return p;
  }
  if (sub === 'pull') {
    const remote = git(DATA_DIR, ['remote'], { quiet: true });
    if (remote.ok && remote.out.trim()) {
      git(DATA_DIR, ['fetch', '--prune', 'origin'], { quiet: true });
      const br = git(DATA_DIR, ['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }).out.trim();
      const up = git(DATA_DIR, ['rev-parse', 'origin/' + br], { quiet: true });
      const dirty = git(DATA_DIR, ['status', '--porcelain'], { quiet: true }).out.trim();
      if (dirty) die('[data] 数据仓有未提交改动，停止拉回，避免覆盖本地数据');
      if (up.ok) {
        const lr = git(DATA_DIR, ['rev-list', '--left-right', '--count', 'origin/' + br + '...HEAD'], { quiet: true });
        const [behind, ahead] = lr.out.trim().split(/\s+/).map(Number);
        if (behind > 0 && ahead > 0) die('[data] 数据仓已分叉，拒绝覆盖；先按事件级来源处理 events.db');
        if (behind > 0) {
          const pulled = git(DATA_DIR, ['pull', '--ff-only', 'origin', br], { quiet: true });
          if (!pulled.ok) die('[data] 数据仓快进拉取失败：' + pulled.out.trim().split('\n')[0]);
        }
      }
    }
    mirrorFromData();
    return { ok: true };
  }
  if (sub === 'status') return git(DATA_DIR, ['status', '--short']);
  die('用法: data push|pull|status');
}

const [,, cmd, sub, ...rest] = process.argv;
const opt = { msg: rest.includes('-m') ? rest[rest.indexOf('-m') + 1] : undefined };
if (!GIT) die('找不到 git 便携包（tools/git）');
if (cmd === 'engine') cmdEngine(sub, opt);
else if (cmd === 'data') cmdData(sub, opt);
else if (cmd === 'pull') {
  const rows = cmdPull({ dryRun: process.argv.includes("--dry-run") });
  process.stdout.write(JSON.stringify(rows, null, 2) + String.fromCharCode(10));
}
else if (cmd === 'doctor') {
  const { doctor } = require('./doctor.cjs');
  const r = doctor({ root: ROOT, dataDir: DATA_DIR, gitBin: GIT });
  process.stdout.write(JSON.stringify(r, null, 2) + String.fromCharCode(10));
  process.exitCode = r.ok ? 0 : 1;
}
else if (cmd === 'link') {
  const { link } = require('./doctor.cjs');
  const r = link({ root: ROOT, dataDir: DATA_DIR, apply: process.argv.includes('--apply') });
  process.stdout.write(JSON.stringify(r, null, 2) + String.fromCharCode(10));
}
else if (cmd === 'all') {
  // 2026-11-19（用户拍板：多主，凡有 push 权限的机器都能写）：push 前必须先拉。
  //   落后就 --ff-only 快进；分叉/脏/拉失败一律停，绝不在落后状态 push。
  const pre = cmdPull({ dryRun: true }).filter((r) => r && r.repo);
  if (pre.some((r) => r.behind > 0)) {
    say('[all] 检测到落后，先 pull');
    cmdPull({});
    const after = cmdPull({ dryRun: true }).filter((r) => r && r.repo);
    const stuck = after.filter((r) => r.behind > 0 || r.ahead > 0 || r.action === 'pull-failed' || r.action === 'diverged' || r.action === 'skipped-dirty');
    if (stuck.length) {
      process.stderr.write(JSON.stringify({ ok: false, stage: 'pre-pull', stuck }, null, 2) + String.fromCharCode(10));
      process.exit(3);
    }
  }
  cmdEngine('commit', opt); cmdEngine('push', opt); cmdData('push', opt);
}
else {
  console.log('用法: node cp-sync.cjs <engine|data|all> <status|commit|push|pull> [-m "说明"]');
  process.exit(2);
}