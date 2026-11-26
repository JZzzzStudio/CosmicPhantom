// lib/sync-check.js — F50 双仓同步守卫 + F51 目录地图守卫（2026-11-18）
//
// 由来（实案）：2026-11-18 引擎仓缺 git 身份，`cp-sync.cjs` 把「提交失败」写成
// 「无改动或提交失败」，导致工作区脏着没人知道；「忘了推 GitHub」也没有任何机器信号。
// 本模块给 verify 提供两个离线判据（不联网，只读本地 refs）：
//   F50 checkSync：本地 HEAD / origin-tracking / 工作区脏 三项对齐；任一项不齐 → 报红
//   F51 checkMap ：DIRECTORY-MAP.md 声明的目录 == 磁盘实际目录；多一个少一个 → 报红
//
// 设计约束：
//   - 离线安全：只读本地 origin/<branch> 引用，不 fetch（断网也能判，代价是别的机器推过不会立刻发现）
//   - 缺 git / 缺仓 → 返回 present:false，**不报红**（不能因为没装 git 就伪造红灯）
//   - 判据自证：tests/sync-gate-test.mjs 用临时仓喂三态（干净/脏/领先/落后）断言会响

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GIT_CANDIDATES = (root) => [
  process.env.CP_GIT,
  join(root, "tools", "git", "cmd", "git.exe"),
  join(root, "tools", "git", "mingw64", "bin", "git.exe"),
  "git",
].filter(Boolean);

export function gitBinary(root) {
  const cands = GIT_CANDIDATES(root);
  return cands.find((p) => p === "git" || existsSync(p)) || null;
}

function git(gitBin, cwd, args) {
  try {
    const r = spawnSync(gitBin, ["-C", cwd, ...args], { encoding: "utf8", timeout: 15000 });
    return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() };
  } catch (e) {
    return { ok: false, out: String(e.message || e) };
  }
}

/**
 * 单个仓的对齐状态。
 * @returns {{dir,present,ok,reason?,branch?,head?,upstream?,dirty?,ahead?,behind?}}
 */
export function checkRepo(gitBin, dir) {
  const base = { dir, present: false, ok: null };
  if (!dir || !gitBin || !existsSync(join(dir, ".git"))) return { ...base, reason: "不是 git 仓（跳过，不报红）" };

  const branch = git(gitBin, dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) return { ...base, present: true, ok: false, reason: "无 HEAD（仓库还没有提交）" };
  const br = branch.out;

  const head = git(gitBin, dir, ["rev-parse", "HEAD"]);
  const upstreamRef = `origin/${br}`;
  const upstream = git(gitBin, dir, ["rev-parse", upstreamRef]);

  const dirtyOut = git(gitBin, dir, ["status", "--porcelain"]);
  const dirty = dirtyOut.ok ? dirtyOut.out.split("\n").filter(Boolean).length : -1;

  let ahead = 0, behind = 0, hasUpstream = upstream.ok;
  if (hasUpstream) {
    const lr = git(gitBin, dir, ["rev-list", "--left-right", "--count", `${upstreamRef}...HEAD`]);
    if (lr.ok) {
      const [b, a] = lr.out.split(/\s+/).map((n) => Number(n) || 0);
      behind = b; ahead = a;
    }
  }

  const st = {
    dir, present: true, branch: br,
    head: head.ok ? head.out.slice(0, 7) : null,
    upstream: hasUpstream ? upstream.out.slice(0, 7) : null,
    dirty, ahead, behind,
  };
  if (!hasUpstream) return { ...st, ok: false, reason: `无 ${upstreamRef}（远端未配置或从未推送）` };
  if (dirty > 0) return { ...st, ok: false, reason: `${dirty} 个未提交改动` };
  if (ahead > 0) return { ...st, ok: false, reason: `本地领先远端 ${ahead} 个提交（没推）` };
  if (behind > 0) return { ...st, ok: false, reason: `落后远端 ${behind} 个提交（没拉）` };
  return { ...st, ok: true };
}

/**
 * 双仓同步总判据。problems 里每条都是可直接显示给人看的 stale 文本。
 */
