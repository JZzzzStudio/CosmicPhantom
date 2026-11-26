#!/usr/bin/env node
/**
 * sync-gate-test.mjs — F50 双仓同步守卫 + F51 目录地图守卫 三态回归（2026-11-18）
 *
 * 由来：引擎仓缺 git 身份 → commit 静默失败；`cp-sync` 把失败写成「无改动」，仓脏着没人知道；
 *      「忘了推」也没有任何机器信号。本测试证明两个判据真的会响、且不会伪造红灯。
 *
 * 覆盖（F50）：干净且对齐=绿 / 有未提交改动=红 / 本地领先=红 / 落后远端=红 / 无 upstream=红 / 非 git 目录=跳过不报红
 * 覆盖（F51）：地图与磁盘一致=绿 / 磁盘多目录=红 / 地图多条目=红 / 「已核销」段不计入=不误报
 *
 * 用临时目录，不碰生产。命令：node tests/sync-gate-test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRepo, checkMap, gitBinary } from "../lib/sync-check.js";

const TMP = mkdtempSync(join(tmpdir(), "cp-sync-gate-"));
let passed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log("  ✓ " + name); }
  else { failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}

const GIT = gitBinary(TMP);
if (!GIT) {
  console.log("SKIP: 本机没有 git，无法验证 F50（不算通过）");
  process.exit(0);
}

function g(cwd, args) {
  const r = spawnSync(GIT, ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${r.stderr}`);
  return r.stdout.trim();
}
function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  g(dir, ["init", "-q"]);
  g(dir, ["config", "user.name", "t"]);
  g(dir, ["config", "user.email", "t@local"]);
  writeFileSync(join(dir, "a.txt"), "1\n");
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-q", "-m", "init"]);
}
function setOrigin(dir, ref) { g(dir, ["update-ref", "refs/remotes/origin/master", ref]); }

console.log("\n[F50] 同步判据三态");

// ① 干净 + 远端对齐 → 绿
const repo = join(TMP, "repo");
initRepo(repo);
setOrigin(repo, "HEAD");
let r = checkRepo(GIT, repo);
ok("干净且对齐 → ok:true", r.ok === true, JSON.stringify(r));
ok("  读到 head/upstream/dirty", !!r.head && !!r.upstream && r.dirty === 0, JSON.stringify(r));

// ② 未提交改动 → 红
writeFileSync(join(repo, "untracked.txt"), "x\n");
r = checkRepo(GIT, repo);
ok("有未提交改动 → ok:false 且 dirty=1", r.ok === false && r.dirty === 1, JSON.stringify(r));
ok("  原因提到「未提交改动」", /未提交改动/.test(r.reason || ""), r.reason);
g(repo, ["add", "-A"]); g(repo, ["commit", "-q", "-m", "second"]);

// ③ 本地领先远端 → 红（真实事故形态：改了但没推）
r = checkRepo(GIT, repo);
ok("本地领先 1 → ok:false", r.ok === false && r.ahead === 1, JSON.stringify(r));
ok("  原因提到「没推」", /没推/.test(r.reason || ""), r.reason);

// ④ 落后远端 → 红（别的机器推过 / 本机没拉）
g(repo, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
g(repo, ["checkout", "-q", "-b", "other"]);
writeFileSync(join(repo, "b.txt"), "2\n");
g(repo, ["add", "-A"]); g(repo, ["commit", "-q", "-m", "remote-only"]);
setOrigin(repo, "HEAD");
g(repo, ["checkout", "-q", "master"]);
r = checkRepo(GIT, repo);
ok("落后远端 1 → ok:false", r.ok === false && r.behind === 1, JSON.stringify(r));
ok("  原因提到「没拉」", /没拉/.test(r.reason || ""), r.reason);

// ⑤ 无 upstream → 红（从未推送，最常见的新机状态）
g(repo, ["update-ref", "-d", "refs/remotes/origin/master"]);
r = checkRepo(GIT, repo);
ok("无 upstream → ok:false", r.ok === false && /远端未配置|无 origin/.test(r.reason || ""), JSON.stringify(r));

// ⑥ 非 git 目录 → 跳过且不报红（不能伪造红灯）
const plain = join(TMP, "plain");
mkdirSync(plain, { recursive: true });
r = checkRepo(GIT, plain);
ok("非 git 目录 → present:false 且 ok:null", r.present === false && r.ok === null, JSON.stringify(r));

console.log("\n[F51] 目录地图判据");

const mapRoot = join(TMP, "maproot");
for (const d of ["core", "skills", "node_modules"]) mkdirSync(join(mapRoot, d), { recursive: true });
const mapFile = join(mapRoot, "DIRECTORY-MAP.md");
const writeMap = (rows, retired = "") => writeFileSync(mapFile, [
  "# 目录语义地图",
  "## 根目录（核心文件）",
  "| 文件 | 语义 | 层 |",
  "|---|---|---|",
  "| `events.db` | 录音带 | 【真源】 |",
  rows,
  retired,
  "",
].join("\n"));

// ① 一致 → 绿
writeMap([
  "| `core/` | 规则 | 【档案】 |",
  "| `skills/` | 技能 | 【真源】 |",
  "| `node_modules/` | 依赖 | 【派生】 |",
  "| `resources/mcp-server/` | MCP | 【引擎】 |",
].filter((l) => !l.includes("resources")).join("\n"));
let m = checkMap(mapRoot);
ok("地图与磁盘一致 → ok:true", m.ok === true, JSON.stringify({ missing: m.missing, extra: m.extra }));

// ② 磁盘多了目录 → 红
mkdirSync(join(mapRoot, "stray_tool"), { recursive: true });
m = checkMap(mapRoot);
ok("磁盘多目录 → ok:false 且 extra 含 stray_tool", m.ok === false && m.extra.includes("stray_tool"), JSON.stringify(m.extra));

// ③ 地图多了条目 → 红
writeMap([
  "| `core/` | 规则 | 【档案】 |",
  "| `skills/` | 技能 | 【真源】 |",
  "| `node_modules/` | 依赖 | 【派生】 |",
  "| `ghost_dir/` | 早已删除 | 【工具】 |",
].join("\n"));
m = checkMap(mapRoot);
ok("地图多条目 → ok:false 且 missing 含 ghost_dir", m.ok === false && m.missing.includes("ghost_dir"), JSON.stringify(m.missing));

// ④ 「已核销」段不计入（防把删过的目录又当成「必须存在」）
//    注：核销的语义是「本机已不存在」——所以这里必须同时把磁盘目录删掉，
//    否则「核销说没有但它还在」本身就是地图与事实矛盾，应当报（下面的反向断言）。
rmSync(join(mapRoot, "stray_tool"), { recursive: true, force: true });
writeFileSync(mapFile, [
  "# 目录语义地图",
  "## 根目录（核心文件）",
  "| 文件 | 语义 | 层 |",
  "|---|---|---|",
  "| `core/` | 规则 | 【档案】 |",
  "| `skills/` | 技能 | 【真源】 |",
  "| `node_modules/` | 依赖 | 【派生】 |",
  "## 已核销（本机不存在）",
  "| 条目 | 原语义 | 现状 |",
  "|---|---|---|",
  "| `stray_tool/` | 旧工具 | 已删 |",
  "",
].join("\n"));
m = checkMap(mapRoot);
ok("已核销段不计入 → 不再报 missing", m.ok === true && m.missing.length === 0, JSON.stringify({ missing: m.missing, extra: m.extra }));

// ⑤ 反向：核销说「不存在」但磁盘上还有 → 应当报（不许地图与事实矛盾）
mkdirSync(join(mapRoot, "stray_tool"), { recursive: true });
m = checkMap(mapRoot);
ok("核销目录却仍在磁盘 → ok:false", m.ok === false && m.extra.includes("stray_tool"), JSON.stringify(m.extra));
rmSync(join(mapRoot, "stray_tool"), { recursive: true, force: true });

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed / ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log("  FAIL " + f); process.exit(1); }