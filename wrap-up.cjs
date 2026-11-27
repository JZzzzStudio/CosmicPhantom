#!/usr/bin/env node
/**
 * wrap-up.cjs — 一键收尾(P0-4,2026-08-29 实装)。
 *
 * 把收尾自检四步从"4 次自觉"压缩为"1 条命令",顺序锁死(F6 抓的顺序错乱类人祸在此根除):
 *   ①verify(noise=0 且 indexDrift=false 才放行;stale 仅显示不强判)
 *   ②events status(events=projected 才放行)
 *   ③current-state update(--patch-file 传入时执行,revision 自动读取;无 patch 跳过并提示)
 *   ④update-snapshot(刷新 AGENTS.md 快照)
 *   ⑤maintain(index+distill+project-version+mirror)
 *
 * 用法(便携 node,需 --experimental-sqlite):
 *   node --experimental-sqlite wrap-up.cjs --root <root> [--actor agent] [--patch-file patch.json] [--skip-state]
 * 任一步失败:打印 ❌ + 所在步骤,exit 1;全过:打印 ✅ 摘要。
 * patch 内容须过内容纪律(summary ≤100 字、objective ≤250B、nextActions ≤3 条,校验在 current-state.js)。
 */
const { spawnSync } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg("--root") || join(homedir(), ".cosmic-phantom");
const NODE = process.env.CP_NODE || join(ROOT, "tools", "node", "node.exe");
const ACTOR = arg("--actor") || process.env.CP_ACTOR || "agent";
const PATCH_FILE = arg("--patch-file");
const SKIP_STATE = process.argv.includes("--skip-state");
const cli = ["--experimental-sqlite"];

function run(step, file, args, judge) {
  const r = spawnSync(NODE, [...cli, join(ROOT, file), ...args], { encoding: "utf8", timeout: 120000 });
  let out = null;
  try { out = JSON.parse((r.stdout || "").trim()); } catch {}
  const verdict = judge ? judge(out, r) : { ok: r.status === 0 };
  console.log(`${verdict.ok ? "✅" : "❌"} ${step}${verdict.note ? ` — ${verdict.note}` : ""}`);
  if (!verdict.ok) {
    if (r.stderr) console.error((r.stderr || "").slice(0, 500));
    console.error(`❌ 收尾在第 ${step} 步中断,修复后重跑本命令。`);
    process.exit(1);
  }
  return out;
}

console.log("🛠️ wrap-up 收尾开始");
// T05 写入纪律（2026-11-19，依据 Anthropic 的 salience 原则）：
//   只记「不写就不存在」的策略/规则/坑；能从环境重读的状态不要落卡。
console.log("📝 写入自问：这一轮里，哪条信息是「不写下来就不存在」的？其余不必写入。");

// ① verify:0 噪音 + 无索引漂移才放行(stale 为建议级,只显示)
const v = run("1/6 verify", "memory-cli.js", ["verify", "--root", ROOT], (out, r) => {
  if (!out) return { ok: r.status === 0, note: "(非 JSON 输出,按 exit code)" };
  const ok = r.status === 0 && out.noise === 0 && out.indexDrift === false;
  const staleNote = Array.isArray(out.stale) && out.stale.length ? ` | stale ${out.stale.length} 条(建议级):${out.stale[0]}` : "";
  return { ok, note: `noise=${out.noise} indexDrift=${out.indexDrift} total=${out.total}${staleNote}` };
});

// ② events status:events=projected
run("2/6 events status", "events.js", ["status", "--root", ROOT], (out, r) => {
  if (!out) return { ok: r.status === 0, note: "(非 JSON 输出,按 exit code)" };
  // 2026-11-19：audit 行（purge-audit）按设计不投影，不计入缺口，否则收尾永久卡死
  const audit = Number(out.audit || 0);
  const ok = r.status === 0 && (out.events - audit) === out.projected;
  return { ok, note: `events=${out.events} audit=${audit} projected=${out.projected}` };
});

// ③ current-state update(可选:--patch-file 或 --skip-state)
if (SKIP_STATE) {
  console.log("⏭️ 3/6 current-state update — --skip-state 跳过(状态未更新,新会话注入仍是旧状态)");
} else if (PATCH_FILE && existsSync(PATCH_FILE)) {
  let patch = {};
  try { patch = JSON.parse(readFileSync(PATCH_FILE, "utf8")); } catch (e) { console.error(`❌ patch 解析失败:${e.message}`); process.exit(1); }
  const cur = JSON.parse(readFileSync(join(ROOT, "current-state.json"), "utf8"));
  const pf = join(ROOT, ".wrapup-patch.tmp");
  require("node:fs").writeFileSync(pf, JSON.stringify(patch), "utf8");
  const r = spawnSync(NODE, [...cli, join(ROOT, "current-state.js"), "update", "--expected-revision", String(cur.revision), "--actor", ACTOR, "--root", ROOT], { encoding: "utf8", timeout: 30000, input: JSON.stringify(patch) });
  let out = null; try { out = JSON.parse((r.stdout || "").trim()); } catch {}
  const err = out?.error || (r.status !== 0 ? (r.stderr || "unknown").slice(0, 300) : null);
  if (err) { console.log(`❌ 3/6 current-state update — ${err}`); require("node:fs").rmSync(pf, { force: true }); process.exit(1); }
  console.log(`✅ 3/6 current-state update — rev ${cur.revision}→${cur.revision + 1} by ${ACTOR}`);
  try { require("node:fs").rmSync(pf, { force: true }); } catch {}
} else {
  console.log("⏭️ 3/6 current-state update — 未传 --patch-file,跳过(如状态有变,补跑 current-state.js update 后再重跑本命令)");
}