export function checkSync(root, dataDir = process.env.CP_DATA_DIR || join(homedir(), "cp-memory"), options = {}) {
  const gitBin = gitBinary(root);
  if (!gitBin) {
    return { ok: null, git: null, engine: null, data: null, problems: [] };
  }
  // 2026-11-19（票 27）：默认离线；显式开启时才联网核对远端是否领先。
  const doFetch = options.fetch === true || process.env.CP_F50_FETCH === "1";
  const fetched = { engine: null, data: null };
  if (doFetch) {
    for (const [k, dir] of [["engine", root], ["data", dataDir]]) {
      if (!dir || !existsSync(join(dir, ".git"))) continue;
      fetched[k] = git(gitBin, dir, ["fetch", "--prune", "origin"]).ok;
    }
  }
  const engine = checkRepo(gitBin, root);
  const data = checkRepo(gitBin, dataDir);
  const problems = [];
  const add = (label, r) => {
    if (r && r.present && r.ok === false) problems.push(`🔴 [F50] ${label}未同步：${r.reason}`);
  };
  add("引擎仓", engine);
  add("数据仓", data);
  const ok = problems.length === 0;
  return { ok, git: gitBin, engine, data, problems, fetched, fetchedHint: doFetch ? undefined : "未 fetch：只比本地 origin 引用，可能落后于远端（设 CP_F50_FETCH=1 联网核对）" };
}

/**
 * 目录地图 vs 磁盘。
 * 只认表格里以 `/` 结尾的单元格（目录标记）；「已核销」段不计入。
 */
export function checkMap(root) {
  const path = join(root, "DIRECTORY-MAP.md");
  if (!existsSync(path)) return { present: false, ok: null, missing: [], extra: [], mapped: [] };

  const text = readFileSync(path, "utf8");
  const live = text.split(/^##\s*已核销/m)[0];
  const mapped = new Set();
  for (const line of live.split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`/);
    if (!m) continue;
    const cell = m[1];
    if (!cell.endsWith("/")) continue;           // 只认目录行：`xxx/`
    const seg = cell.replace(/\/+$/, "").split("/")[0];
    if (!seg || seg === "." || seg === "..") continue;
    mapped.add(seg);
  }

  // 新克隆场景（2026-11-19 实测）：地图里声明但被 .gitignore 排除的目录（backup/embedding-db/node_modules/tools）
  //   在干净克隆里必然不存在 —— 那不是漂移，是生成物。按 .gitignore 前缀匹配放行，避免新机器一上来就报红。
  const ignored = [];
  try {
    for (const line of readFileSync(join(root, ".gitignore"), "utf8").split(String.fromCharCode(10))) {
      let t = line.trim();
      if (!t || t.startsWith("#")) continue;
      if (t.startsWith("/")) t = t.slice(1);
      t = t.split("/")[0];
      while (t.endsWith("*")) t = t.slice(0, -1);
      if (t) ignored.push(t);
      if (t && !t.startsWith("#")) ignored.push(t);
    }
  } catch {}
  const gitignored = (name) => ignored.some((t) => t && (name === t || name.startsWith(t)));
  let real = [];
  try {
    real = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== ".git")
      .map((d) => d.name);
  } catch { /* 读不到目录就当没数据，不伪造红灯 */ }

  const realSet = new Set(real);
  const missing = [...mapped].filter((n) => !realSet.has(n) && !gitignored(n)).sort();
  const missingButIgnored = [...mapped].filter((n) => !realSet.has(n) && gitignored(n)).sort();
  const extra = real.filter((n) => !mapped.has(n) && !gitignored(n)).sort();
  // 2026-11-19（票 26）：地图只管目录 → 根目录新增脚本永远不入册。这里补文件级检查（只查 .cjs/.js/.mjs）。
  const FILE_EXT = /\.(cjs|js|mjs)$/;
  const rootFiles = (() => { try { return readdirSync(root, { withFileTypes: true }).filter((d) => d.isFile() && FILE_EXT.test(d.name)).map((d) => d.name).sort(); } catch { return []; } })();
  const filePatterns = [...live.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((p) => /\.(?:cjs|js|mjs)$/.test(p) && /<[^>]+>/.test(p))
    .map((p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&").replace(/<[^>]+>/g, "[^/]+")}$`));
  const genericFiles = [];
  if (live.includes("<host>-adapter.js")) genericFiles.push(/^[^/]+-adapter\.(cjs|js|mjs)$/);
  if (live.includes("<host>-flush.cjs")) genericFiles.push(/^[^/]+-flush\.cjs$/);
  if (live.includes("<host>-hook-wrap.cjs")) genericFiles.push(/^[^/]+-hook-wrap\.cjs$/);
  const mappedFile = (f) => live.includes(f) || filePatterns.some((re) => re.test(f)) || genericFiles.some((re) => re.test(f));
  const unmappedFiles = rootFiles.filter((f) => !mappedFile(f));
  return {
    present: true,
    ok: missing.length === 0 && extra.length === 0 && unmappedFiles.length === 0,
    missing, extra, missingButIgnored, unmappedFiles,
    mapped: [...mapped].sort(),
    real: real.sort(),
  };
}