#!/usr/bin/env node
/**
 * install-bundle.cjs — 继承包落地器（2026-09-16 立）
 *
 * 上游设计：pro/inherit-lander-design-20260916.md（四阶段 P0 预检 → P1 还原 → P2 占位符还原 → P3 注册 → P4 自检 L1-L4）
 * 打包器：pack-bundle.cjs（产出 cosmic-phantom/ + claude-home/ + payload/ + MANIFEST.json）
 *
 * 铁律（每条都对应一次真实事故）：
 *   ① **默认 dry-run**，真写必须显式 `--apply`（防手滑）
 *   ② **接入件 merge 不 overwrite** —— `~/.claude.json` 含目标机 Claude Code 自身状态（userID/skillUsage 等），整文件覆盖 = 灾难
 *   ③ **升级模式不碰真源** —— 目标已有 CP 时，events.db / daily / memories / distilled / current-state.json 一律不覆盖
 *   ④ **写后必须回读断言** —— "写进去 ≠ 生效"是用户铁律；回读是本器唯一能部分兑现它的动作
 *   ⑤ **L3/L4 不许并入"通过"** —— 落地器验不了（需宿主会话），只能输出"已注册，待确认"并写进盲区账本
 *   ⑥ **失败即停** —— 不允许"跳过继续"（半装状态比失败更危险）
 *   ⑦ **备份口径** —— 凡本器**写过的已存在文件**必先备份；本器没碰的文件不进备份（含 PROTECT 项，它们永不写入）
 *
 * 用法（在新机上，先用**包内 node** 跑）：
 *   <包>/cosmic-phantom/tools/node/node.exe <包>/cosmic-phantom/scripts/packaging/install-bundle.cjs \
 *     --bundle <包目录> [--root <目标CP根>] [--home <目标用户目录>] [--apply] [--with-plugins] [--force]
 *
 * 退出码（**只有两档**，与 pro/design-vs-impl-audit-20260916.md §四点五 P1 定案一致）：
 *   4 = 包侧全通（P0 校验 + P1 还原 + P2/P3 写入回读 + L1/L2/L3a/L4a）→ **L3b/L4b 待人工确认**
 *   1 = 失败（report.errors 里带所在阶段 P0/P1/P1b/P2/P3/P4）
 *   ⚠️ **没有 0 档**：机器可验的部分全过 ≠ 落地达标 —— 达标必须有宿主侧人工确认（L3b/L4b）。
 *      设计文档曾写三档（含"0 = L1/L2 通过"），但 `finalize(0)` 从来不可达（成功路径固定走 4），
 *      属纸面承诺已删档并对齐。**不要"修"回 0**：那会让"没人在新机真调过一次工具"被读成"装好了"。
 *
 * 备份口径（铁律⑦）：备份落 `<目标根>/backup/install-<ts>/`，映射落 `MAP.json`，`--rollback` 据其逐条拷回。
 *   进备份的三类：① CP 树内被覆盖的文件 ② 宿主三件（`.claude.json` / `settings.json` / `CLAUDE.md`）
 *   ③ 外部包内被覆盖的文件。**PROTECT/PROTECT_REL 清单里的项永不写入**，故无需备份。
 */
'use strict';

const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync, renameSync, copyFileSync, rmSync } = require('node:fs');
const { join, dirname, relative, sep, basename } = require("node:path");
const { homedir } = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require('node:child_process');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const BUNDLE = arg('--bundle');
const TARGET_HOME = arg('--home') || homedir();
const TARGET_ROOT = arg('--root') || join(TARGET_HOME, '.cosmic-phantom');
const APPLY = process.argv.includes('--apply');
const WITH_PLUGINS = process.argv.includes('--with-plugins');
const NO_SHORTCUTS = process.argv.includes('--no-shortcuts');
// 注入层无法合并时的显式开关（2026-09-19 对抗实验 B）：默认硬失败，见 register() ③
const ALLOW_MD_SKIP = process.argv.includes('--allow-claude-md-skip');
const CLIENT_DIR = arg('--client-dir') || join(TARGET_HOME, 'Claude Code Haha');
// 路径重定位表（由 MANIFEST.externalPackages 计算）：把"源机的包外绝对路径"改写到"目标机的新位置"。
//   动机：STS 工具可能被 settings.json 的 extraKnownMarketplaces 引用；
//   它现在随包入包 → 落地时必须把那条路径改指到新位置，否则插件加载不到。
let RELOCATIONS = [];
const FORCE = process.argv.includes('--force');
const REPORT_PATH = arg('--report') || (BUNDLE ? join(BUNDLE, 'INSTALL-REPORT.json') : null);

const PACKED = BUNDLE ? join(BUNDLE, 'cosmic-phantom') : null;
// 运行时解析（审计 F3 / 设计 P3 承诺"用包内 node 跑一次"）：
//   原实现 NODE_EXE = process.execPath，注释写"落地器自己就是用包内 node 跑的"——**这是调用方约定，不是代码保证**。
//   我在源机用源机 node 拉起它，于是 L1/L2/L3a/L4a 四条**全部由源机 node 执行**，
//   "包内 node 在新机能否跑"至今零验证（而它正是 G1 修好后才带上的能力）。
//   新语义：**包内有 node 就一律用它**（含所有子进程），并记进报告 nodeUsed；包内没有则降级用当前 node，
//   同时在报告里置 fallback=true 并告警（不静默——"用的是哪颗 node"必须可查）。
const PACKAGED_NODE = PACKED
  ? [join(PACKED, 'tools', 'node', 'node.exe'), join(PACKED, 'tools', 'node', 'node')].find((p) => existsSync(p))
  : null;
const NODE_EXE = PACKAGED_NODE || process.execPath;
const NODE_FALLBACK = !PACKAGED_NODE;
const CLAUDE_HOME = join(TARGET_HOME, '.claude');

// 升级模式：**覆盖代码与配置，保护数据/状态/档案**（2026-09-16 S1 修正）
//   原实现：任何已存在文件一律跳过 → "只补缺"被实现成"什么都不更新" ⇒ **升级模式装不上新代码**，
//   却报"完成"（语义走偏，比"未实现"更危险，见 pro/design-vs-impl-audit-20260916.md §三）。
//   现在：保护清单外的文件**允许覆盖**，且覆盖前**逐个备份**到 backup/install-<ts>/（回滚有依据）。
const PROTECT = new Set([
  // 真源（绝不可覆盖）
  'events.db', 'daily', 'memories', 'distilled',
  // 状态/档案/回滚点
  'current-state.json', 'backup', '.flags', 'views', 'pro', 'state-timestamps.json', 'docs', 'delivery', 'topics',
  // 数据/台账/机器相关登记（审计 H1：原清单漏掉这些 → 升级会用源机版本覆盖目标机数据）
  'MEMORY.md', '.context', 'change-log.jsonl', 'change-baseline.json',
  'project-root.json', 'hosts.json', 'sources.json', 'eval',
  'hook-errors.log', 'processed.json', 'state-poll.json',
  // 宿主游标 / 机器登记（2026-09-19 对抗实验 C 扫出漏项，**实测确认会被覆盖**）：
  //   原清单逐个列举了 hosts.json/project-root.json/sources.json，但漏了这三个 ——
  //   它们都是"**目标机自己的**读到哪了 / 本机路径登记"，被源机版本覆盖 = 新机游标错位、路径指向源机。
  '.proma-cursor.json', '.wb-cursor.json', 'state-db-path.txt',
  // 派生索引（可重建，覆盖无意义还会引入 churn）
  'memory-index.db', 'links.json', 'fingerprints.db', 'embedding-db',
  // SQLite 边车（2026-09-19 实测事故修复）：`-wal`/`-shm`/`-journal` 是**与某一个具体 .db 配对的瞬时状态**。
  //   原实现只保护 `events.db` 本身 → 升级时源机的 `events.db-wal`/`-shm` 被复制到目标机，
  //   配的却是**目标机自己的** events.db（它受保护、没被覆盖）= 边车与库不配对。
  //   实测证据：bundle 内 events.db-wal(0B) + events.db-shm(32768B)，升级后出现在目标根。
  //   两侧防线：打包器不带（pack-bundle SIDECAR_RE），落地器不写（本条）。
  'events.db-wal', 'events.db-shm', 'events.db-journal',
  'memory-index.db-wal', 'memory-index.db-shm', 'memory-index.db-journal',
  'fingerprints.db-wal', 'fingerprints.db-shm', 'fingerprints.db-journal',
]);
// 目录内需要单独保护的文件（core/ 里既有协议 rules.md，也有三本台账 → 不能整目录一刀切）
const PROTECT_REL = new Set([
  'core/improvement-ledger.md', 'core/absorbed-notes.md', 'core/blindspot-ledger.md',
]);
// 形态保护（2026-09-19 对抗实验 C 的设计层修正）：
//   逐个列举式白名单有个**脆弱默认值** —— "未来新增的状态文件"默认被放行（当作代码覆盖）。
//   宿主游标就是活例子：加了新宿主就会多一个 `.<host>-cursor.json`，没人记得回来改这张表。
//   故按**形态**再兜一层；命中即保护，无需登记。
const PROTECT_RE = [/^\.\w+-cursor\.json$/i];
const PROTECTED = PROTECT;   // 兼容旧名（preflight/报告里引用）
const ADDED_CAP = 5000;      // addedList 上限（见 copyTree 内的 ponytail 注）

