#!/usr/bin/env node
/**
 * pack-bundle.cjs — 继承包打包器（2026-09-16 立）
 *
 * 目标（用户 2026-09-15 定）：把"系统 + 被调教好的状态"固化成一个包，
 *   新机装完【不需要再一步步调教】——打开就跟没换电脑一样。
 *
 * 核心设计：
 *   ① **不动源机环境** —— 本脚本只读当前配置，生成占位符化副本到包目录。
 *   ② **环境相关只有两类** —— 绝对路径 + 盘符；其余全是环境无关的内容/逻辑，直接拷。
 *   ③ **接入件不是"拷贝"而是"模板 + 落地器重建"** —— 因为注册动作必须在新机执行，且必须当场验证。
 *
 * 用法：node pack-bundle.cjs --out <包目录> [--root <CP根>] [--home <用户目录>] [--dry-run]
 *
 * 产出结构：
 *   <包目录>/
 *   ├── cosmic-phantom/     CP 真源全量（排除 tools/backup/.git/node_modules 等可重建项）
 *   ├── claude-home/        ~/.claude 接入件（settings/mcp/CLAUDE/skills/plugins）
 *   ├── payload/            占位符化后的配置副本（落地器据此还原）
 *   └── MANIFEST.json       包清单 + 占位符白名单 + 落地校验项
 */
'use strict';

const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync, statSync: st, rmSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join, relative, sep, basename, dirname } = require("node:path");
const { spawnSync } = require("node:child_process");
const { homedir } = require('node:os');

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg('--root') || join(homedir(), '.cosmic-phantom');
const HOME = arg('--home') || homedir();
const OUT = arg('--out');
const DRY = process.argv.includes('--dry-run');

if (!OUT) {
  console.log(JSON.stringify({ error: '缺少 --out <包目录>', usage: 'node pack-bundle.cjs --out <dir> [--root <CP根>] [--home <用户目录>] [--dry-run]' }));
  process.exit(1);
}

// ── 占位符规则：环境相关的两类（用户 2026-09-15 明示：机名/用户名/盘符变动是基本考虑）──
//   <USER_HOME> 覆盖用户主目录与盘符；顺序敏感，先替换更长路径
const PLACEHOLDERS = [
  { name: '<USER_HOME>', from: [HOME.replace(/\\/g, '/'), HOME] },
];

function toPortable(text) {
  let out = text;
  let hits = 0;
  for (const p of PLACEHOLDERS) {
    for (const f of p.from) {
      if (!f) continue;
      const re = new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]'), 'g');
      const before = out;
      out = out.replace(re, p.name);
      if (out !== before) hits += (before.length - out.length) > 0 ? 1 : 0;
    }
  }
  return { text: out, hits };
}

// 需要占位符化的活配置（2026-09-15 扫描确认：只有这些是"活配置"，其余命中皆历史存档）
// ⚠️ 2026-09-16：移除 `~/.claude/mcp.json` —— 该文件已被实测判定为**冗余副本**
//   （cc-haha 只读 `~/.claude.json`：重启后新进程起于该文件被改名之后仍正常，见 blindspot-ledger A-002）。
//   把它打进包只会让落地器在新机重造冗余，故不带。
const LIVE_CONFIGS = [
  { src: join(HOME, '.claude', 'settings.json'), rel: 'claude-home/settings.json', json: true },
  { src: join(HOME, '.claude.json'), rel: 'claude-home/dot-claude.json', json: true },
  { src: join(HOME, '.claude', 'CLAUDE.md'), rel: 'claude-home/CLAUDE.md', json: false },
  // ⚠️ 2026-09-19 用户实机拷打补入（**「开袋即食」缺的就是这两条**）：
  //   原清单只带"CP 的接入件"，**没带客户端自己的配置** → 新机上客户端起来后要求重新配模型。
  //   实测判定（机械 grep 全部候选落点，非猜）：模型/provider/key 的**唯一真源**就是 `cc-haha/providers.json`；
  //   `%APPDATA%/claude-code-desktop/` 下的命中**全是 HTTP 缓存**（Cache/Cache_Data/*）+ Local Storage 里一个 provider 名，
  //   `cc-haha/db/*.sqlite` 的命中是**全文索引**（派生数据）→ 都不带。
  //   两文件特性：**零本机路径、零用户名**（实测）→ 原样搬，无需占位符化；含**明文密钥**（见 READ-ME-FIRST 警告）。
  { src: join(HOME, '.claude', 'cc-haha', 'providers.json'), rel: 'claude-home/cc-haha-providers.json', json: true },
  { src: join(HOME, '.claude', 'cc-haha', 'settings.json'), rel: 'claude-home/cc-haha-settings.json', json: true },
];

// ~/.claude 下需要整目录带走的（环境无关的纯内容）
const HOME_DIRS = ['skills', 'plugins'];

