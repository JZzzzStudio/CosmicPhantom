#!/usr/bin/env node
/**
 * change-ledger.cjs — 内容层变更台账 + git 快照层(2026-08-29 实装,用户拍板 ①B ②A)。
 *
 * 回答"谁在什么时间改动了什么":
 *   ① 管道内修改 → events.db 已有 instance+ts 溯源,daily 段头已加"通道："标注(不改本脚本);
 *   ② 直接改文件(盲区,Proma 事故形态) → 本脚本在 verify/收尾时对内容层做 SHA-256 指纹对账,
 *      变更逐文件归因(文件 mtime 与 events.db 各 instance 会话活动窗口对齐,120 分钟窗),
 *      追加 change-log.jsonl;归因对不齐 = "无归因变更"(F19 进 stale 第一屏报警)。
 *   ③ git 快照层:检出变更即自动 commit(author=主归因 instance),任意时点可 diff/回滚。
 *      git 解析(2026-09-30 W1-C):CP_GIT → tools/git 便携包 → PATH;全不可用 → 显式降级
 *      (gitStatus="skipped-no-git",快照层跳过、内容层台账照常,exit 0 不算硬失败——新机迁移首验
 *       第 6 步曾因新机无 git 整链中断,此处改为留痕降级)。
 *
 * 范围(用户拍板 B:内容层) memories/ core/ daily/ .context/ AGENTS.md current-state.json
 *   reply-policy.json —— 脚本/索引/派生层不看(行为由 hook-smoke/verify 兜底)。
 * 纪律:事件驱动(收尾/手动触发,禁常驻监听);hash 变才算变更(touch 不算);git 失败显式报不静默。
 *
 * 用法:
 *   node --experimental-sqlite change-ledger.cjs --root <root> [--dry-run]
 *   首次运行 = 建基线(change-baseline.json),不记变更不 commit。
 */
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync } = require("node:fs");
const { join, relative, sep } = require("node:path");
const { homedir } = require("node:os");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg("--root") || join(homedir(), ".cosmic-phantom");
const DRY = process.argv.includes("--dry-run");
const BASELINE = join(ROOT, "change-baseline.json");
const CHANGELOG = join(ROOT, "change-log.jsonl");
const ATTRIB_WINDOW_MS = 120 * 60000;   // 归因窗口:事件在 mtime 前 120 分钟内视为可能活动

// git 候选(bin/git 便携优先于 PATH):解析结果按次运行缓存
const GIT_CANDIDATES = [
  process.env.CP_GIT,
  join(ROOT, "tools", "git", "cmd", "git.exe"),
  join(ROOT, "tools", "git", "mingw64", "bin", "git.exe"),
  join(ROOT, "tools", "git", "bin", "git.exe"),
  "git",
].filter(Boolean);
let _gitInfo;
function resolveGit() {
  if (_gitInfo !== undefined) return _gitInfo;
  for (const cand of GIT_CANDIDATES) {
    if (cand !== "git" && !existsSync(cand)) continue;
    const p = spawnSync(cand, ["--version"], { encoding: "utf8", timeout: 15000 });
    if (p.status === 0 && /git version/.test(p.stdout || "")) { _gitInfo = { bin: cand, version: (p.stdout || "").trim() }; return _gitInfo; }
  }
  _gitInfo = null;
  return null;
}
const SCAN_DIRS = ["memories", "core", "daily", ".context"];
const SCAN_FILES = ["AGENTS.md", "current-state.json", "reply-policy.json"];

function sha16(p) { return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16); }

function scan() {
  const files = {};
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = relative(ROOT, p).split(sep).join("/");
        try { files[rel] = { h: sha16(p), m: statSync(p).mtimeMs }; } catch {}
      }
    }
  };
  for (const d of SCAN_DIRS) walk(join(ROOT, d));
  for (const f of SCAN_FILES) { const p = join(ROOT, f); if (existsSync(p)) files[f] = { h: sha16(p), m: statSync(p).mtimeMs }; }
  return files;
}

function loadAttribution() {
  const ev = join(ROOT, "events.db");
  if (!existsSync(ev)) return [];
  try {
    const db = new DatabaseSync(ev, { readOnly: true });
    try { return db.prepare("SELECT ts, instance, src_host FROM events ORDER BY ts").all().map(r => ({ t: Date.parse(r.ts), i: r.src_host || r.instance })); }
    finally { try { db.close(); } catch {} }
  } catch { return []; }
}

function attribute(mtimeMs, events) {
  // 归因:事件时间 ∈ [mtime-120min, mtime+2min] 内,取距 mtime 最近者
  let best = null, bestGap = Infinity;
  for (const e of events) {
    if (!Number.isFinite(e.t)) continue;
    const gap = mtimeMs - e.t;
    if (gap < -2 * 60000 || gap > ATTRIB_WINDOW_MS) continue;
    const abs = Math.abs(gap);
    if (abs < bestGap) { bestGap = abs; best = e.i; }
  }
  return best;
}

function git(args) {
  const g = resolveGit();
  if (!g) return { status: null, error: new Error("no-git"), stdout: "", stderr: "no-git" };
  return spawnSync(g.bin, ["-C", ROOT, ...args], { encoding: "utf8", timeout: 60000 });
}