const report = { at: null, apply: APPLY, bundle: BUNDLE, targetHome: TARGET_HOME, targetRoot: TARGET_ROOT, nodeUsed: { exe: NODE_EXE, packaged: !!PACKAGED_NODE, fallback: NODE_FALLBACK }, phases: {}, actions: [], errors: [], pending: [] };
const say = (msg) => console.log(`[${APPLY ? 'INSTALL' : 'DRY-RUN'}] ${msg}`);
function fail(phase, msg) {
  report.errors.push({ phase, msg });
  console.error(`❌ [${phase}] ${msg}`);
  const bd = report.phases.P1 && report.phases.P1.backup;
  if (bd) {
    console.error(`\n↩️ 回滚指引（U2）：本次已备份到\n   ${bd}\n   恢复全场：node install-bundle.cjs --rollback --root "${TARGET_ROOT}" --home "${TARGET_HOME}"\n   恢复单个：按 ${join(bd, 'MAP.json')} 里 {backup → target} 逐条手工拷回\n   （备份内已保留原始相对路径，未做任何删除）\n   ⚠️ 备份保留至验收确认（B3-D2）：请勿提前清理——确认前销毁 = 证据与回滚副本双失（9-27 D2 教训）`);
  } else {
    console.error('\n（本次未产生备份：失败发生在写入阶段之前，目标机未被改动）');
  }
  finalize(1);
}

/* ══════════════ U2 回滚：设计 §3 承诺的"回去的路" ══════════════ */
function newestBackupDir() {
  const b = join(TARGET_ROOT, 'backup');
  if (!existsSync(b)) return null;
  const dirs = readdirSync(b).filter((d) => /^install-/.test(d)).sort();
  return dirs.length ? join(b, dirs[dirs.length - 1]) : null;
}