// ── 外部包（2026-09-16 用户拍板"两者都入包"）──
//   ① 可选客户端本体（Electron/Tauri；是否可通过拷贝式安装启动需单独验证）
//   ② 可选第三方 STS 工具；它可能是 settings.json 的 extraKnownMarketplaces 指向物，
//      不入包则该引用在新机可能失效——这正是 G2 的包外引用
//   记录到 MANIFEST.externalPackages，由落地器按声明安装（含目标位与入口文件）。
const CLIENT_SRC = arg('--client-src') || process.env.CP_CLIENT_SRC || null;
const STS_SRC = arg('--sts-src') || process.env.CP_STS_SRC || null;
const EXTERNAL_PACKAGES = [
  { id: 'cc-haha-client', from: CLIENT_SRC, to: 'client', installTo: '<CLIENT_DIR>', entry: 'Claude Code Haha.exe', exclude: ['Uninstall Claude Code Haha.exe'], note: 'Electron 客户端本体；⚠️ 拷贝式安装能否在无注册表的机器上启动＝未验证' },
  { id: 'sts-tool', from: STS_SRC, to: 'tools-src/stop-that-shit', installTo: '<TARGET_ROOT>/tools/stop-that-shit', entry: 'hooks/stop-that-shit-claude.cjs', exclude: ['.git'], note: '第三方拦截工具；落地器需把它装到目标位，并把 settings.json 的 extraKnownMarketplaces 路径改写过去' },
];

// CP 里不带走的重目录（可重建 / 体积大 / 与机器绑定）
// ⚠️ 2026-09-16 修正两处硬伤（落地器设计时实测发现，见 pro/inherit-lander-design-20260916.md §0）：
//   G1 `tools/` **必须入包** —— 它是便携 node 运行时（tools/node/node.exe），而所有 hook 声明与全部
//      CLI 都指向它。原来排除它 → 新机上 hook 指向不存在的可执行文件、引擎跑不了（L1/L2 直接失败），
//      而 dry-run 报的"硬编码 0 残留"依然漂亮 —— 指标测的是路径写对没，没测指向的东西在不在。
//   G3 `embedding-db/`（94MB 向量模型）改为**默认入包** —— 环境无关资产；不入则新机检索降级纯 BM25，
//      若新机无网/ModelScope 不通则**永久降级**，与"打开就跟没换电脑一样"冲突。瘦身用 `--no-model`。
// `.flags/`（2026-09-19 包卫生）：**全是本机运行态，没一条该旅行** ——
//   `audit-due.json`（审计基线，带 clearedBy）· `guard-coverage.json`（守卫覆盖基线）·
//   `precompact-probes.jsonl` / `precompact-snapshot.json` / `session-sources.txt`（探针记录）·
//   `sess_*.stop-remind`（旧会话的去重标记）。
//   不排除的后果：全新机一落地就**误以为"已审计"**（F24 假绿）、带着别人会话的标记。
//   新机上这些文件由各脚本**按需自建**（audit-due / claude-hook-wrap / precompact-probe 均有 mkdir；
//   落地器另在 P1 补建空目录兜底，见 install-bundle.cjs）。
const ROOT_EXCLUDE = new Set(['backup', 'node_modules', '.git', '.flags']);
// 审计 H2：临时/沙箱残留必须排除（原实现会把 .tmp-* 与 .bak 打进包 —— 实测我的沙箱目录
//   曾随包旅行；包卫生与'传输完整性'是一件事的两面）。
const ROOT_EXCLUDE_PREFIX = ['.tmp-', 'tmp-'];
const ROOT_EXCLUDE_SUFFIX = ['.bak', '.bak-20260830'];
// 宿主游标 `.<host>-cursor.json`（2026-09-19 换用户名实测 B-001 抓出）：
//   它的内容是「**源机**绝对路径 → 已读行号」的映射。换机后（用户名/盘符一变）**每一条都是死键**，
//   带着走只会让新机拿着一份指向别人机器的账本。
//   与 `.flags` 不同：游标**该被保护但不必被携带** —— 落地器侧 PROTECT 保留（升级不覆盖目标机自己的），
//   打包器侧**不带**（让新机从零核对，而不是继承一份无意义的续读位置）。
//   形态匹配而非列举：加新宿主就多一个 `.<host>-cursor.json`，列举式迟早漏（与落地器 PROTECT_RE 同思路）。
const ROOT_EXCLUDE_RE = [/^\.\w+-cursor\.json$/i];
const NO_MODEL = process.argv.includes('--no-model');
// 单文件归档开关（2026-09-19 补）：默认产出 `<out>.zip`；`--no-archive` 跳过
const NO_ARCHIVE = process.argv.includes('--no-archive');
if (NO_MODEL) ROOT_EXCLUDE.add('embedding-db');

/* ══════════════ 未登记项挡板（2026-09-19 立，**不靠回忆**） ══════════════
 * 根因（**一次真实事故**）：打包清单是**靠我回忆列的** → **整个 `~/.claude/cc-haha/` 被漏掉**，
 *   而那里正是**模型 / provider / 密钥的唯一真源** ⇒ 新机上客户端起来后要求重新配模型，
 *   直到用户实机拷打才暴露。**"开袋即食"缺的那一块，根因就是"清单靠想"。**
 *
 * 机制：机械枚举 `~/.claude` 与 `~/.claude/cc-haha` 的**全部**条目 → 逐个对照下面两张表；
 *   **既不在"带走"、也不在"有意不带（须写理由）"里的 = 未登记 ⇒ 打包直接失败**。
 *   ⇒ 以后**任何**新增条目（宿主升级、新装工具…）都会**立刻挡住打包**，逼我当场判定一次，
 *     而不是默默漏掉、等用户在新机上发现。**下一个 cc-haha 会被这个挡板自己抓出来。**
 * 要放行：把它登记进表（最好是带理由），或临时 `--allow-unregistered`（会写进报告与 MANIFEST）。
 */