function gitReady() {
  if (!resolveGit()) return { noGit: true };
  if (!existsSync(join(ROOT, ".git"))) {
    const r = git(["init"]);
    if (r.status !== 0) return { error: `git init 失败: ${(r.stderr || "").slice(0, 200)}` };
    git(["config", "user.name", "cosmic-phantom"]);
    git(["config", "user.email", "cp@local"]);
    const ignore = ["tools/", "backup/", "memory-index.db", "fingerprints.db", "embedding-db/", "links.json", "events.db", "events.db-wal", "events.db-shm", "hook-errors.log", ".watch.lock", ".watch-paused", "*.tmp", "state-poll.json"];
    const ig = join(ROOT, ".gitignore");
    if (!existsSync(ig)) writeFileSync(ig, ignore.join("\n") + "\n", "utf8");
  }
  return {};
}

function main() {
  const now = new Date().toISOString();
  const current = scan();
  const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
  if (!base) {
    // 首次:建基线
    if (DRY) { console.log(JSON.stringify({ at: now, firstRun: true, files: Object.keys(current).length, note: "dry-run 不写基线" }, null, 2)); return; }
    writeFileSync(BASELINE, JSON.stringify({ version: 1, at: now, files: current }, null, 1), "utf8");
    console.log(JSON.stringify({ at: now, firstRun: true, files: Object.keys(current).length, note: "基线已建立,下次运行开始对账" }, null, 2));
    return;
  }

  // 对账:hash 变才算变更(touch/mtime-only 不算)
  const changes = [];
  for (const [rel, cur] of Object.entries(current)) {
    const prev = base.files[rel];
    if (!prev) changes.push({ file: rel, kind: "added", mtime: new Date(cur.m).toISOString(), attributed: null });
    else if (prev.h !== cur.h) changes.push({ file: rel, kind: "modified", mtime: new Date(cur.m).toISOString(), attributed: null });
  }
  for (const rel of Object.keys(base.files)) if (!current[rel]) changes.push({ file: rel, kind: "deleted", mtime: now, attributed: null });

  const events = loadAttribution();
  for (const c of changes) c.attributed = attribute(c.kind === "deleted" ? Date.now() : Date.parse(c.mtime), events);

  const unattributed = changes.filter(c => !c.attributed);
  const counts = changes.reduce((a, c) => (a[c.kind] = (a[c.kind] || 0) + 1, a), {});
  const record = { at: now, total: changes.length, added: counts.added || 0, modified: counts.modified || 0, deleted: counts.deleted || 0, unattributed: unattributed.length, changes, committed: null };

  if (DRY) { console.log(JSON.stringify({ ...record, note: "dry-run 不写 log 不 commit" }, null, 2)); return; }

  // git 快照层(顺序:先写台账/基线,再 add -A —— 首次变更时 change-log.jsonl 才存在)
  if (changes.length) {
    writeFileSync(BASELINE, JSON.stringify({ version: 1, at: now, files: current }, null, 1), "utf8");
    const tmp = CHANGELOG + ".tmp";
    let prev = "";
    try { prev = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : ""; } catch {}
    writeFileSync(tmp, prev + JSON.stringify(record) + "\n", "utf8");
    renameSync(tmp, CHANGELOG);

    const gr = gitReady();
    if (gr.noGit) {
      // 显式降级:不退化成硬失败(内容层台账已写,快照层留痕跳过)
      record.gitStatus = "skipped-no-git";
      record.gitNote = "未找到可用 git(CP_GIT / tools/git 便携 / PATH 均不可用)→ 快照层降级跳过,内容层台账照常";
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    if (gr.error) { record.gitStatus = "error"; record.gitError = gr.error; console.log(JSON.stringify(record, null, 2)); process.exitCode = 1; return; }
    const tally = {};
    for (const c of changes) if (c.attributed) tally[c.attributed] = (tally[c.attributed] || 0) + 1;
    const mainInstance = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || "unattributed";
    const gInfo = resolveGit();
    if (gInfo) record.gitUsed = `${gInfo.bin} (${gInfo.version})`;
    const add = git(["add", "-A"]);
    if (add.status !== 0) { record.gitStatus = "error"; record.gitError = `git add 失败: ${(add.stderr || "").slice(0, 200)}`; console.log(JSON.stringify(record, null, 2)); process.exitCode = 1; return; }
    record.gitStatus = "ok";
    const msg = `change-ledger ${now}: ${changes.length} 处变更(added ${counts.added || 0}/modified ${counts.modified || 0}/deleted ${counts.deleted || 0}) 归因:${Object.entries(tally).map(([k, v]) => `${k.split(":")[0]}×${v}`).join(",") || "无归因"}`;
    const ci = git(["-c", `user.name=${mainInstance.split(":")[0]}`, "-c", "user.email=cp@local", "commit", "-m", msg]);
    if (ci.status !== 0) {
      if ((ci.stdout || "").includes("nothing to commit")) record.committed = "no-change";
      else { record.gitStatus = "error"; record.gitError = `git commit 失败: ${((ci.stderr || "") + (ci.stdout || "")).slice(0, 200)}`; console.log(JSON.stringify(record, null, 2)); process.exitCode = 1; return; }
    } else {
      const sha = git(["rev-parse", "--short", "HEAD"]);
      record.committed = sha.status === 0 ? sha.stdout.trim() : "committed";
    }
  }
  // 可选面板联动：仅在调用方显式提供构建器路径时刷新外部面板。
  try {
    const b = process.env.CP_PANEL_BUILDER;
    if (b && changes.length && existsSync(b)) spawnSync(process.execPath, ["--experimental-sqlite", b], { encoding: "utf8", timeout: 20000 });
  } catch {}
  console.log(JSON.stringify(record, null, 2));
}

try { main(); } catch (e) { console.error(`change-ledger 异常: ${e.message}`); process.exit(1); }