function rollback() {
  const dir = arg('--rollback-dir') || newestBackupDir();
  const out = { ok: false, backupDir: dir, restored: 0, missing: [], errors: [] };
  if (!dir || !existsSync(dir)) { out.error = '找不到备份目录（<目标根>/backup/install-*）'; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
  const mapFile = join(dir, 'MAP.json');
  if (!existsSync(mapFile)) { out.error = `备份目录缺 MAP.json：${mapFile}（旧版备份无映射，需手工拷回）`; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
  let map;
  try { map = JSON.parse(readFileSync(mapFile, 'utf8')); } catch (e) { out.error = `MAP.json 解析失败: ${e.message}`; console.log(JSON.stringify(out, null, 2)); process.exit(1); }
  out.files = map.files.length;
  for (const it of map.files) {
    const src = join(dir, it.backup);
    if (!existsSync(src)) { out.missing.push(it.backup); continue; }
    try { mkdirSync(dirname(it.target), { recursive: true }); copyFileSync(src, it.target); out.restored += 1; }
    catch (e) { out.errors.push(`${it.target}: ${e.message}`); }
  }
  // M3（2026-09-16）：`--purge-added` 显式开关 —— 删除"升级时新增"的文件。
  //   默认**不删**（删除是破坏性动作）；需要"真正回到升级前"时显式加此开关。
  const addedList = Array.isArray(map.added) ? map.added : [];
  if (process.argv.includes('--purge-added')) {
    let purged = 0, kept = [];
    for (const f of addedList) {
      try { if (existsSync(f)) { rmSync(f, { force: true }); purged += 1; } } catch (e) { kept.push(`${f}: ${e.message}`); }
    }
    out.purged = purged;
    if (kept.length) out.purgeErrors = kept.slice(0, 5);
  }
  out.ok = out.missing.length === 0 && out.errors.length === 0;
  // 审计 M3 如实标注：本命令**只恢复被覆盖的文件**，不删除"升级时新增"的文件
  //   （未做删除是刻意的：回滚里删文件属破坏性动作，需拍板；宁可诚实标注语义）
  const added = addedList;   // 复用上面已解析的 addedList
  out.scope = process.argv.includes('--purge-added')
    ? '已恢复被覆盖文件，并已删除升级新增的文件（--purge-added）'
    : '仅恢复被覆盖文件；升级时新增的文件**未删除**（需清理时加 --purge-added）';
  if (map.addedTruncated) {
    out.addedTruncated = true;
    out.scope += `｜⚠️ 新增清单**被截断**（上限 ${map.addedCap || 5000}）→ --purge-added 只能删清单内的，其余需手工清理`;
  }
  out.addedNotRemoved = added.length;
  out.addedSample = added.slice(0, 5);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

function finalize(code) {
  report.at = new Date().toISOString();
  report.exitCode = code;
  // 退出码只有两档（P1 定案）：删掉原 `code === 0 ? 'L1/L2 通过'` 死分支 —— 它不可达，
  //   留着会让人以为"存在一个只过 L1/L2 的成功态"（那正是设计文档三档承诺的残留）。
  // 退出码 4 不等于"哪哪都好"：若存在**已知的未完成项**（如注入层未装），verdict 必须如实带出来，
  //   否则「包侧全通」这四个字又会把半装读成全通（2026-09-19 对抗实验 B 的教训）。
  const mdSkip = (report.pending || []).some((x) => String(x).startsWith('注入层未装'));
  report.verdict = code === 4
    ? `包侧全通（P0 校验 / P1 还原 / P2·P3 写入回读 / L1·L2·L3a·L4a）${mdSkip ? '；⚠️ **但注入层未装**（已按 --allow-claude-md-skip 接受，见 pending）→ **不算完整落地**' : ''}；L3b·L4b 待人工确认（不许并入"通过"）`
    : '失败';
  if (REPORT_PATH && APPLY) {
    try { writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8'); say(`报告已写入 ${REPORT_PATH}`); } catch (e) { console.error('报告写入失败:', e.message); }
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

// ── 占位符展开：<USER_HOME> → 目标机 home（正斜杠形态；Windows 接受混合分隔符，JSON 转义也不受影响）──
function expand(text) {
  let t = text.split('<USER_HOME>').join(TARGET_HOME.replace(/\\/g, '/'));
  // ⚠️ 2026-09-19：`--root` 指定了**非默认位**时，payload 里的 "<USER_HOME>/.cosmic-phantom" 必须改指 TARGET_ROOT。
  //   原实现只做占位符替换 → 注册值一律落到 <home>/.cosmic-phantom，而文件被装到 TARGET_ROOT：
  //   实测（伪新机 --root 指测试目录）注册的 node/脚本**全指向不存在的位置**，P3 回读断言当场拦下。
  //   默认位时两者相等，本步无副作用。
  const homeCp = join(TARGET_HOME, '.cosmic-phantom').replace(/\\/g, '/');
  const rootFwd = TARGET_ROOT.replace(/\\/g, '/');
  if (homeCp !== rootFwd) t = t.split(homeCp).join(rootFwd);
  // 路径重定位：源机的包外绝对路径 → 目标机新位置（三种书写形态都替：正斜杠 / 单反斜杠 / JSON 双反斜杠）
  for (const r of RELOCATIONS) {
    for (const v of [r.fromFwd, r.fromBwd, r.fromBwdEsc]) if (v) t = t.split(v).join(r.to);
  }
  return t;
}

// CP 脚本的 JSON 输出有两种形态：events.js 走单行、memory-cli.js 走多行 pretty-print。
//   首版落地器只取"最后一行"→ 撞上 pretty-print 时必然解析失败（伪新机测试实测抓到）。
function parseJson(stdout) {
  const t = String(stdout || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const lines = t.split('\n').map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function walkFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

// U3：写入前 diff —— 逐顶层键比较，列出真正会变的键（设计 §2 P2 承诺"不静默覆盖"）
function diffTopKeys(beforeJson, afterJson) {
  let a = {}, b = {};
  try { a = JSON.parse(beforeJson) || {}; } catch {}
  try { b = JSON.parse(afterJson) || {}; } catch {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  return out;
}

// 从 hook command 之类的字符串里抽出盘符绝对路径（用于"引用可解析"断言）
function extractPaths(text) {
  const out = new Set();
  for (const m of String(text).match(/"([A-Za-z]:[\\/][^"]*)"/g) || []) out.add(m.slice(1, -1));
  return [...out];
}

/* ══════════════ P0 预检（只读，不改任何东西） ══════════════ */
function preflight() {
  const p = { ok: false, checks: [], facts: {} };
  if (!BUNDLE || !existsSync(BUNDLE)) { fail('P0', `缺少或找不到 --bundle 目录: ${BUNDLE}`); }

  const manifestPath = join(BUNDLE, 'MANIFEST.json');
  if (!existsSync(manifestPath)) fail('P0', 'MANIFEST.json 不存在（包不完整）');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (e) { fail('P0', `MANIFEST.json 无法解析: ${e.message}`); }
  // ⚠️ 2026-09-19：这里原先是**手挑的子集** —— 漏了 `sourceHome`/`sourceRoot`，
  //   而 P1c（机器绑定路径重写）正要读 `sourceHome` ⇒ 读不到 → **静默跳过** ⇒
  //   **又一个"半装被读成全通"**（报告里一个字都没有）。教训：**手挑子集 = 默认丢字段**。
  report.manifest = {
    schemaVersion: manifest.schemaVersion, packedAt: manifest.packedAt, totals: manifest.totals,
    externalRefs: manifest.externalRefs, excluded: manifest.excluded, externalPackages: manifest.externalPackages,
    sourceHome: manifest.sourceHome, sourceRoot: manifest.sourceRoot,
  };

  // 计算路径重定位表（外部包：源机路径 → 目标机新位置）
  RELOCATIONS = [];
  for (const pkg of manifest.externalPackages || []) {
    if (!pkg || !pkg.from) continue;
    let to = null;
    if (pkg.id === 'cc-haha-client') to = CLIENT_DIR;
    else if (pkg.id === 'sts-tool') to = join(TARGET_ROOT, 'tools', 'stop-that-shit');
    if (!to) continue;
    const fromFwd = pkg.from.replace(/\\/g, '/');
    RELOCATIONS.push({ id: pkg.id, fromFwd, fromBwd: fromFwd.replace(/\//g, '\\'), fromBwdEsc: fromFwd.replace(/\//g, '\\\\'), to: to.replace(/\\/g, '/') });
  }
  if (RELOCATIONS.length) p.checks.push({ name: `路径重定位 ${RELOCATIONS.length} 条`, ok: true, note: RELOCATIONS.map((r) => `${r.fromFwd} → ${r.to}`).join('｜') });

  // ① 包自洽：payload 的 <USER_HOME> 引用必须在包内可解析（G1 教训：格式正确 ≠ 指向的东西在）
  const missing = [];
  let refCount = 0;
  for (const rel of ['payload/settings.json', 'payload/dot-claude.json', 'payload/CLAUDE.md']) {
    const f = join(BUNDLE, rel);
    if (!existsSync(f)) { p.checks.push({ name: rel, ok: false, note: 'payload 文件缺失' }); continue; }
    const text = readFileSync(f, 'utf8');
    for (const ref of extractPaths(expand(text))) {
      refCount += 1;
      const refNorm = ref.split(/[\\/]/).join('/');
      // 外部包引用（2026-09-16）：重定位后的路径指向"安装位"，而它在包内是另一个位置
      //   （如 STS：安装位 <目标根>/tools/stop-that-shit ←→ 包内 tools-src/stop-that-shit）
      const extHit = RELOCATIONS.find((r) => refNorm === r.to || refNorm.startsWith(r.to + '/'));
      if (extHit) {
        const pkg = (report.manifest.externalPackages || []).find((x) => x.id === extHit.id);
        const rest = refNorm.slice(extHit.to.length).replace(/^\//, '');
        const inBundle = join(BUNDLE, pkg ? pkg.to : '', rest);
        if (!existsSync(inBundle)) missing.push(`${ref}（应在包内 ${pkg ? pkg.to : '?'}/${rest}）`);
        continue;
      }
      const norm = ref.split(/[\\/]/);
      const idx = norm.indexOf('.cosmic-phantom');
      if (idx < 0) continue;                                   // 非 CP 内引用（可能是包外路径，见 externalRefs）
      const inBundle = join(PACKED, ...norm.slice(idx + 1));
      if (!existsSync(inBundle)) missing.push(ref);
    }
  }
  p.checks.push({ name: '包自洽（引用可解析）', ok: missing.length === 0, refs: refCount, missing });

  // ①b 包完整性（B1 + U1，2026-09-16）：逐文件 sha256 —— **传输是必经一步**，
  //    同字节数的损坏/替换只有 checksum 能发现；文件数核对只能抓"缺/多"，抓不了"换"。
  {
    const ckName = manifest.checksumFile || 'CHECKSUMS.sha256';
    const ckFile = join(BUNDLE, ckName);
    if (!existsSync(ckFile)) {
      p.checks.push({ name: '包完整性（checksum）', ok: false, note: `缺 ${ckName}` });
      fail('P0', `缺 ${ckName}：无法验证传输完整性（用新版 pack-bundle 重打）`);
    } else {
      const expected = new Map();
      for (const line of readFileSync(ckFile, 'utf8').split('\n')) {
        const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
        if (m) expected.set(m[2], m[1]);
      }
      const mismatch = [], miss = [];
      for (const [rel, hash] of expected) {
        const fp = join(BUNDLE, rel.split('/').join(sep));
        if (!existsSync(fp)) { miss.push(rel); continue; }
        let got = null;
        try { got = createHash('sha256').update(readFileSync(fp)).digest('hex'); } catch {}
        if (got !== hash) mismatch.push(rel);
      }
      // 审计 M4 修正：① 空清单单独报（原报"内容不符 0 / 缺失 0"属**误导**）
      //               ② 断言清单条数 == MANIFEST.checksumCount —— 否则**截断 CHECKSUMS 可静默降低覆盖**
      //                  （实测：截成 1 行仍报"✅ 1 个文件 sha256 全对"）
      if (expected.size === 0) fail('P0', `完整性清单为空（${ckName} 可解析出 0 条）—— 无法验证任何文件，拒绝继续`);
      if (Number.isFinite(manifest.checksumCount) && expected.size !== manifest.checksumCount) {
        fail('P0', `完整性清单被截断/被改：清单 ${expected.size} 条 ≠ MANIFEST 声明 ${manifest.checksumCount} 条 —— 拒绝继续（否则会静默降低校验覆盖）`);
      }
      const okCk = mismatch.length === 0 && miss.length === 0;
      p.checks.push({ name: '包完整性（checksum）', ok: okCk, files: expected.size, declared: manifest.checksumCount, mismatchedTotal: mismatch.length, missingTotal: miss.length, sample: [...mismatch, ...miss].slice(0, 5) });
      if (!okCk) fail('P0', `包已损坏或被改动（校验 ${expected.size} 个文件）：内容不符 ${mismatch.length} / 缺失 ${miss.length}\n  例：${[...mismatch, ...miss].slice(0, 5).join('\n      ')}`);
      say(`P0 包完整性 ✅ ${expected.size} 个文件 sha256 全对（清单条数与 MANIFEST 声明一致）`);
    }
  }
  if (missing.length) fail('P0', `有 ${missing.length} 条引用指向包内不存在的文件（新机装不起来）：\n  - ${missing.join('\n  - ')}`);

  // ② 运行时可用（审计 F3：这里必须报**本次实际用的是哪颗 node**，不能只写"包内 node"）
  if (!existsSync(NODE_EXE)) fail('P0', `node 不可用: ${NODE_EXE}`);
  const rt = spawnSync(NODE_EXE, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8', timeout: 15000 });
  const rtVersion = rt.status === 0 ? spawnSync(NODE_EXE, ['-v'], { encoding: 'utf8' }).stdout.trim() : null;
  p.checks.push({ name: `运行时（${PACKAGED_NODE ? '包内 node' : '⚠️ 非包内 node（降级）'}）`, ok: rt.status === 0 && (rt.stdout || '').includes('ok'), node: NODE_EXE, packaged: !!PACKAGED_NODE, version: rtVersion });
  if (!p.checks[p.checks.length - 1].ok) fail('P0', 'node 无法执行');
  if (NODE_FALLBACK) say(`⚠️ 包内没有 tools/node —— 本次**所有子进程**用的是 ${NODE_EXE}（**不是**包内 node）。新机上若这颗 node 不存在，落地器**根本无法启动**：务必用包内 node 拉起（见文件头用法）。`);
  else say(`P0 运行时 ✅ 包内 node ${rtVersion}（本次全部子进程都用它）`);

  // ③ 目标机状态
  const cpExists = existsSync(TARGET_ROOT);
  const hasEvents = existsSync(join(TARGET_ROOT, 'events.db'));
  p.facts.mode = cpExists ? (hasEvents ? 'upgrade' : 'partial') : 'fresh';
  p.facts.targetHome = TARGET_HOME;
  p.facts.targetRoot = TARGET_ROOT;
  p.facts.claudeHome = CLAUDE_HOME;
  p.facts.cpRootExists = cpExists;
  p.checks.push({ name: `目标模式: ${p.facts.mode}`, ok: true, note: p.facts.mode === 'fresh' ? '全新机（全量拷贝）' : '目标已有 CP → 覆盖代码/配置（逐个备份），保护数据/状态/档案' });

  // ④ 包外引用提示（不影响继续，但必须让用户看见）
  const ext = report.manifest.externalRefs || [];
  if (ext.length) say(`⚠️ 包外引用 ${ext.length} 条（home 之外，占位符覆盖不到，新机可能失效）：\n      ${ext.map((e) => e.path).join('\n      ')}`);

  p.ok = true;
  report.phases.P0 = p;
  return { manifest, p };
}

/* ══════════════ P1 还原（先建回滚点；升级模式不碰真源） ══════════════ */
function restore() {
  const r = { copied: 0, overwritten: 0, unchanged: 0, protectedSkipped: 0, overwrittenSample: [], mode: report.phases.P0.facts.mode, backup: null, backupMap: [], backupDupes: 0, overwrittenTargets: [], addedList: [], addedTruncated: false };
  const backupDir = join(TARGET_ROOT, 'backup', `install-${Date.now()}`);
  // 回滚映射：每个被备份的文件记 {backup: 备份内相对路径, target: 原始绝对路径}
  //   命名空间用 tag（cp / claude-home-skills / …）避免不同根的 rel 撞名；落 MAP.json 供 --rollback 用
  // P2 备份口径修正（2026-09-19）：**每个目标文件只备份一次**。
  //   原实现无去重：同一个文件可能被"预置关键项"（state/ 段）与 copyTree 两次触达，
  //   于是 MAP.json 里同一 target 出现两次（回滚会重复拷同一份，且备份计数虚高）。
  const backedUp = new Set();
  // 去重键（2026-09-19 对抗实验 D）：**只在 Windows 折叠大小写**。
  //   原实现无条件 toLowerCase() —— 在**区分大小写**的文件系统上会把 `Foo.js` 与 `foo.js` 当成同一个，
  //   于是后者**不进备份**（回滚静默漏一个文件）。本机是 Windows 故无感，但落地器已声明跨平台
  //   （`tools/node/node.exe` 找不到时回落 `tools/node/node`），属真隐患。
  const bakKey = (f) => { const s = String(f).replace(/\\/g, '/'); return process.platform === 'win32' ? s.toLowerCase() : s; };
  const bak = (file, tag, rel) => {
    const key = bakKey(file);
    if (backedUp.has(key)) { r.backupDupes += 1; return null; }
    backedUp.add(key);
    const bakRel = join(tag, rel);
    const dest = join(backupDir, bakRel);
    try {
      if (APPLY) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(file, dest); }
      r.backupMap.push({ backup: bakRel, target: file });
    } catch (e) { say(`⚠️ 备份失败 ${file}: ${e.message}`); }
    return dest;
  };

  const copyTree = (srcDir, dstDir, protectHere, tag) => {
    for (const src of walkFiles(srcDir)) {
      const rel = relative(srcDir, src);
      const top = rel.split(/[\\/]/)[0];
      const dst = join(dstDir, rel);
      if (existsSync(dst)) {
        const relNorm = rel.split(/[\\/]/).join('/');
        if (protectHere && (PROTECT.has(top) || PROTECT_REL.has(relNorm) || PROTECT_RE.some((re) => re.test(top))) && !FORCE) { r.protectedSkipped += 1; continue; }
        // 同内容 → 跳过（幂等，不动 mtime）
        let same = false;
        try { same = readFileSync(src).equals(readFileSync(dst)); } catch {}
        if (same) { r.unchanged += 1; continue; }
        // 内容不同 → **备份后覆盖**（升级语义：更新代码/配置；回滚有依据）
        bak(dst, tag, rel);
        if (APPLY) copyFileSync(src, dst);
        r.overwritten += 1;
        r.overwrittenTargets.push(dst);
        if (r.overwrittenSample.length < 8) r.overwrittenSample.push(rel);
        continue;
      }
      if (APPLY) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      }
      r.copied += 1;
      // M3：记录"本次新增"的文件 —— 回滚**不删**它们（删除属破坏性动作，需拍板），
      //     但必须让用户知道回滚后哪些文件是"升级留下的"，否则 ok:true 会被读成"回到升级前"。
      // 2026-09-19 对抗实验 E：原实现到 5000 就**静默停止记录** → `--purge-added` 会漏删，
      //   而报告里看不出来。改为**显式置位**并落报告（宁可有截断标记，不要静默不全）。
      //   ponytail: 上限 5000 → 升级路径：改流式写盘（边拷边追加 MAP，不在内存攒数组）
      if (r.addedList.length < ADDED_CAP) r.addedList.push(dst); else r.addedTruncated = true;
    }
  };

  // ⚠️ 2026-09-19 实测缺陷修复（🔴）：原实现把**整个备份块**关在 `cpMode`（= 非 fresh）里，且注释假设
  //   "宿主配置文件（升级模式才有意义）"。**这个假设是错的**：`fresh` 的真实含义只是「这台机器上没有 CP」，
  //   **不等于「宿主是干净的」** —— 真新机上用户早就装好了 Claude Code，`~/.claude.json` / `settings.json` /
  //   `CLAUDE.md` / `cc-haha/*` **都已经存在**，而它们照样会被本器覆盖。
  //   **实测证据**：预置了自有 providers.json 的目标机 → 报告写 `replaced（原文件已备份）`，
  //   但备份目录里**根本没有那个文件** ⇒ **"已备份"是假的**（与今日 hooks 缺陷同族：声称做了、实际没做）。
  //   修法：备份判据改为「**目标文件是否存在**」，与 fresh/upgrade **彻底解耦**。
  if (APPLY) {
    const cpStateFiles = ['current-state.json', 'reply-policy.json', 'resume-manifest.json', 'AGENTS.md']
      .map((f) => [join(TARGET_ROOT, f), 'state', f]);
    const hostFiles = [
      [join(TARGET_HOME, '.claude.json'), 'claude-home', '.claude.json'],
      [join(CLAUDE_HOME, 'settings.json'), 'claude-home', 'settings.json'],
      [join(CLAUDE_HOME, 'CLAUDE.md'), 'claude-home', 'CLAUDE.md'],
      // 客户端模型配置：**覆盖**（"开袋即食"要的是直接可用），但覆盖必须有回头路（铁律⑦）
      [join(CLAUDE_HOME, 'cc-haha', 'providers.json'), 'claude-home', 'cc-haha__providers.json'],
      [join(CLAUDE_HOME, 'cc-haha', 'settings.json'), 'claude-home', 'cc-haha__settings.json'],
    ];
    const all = [...cpStateFiles, ...hostFiles];
    if (all.some(([f]) => existsSync(f))) {
      mkdirSync(backupDir, { recursive: true });
      for (const [f, tag, rel] of all) if (existsSync(f)) bak(f, tag, rel);
      // B3-D2（2026-09-28，来源 9-27 挑刺 D2）：备份保留至用户确认——防"确认前被清理致证据+回滚副本双失"
      try {
        writeFileSync(join(backupDir, 'PENDING-CONFIRM.txt'),
          '此备份必须保留至新机验收通过并经用户确认后再清理。\n' +
          '原因（9-27 D2 教训）：误装事故中，唯一含 .claude.json 原件的备份被提前销毁，恢复正确性无法复核、回滚副本双失。\n' +
          '确认后清理方式：手动删除本目录（无自动清理）。\n' +
          '生成时间：' + new Date().toISOString() + '\n', 'utf8');
      } catch {}
      r.backup = backupDir;
    }
  }

  say(`P1 还原 CP 真源 → ${TARGET_ROOT}（模式: ${r.mode}）`);
  // `.flags/` 不进包（本机运行态，见 pack-bundle 注释）→ 这里补建空目录兜底：
  //   claude-flush / memory-cli / zcode-flush 三处**未见自建**，目录不存在时它们的写会静静地失败。
  if (APPLY) { try { mkdirSync(join(TARGET_ROOT, '.flags'), { recursive: true }); } catch (e) { say(`⚠️ 建 .flags 目录失败: ${e.message}`); } }
  copyTree(PACKED, TARGET_ROOT, true, 'cp');
  say(`P1 还原宿主内容件 → ${CLAUDE_HOME}/{skills,plugins}`);
  for (const d of ['skills', 'plugins']) {
    const src = join(BUNDLE, 'claude-home', d);
    if (existsSync(src)) copyTree(src, join(CLAUDE_HOME, d), false, `claude-home-${d}`);
  }

  // P1b 外部包（2026-09-16 用户拍板入包）：客户端本体 + STS 工具
  const ext = report.manifest.externalPackages || [];
  r.external = [];
  for (const pkg of ext) {
    if (!pkg || !pkg.packed) { r.external.push({ id: pkg && pkg.id, skipped: '未打包' }); continue; }
    const dstRoot = pkg.id === 'cc-haha-client' ? CLIENT_DIR : join(TARGET_ROOT, 'tools', 'stop-that-shit');
    const srcRoot = join(BUNDLE, pkg.to);
    if (!existsSync(srcRoot)) { r.external.push({ id: pkg.id, skipped: '包内缺' }); continue; }
    say(`P1b 外部包 ${pkg.id} → ${dstRoot}`);
    copyTree(srcRoot, dstRoot, false, `ext-${pkg.id}`);
    const entry = pkg.entry ? join(dstRoot, pkg.entry) : null;
    const entryOk = !entry || existsSync(entry);
    r.external.push({ id: pkg.id, dst: dstRoot, entry: pkg.entry, entryOk, mb: pkg.mb });
    if (entry && !entryOk && APPLY) fail('P1b', `${pkg.id} 的入口文件缺失：${entry}`);
    // 桌面 + 开始菜单快捷方式（仅客户端；用 PowerShell 生成 .lnk）
    // ⚠️ 2026-09-19 实测事故修复：原实现 `$s.Save()` **无条件覆盖用户已有的同名快捷方式，且完全不走备份**——
    //   直接违反铁律⑦（凡写过的已存在文件必先备份）。事故：本机 8-29 建的两个真快捷方式被本器测试
    //   指向假客户端（已人工还原）。修法：**先读现状** → 已指向目标则跳过（幂等，不再碰用户桌面）；
    //   需要改的**先备份原 .lnk 再写**，并逐条记进报告。
    if (APPLY && !NO_SHORTCUTS && pkg.id === 'cc-haha-client' && entry) {
      const probe = "$w=New-Object -ComObject WScript.Shell;$o=@();foreach($p in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))){$f=Join-Path $p 'Claude Code Haha.lnk';$e=Test-Path $f;$t='';if($e){$t=$w.CreateShortcut($f).TargetPath};$o+=[pscustomobject]@{path=$f;exists=$e;target=$t}};$o|ConvertTo-Json -Compress";
      const rp = spawnSync('powershell', ['-NoProfile', '-Command', probe], { encoding: 'utf8', timeout: 30000 });
      let state = [];
      try { const j = JSON.parse((rp.stdout || '').trim() || '[]'); state = Array.isArray(j) ? j : (j ? [j] : []); } catch (e) { state = []; }
      if (state.length === 0) { say(`⚠️ 快捷方式探测失败（跳过，不猜）：${(rp.stderr || '').slice(0, 120)}`); r.shortcut = { ok: false, error: 'probe-failed', stderr: (rp.stderr || '').slice(0, 200) }; continue; }
      const want = String(entry).toLowerCase();
      const toWrite = [], items = [];
      for (let i = 0; i < state.length; i += 1) {
        const it = state[i];
        if (it.exists && String(it.target || '').toLowerCase() === want) { items.push({ path: it.path, action: 'unchanged（已指向目标）' }); continue; }
        if (it.exists) bak(it.path, 'shortcut', `${i}-${basename(it.path)}`);      // 铁律⑦：先备份再覆盖
        toWrite.push(it.path);
        items.push({ path: it.path, action: it.exists ? 'overwritten（原快捷方式已备份）' : 'created' });
      }
      if (toWrite.length) {
        const list = toWrite.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(',');
        const ps = `$w=New-Object -ComObject WScript.Shell;foreach($f in @(${list})){$s=$w.CreateShortcut($f);$s.TargetPath='${entry}';$s.WorkingDirectory='${dstRoot}';$s.Save()}`;
        const rr = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60000 });
        r.shortcut = { ok: rr.status === 0, written: toWrite.length, stderr: (rr.stderr || '').slice(0, 200) };
      } else {
        r.shortcut = { ok: true, written: 0 };
      }
      r.shortcut.items = items;
      say(`P1b 快捷方式: ${r.shortcut.ok ? `✅ 写 ${r.shortcut.written} 个 · 已正确跳过 ${items.length - toWrite.length} 个` : '❌ ' + r.shortcut.stderr}`);
    } else if (APPLY && NO_SHORTCUTS && pkg.id === 'cc-haha-client') {
      r.shortcut = { ok: true, skipped: '--no-shortcuts' };
      say('P1b 快捷方式: 已按 --no-shortcuts 跳过');
    }
  }
  // P2 口径断言（2026-09-19）：**凡被覆盖的，必在备份映射里** —— "改了却没备份" = 回滚缺口。
  //   原实现只保证"预置的 7 个关键项"进备份，其它被覆盖项是否进备份**靠实现细节碰巧成立**，无人断言。
  {
    const notBacked = r.overwrittenTargets.filter((t) => !backedUp.has(bakKey(t)));
    r.backupCoverage = { overwritten: r.overwrittenTargets.length, missing: notBacked.length, sample: notBacked.slice(0, 5), dupesMerged: r.backupDupes };
    if (notBacked.length) fail('P1', `备份口径被破坏：${notBacked.length} 个被覆盖的文件不在备份映射里（回滚会漏）\n  例：${notBacked.slice(0, 5).join('\n      ')}`);
  }

  // 回滚映射落盘：`--rollback` 据此逐文件拷回（U2，设计 §3 承诺的"回去的路"）
  if (APPLY && r.backupMap.length) {
    try {
      writeFileSync(join(backupDir, 'MAP.json'), JSON.stringify({ at: new Date().toISOString(), targetRoot: TARGET_ROOT, targetHome: TARGET_HOME, files: r.backupMap, added: r.addedList, addedTruncated: r.addedTruncated, addedCap: ADDED_CAP }, null, 2) + '\n', 'utf8');
      say(`P1 回滚点：备份 ${r.backupMap.length} 个文件 → ${backupDir}（口径：凡被本器写过的已存在文件；重复触达已合并 ${r.backupDupes} 次；回滚：--rollback）`);
    } catch (e) { say(`⚠️ 回滚映射写入失败: ${e.message}`); }
  }
  // P1c 机器绑定路径重写（2026-09-19 补，「免人工」缺口盘点抓出）：
  //   `sources.json` 记录各宿主的会话源目录，写的是**源机绝对路径**（如 `<源home>/.proma/agent-sessions`）。
  //   它在 PROTECT 里 —— 那防的是"升级时覆盖目标机的"，但 **fresh 时目标机没有它 → 拷的是源机的** →
  //   新机上这些路径**指向不存在的目录** → `install-check` 的 `source:*` 项必然报红，而**没有别的地方会替它改**。
  //   修法：fresh 模式下，把注册表里的**源机 home 前缀**改写成目标机 home。只换前缀，不动其余结构。
  //   （源机 home 从 MANIFEST.sourceHome 读，不靠猜。）
  if (APPLY && r.mode === 'fresh') {
    const srcHome = ((report.manifest || {}).sourceHome || '').replace(/\\/g, '/');
    const dstHome = TARGET_HOME.replace(/\\/g, '/');
    if (!srcHome) {
      // 不静默：源机 home 缺失 = 这一步没做成，必须让人看见（否则又是"半装读成全通"）
      report.pending.push('机器绑定路径未重写：MANIFEST 缺 sourceHome，sources.json 里的宿主源目录仍指向源机 —— 需人工核对');
      say('⚠️ P1c 跳过：MANIFEST 没有 sourceHome，无法判断要重写哪个前缀（已记入 pending）');
    } else if (srcHome !== dstHome) {
      const sf = join(TARGET_ROOT, 'sources.json');
      if (!existsSync(sf)) {
        report.pending.push('机器绑定路径未重写：目标根没有 sources.json（包内可能缺）—— 请核对该文件是否随包');
        say('⚠️ P1c 跳过：目标根没有 sources.json（已记入 pending）');
      } else {
        try {
          const before = readFileSync(sf, 'utf8');
          const after = before.split(srcHome).join(dstHome).split(srcHome.split('/').join('\\\\')).join(dstHome);
          if (after !== before) {
            writeFileSync(sf, after, 'utf8');
            const n = before.split(srcHome).length - 1;
            r.pathRewrite = { file: 'sources.json', from: srcHome, to: dstHome, hits: n };
            say(`P1c 机器绑定路径重写：sources.json 里 ${n} 处源机 home → 目标机 home（否则新机上这些源目录必然不存在）`);
          } else {
            say('P1c 机器绑定路径：sources.json 不含源机 home 前缀，无需重写');
          }
        } catch (e) {
          report.pending.push(`机器绑定路径重写失败：sources.json（${e.message}）—— 该文件的源目录会指向源机`);
          say(`⚠️ P1c sources.json 路径重写失败（已记入 pending）：${e.message}`);
        }
      }
    }
  }

  say(`P1 统计：新增 ${r.copied} · 覆盖 ${r.overwritten}（**备份覆盖 ${r.backupCoverage.overwritten - r.backupCoverage.missing}/${r.backupCoverage.overwritten}**）· 同内容跳过 ${r.unchanged} · 保护跳过 ${r.protectedSkipped}${r.overwrittenSample.length ? `（覆盖例：${r.overwrittenSample.slice(0, 5).join(', ')}）` : ''}`);
  report.phases.P1 = r;   // r.external / r.shortcut 随 P1 一并落报告
  return r;
}

/* ══════════════ P2 占位符还原 ══════════════ */
function expandPayload() {
  const e = { files: [] };
  const pairs = [
    { rel: 'payload/settings.json', dst: join(CLAUDE_HOME, 'settings.json'), kind: 'json-merge' },
    { rel: 'payload/dot-claude.json', dst: join(TARGET_HOME, '.claude.json'), kind: 'json-merge' },
    { rel: 'payload/CLAUDE.md', dst: join(CLAUDE_HOME, 'CLAUDE.md'), kind: 'md-snapshot' },
    // 客户端模型配置（2026-09-19 补，用户实机拷打）：**整体替换**语义（不是 merge）——
    //   这是客户端自己的配置结构，merge 会造出畸形；存在则先备份（见 restore 的备份清单）。
    { rel: 'payload/cc-haha-providers.json', dst: join(CLAUDE_HOME, 'cc-haha', 'providers.json'), kind: 'json-file' },
    { rel: 'payload/cc-haha-settings.json', dst: join(CLAUDE_HOME, 'cc-haha', 'settings.json'), kind: 'json-file' },
  ];
  for (const it of pairs) {
    const src = join(BUNDLE, it.rel);
    if (!existsSync(src)) { e.files.push({ rel: it.rel, ok: false, note: 'payload 缺失' }); continue; }
    const text = expand(readFileSync(src, 'utf8'));
    if (it.kind === 'json-merge' || it.kind === 'json-file') {
      let incoming;
      try { incoming = JSON.parse(text); } catch (err) { fail('P2', `${it.rel} 展开后不是合法 JSON: ${err.message}`); }
      e.files.push({ rel: it.rel, dst: it.dst, kind: it.kind, incoming, raw: it.kind === 'json-file' ? text : undefined });
    } else {
      e.files.push({ rel: it.rel, dst: it.dst, kind: it.kind, text });
    }
  }
  report.phases.P2 = e;
  return e;
}

/* ══════════════ P3 注册（merge 不 overwrite + 写后回读断言） ══════════════ */
function register() {
  const g = { mcp: null, hooks: null, claudeMd: null, plugins: WITH_PLUGINS ? 'merged' : 'skipped（包外路径，需人工确认）', readback: [] };
  // 先挂上再干活（与 P4 同一教训）：P3 内任一 fail() 会立刻 finalize(1)，
  //   若这时 phases.P3 还没赋上，报告里**整段 P3 丢失**（2026-09-19 对抗实验 B 实测到：B-1 报告里读不到 claudeMd）。
  report.phases.P3 = g;
  const p2 = report.phases.P2.files;

  // ① ~/.claude.json：只 merge mcpServers["cosmic-phantom"]，其余（userID/skillUsage…）原样保留
  const dotClaude = p2.find((f) => f.rel === 'payload/dot-claude.json');
  // 2026-10-28：源机 `~/.claude.json` 可能整个没有 mcpServers（Claude Code retired 后注册已被移除）。
  //   原实现无条件赋 `cur.mcpServers = {...}` 并进入回读断言 → 目标机写入一个空对象后断言"键存在"必然失败，
  //   整个安装停在 P3（实测：本次迁移包首跑即踩）。修法：只有包里真有 cosmic-phantom 条目时才注册与断言。
  const incomingCpMcp = dotClaude && dotClaude.incoming && (dotClaude.incoming.mcpServers || {})['cosmic-phantom'];
  if (dotClaude && dotClaude.incoming && incomingCpMcp) {
    const dst = dotClaude.dst;
    let cur = {};
    if (existsSync(dst)) { try { cur = JSON.parse(readFileSync(dst, 'utf8').replace(/^\uFEFF/, '')); } catch (err) { fail('P3', `目标 ${dst} 不是合法 JSON，拒绝覆盖: ${err.message}`); } }
    const before = JSON.stringify(cur.mcpServers || {});
    const beforeSnapshot = JSON.stringify(cur);
    cur.mcpServers = Object.assign({}, cur.mcpServers, dotClaude.incoming.mcpServers || {});
    const changedKeys = diffTopKeys(beforeSnapshot, JSON.stringify(cur));
    g.mcp = { dst, changed: before !== JSON.stringify(cur.mcpServers), changedKeys, key: 'mcpServers.cosmic-phantom' };
    const reg = (dotClaude.incoming.mcpServers || {})['cosmic-phantom'] || {};
    say(`P3 MCP 注册 → ${dst}｜变更键: ${changedKeys.join(', ') || '无'}｜写入值: command=${reg.command} args[0]=${Array.isArray(reg.args) ? reg.args[0] : ''}`);
    if (APPLY) { mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, JSON.stringify(cur, null, 2) + '\n', 'utf8'); }
  } else if (dotClaude) {
    say('P3 MCP 注册跳过：包内 ~/.claude.json 无 mcpServers.cosmic-phantom（源机未注册/已退役），不写空对象也不谎报回读');
    g.mcp = { skipped: true, reason: 'payload 无 cosmic-phantom 条目' };
  }

  // ② ~/.claude/settings.json：merge hooks 三事件；插件键默认跳过（其路径是包外引用）
  const st = p2.find((f) => f.rel === 'payload/settings.json');
  if (st && st.incoming) {
    const dst = st.dst;
    let cur = {};
    if (existsSync(dst)) { try { cur = JSON.parse(readFileSync(dst, 'utf8').replace(/^\uFEFF/, '')); } catch (err) { fail('P3', `目标 ${dst} 不是合法 JSON，拒绝覆盖: ${err.message}`); } }
    const inHooks = st.incoming.hooks || {};
    const beforeHooksSnapshot = JSON.stringify(cur);
    // ⚠️ 2026-09-19 对抗实验 A 实测缺陷修复（🔴）：原实现 `cur.hooks = Object.assign({}, cur.hooks, inHooks)`
    //   是**按事件整组替换** —— 目标机用户自己的 hooks 被整个吞掉。
    //   **实测证据**：目标机预置了自有的 SessionStart/Stop 两个 hook → 装完后两个都没了，每个事件只剩 CP 那 1 组。
    //   真新机上用户**早就装好了 Claude Code、有自己的 hook**（通知/状态栏/第三方插件）→ 这条会静默毁掉别人的配置，
    //   与 N1（快捷方式）同族。紧随其后的 `if (!cur.hooks[ev])` 是**死代码**（Object.assign 已赋过值）＝"写了但没生效"。
    //   新语义：**按事件追加 + 按命令去重**（幂等：重复跑不重复追加）。
    const cmdsOf = (arr) => (Array.isArray(arr) ? arr : []).flatMap((grp) => ((grp && grp.hooks) || []).map((h) => (h && h.command) || '')).filter(Boolean);
    cur.hooks = Object.assign({}, cur.hooks);
    const hookMerge = [];
    // ⚠️ 2026-09-19 二次修复（**换机场景必踩**）：原去重判据是「**命令字符串完全相等**」——
    //   而**换了机器，CP 的绝对路径必然变** ⇒ 同一个 hook 被当成"新的"→ **再追加一条** ⇒ 双 hook。
    //   实测：一次 root 与 home 不一致的误装把 `settings.json` 从 1629 撑到 2872 字节（hooks 双份）。
    //   新判据：先按**脚本名**认"这是同一个 hook 的不同路径版本" → **原地更新**（而不是追加）。
    //   脚本名很特定（compaction-inject.cjs / claude-flush.cjs / flush-reminder.cjs / precompact-probe.cjs），
    //   ponytail: 脚本名粒度匹配 → 升级路径：若将来出现同名不同工具，改为「脚本名+参数形状」双判
    const scriptNameOf = (cmd) => { const m = String(cmd || '').match(/([^\\/\s"']+\.(?:c?js|mjs))(?:\s|$|")/); return m ? m[1] : null; };
    for (const [ev, groups] of Object.entries(inHooks)) {
      const curArr = Array.isArray(cur.hooks[ev]) ? cur.hooks[ev].slice() : [];
      const curCmds = cmdsOf(curArr);
      const toAdd = [];
      const updated = [];
      for (const grp of (Array.isArray(groups) ? groups : [])) {
        const cs = cmdsOf([grp]);
        if (cs.length === 0) continue;
        if (cs.every((c) => curCmds.includes(c))) continue;              // ① 一模一样的命令已在 → 跳过（幂等）
        const names = cs.map(scriptNameOf).filter(Boolean);
        const idx = names.length ? curArr.findIndex((g) => cmdsOf([g]).some((c) => names.includes(scriptNameOf(c)))) : -1;
        if (idx >= 0) { curArr[idx] = grp; updated.push(ev); continue; }  // ② 已有**同脚本**的（路径变了）→ 原地更新
        toAdd.push(grp);                                                  // ③ 真没有 → 追加
      }
      const merged = curArr.concat(toAdd);
      if (merged.length) cur.hooks[ev] = merged; else delete cur.hooks[ev];
      hookMerge.push({ ev, kept: curArr.length, added: toAdd.length, updated: updated.length });
    }
    g.hookMerge = hookMerge;
    g.hooks = { dst, events: Object.keys(inHooks), changedKeys: diffTopKeys(beforeHooksSnapshot, JSON.stringify(cur)) };
    const haveSts = RELOCATIONS.some((r) => r.id === 'sts-tool');
    if (WITH_PLUGINS || haveSts) {
      if (st.incoming.extraKnownMarketplaces) cur.extraKnownMarketplaces = Object.assign({}, cur.extraKnownMarketplaces, st.incoming.extraKnownMarketplaces);
      if (st.incoming.enabledPlugins) cur.enabledPlugins = Object.assign({}, cur.enabledPlugins, st.incoming.enabledPlugins);
    }
    if (APPLY) { mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, JSON.stringify(cur, null, 2) + '\n', 'utf8'); }
    say(`P3 hook 声明 → ${dst}｜变更键: ${(g.hooks.changedKeys || []).join(', ') || '无'}｜事件: ${g.hooks.events.join('/')}${(WITH_PLUGINS || haveSts) ? ' + 插件键（STS 路径已重定位）' : '；插件键已跳过（包内无 STS 工具）'}`);
  }

  // ③b 客户端模型配置（2026-09-19 补，用户实机拷打）——**「开袋即食」缺的就是这一步**
  //   原实现把客户端本体搬进来了（767MB），却把它的**配置**留在旧边界"新机自装"里 →
  //   新机上得到一个**不会说话的客户端外壳**，要用户重新配 provider/密钥。
  //   语义：**整体替换 + 先备份**（不是 merge，也不是"已存在就跳过"——跳过就等于没搬）。
  for (const f of p2.filter((x) => x.kind === 'json-file')) {
    const before = existsSync(f.dst) ? readFileSync(f.dst, 'utf8') : null;
    const same = before !== null && before === f.raw;
    if (APPLY && !same) { mkdirSync(dirname(f.dst), { recursive: true }); writeFileSync(f.dst, f.raw, 'utf8'); }
    const action = before === null ? 'created' : (same ? 'unchanged' : 'replaced（原文件已备份）');
    (g.ccHaha = g.ccHaha || []).push({ dst: f.dst, action, providers: Array.isArray(f.incoming.providers) ? f.incoming.providers.length : undefined });
    say(`P3 客户端模型配置 → ${f.dst}（${action}${Array.isArray(f.incoming.providers) ? ` · ${f.incoming.providers.length} 个 provider` : ''}）`);
    // 回读断言（铁律④）：写完必须读得回来，且 provider 数对得上
    if (APPLY) {
      let back = null;
      try { back = JSON.parse(readFileSync(f.dst, 'utf8').replace(/^\uFEFF/, '')); } catch { back = null; }
      const okShape = back !== null && (f.incoming.providers === undefined || (Array.isArray(back.providers) && back.providers.length === f.incoming.providers.length));
      g.readback.push({ label: `客户端配置回读 ${basename(f.dst)}`, exists: okShape, note: okShape ? `provider ${Array.isArray(back.providers) ? back.providers.length : 'n/a'}` : '读不回或 provider 数不符' });
      if (!okShape) fail('P3', `客户端模型配置回读失败：${f.dst} 写进去了但读不回来或结构不对`);
    }
  }

  // ③ ~/.claude/CLAUDE.md：已存在时只换快照段（不重写用户的注入层）
  const md = p2.find((f) => f.rel === 'payload/CLAUDE.md');
  if (md && md.text) {
    const dst = md.dst;
    const S = '<!-- snapshot-start -->', E = '<!-- snapshot-end -->';
    if (!existsSync(dst)) {
      if (APPLY) { mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, md.text, 'utf8'); }
      g.claudeMd = { dst, action: 'created' };
    } else {
      const cur = readFileSync(dst, 'utf8').replace(/^\uFEFF/, '');
      const m = md.text.match(new RegExp(`${S}[\\s\\S]*?${E}`));
      if (cur.includes(S) && cur.includes(E) && m) {
        const next = cur.replace(new RegExp(`${S}[\\s\\S]*?${E}`), m[0]);
        const changed = next !== cur;
        if (APPLY && changed) writeFileSync(dst, next, 'utf8');
        g.claudeMd = { dst, action: changed ? 'snapshot-updated' : 'unchanged' };
      } else if (cur.replace(/\r\n/g, '\n') === md.text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')) {
        // 2026-10-28 幂等修复：包内 CLAUDE.md 本身就没有快照段时，上次安装写入的内容与包内逐字相同，
        //   第二次跑（升级/重装）会被下面的"无快照段"分支硬失败 —— 实测第二次安装直接红灯。
        //   判据：目标文件 == 包内内容（去 BOM/统一换行）=> 已装，不报错也不重写。
        g.claudeMd = { dst, action: 'unchanged（与包内一致；包内本无快照段）' };
      } else {
        // ⚠️ 2026-09-19 对抗实验 B 实测缺陷修复（🟡→按铁律⑥升为失败）：
        //   目标已有自己的 CLAUDE.md 且无快照段时，原实现**只是 say 了一句就继续** →
        //   **实测**：CP 注入层根本没装上（落地后文件里无 snapshot-start），而落地器报 **exitCode 4「包侧全通」**、
        //   `report.pending` 里也没有它 ⇒ **半装被读成全通**，直接违反铁律⑥ 与"不把未完成读成完成"。
        //   修法：默认**硬失败**（把"要不要手工合并"交还给人），并给一个显式开关表达"我知道、我认了"。
        g.claudeMd = { dst, action: 'skipped（目标已有 CLAUDE.md 但无快照段，未合并）', needManualMerge: true };
        const msg = `注入层未装：${dst} 已存在但**没有 CP 快照段**（无法安全合并 Markdown，怕覆盖你自己的全局指令）。`
          + `\n  ⇒ 本次**未完成**：CP 的接入协议/门禁没写进这台机器的注入层。`
          + `\n  修法（二选一）：① 在该文件里手工加上 ${S} … ${E} 空段后重跑（落地器下次会只更新段内内容）`
          + `\n                  ② 明知如此仍要继续：加 --allow-claude-md-skip（会写进报告 pending，不再报"全通"）`;
        if (ALLOW_MD_SKIP) {
          report.pending.push('注入层未装：~/.claude/CLAUDE.md 无快照段，已按 --allow-claude-md-skip 跳过 —— 需人工合并');
          say('⚠️ P3 注入层：**未装**（已按 --allow-claude-md-skip 接受，记入 pending；verdict 会带出这条，不报"完整落地"）');
        } else {
          fail('P3', msg);
        }
      }
    }
    say(`P3 注入层 → ${dst}（${g.claudeMd.action}）`);
  }

  // ④ 写后回读断言（铁律④）：重新解析并把引用的文件拿到磁盘上验
  const assertFile = (label, path) => { const ok = existsSync(path); g.readback.push({ label, path, exists: ok }); return ok; };
  if (g.mcp && APPLY && !g.mcp.skipped) {
    try {
      const cur = JSON.parse(readFileSync(g.mcp.dst, 'utf8'));
      const s = cur.mcpServers && cur.mcpServers['cosmic-phantom'];
      const okKey = !!s;
      const okCmd = okKey && assertFile('MCP server 脚本', join(TARGET_ROOT, 'resources', 'mcp-server', 'index.js'));
      const okNode = okKey && assertFile('MCP node', (s.command || '').replace(/"/g, ''));
      g.readback.push({ label: 'mcpServers.cosmic-phantom 存在', exists: okKey });
      // 审计 F1 修复：**断言注册值本身**（原实现只验"键存在"，一份 args 写错的注册能全绿通过）
      if (okKey) {
        const norm = (v) => String(v || '').replace(/\\/g, '/');
        const wantScript = norm(join(TARGET_ROOT, 'resources', 'mcp-server', 'index.js'));
        const wantRoot = norm(TARGET_ROOT);
        const args = Array.isArray(s.args) ? s.args : [];
        const scriptArg = args.map(norm).find((a) => /mcp-server\/index\.js$/.test(a)) || null;
        const rootIdx = args.indexOf('--root');
        const rootArg = rootIdx >= 0 ? norm(args[rootIdx + 1]) : null;
        g.readback.push({ label: '注册值[脚本] == 期望', exists: scriptArg === wantScript, got: scriptArg, want: wantScript });
        g.readback.push({ label: '注册值[--root] == 目标根', exists: rootArg === wantRoot, got: rootArg, want: wantRoot });
      }
      if (!okKey || !okCmd || !okNode) fail('P3', '回读断言失败：MCP 注册写进去了但读不回来或指向的文件不存在');
      const badReg = g.readback.filter((x) => !x.exists && /注册值/.test(x.label));
      if (badReg.length) fail('P3', `回读断言失败：**注册值本身不对** → ${badReg.map((b) => `${b.label}（got=${b.got} want=${b.want}）`).join('；')}`);
    } catch (err) { fail('P3', `回读 ${g.mcp.dst} 失败: ${err.message}`); }
  }
  if (g.hooks && APPLY) {
    try {
      const cur = JSON.parse(readFileSync(g.hooks.dst, 'utf8'));
      // ⚠️ 2026-09-19 连锁修正：hooks 改为**追加**后，`arr[0]` 可能是**目标机用户自己的** hook，
      //   原断言的 `arr[0].hooks[0].command` 会去验一个不是 CP 的命令（要么假绿、要么假红）。
      //   新断言：**CP 声明的每条命令都必须在位**（无论排第几组）。
      const wantHooks = ((report.phases.P2.files.find((f) => f.rel === 'payload/settings.json') || {}).incoming || {}).hooks || {};
      const cmdsOf = (arr) => (Array.isArray(arr) ? arr : []).flatMap((grp) => ((grp && grp.hooks) || []).map((h) => (h && h.command) || '')).filter(Boolean);
      for (const ev of g.hooks.events) {
        const arr = (cur.hooks && cur.hooks[ev]) || [];
        const present = cmdsOf(arr);
        const want = cmdsOf(wantHooks[ev]);
        const missing = want.filter((c) => present.includes(c) === false);
        g.readback.push({
          label: `hooks.${ev}：CP 声明的 ${want.length} 条命令均在位`,
          exists: missing.length === 0,
          note: missing.length ? `缺: ${missing.join(' / ')}` : `该事件共 ${arr.length} 组（用户自有组一并保留）`,
        });
        if (missing.length) fail('P3', `回读断言失败：hooks.${ev} 缺 CP 声明的命令 → ${missing.join(' / ')}`);
        for (const c of want) for (const p of extractPaths(c)) assertFile(`hooks.${ev} 引用`, p);
      }
      const bad = g.readback.filter((x) => !x.exists);
      if (bad.length) fail('P3', `回读断言失败：\n  - ${bad.map((b) => `${b.label}${b.note ? '（' + b.note + '）' : b.path ? ': ' + b.path : ''}`).join('\n  - ')}`);
    } catch (err) { fail('P3', `回读 ${g.hooks.dst} 失败: ${err.message}`); }
  }
  report.phases.P3 = g;
  return g;
}

/* ══════════════ 变更总账（P4 承诺"一份将要做什么的清单"） ══════════════ */
// 审计 P4 / 设计对账 P4：原实现只有分阶段 say() 过程日志 —— **dry-run 跑完也看不到"最终会改哪些文件"**，
//   而"先看清要改什么再决定要不要 --apply"正是 dry-run 存在的理由。
//   本函数把 P0/P1/P2/P3 的结果汇总成一张清单：dry-run 下=将要做什么；--apply 下=已经做了什么。
function planSummary() {
  const r = report.phases.P1 || {};
  const g = report.phases.P3 || {};
  const rel = (p) => { try { return relative(TARGET_ROOT, p).split(/[\\/]/).join('/'); } catch { return p; } };
  const plan = {
    mode: report.phases.P0.facts.mode,
    node: report.nodeUsed,
    willAdd: r.copied || 0,
    willOverwrite: r.overwritten || 0,
    willBackup: (r.backupMap || []).length,
    backupCoverage: r.backupCoverage || null,
    protectedSkip: r.protectedSkipped || 0,
    unchangedSkip: r.unchanged || 0,
    externalPackages: (r.external || []).map((x) => ({ id: x.id, dst: x.dst, skipped: x.skipped })),
    hostConfig: [
      g.mcp ? { file: g.mcp.dst || null, skipped: !!g.mcp.skipped, changedKeys: g.mcp.changedKeys || [] } : null,
      g.hooks ? { file: g.hooks.dst, changedKeys: g.hooks.changedKeys } : null,
      g.claudeMd ? { file: g.claudeMd.dst, action: g.claudeMd.action } : null,
    ].filter(Boolean),
    overwriteSample: (r.overwrittenSample || []).slice(0, 20),
    addSample: (r.addedList || []).slice(0, 20).map(rel),
  };
  report.plannedChanges = plan;
  const verb = APPLY ? '已变更总账' : '将要变更总账（dry-run 预演）';
  say('');
  say(`═══ ${verb} ═══`);
  say(`  模式 ${plan.mode}｜node ${plan.node.packaged ? '包内' : '降级(非包内)'} ${plan.node.exe}`);
  say(`  新增 ${plan.willAdd} 个文件${plan.addSample.length ? `（例：${plan.addSample.slice(0, 5).join(', ')}${plan.willAdd > 5 ? ' …' : ''}）` : ''}`);
  say(`  覆盖 ${plan.willOverwrite} 个文件，全部已备份 —— 例：${plan.overwriteSample.slice(0, 5).join(', ') || '（无）'}${plan.willOverwrite > 5 ? ' …' : ''}`);
  say(`  备份 ${plan.willBackup}（重复触达合并 ${(plan.backupCoverage && plan.backupCoverage.dupesMerged) || 0}）· 保护跳过 ${plan.protectedSkip} · 同内容跳过 ${plan.unchangedSkip}`);
  for (const e of plan.externalPackages) say(`  外部包 ${e.id}: ${e.skipped || '→ ' + e.dst}`);
  for (const h of plan.hostConfig) say(`  宿主配置 ${h.file}：${h.action || '变更键 [' + (h.changedKeys || []).join(', ') + ']'}`);
  if (!APPLY) say('  ⚠️ 以上是**预演**：没有加 --apply，目标机一个字节都没改。');
  say('══════════════════════════════');
  say('');
  return plan;
}

/* ══════════════ P4 自检 L1-L4 ══════════════ */
function selfCheck() {
  const s = { L1: null, L2: null, L3a: null, L4a: null, L3b: '待确认（宿主侧）', L4b: '待确认（宿主侧）' };
  report.phases.P4 = s;   // 先挂上：否则 fail() 时报告里 P4 整段丢失（伪新机测试实测抓到的 Bug 2）
  const run = (file, args, timeout) => spawnSync(NODE_EXE, ['--experimental-sqlite', join(TARGET_ROOT, file), ...args, '--root', TARGET_ROOT], { encoding: 'utf8', timeout });

  if (APPLY) {
    const r1 = run('memory-cli.js', ['stats'], 60000);
    const j1 = parseJson(r1.stdout);
    const count = j1 && Number.isFinite(j1.total) ? j1.total : null;
    s.L1 = { ok: r1.status === 0 && count !== null && count > 0, count, exitStatus: r1.status, stderr: (r1.stderr || '').slice(0, 300), raw: (r1.stdout || '').slice(0, 200) };
    say(`P4 L1 真源可读: ${s.L1.ok ? `✅ count=${count}` : '❌ ' + (s.L1.stderr || s.L1.raw)}`);

    const r2 = run('memory-cli.js', ['verify'], 90000);
    const j2 = parseJson(r2.stdout);
    s.L2 = { ok: r2.status === 0 && !!j2, stale: j2 && Array.isArray(j2.stale) ? j2.stale.length : null, indexDrift: j2 ? j2.indexDrift : null, exitStatus: r2.status, stderr: (r2.stderr || '').slice(0, 300) };
    say(`P4 L2 引擎可跑: ${s.L2.ok ? `✅（stale ${s.L2.stale} 条，可接受）` : '❌ ' + (s.L2.stderr || '')}`);
    if (!s.L1.ok || !s.L2.ok) fail('P4', 'L1/L2 未通过 —— 落地不成立');

    // ── L3a【我能读·机器可验那一半】MCP server 在新根能否应答工具调用 ──
    //   2026-09-16 修正：原先把 L3 整体判为"验不了"——不准确。MCP 是标准 stdio JSON-RPC，
    //   喂协议就能调，与宿主做的事完全一样。宿主"能否连上它"（L3b）才是验不了的那半。
    const smoke = join(TARGET_ROOT, 'mcp-smoke.cjs');
    if (existsSync(smoke)) {
      const rs = spawnSync(NODE_EXE, [smoke, '--config', join(TARGET_HOME, '.claude.json'), '--root', TARGET_ROOT], { encoding: 'utf8', timeout: 120000 });
      const js = parseJson(rs.stdout);
      s.L3a = { ok: !!(js && js.ok), toolCount: js && js.toolCount, protocol: js && js.protocolVersion, preview: js && (js.resultPreview || '').slice(0, 120), error: js && js.error };
      say(`P4 L3a MCP 工具可调（新根）: ${s.L3a.ok ? `✅ ${s.L3a.toolCount} 工具 / 协议 ${s.L3a.protocol}` : '❌ ' + (s.L3a.error || '')}`);

      // ── L4a【我能写·机器可验那一半】Stop 链能否真落盘 ──
      //   做法沿用本仓既有纪律（install-check --live 5.3）：**临时 root 副本**里跑，验完即清
      //   —— 绝不污染目标机 events.db；即使目标是真机也安全。
      const tmp = join(TARGET_ROOT, 'backup', `l4a-probe-${Date.now()}`);
      try {
        mkdirSync(tmp, { recursive: true });
        for (const f of ['events.js', 'claude-flush.cjs', 'decision-cards.js', 'update-snapshot.js', 'reply-policy.json', 'events.db']) {
          const src = join(TARGET_ROOT, f);
          if (existsSync(src)) copyFileSync(src, join(tmp, f));
        }
        mkdirSync(join(tmp, 'core'), { recursive: true });
        const marker = `L4A-PROBE-${Date.now()}`;
        const transcript = join(tmp, 'probe-transcript.jsonl');
        writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: marker }] } }) + '\n', 'utf8');
        const payload = JSON.stringify({ session_id: 'l4a-probe', transcript_path: transcript });
        const r4 = spawnSync(NODE_EXE, [join(tmp, 'claude-flush.cjs')], {
          input: payload, encoding: 'utf8', timeout: 120000,
          env: { ...process.env, CP_ROOT: tmp, CP_NODE: NODE_EXE, CP_HOST: 'claude-code' },
        });
        let landed = false;
        try { landed = readFileSync(join(tmp, 'events.db'), 'latin1').includes(marker); } catch {}
        s.L4a = { ok: landed, marker, exitStatus: r4.status, stderr: (r4.stderr || '').slice(0, 300) };
        say(`P4 L4a Stop 链真落盘（临时副本）: ${landed ? '✅ marker 已落盘' : '❌ 未落盘 ' + (s.L4a.stderr || '')}`);
      } catch (e) {
        s.L4a = { ok: false, error: e.message };
        say(`P4 L4a 失败: ${e.message}`);
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
      if (!s.L3a.ok || !(s.L4a && s.L4a.ok)) fail('P4', 'L3a/L4a 未通过 —— 包侧自检不成立');
    } else {
      s.L3a = { ok: false, error: 'mcp-smoke.cjs 不在包内' };
      say('P4 L3a 跳过：包内缺 mcp-smoke.cjs');
    }

    // ⑤ L3b/L4b（宿主侧那一半）验不了 → 写进盲区账本（未观测），交给 F25 盯
    try {
      const lf = join(TARGET_ROOT, 'core', 'blindspot-ledger.md');
      if (existsSync(lf)) {
        let text = readFileSync(lf, 'utf8');
        const nums = [...text.matchAll(/\|\s*B-(\d{3})\s*\|/g)].map((m) => +m[1]);
        const next = (nums.length ? Math.max(...nums) : 0) + 1;
        const rows = [
          `| B-${String(next).padStart(3, '0')} | 新机上【我能读】：MCP 工具可实际调用 | 在新宿主会话里调一次 recall_memory | \`未观测\` | 落地器无法自验（需宿主会话）；落地时间 ${new Date().toISOString()} |`,
          `| B-${String(next + 1).padStart(3, '0')} | 新机上【我能写】：Stop hook 真实落盘 | 说一句话后查 events.db 是否新增 | \`未观测\` | 同上 |`,
        ];
        if (!text.includes('新机上【我能读】')) {
          text = text.replace(/(\n## 6\. 对账法)/, `\n${rows.join('\n')}\n$1`);
          if (APPLY) writeFileSync(lf, text, 'utf8');
          say(`P4 已写入盲区账本 2 条未观测项（B-${String(next).padStart(3, '0')} / B-${String(next + 1).padStart(3, '0')}）→ 已登记为未观测（**不设红灯**：非阻塞且原理上须等真机；真机验证后手动清）`);
        }
      }
    } catch (e) { say(`⚠️ 盲区账本写入跳过: ${e.message}`); }
  }
  // ⚠️ 2026-09-19：原为**整体赋值** → 把前面阶段（P3 注入层未装等）push 进来的 pending **全抹掉**。
  //   实测：B-2 加 --allow-claude-md-skip 后报告 pending 里只剩 L3b/L4b，注入层那条消失（= 又一次半装被读成全通）。
  //   改为**追加**：pending 是全流程累计的"未完成面"，任何阶段都只许往里加，不许覆盖。
  report.pending = [
    ...(report.pending || []),
    'L3b【宿主侧】: 在 Claude Code 里实际调一次 recall_memory（返回记忆数组=通过）—— 机器可验的那半 L3a 已过',
    'L4b【宿主侧】: 说一句话后查 events.db 是否新增 session（增加=通过）—— 机器可验的那半 L4a 已过',
  ];
  report.phases.P4 = s;
  return s;
}

/* ══════════════ 主流程 ══════════════ */
try {
  if (process.argv.includes('--rollback')) { rollback(); }   // 回滚不需要包，只需要目标根
  if (!BUNDLE) { console.log(JSON.stringify({ error: '缺少 --bundle <包目录>', usage: 'node install-bundle.cjs --bundle <包目录> [--apply]' })); process.exit(1); }
  say(`包=${BUNDLE}｜目标 home=${TARGET_HOME}｜目标根=${TARGET_ROOT}${APPLY ? '' : '（dry-run：不改任何文件）'}`);
  preflight();
  restore();
  expandPayload();
  register();
  planSummary();
  selfCheck();
  finalize(4);
} catch (e) {
  report.errors.push({ phase: 'unhandled', msg: String(e && e.stack || e) });
  try { finalize(1); } catch { console.error(e); process.exit(1); }
}
