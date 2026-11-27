#!/usr/bin/env node
/**
 * update-snapshot.js — AGENTS.md 状态快照刷新（强执行通道 2，2026-08-12）
 *
 * 宿主每次新会话自动注入工作区 AGENTS.md——收尾时刷新快照段，
 * 新会话开场即带当前状态，不靠 Agent 自觉执行 recall。
 * 与 MCP instructions（通道 1）双保险：任一被宿主支持即生效。
 *
 * 用法:
 *   node update-snapshot.js [--root <cosmic根>]
 * 输出: { ok, snapshotBytes }
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const AGENTS_FILE = join(ROOT, "AGENTS.md");
const NODE = existsSync(join(ROOT, "tools", "node", "node.exe")) ? join(ROOT, "tools", "node", "node.exe") : process.execPath;
const START = "<!-- snapshot-start -->";
const END = "<!-- snapshot-end -->";

function buildSnapshot() {
  const parts = [];
  try {
    const st = JSON.parse(readFileSync(join(ROOT, "current-state.json"), "utf8").replace(/^\uFEFF/, ""));
    parts.push(`- revision ${st.revision}（${(st.updatedAt || "").slice(0, 10)}）`);
    if (st.objective) parts.push(`- 当前目标：${st.objective}`);
    if (Array.isArray(st.nextActions) && st.nextActions.length) parts.push(`- 下一步：${st.nextActions.slice(0, 2).join(" / ")}`);
    if (Array.isArray(st.decisions) && st.decisions.length) parts.push(`- 最近决策：${st.decisions.slice(-2).join(" / ")}`);
  } catch (e) { parts.push(`- 状态读取失败：${e.message}`); }
  try {
    const r = spawnSync(NODE, ["--experimental-sqlite", join(ROOT, "events.js"), "coverage", "--root", ROOT], { encoding: "utf8", timeout: 20000 });
    if (r.status === 0) {
      const j = JSON.parse((r.stdout || "").split("\n").filter(Boolean).pop() || "{}");
      const bad = (j.gaps || []).filter(g => g.gap !== null && g.gap > 1).map(g => `${g.name}(${g.gap})`).join("、");
      const missSum = (j.gaps || []).reduce((a, g) => a + (g.missing || 0), 0);
      const extraSum = (j.gaps || []).reduce((a, g) => a + (g.extra || 0), 0);
      parts.push(`- 吸收状态：missing ${missSum} / extra ${extraSum}（严格对齐 ${j.aligned}/${j.checked} 源${bad ? `；缺口 ${bad}` : ""}）`);
    }
  } catch {}
  try {
    const files = readdirSync(join(ROOT, "daily")).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-1);
    const decs = [];
    for (const f of files) {
      const raw = readFileSync(join(ROOT, "daily", f), "utf8").replace(/^\uFEFF/, "");
      for (const m of (raw.match(/^- (?:⭐👤 用户（决策）|🛠️ Agent（成果）)：.+$/gm) || []).slice(-2)) decs.push(m.replace(/^- (?:⭐👤 用户（决策）|🛠️ Agent（成果）)：/, "").slice(0, 100));
    }
    if (decs.length) parts.push(`- 最近记录：${decs.join(" / ")}`);
  } catch {}
  return "## 📸 状态快照（收尾自动刷新，新会话开场即注入；勿手改）\n" + parts.join("\n");
}

// 快照目标（2026-09-16 多宿主化）：新会话"打开就知道在干什么"靠的是**注入层带快照**。
//   Claude Code 的注入层 = ~/.claude/CLAUDE.md（每会话必注入，已验证）→ 快照写进它即可。
//   本脚本由 Stop 链（claude-flush.cjs）自动调用 → 每轮保鲜，无需人工动作。
//   【2026-09-16 修正】原注释称"Claude Code 侧 SessionStart hook 至今未真实触发、探针为空"——已证伪：
//   探针实测到 source="startup" 与 source="compact"，该 hook 通道真实可用。
//   【沙箱隔离】宿主目标（~/.claude/CLAUDE.md）是**绝对路径、不随 --root 走**：沙箱测试若带 --root，
//   仍会写真实宿主文件（2026-09-16 实测踩到；本次因内容恰好一致未造成改变，属侥幸）。
//   对策：只在 ROOT = 规范真源根时才写宿主目标，沙箱一律不碰宿主。
const CANONICAL_ROOT = join(homedir(), ".cosmic-phantom");
const IS_CANONICAL = resolve(ROOT) === resolve(CANONICAL_ROOT);
const TARGETS = [
  { host: "workdir", file: AGENTS_FILE },
  ...(IS_CANONICAL ? [{ host: "claude-code", file: join(homedir(), ".claude", "CLAUDE.md") }] : []),
];

function syncOne(file, block) {
  if (!existsSync(file)) return { file, skipped: "文件不存在" };
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const updated = raw.includes(START) && raw.includes(END)
    ? raw.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block)
    : raw.replace(/\n## 我是谁/, `\n${block}\n\n## 我是谁`);
  if (updated === raw) return { file, action: "unchanged" };
  writeFileSync(file, updated, "utf8");
  return { file, action: "updated" };
}

function main() {
  const snap = buildSnapshot();
  const block = `${START}\n${snap}\n${END}`;
  const results = TARGETS.map((t) => ({ host: t.host, ...syncOne(t.file, block) }));
  process.stdout.write(JSON.stringify({ ok: true, snapshotBytes: Buffer.byteLength(block), targets: results, at: new Date().toISOString() }) + "\n");
}

main();

// reply-policy 单源同步(2026-08-29 reverse-skill 经验:单源→派生物自动生成→F20 守卫)
// 2026-09-15 B1 修复：原用 require()，而本文件是 ESM → "require is not defined"。
// 后果：门禁自动同步自 2026-08-29 上线起从未成功执行过一次（fail-open 静默吞掉，无人发现）。
// 顶部已 import spawnSync / join / homedir，此处直接复用，不再重复解构。
try {
  const root = (() => { const i = process.argv.indexOf("--root"); return i > 0 ? process.argv[i + 1] : join(homedir(), ".cosmic-phantom"); })();
  const r = spawnSync(process.execPath, [join(root, "sync-reply-policy.mjs"), "--root", root], { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) console.error("[sync-reply-policy] 同步失败:", (r.stderr || "").slice(0, 200));
} catch (e) { console.error("[sync-reply-policy] fail-open:", e.message); }