const CLAUDE_DIR_TAKEN = new Set(['CLAUDE.md', 'settings.json', 'skills', 'plugins', 'cc-haha']);
const CLAUDE_DIR_SKIP = {
  '.runtime': '机器相关（Python venv）',
  'appearance-state.json': 'UI 主题状态（机器相关）',
  'backups': 'Claude Code 自己的旧备份（机器相关）',
  'desktop-server-state.json': '本机端口（机器相关）',
  'file-history': 'Claude Code 文件历史/撤销栈（机器相关，且体积大）',
  'mcp.json.bak-20260916-冗余副本': '已判定为冗余副本的旧备份（见 blindspot-ledger A-002）',
  'mcp.json': '已判定为冗余副本：cc-haha 只读 ~/.claude.json（blindspot-ledger A-002，2026-09-16 起不入包）；本机残留仅为历史遗留',
  'projects': '会话记录（目标机自有，带了反而污染）',
  'session-env': '会话环境',
  'sessions': '会话索引',
  'shell-snapshots': 'shell 快照（机器相关）',
  'tasks': '任务状态（机器相关）',
  'telemetry': '遥测',
  'window-state.json': '窗口位置（机器相关）',
};
const CCHAHA_TAKEN = new Set(['providers.json', 'settings.json']);
const CCHAHA_SKIP = {
  'db': '本地索引（派生，可重建；且 SQLite 带 WAL 会有边车问题）',
  'desktop-ui.json': 'UI 布局偏好（非必要）',
  'diagnostics': '诊断日志',
  'public-access-devices.json': '公网访问设备表（本机为空，机器相关）',
  'traces': 'trace 记录（本机 2.8GB，机器相关）',
};
// 带 *.bak-* / *.bak 后缀的一律视为"旧备份"（按规则 §4.11，备份本身就归 backup/file-backups/）
const isBak = (n) => /\.bak(-|$)/i.test(n);

// 排除账（G2 配套）：记录"没带走什么、为什么"，供落地器据此输出"包外引用/失效清单"
const EXCLUDE_REASONS = {
  backup: '回滚点/历史备份，可重建',
  node_modules: 'npm 可再生',
  '.git': '版本库（注：不带则新机无变更审计基线）',
  'embedding-db': '--no-model 显式要求瘦身 → 新机检索将降级为纯 BM25',
  '.flags': '本机运行态（审计/守卫基线 + 探针记录 + 旧会话标记）→ 不随包，新机按需自建',
  '<host>-cursor.json': '宿主游标＝源机绝对路径→行号映射；跨机后全是死键 → 不随包，新机从零核对',
};

function log(msg) { console.log(`[pack] ${msg}`); }

