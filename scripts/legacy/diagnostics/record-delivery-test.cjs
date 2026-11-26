#!/usr/bin/env node
/**
 * record-delivery-test.cjs — 交付测试台账写入（C1，2026-09-29 STS×CP）
 *
 * 背景：迁移包等交付物存在「改完忘测就交付」的风险（2026-09-29 用户定纪律：改→测试→才报）。
 *   本脚本把「测试过」变成有账可查：追加一行到 `.flags/delivery-verification.jsonl`，
 *   由 `memory-cli.js` verify 的 F27 守卫对账「交付物改动是否晚于最后测试」。
 *   配套（C2）：cp-autopilot 的 pending 通道会对「包有改动未测试」做会话内轻提醒。
 *
 * 用法：
 *   node record-delivery-test.cjs <deliverable> <pass|fail|retired> [evidence] [--root <根>] [--by <actor>]
 *     <deliverable>  交付物路径（文件或目录；目录对账时取递归最大 mtime）
 *     pass|fail      测试结果；retired = 退役（F27 跳过该条目，用于交付物永久移除后清账）
 *     [evidence]     证据引用（pro/ 档案、evt_xxx、测试名等；可省略）
 *
 * 输出：JSON 到 stdout（{ok, deliverable, result, testedAt, observedMtime, by, file}）。
 * 失败语义：参数错误 / pass|fail 时交付物不存在 / 写入失败 → exit 1 + JSON error（调用方必须知道没记上）。
 *
 * 纪律（2026-09-29 挑刺 R7 固化）：
 *   - record 必须是「包测试链的最后一个动作」——DryRun 等测试会写包内 logs\（更新 mtime），
 *     若 record 之后再跑任何测试动作，F27 会报「改动晚于最后测试」（判据正确但会困惑）。
 *   - 正确顺序：改动 → 全部测试（含 DryRun）→ record → verify 确认 F27 转绿。
 */
'use strict';

const { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

// 位置参数：剔除 --root <v> / --by <v> 与其值
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root' || a === '--by') { i++; continue; }
  if (a.startsWith('--')) continue;
  positional.push(a);
}

const ROOT = arg('--root') || process.env.CP_ROOT || join(homedir(), '.cosmic-phantom');
const FILE = join(ROOT, '.flags', 'delivery-verification.jsonl');

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function die(error) { out({ ok: false, error }); process.exit(1); }

const [deliverableArg, result, evidence] = positional;

if (!deliverableArg) die('缺少 <deliverable>；用法: node record-delivery-test.cjs <deliverable> <pass|fail|retired> [evidence] [--root <根>] [--by <actor>]');
if (!['pass', 'fail', 'retired'].includes(result)) die(`<result> 必须为 pass|fail|retired（收到：${result || "空"}）`);

const deliverable = resolve(deliverableArg);
if (result !== 'retired' && !existsSync(deliverable)) die(`交付物不存在，无法记录测试：${deliverable}`);

// 交付物最新 mtime（目录 = 递归最大；fail-open 单项错误跳过）
function latestMtime(p) {
  let mx = 0;
  const walk = (q) => {
    let st; try { st = statSync(q); } catch { return; }
    if (st.mtimeMs > mx) mx = st.mtimeMs;
    if (st.isDirectory()) {
      let kids = []; try { kids = readdirSync(q); } catch { return; }
      for (const k of kids) walk(join(q, k));
    }
  };
  walk(p);
  return mx || null;
}

const now = new Date();
const observedMtimeMs = latestMtime(deliverable);
const rec = {
  schemaVersion: 1,
  deliverable,
  result,
  evidence: evidence || null,
  testedAt: now.toISOString(),
  observedMtime: observedMtimeMs ? new Date(observedMtimeMs).toISOString() : null,
  by: arg('--by') || 'Proma',
};

try {
  mkdirSync(join(ROOT, '.flags'), { recursive: true });
  appendFileSync(FILE, JSON.stringify(rec) + '\n', 'utf8');
} catch (error) {
  die(`台账写入失败: ${error.message}`);
}

out({ ok: true, ...rec, file: FILE });
