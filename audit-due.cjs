#!/usr/bin/env node
/**
 * audit-due.cjs — 「重大改动后必须跑对抗式查验」的机器强制（I-007 转化，2026-09-16）
 *
 * 背景（改进台账 I-007）：2026-09-15 用户「挑个刺」挖出 10 条全是当天自己造的坑——根因是
 *   "装东西时只看能不能跑通，没做装完会不会留坑的自检"。当时的转化措施写成"重大改动后应主动跑
 *   对抗式查验"，但那仍是**自觉**：adversarial-audit 只有"用户说挑刺 / 蒸馏连动"两个触发，
 *   缺"重大改动"这一路，且没有任何机制能证明"我到底跑了没有"。
 *
 * 本脚本把那一环变成有账可查：
 *   ① 客观判据 = 关键文件的 mtime 晚于「上次清账基线」（不写死时钟窗口，事件驱动）
 *   ② 落 flag `.flags/audit-due.json`（谁改了、从何时起、待查验）
 *   ③ 由 `memory-cli.js` 的 verify 守卫 F24 读 flag → stale 报红 → 收尾自检第①步必红
 *   ④ 清账唯二条件：跑完对抗式查验产出 pro/audit-*.md 后 `--clear --by <档案>`，
 *      或改判否决（须在本脚本 --clear 理由里写明）
 *
 * 用法：
 *   node audit-due.cjs [--root <根>]                    侦测并落 flag（Stop hook 链尾调用）
 *   node audit-due.cjs --status [--root <根>]           只看当前 flag
 *   node audit-due.cjs --clear --by <审计档案路径>      清账（跑完查验后）
 * 失败语义：fail-open——任何异常只写 hook-errors.log，绝不影响宿主主流程。
 */
'use strict';

const { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const ROOT = arg('--root') || process.env.CP_ROOT || join(homedir(), '.cosmic-phantom');
const FLAG = join(ROOT, '.flags', 'audit-due.json');
const LOG = join(ROOT, 'hook-errors.log');

// 关键文件清单：改了这些 = 动了机制本身，不是普通内容编辑。
//   刻意排除 daily/ distilled/ memories/ pro/ backup/（那些是内容与档案，改了不需要重挑刺）
const KEY_FILES = [
  // 引擎
  'events.js', 'memory-cli.js', 'validate.js', 'memory-retrieval.js', 'inject.js',
  'resume-context.js', 'current-state.js', 'link-graph.js', 'session-adapter.js',
  'decision-cards.js', 'update-snapshot.js', 'sync-reply-policy.mjs', 'skills-sync.js',
  'embed.js', 'identity-card.js', 'inject-config.js',
  // 收尾与维护层
  'wrap-up.cjs', 'change-ledger.cjs', 'audit-due.cjs',
  // C1 交付台账写入点（2026-09-29 STS×CP 补入；改了 = 改「交付前必测」的记账机制）
  'record-delivery-test.cjs',
  // 继承包链路（2026-09-19 补入 —— 原清单**漏了它们**，而这两个恰恰是「在新机上跑一次、错了不好回头」的东西；
  //   2026-09-19 那轮 7 条缺陷全出在这里，却因为不在表内而**没有任何守卫要求重挑刺**。与"audit-due 自己在表内"同理）
  'scripts/packaging/install-bundle.cjs', 'scripts/packaging/pack-bundle.cjs',
  // 宪法层（改了必须重挑刺）
  // 注：AGENTS.md **刻意不收**——它每轮收尾被 update-snapshot 自动重写（revision 一变就写），
  //   收进去会导致"每次收尾后 F24 必红"= 永久狼来了（2026-09-16 沙箱证伪：跑一次快照刷新 → due:true）。
  //   代价：AGENTS.md 里的**协议主体**（非快照段）改动不再自动触发查验，属已知盲区。
  'MEMORY.md', 'reply-policy.json',
  'core/rules.md', 'core/reply-style.md', '.context/CONTEXT.md',
];

function logErr(message) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] audit-due: ${message}\n`, 'utf8'); } catch {}
}

function readFlag() {
  try { return JSON.parse(readFileSync(FLAG, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function writeFlag(obj) {
  try {
    mkdirSync(join(ROOT, '.flags'), { recursive: true });
    writeFileSync(FLAG, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return true;
  } catch (error) { logErr(`flag 写入失败: ${error.message}`); return false; }
}

// 基线默认值 = 最新一份对抗式查验档案的 mtime（"自上次挑刺以来"）。没有档案才退化为现在。
function newestAuditDoc() {
  try {
    const dir = join(ROOT, 'pro');
    const files = readdirSync(dir).filter((f) => /^audit-.*\.md$/.test(f));
    let newest = 0, name = null;
    for (const f of files) {
      const m = statSync(join(dir, f)).mtimeMs;
      if (m > newest) { newest = m; name = `pro/${f}`; }
    }
    return newest ? { at: newest, name } : null;
  } catch { return null; }
}

// 外部关键文件（宿主配置不在 ROOT 下）
function externalFiles() {
  const out = [];
  const settings = join(homedir(), '.claude', 'settings.json');
  if (existsSync(settings)) out.push({ label: '~/.claude/settings.json', path: settings });
  return out;
}

function changedSince(baselineMs) {
  const changed = [];
  for (const rel of KEY_FILES) {
    const p = join(ROOT, rel);
    try {
      if (existsSync(p) && statSync(p).mtimeMs > baselineMs) changed.push(rel);
    } catch { /* 单个文件读不到不影响整体 */ }
  }
  for (const e of externalFiles()) {
    try { if (statSync(e.path).mtimeMs > baselineMs) changed.push(e.label); } catch {}
  }
  return changed;
}

function main() {
  const flag = readFlag();
  const auditDoc = newestAuditDoc();

  if (process.argv.includes('--status')) {
    process.stdout.write(JSON.stringify({
      flag: flag || null,
      newestAuditDoc: auditDoc ? auditDoc.name : null,
      note: 'due=true 时 verify 守卫 F24 会报 stale；跑完对抗式查验后用 --clear --by <档案> 清账',
    }, null, 2) + '\n');
    return;
  }

  if (process.argv.includes('--clear')) {
    const by = arg('--by') || null;
    // 凭据校验（2026-09-16 自踩补洞）：清账必须指向**真实存在的 pro/audit-*.md**。
    //   起因：实验时用 `--by test` 直接把生产账清了——账本若能被随手自洗，F24 就白装了。
    //   规则：--by 必填且必须命中 ROOT/pro/audit-*.md；命中的档案 mtime 早于本次基线则**只警告不阻断**
    //   （正常流程是"边查边改"，档案必然早于最后一次修复，硬卡会把机制卡死）。
    if (!by) {
      process.stdout.write(JSON.stringify({ cleared: false, error: '--clear 必须带 --by <pro/audit-*.md>（清账要凭据）' }, null, 2) + '\n');
      return;
    }
    const byPath = join(ROOT, by.replace(/^[\\/]+/, ''));
    const isAuditDoc = /(^|[\\/])pro[\\/]audit-.*\.md$/.test(byPath);
    if (!isAuditDoc || !existsSync(byPath)) {
      process.stdout.write(JSON.stringify({ cleared: false, error: `凭据不合法：${by} —— 必须是指向 ROOT/pro/audit-*.md 且真实存在的路径` }, null, 2) + '\n');
      return;
    }
    let warn = null;
    try {
      const docMs = statSync(byPath).mtimeMs;
      const baseMs = flag && flag.baseline ? Date.parse(flag.baseline) : 0;
      if (baseMs && docMs < baseMs) warn = '凭据档案 mtime 早于当前基线（边查边改的正常情形；若并非如此请复查是否真有对应查验）';
    } catch {}
    const baseline = new Date().toISOString();
    const ok = writeFlag({
      baseline,
      due: false,
      changed: [],
      clearedBy: by,
      clearedAt: baseline,
      note: '清账基线 = 本次查验时刻；此后任何关键文件改动会再次触发待查验',
    });
    process.stdout.write(JSON.stringify({ cleared: ok, baseline, clearedBy: by, warning: warn, previousChanged: (flag && flag.changed) || [] }, null, 2) + '\n');
    return;
  }

  // 侦测模式
  let baselineMs, baselineFrom;
  if (flag && flag.baseline) { baselineMs = Date.parse(flag.baseline); baselineFrom = 'flag'; }
  else if (auditDoc) { baselineMs = auditDoc.at; baselineFrom = auditDoc.name; }
  else { baselineMs = Date.now(); baselineFrom = 'now(首次初始化)'; }

  if (!Number.isFinite(baselineMs)) { logErr('基线不可解析，退化为现在'); baselineMs = Date.now(); baselineFrom = 'now(兜底)'; }

  const changed = changedSince(baselineMs);
  const baseline = new Date(baselineMs).toISOString();
  const due = changed.length > 0;

  // 已 due 的账不被清空（失败的查验不能靠"文件改回去"洗掉）
  const keepDue = !!(flag && flag.due);
  writeFlag({
    baseline,
    baselineFrom,
    due: due || keepDue,
    changed: due ? changed : (keepDue ? flag.changed : []),
    checkedAt: new Date().toISOString(),
    note: due
      ? `自 ${baseline.slice(0, 10)} 起 ${changed.length} 个关键文件被改动，未跑对抗式查验`
      : '无待查验改动',
  });

  process.stdout.write(JSON.stringify({ due: due || keepDue, baseline, baselineFrom, changed: due ? changed : (keepDue ? flag.changed : []) }, null, 2) + '\n');
}

try { main(); } catch (error) { logErr(`unhandled: ${error.message}`); process.stdout.write('{}\n'); }