function main() {
  const manifest = {
    schemaVersion: 1,
    packedAt: null,        // 由调用方在真机落地时戳（禁 Date.now 于纯函数内，此处仅占位）
    sourceHome: HOME,
    sourceRoot: ROOT,
    placeholders: PLACEHOLDERS.map((p) => p.name),
    payload: [],
    dirs: [],
    excluded: [],          // 排除账：没带走什么 + 为什么（落地器据此提示"失效面"）
    externalRefs: [],      // G2：包内引用的 **home 之外** 的绝对路径（占位符覆盖不到 → 新机需人工处理）
    totals: { files: 0, bytes: 0 },
    verification: [],
  };

  if (!existsSync(ROOT)) { console.log(JSON.stringify({ error: `CP 根不存在: ${ROOT}` })); process.exit(1); }

  // ①' 未登记项挡板（见文件头注释）：机械枚举 `~/.claude` 与 `cc-haha`，未登记者**直接失败**
  {
    const unreg = [];
    const check = (dir, taken, skip, label) => {
      let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const n = e.name;
        if (taken.has(n)) continue;
        if (Object.prototype.hasOwnProperty.call(skip, n)) continue;
        if (isBak(n)) continue;                       // 旧备份，按纪律本就该在 backup/file-backups/
        unreg.push(`${label}${n}${e.isDirectory() ? '/' : ''}`);
      }
    };
    check(join(HOME, '.claude'), CLAUDE_DIR_TAKEN, CLAUDE_DIR_SKIP, '~/.claude/');
    check(join(HOME, '.claude', 'cc-haha'), CCHAHA_TAKEN, CCHAHA_SKIP, '~/.claude/cc-haha/');
    manifest.unregistered = unreg;
    if (unreg.length && !process.argv.includes('--allow-unregistered')) {
      console.log(JSON.stringify({
        error: '发现**未登记**的宿主配置条目 —— 拒绝打包（清单不许靠回忆列）',
        unregistered: unreg,
        fix: '二选一：① 判定该带 → 加进 pack-bundle.cjs 的 CLAUDE_DIR_TAKEN / CCHAHA_TAKEN；'
          + '② 判定不带 → 加进对应的 *_SKIP 并**写清理由**。'
          + '（临时放行：--allow-unregistered，会写进 MANIFEST 留痕）',
        why: '这条挡板的由来：整个 cc-haha/（模型/密钥真源）曾被漏掉，导致新机上要重配模型 —— 根因就是打包清单靠回忆列',
      }, null, 2));
      process.exit(1);
    }
    if (unreg.length) log(`⚠️ --allow-unregistered：${unreg.length} 个未登记条目被放行（已写进 MANIFEST）：${unreg.join(', ')}`);
    else log(`未登记项挡板 ✅：~/.claude 与 cc-haha 下的条目**全部已登记**（带走 ${CLAUDE_DIR_TAKEN.size + CCHAHA_TAKEN.size} 项 / 有意不带 ${Object.keys(CLAUDE_DIR_SKIP).length + Object.keys(CCHAHA_SKIP).length} 项）`);
  }

  if (!DRY) {
    mkdirSync(join(OUT, 'payload'), { recursive: true });
    mkdirSync(join(OUT, 'cosmic-phantom'), { recursive: true });
    mkdirSync(join(OUT, 'claude-home'), { recursive: true });
  }

  // ①a SQLite 边车（`-wal` / `-shm` / `-journal`）：**与某个具体 .db 配对的瞬时状态**，不该旅行。
  //   事故（2026-09-19 实测抓到的）：旧包带了 `events.db-wal`(0B) + `events.db-shm`(32KB)，
  //   而落地器在**升级模式**又把它们复制到目标机 —— 目标机用的是**它自己的** events.db（受保护、未覆盖），
  //   却配上源机的边车 = 不配对（SQLite 靠 salt/校验和判失配，通常自愈，但属未定义运气）。
  //   规则：`-shm`/`-journal` 一律不带；`-wal` **非空即停**（非空 = 有未 checkpoint 的事务，丢掉就是丢数据）。
  //   （落地器侧另有第二道防线：这三类已进 PROTECT，升级时永不写入目标。）
  const SIDECAR_RE = /-(wal|shm|journal)$/i;
  const sidecars = [];
  const blocking = [];
  (function scanSide(d) {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = join(d, e.name);
      if (e.isDirectory()) { if (ROOT_EXCLUDE.has(e.name) === false) scanSide(fp); continue; }
      if (SIDECAR_RE.test(e.name) === false) continue;
      let sz = 0; try { sz = statSync(fp).size; } catch {}
      const rel = relative(ROOT, fp).split(sep).join('/');
      sidecars.push({ rel, size: sz });
      if (/-wal$/i.test(e.name) && sz > 0) blocking.push({ rel, size: sz });
    }
  })(ROOT);
  if (sidecars.length) log(`SQLite 边车：发现 ${sidecars.length} 个（${sidecars.map((s) => s.rel + '(' + s.size + 'B)').join(', ')}）→ 一律不带进包`);
  if (blocking.length) {
    console.log(JSON.stringify({
      error: '存在**非空**的 SQLite WAL —— 说明有未 checkpoint 的事务，不进包=丢数据，进包=可能污染新机',
      blocking,
      fix: '先在源机把 WAL 落盘再打包：node memory-cli.js maintain（或对每个 .db 执行 PRAGMA wal_checkpoint(TRUNCATE)）',
    }, null, 2));
    process.exit(1);
  }
  manifest.sqliteSidecars = { excluded: sidecars, blocking: [] };

  // ① CP 真源全量（排除可重建/绑定项）
  const rootEntries = readdirSync(ROOT);
  let copiedRoot = 0;
  for (const e of rootEntries) {
    if (ROOT_EXCLUDE.has(e) || ROOT_EXCLUDE_PREFIX.some((p) => e.startsWith(p)) || ROOT_EXCLUDE_SUFFIX.some((s) => e.endsWith(s)) || ROOT_EXCLUDE_RE.some((re) => re.test(e))) {
      // 形态规则命中的项，其名字不在 EXCLUDE_REASONS 里 → 回落到该形态的登记理由（否则会误报"未登记原因"）
      const reason = EXCLUDE_REASONS[e] || (ROOT_EXCLUDE_RE.some((re) => re.test(e)) ? EXCLUDE_REASONS['<host>-cursor.json'] : '未登记原因');
      log(`跳过: ${e}（${reason}）`);
      manifest.excluded.push({ item: e, reason });
      continue;
    }
    const src = join(ROOT, e);
    let isDir = false;
    try { isDir = statSync(src).isDirectory(); } catch { continue; }
    if (isDir && (e === 'delivery' || e === 'docs')) {
      log(`跳过（历史档案，可选）: ${e}`);
      manifest.excluded.push({ item: e, reason: '历史档案（逐字存档，不影响运行）' });
      continue;
    }
    if (!DRY) cpSync(src, join(OUT, 'cosmic-phantom', e), { recursive: true, filter: (s) => SIDECAR_RE.test(basename(s)) === false });
    copiedRoot++;
  }
  manifest.dirs.push({ name: 'cosmic-phantom', entries: copiedRoot, note: 'CP 真源；排除 backup/node_modules/.git/embedding-db/tools/delivery/docs' });

  // ② ~/.claude 的内容型目录（环境无关，直接拷）
  for (const d of HOME_DIRS) {
    const src = join(HOME, '.claude', d);
    if (!existsSync(src)) { log(`跳过（不存在）: ~/.claude/${d}`); continue; }
    if (!DRY) cpSync(src, join(OUT, 'claude-home', d), { recursive: true });
    manifest.dirs.push({ name: `claude-home/${d}`, note: '环境无关内容，直接拷' });
  }

  // ③ 活配置 → 占位符化副本
  for (const cfg of LIVE_CONFIGS) {
    if (!existsSync(cfg.src)) { log(`跳过（不存在）: ${cfg.src}`); continue; }
    const raw = readFileSync(cfg.src, 'utf8');
    const before = (raw.match(/C:[\\/]Users[\\/][^"'\\/\s]+/gi) || []).length;
    const { text } = toPortable(raw);
    const after = (text.match(/C:[\\/]Users[\\/][^"'\\/\s]+/gi) || []).length;
    if (!DRY) writeFileSync(join(OUT, 'payload', cfg.rel.replace('claude-home/', '')), text, 'utf8');
    manifest.payload.push({ rel: cfg.rel, source: cfg.src, hardcodedBefore: before, hardcodedAfter: after, portable: after === 0 });
    log(`占位符化 ${cfg.rel}: ${before} → ${after} 处硬编码残留`);
  }

  // ③b 外部包：客户端本体 + STS 工具（用户拍板入包；逐项记录来源/目标位/入口/排除项）
  manifest.externalPackages = [];
  for (const pkg of EXTERNAL_PACKAGES) {
    const src = pkg.from;
    if (!src || !existsSync(src)) { log(`跳过（未提供或源不存在）: ${pkg.id} ← ${src || '<未配置>'}`); manifest.externalPackages.push({ ...pkg, packed: false, reason: src ? '源不存在' : '未提供源路径' }); continue; }
    const dst = join(OUT, pkg.to);
    let files = 0, bytes = 0;
    if (!DRY) {
      cpSync(src, dst, {
        recursive: true,
        filter: (s) => {
          const base = s.split(/[\\/]/).pop();
          if ((pkg.exclude || []).includes(base)) return false;
          return true;
        },
      });
      const w = (d) => { for (const ent of readdirSync(d, { withFileTypes: true })) { const p = join(d, ent.name); if (ent.isDirectory()) w(p); else { try { files += 1; bytes += st(p).size; } catch {} } } };
      try { w(dst); } catch {}
    }
    log(`外部包 ${pkg.id}: ${src} → ${pkg.to}（${files} 文件 / ${(bytes / 1048576).toFixed(1)} MB）`);
    manifest.externalPackages.push({ ...pkg, packed: !DRY, files, mb: +(bytes / 1048576).toFixed(1) });
  }

  // ③c 传输与验收指引（2026-09-19 补）：**这个"包"其实是一个含数千文件的目录**（见设计文档 §8.4「包的形态」）。
  //   目录形态唯一的致命风险＝传输途中漏文件/损坏，而落地器 P0 会对**每一个文件**做 sha256 全量校验兜住它 ——
  //   但此前**这句话只在我脑子里，没写在包上**。本文件由打包器生成 → 会被 CHECKSUMS 覆盖 → 不可被悄悄改掉。
  //   （必须在 ⑦ 枚举之前写，否则不会进校验清单。）
  if (!DRY) {
    const totals = manifest.totals || {};
    writeFileSync(join(OUT, 'READ-ME-FIRST.txt'), [
      '【先读这个，再往下做】',
      '',
      '这个"包"其实是一个**目录**（不是 zip/exe），里面有几千个文件。',
      '目录形态唯一的致命风险是：**传输途中漏了或坏了某个文件**。',
      '→ 落地器会在安装前对**每一个文件**做 sha256 校验，**漏一个或改一字节都会当场拒装**。',
      '   所以：**先拷，再校验，再装**。不要跳过校验直接装。',
      '',
      '⚠️⚠️ 【本包含明文 API 密钥】providers.json 3 条 + cc-haha/settings.json 1 条。',
      '     它是给**本人跨机搬运**用的**私人包**，不是分发件。**不要上传网盘公开链接 / 不要给他人**。',
      '     拷完确认能用之后，如果包会留在公共介质上，先把里面 payload/cc-haha-*.json 两个文件删掉。',
      '',
      '── 第 0 步：先在【终端】验（**不需要模型，不需要对话框**）────────',
      '这是机器可验的那半，零模型依赖 —— 在上面的 P0 校验命令里已经跑了。',
      '看到 "P0 包完整性 ✅" + "P4 L1 真源可读 ✅" + "P4 L2 引擎可跑 ✅" 就说明：',
      '包没坏、CP 引擎能跑、MCP server 能应答工具调用、Stop 链能真落盘。',
      '**这一半不需要你配任何模型就能验完。**',
      '',
      '── 第 1 步：把包弄到新机上 ──────────────────────────',
      '【优先】如果你手上有**同名的 .zip 文件**（和本目录同级的 <本目录名>.zip）：',
      '  传那**一个文件**就行 —— 比传 4245 个小文件快得多、也不会漏。',
      '  传到新机后 **双击解压** 即可，不需要任何命令行工具。',
      '  · 网盘/邮件/对象存储都行；**注意它内含明文密钥**（见上方警告）。',
      '',
      '【只能整目录拷时】把**整个目录**（含隐藏文件）复制过去，别只挑几个子目录：',
      '      robocopy "<源>" "<目标>" /E /COPY:DAT /R:2 /W:2 /XD "$RECYCLE.BIN" "System Volume Information"',
      '  · 先确认目标盘剩余空间 > 1.2 GB。',
      '',
      '── 第 1.5 步：还要拷【项目根】────────────────────',
      '   注意：本包**不含项目文件**（源机项目根目录之类）。',
      '   换机流程本来就要求**把项目根整个目录一起拷过去**（含它的 .project-root.json），',
      '   落地器只负责把"项目根指向哪"写进注册表 —— **目录本身要你自己拷**。',
      '   忘了这步的表现：install-check 报 "project-root-identity 目录不存在"。',
      '',
      '── 第 2 步：校验完整性（**必做**）──────────────────',
      '在包里用**包内的 node** 跑落地器的预检（不加 --apply 就是 dry-run，只校验不改动）：',
      '  <包>/cosmic-phantom/tools/node/node.exe <包>/cosmic-phantom/scripts/packaging/install-bundle.cjs \\',
      '      --bundle "<包目录>" --home "<新机用户目录>" --no-shortcuts',
      '看到 "P0 包完整性 ✅ N 个文件 sha256 全对（清单条数与 MANIFEST 声明一致）" 才算传好了。',
      '**报"内容不符/缺失"就是传输坏了 —— 重新拷，别硬装。**',
      '',
      '── 第 3 步：真装 ────────────────────────────────────',
      '把上一条命令加上 --apply 即可。装完报告里看两件事：',
      '  · exitCode 4 = 包侧全通；exitCode 1 = 失败（报告 errors 里带阶段）',
      '  · verdict / pending 里有没有"注入层未装"之类的**未完成项** —— 有就不算装好',
      '',
      '── 最后一步（只有人能做）────────────────────────────',
      '                      ',
      'L3b【我能读】在新机的 Claude Code 里调一次 recall_memory，能返回记忆 = 过。',
      'L4b【我能写】在新机说一句话，然后查 events.db 是否新增 session = 过。',
      '这两条机器验不了（涉及宿主真行为），落地器只会标"待人工确认"，不会并入"通过"。',
      '',
      `── 本包信息 ──────────────────────────────────────`,
      `文件数 ${totals.files || '?'} ｜ 体积 ${totals.mb || '?'} MB ｜ 打包于 ${manifest.packedAt || '?'}`,
      '校验清单：CHECKSUMS.sha256（覆盖除它自身以外的全包，含 MANIFEST.json）',
      '',
    ].join('\n'), 'utf8');
    log('已生成 READ-ME-FIRST.txt（传输与验收指引，进校验清单）');
  }

  // ③d 一键入口 `install.cmd`（2026-09-19 补）
  //   设计文档 §8.4 原文就是「目录 + **`install.cmd`**？」—— 我当日定案"目录形态、不做归档"时，
  //   把 `install.cmd` **连同 zip 一起否了**。但它跟"归档形态"是**两回事**：它是**执行入口**。
  //   动机（同批）：新机在远方时，那台机器上**未必有人愿意/会敲一长串命令行**；
  //   双击一个 .cmd 才是真的"开袋即食"。脚本里**自带包完整性预检**，坏了会停下并提示重传。
  if (!DRY) {
    const cmd = [
      '@echo off',
      'chcp 65001 >nul',
      'setlocal',
      'set "PKG=%~dp0"',
      'set "PACK=%~dp0"',
      'set "NODE=%PKG%cosmic-phantom\\tools\\node\\node.exe"',
      'set "INST=%PKG%cosmic-phantom\\scripts\\packaging\\install-bundle.cjs"',
      '',
      'echo ================================================',
      'echo   Cosmic Phantom 安装（开袋即食）',
      'echo ================================================',
      'echo   包目录  : %PACK%',
      'echo   用户目录: %USERPROFILE%',
      'echo.',
      '',
      'if not exist "%NODE%" ( echo [x] 找不到包内 node，包可能没解压完整：%NODE% & echo. & pause & exit /b 1 )',
      'if not exist "%INST%"  ( echo [x] 找不到落地器：%INST% & echo. & pause & exit /b 1 )',
      '',
      'echo [1/2] 先做包完整性校验（只读，不改动任何东西）…',
      'echo.',
      '"%NODE%" "%INST%" --bundle "%PACK%" --home "%USERPROFILE%"',
      'set RC=%errorlevel%',
      'if "%RC%"=="4" goto :verified',
      'if "%RC%"=="0" goto :verified',
      'echo.',
      'echo [x] 校验没通过（退出码 %RC%）—— 包在传输中损坏或缺失。',
      'echo     请把包重新传一次（优先传同名 .zip 单个文件），别硬装。',
      'echo.',
      'pause',
      'exit /b 1',
      ':verified',
      '',
      'echo.',
      'echo [2/2] 校验通过，开始安装…',
      'echo.',
      '"%NODE%" "%INST%" --bundle "%PACK%" --home "%USERPROFILE%" --apply',
      'set RC=%errorlevel%',
      '',
      'echo.',
      'echo ================================================',
      'echo   安装结束，退出码 %RC%',
      'echo   4 = 包侧全通（L3b/L4b 仍需人工确认，见报告 pending）',
      'echo   1 = 失败（报告 errors 里带阶段）',
      'echo ================================================',
      'echo.',
      'echo 下一步：打开 Proma，新开一个会话发一句话，检查记忆工具与自动落盘。',
      'echo.',
      'pause',
      '',
    ].join('\r\n');
    writeFileSync(join(OUT, 'install.cmd'), cmd, 'utf8');
    log('已生成 install.cmd（双击即装；自带包完整性预检，进校验清单）');
  }

  // ④ G2：扫出包内引用的 **home 之外** 的绝对路径（占位符覆盖不到 → 新机需人工确认/重指）
  //   判据：payload 每个文本里的盘符绝对路径，剔除已被 <USER_HOME> 覆盖的与 URL 里的。
  {
    const found = new Map();
    for (const cfg of LIVE_CONFIGS) {
      const f = join(OUT, 'payload', cfg.rel.replace('claude-home/', ''));
      if (DRY || !existsSync(f)) continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.match(/[A-Za-z]:[\\/][^"'\r\n]{2,}/g) || []) {
        const p = m.trim();
        if (/^<USER_HOME>/.test(p)) continue;
        if (/^\w+:\/\//.test(p)) continue;              // URL（含盘符样式的 http:// 不会命中，仅防御）
        found.set(p, (found.get(p) || 0) + 1);
      }
    }
    manifest.externalRefs = [...found.entries()].map(([path, times]) => ({ path, times }));
    if (manifest.externalRefs.length) {
      log(`⚠️ 包外引用 ${manifest.externalRefs.length} 条（home 之外，占位符覆盖不到，新机需人工处理）：`);
      for (const r of manifest.externalRefs) log(`   ${r.path}  ×${r.times}`);
    }
  }

  // ⑤ 体积/文件数（供核对与体积优化；打包前预判 → 防止"以为很小其实很大"）
  if (!DRY) {
    const walk = (d) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else { try { manifest.totals.files += 1; manifest.totals.bytes += st(p).size; } catch {} }
      }
    };
    try { walk(OUT); } catch {}
    manifest.totals.mb = +(manifest.totals.bytes / 1048576).toFixed(1);
  }

  // ⑥ 落地校验项（"100% 落地"的四级判据，由 install 脚本执行）
  manifest.verification = [
    { level: 'L1', name: '真源可读', act: 'node <root>/memory-cli.js stats --root <root>', expect: '有输出且 count>0' },
    { level: 'L2', name: '引擎可执行', act: 'node <root>/verify --root <root>', expect: '可运行（stale 可接受）' },
    { level: 'L3', name: 'MCP 通道通', act: '在 Claude Code 里实际调一次 recall_memory', expect: '返回记忆数组', manual: true,
      note: '落地器无法自验 → 必须输出"已注册，待确认"且写入盲区账本（未观测），不许并入"通过"' },
    { level: 'L4', name: '落盘通道通', act: '说一句话后查 events.db 是否新增', expect: 'session 数增加', manual: true,
      note: '同上' },
  ];

  // ⑦ 完整性校验（B1，2026-09-16）：全包逐文件 sha256 → `CHECKSUMS.sha256`。
  //   动机：传输（U 盘/网盘/跨机拷贝）是继承包的必经一步，而原包只有"文件数+字节数"——
  //   **同字节数的损坏/替换完全发现不了**。本文件是落地器 P0 的唯一传输完整性防线。
  //   ⚠️ 2026-09-16 审计 M5 修正：**MANIFEST.json 现在也纳入校验**（原来排除它 → 改 MANIFEST 不可发现）。
  //     顺序必须为"先定稿 MANIFEST → 再算哈希"，否则自指失效（checksumCount 写在 MANIFEST 里，
  //     而 MANIFEST 的哈希又取决于它的内容）。做法：①枚举文件（排除 CHECKSUMS 自身）得 N
  //     ②写定稿 MANIFEST（含 checksumCount=N）③再对含 MANIFEST 的 N 个文件逐个哈希 → CHECKSUMS。
  //     未覆盖的只剩 CHECKSUMS 自身；它的截断由落地器"清单条数 == MANIFEST.checksumCount"断言兜住，
  //     而伪造该断言需要同时改 MANIFEST → 被 MANIFEST 自己的哈希暴露。
  if (!DRY) {
    // ① 枚举（排除 CHECKSUMS 自身；MANIFEST 参与计数与哈希）
    const files = [];
    const walkAll = (d) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) walkAll(p);
        else {
          const rel = relative(OUT, p).split(sep).join('/');
          if (rel === 'CHECKSUMS.sha256') continue;
          files.push({ abs: p, rel });
        }
      }
    };
    try { walkAll(OUT); } catch (e) { log(`⚠️ checksum 枚举异常: ${e.message}`); }
    // ② 写定稿 MANIFEST（含 checksumCount / packedAt）
    //   注意：MANIFEST 若尚不存在，本步会**新建**它 → 它也必须进清单，故计数与哈希都要把它算上
    //   （首版漏了这步：全新包枚举时 MANIFEST 还不存在 → 根本没被校验，改动不可发现）
    const hadManifest = files.some((f) => f.rel === 'MANIFEST.json');
    manifest.packedAt = 'PLACEHOLDER_SET_AT_INSTALL';
    manifest.checksumFile = 'CHECKSUMS.sha256';
    manifest.checksumCount = files.length + (hadManifest ? 0 : 1);
    manifest.checksumNote = '覆盖除 CHECKSUMS.sha256 自身以外的全包（**含 MANIFEST.json**）；截断由落地器"条数==checksumCount"断言兜底';
    // B1-②（2026-09-28，来源 cp-rd-next-20260919 ②）：打包收尾跑快测试，结果写进 MANIFEST ——"引擎对错"从声称变包内可查
    try {
      if (!DRY) {
        const runT = (f) => {
          const tr = spawnSync(process.execPath, ['--experimental-sqlite', join(ROOT, 'tests', f)], { encoding: 'utf8', timeout: 180000 });
          const tm = (tr.stdout || '').match(/(\d+)\s*(?:passed|通过)\s*[\/／]\s*(\d+)\s*(?:failed|失败)/);
          return tm ? { passed: +tm[1], failed: +tm[2], exit: tr.status } : { passed: null, failed: null, exit: tr.status };
        };
        manifest.tests = { guard: runT('guard-selftest.js'), regression: runT('regression-test.js'), at: new Date().toISOString(), note: '打包时快测（guard/regression）；全量请手动跑 tests 全套' };
      }
    } catch (e) { manifest.tests = { error: String(e.message).slice(0, 120) }; }
    writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    // 新建的 MANIFEST 也要进清单（否则它的改动不可发现，而 checksumCount 已把它算上 → 还会恒报"条数不符"）
    if (!hadManifest) files.push({ abs: join(OUT, 'MANIFEST.json'), rel: 'MANIFEST.json' });
    // ③ 逐个哈希（MANIFEST 已是终稿）
    const lines = [];
    for (const f of files) {
      try { lines.push(`${createHash('sha256').update(readFileSync(f.abs)).digest('hex')}  ${f.rel}`); } catch (e) { log(`⚠️ 哈希失败 ${f.rel}: ${e.message}`); }
    }
    lines.sort();
    writeFileSync(join(OUT, 'CHECKSUMS.sha256'), lines.join('\n') + '\n', 'utf8');
    log(`完整性清单：${lines.length} 个文件（含 MANIFEST.json）→ CHECKSUMS.sha256`);
  }

  // ⑧ 单文件归档（2026-09-19 补，**远程新机场景的刚需**）
  //   动机：用户新机在美国 —— "把 4245 个文件传过去"用网盘/scp 极慢且极易漏；
  //   **能人肉拷单个文件的方案，在"够不着那台机器"时完全不成立**。
  //   ⇒ 收敛传输面为 **1 个文件**。用 **Windows 自带 tar.exe（bsdtar）**，零外部依赖；
  //   产 **zip**（而非 tar）是因为新机上**双击即可解压**，不依赖任何命令行工具。
  //   ⚠️ 必须在 CHECKSUMS 写完之后做 —— 归档不该包含它自己。
  if (!DRY && !NO_ARCHIVE) {
    const SYS_TAR = 'C:\\Windows\\System32\\tar.exe';
    const zipPath = OUT.replace(/[\\/]+$/, '') + '.zip';
    if (!existsSync(SYS_TAR)) {
      log('⚠️ 系统无 C:\\Windows\\System32\\tar.exe（需 Win10 1803+）→ 跳过单文件归档');
    } else {
      try { rmSync(zipPath, { force: true }); } catch {}
      log(`单文件归档中 → ${zipPath}（4245 个文件打包，可能需要几分钟）…`);
      const r = spawnSync(SYS_TAR, ['-a', '-c', '-f', zipPath, '-C', dirname(OUT), basename(OUT)], { encoding: 'utf8', timeout: 1800000 });
      if (r.status === 0 && existsSync(zipPath)) {
        log(`✅ 单文件归档完成 → ${zipPath}（${(statSync(zipPath).size / 1048576).toFixed(1)} MB）`);
      } else {
        log(`⚠️ 归档失败（退出码 ${r.status}）：${String(r.stderr || '').slice(0, 200)}`);
      }
    }
  }

  console.log(JSON.stringify({ ok: true, out: OUT, dryRun: DRY, totals: manifest.totals, excluded: manifest.excluded.length, externalRefs: manifest.externalRefs }, null, 2));
}

try { main(); } catch (e) { console.log(JSON.stringify({ error: String(e && e.message || e) })); process.exit(1); }