// ④ update-snapshot:必须在 update 之后(F6 顺序守卫);前置 resume-manifest 重戳
//   (R1b 2026-09-01 拍板:rules/policy 演进后恢复门曾静默红 15 天——refresh 收进收尾链,不再依赖下次 distill)
const rr = spawnSync(NODE, [join(ROOT, "resume-context.js"), "refresh", "--actor", `wrapup-${ACTOR}`, "--root", ROOT], { encoding: "utf8", timeout: 30000 });
let refreshOk = rr.status === 0;
try { refreshOk = JSON.parse((rr.stdout || "").trim()).ok !== false && refreshOk; } catch {}
if (!refreshOk) console.log(`⚠️ 4/6 前置 resume-manifest refresh 失败(fail-open;手动修复:node resume-context.js refresh --root ${ROOT})`);
run("4/6 update-snapshot", "update-snapshot.js", ["--root", ROOT]);

// ⑤ maintain:index+distill+project-version+mirror
run("5/6 maintain", "memory-cli.js", ["maintain", "--root", ROOT]);

// ⑥ change-ledger(2026-08-29 实装):内容层指纹对账+归因+git 快照。检出变更自动 commit
//   (author=主归因);无归因变更 → F19 进下次 verify stale。放在 maintain 后:收尾所有写完成再对账。
//   (2026-09-30 W1-C:git 不可用时为显式降级 skipped-no-git——显示层加 ⚠️,不再表现为全绿)
let degraded = false;
run("6/6 change-ledger", "change-ledger.cjs", ["--root", ROOT], (out, r) => {
  if (r.status !== 0) return { ok: false, note: "对账/commit 失败,见 stderr" };
  if (!out) return { ok: true, note: "(无 JSON 输出)" };
  if (out.gitStatus === "skipped-no-git") degraded = true;
  const note = out.firstRun ? "基线已建立" : out.total
    ? `${out.total} 处变更(added ${out.added}/modified ${out.modified}/deleted ${out.deleted}) 无归因 ${out.unattributed} committed=${out.committed || "无"}`
    : "无变更";
  return { ok: true, note: degraded ? `${note} | ⚠️ git 不可用:快照层降级(skipped-no-git),内容台账已留痕` : note };
});

// 7/7 胶囊刷新（2026-11-19，票 23）：把注入清单与当前文件对齐。
//   fail-open：失败只提示，不阻断前六步（refresh 失败不代表收尾失败）。
try {
  const r = spawnSync(process.execPath, [join(ROOT, "resume-context.js"), "refresh", "--root", ROOT], { encoding: "utf8", timeout: 60000 });
  if (r.status === 0) console.log("✅ 7/7 resume-context refresh");
  else console.log("⚠️ 7/7 resume-context refresh fail-open — " + String((r.stderr || r.stdout || "")).split("\n")[0].slice(0, 80));
} catch (e) { console.log("⚠️ 7/7 resume-context refresh fail-open — " + String(e.message || e).slice(0, 80)); }

// ⑦ 盲区提醒（B1-③ 2026-09-28，来源 cp-rd-next-20260919 ③）：真机验证沉默可见化——不报红，只常驻一行
//   （cp-rd-next ③ 建议「① ② 全做；③ 只加一行 summary，不加新机制」）
try {
  const bf = join(ROOT, "core", "blindspot-ledger.md");
  if (existsSync(bf)) {
    const txt = readFileSync(bf, "utf8");
    if (txt.includes("L3b 0 次") || /L3b\s*0\s*次/.test(txt)) {
      const days = Math.floor((Date.now() - Date.parse("2026-09-16T00:00:00+08:00")) / 86400000);
      console.log(`📌 [盲区] 真机验证（L3b/L4b）仍未做——自 2026-09-16 挂 ${days} 天（已做请更新 core/blindspot-ledger.md §4）`);
    }
  }
} catch {}

console.log(degraded
  ? "⚠️ 收尾完成:verify→events→state→snapshot→maintain→ledger→refresh 全链通过(含 1 项降级:git 快照层 skipped-no-git)。"
  : "✅ 收尾完成:verify→events→state→snapshot→maintain→ledger 全链通过。");
