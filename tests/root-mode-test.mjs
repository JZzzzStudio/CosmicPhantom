#!/usr/bin/env node
/**
 * root-mode-test.mjs — T00 根隔离与三态判定（2026-11-18）
 *
 * 实案：在干净克隆里跑 verify，报的是家目录库的 total 290；写命令会直接写穿生产库。
 * 判据：不带参数时「当前目录是引擎仓 → 用当前目录；否则家目录」；引擎态写命令默认拒绝。
 *
 * 用临时目录构造引擎仓副本，不碰生产。
 * 命令：node tests/root-mode-test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const NODE = process.execPath;
const TMP = mkdtempSync(join(tmpdir(), "cp-root-mode-"));
let passed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed += 1; console.log("  ✓ " + name); }
  else { failures.push(name + (detail ? " — " + detail : "")); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
};

function makeEngineCopy(dir) {
  // 复制引擎仓「代码面」：全部顶层 .js/.cjs + lib/（数据层不带，正是引擎态的定义）
  mkdirSync(join(dir, "lib"), { recursive: true });
  const src = readdirSync(REPO);
  for (const f of src) {
    if (/.(js|cjs|mjs)$/.test(f)) copyFileSync(join(REPO, f), join(dir, f));
    if (f === "package.json") copyFileSync(join(REPO, f), join(dir, f));
    if (f === "sources.example.json") copyFileSync(join(REPO, f), join(dir, f));
  }
  for (const f of readdirSync(join(REPO, "lib"))) copyFileSync(join(REPO, "lib", f), join(dir, "lib", f));
  return dir;
}
function run(cwd, args) {
  const r = spawnSync(NODE, ["--experimental-sqlite", join(cwd, "memory-cli.js"), ...args], { cwd, encoding: "utf8", timeout: 120000 });
  let json = null;
  try { json = JSON.parse((r.stdout || "").trim()); } catch {}
  return { code: r.status, json, out: (r.stdout || "") + (r.stderr || "") };
}

const eng = makeEngineCopy(join(TMP, "eng"));

// ① 引擎仓 cwd，不带参数 → engine / total 0
let r = run(eng, ["verify"]);
ok("引擎仓内不带参数 → mode=engine", r.json?.mode === "engine", JSON.stringify(r.json?.mode));
ok("  total=0（不读家目录库）", r.json?.total === 0, String(r.json?.total));

// ② CP_ROOT 指定 → 仍是 engine
r = spawnSync(NODE, ["--experimental-sqlite", join(eng, "memory-cli.js"), "verify"], { cwd: TMP, encoding: "utf8", env: { ...process.env, CP_ROOT: eng } });
const j2 = JSON.parse((r.stdout || "{}").trim());
ok("CP_ROOT 生效 → mode=engine", j2.mode === "engine", JSON.stringify(j2.mode));

// ③ 显式 --root 指向生产实例 → instance（存在才测，避免在无库机器上假红）
const HOME_ROOT = process.env.CP_HOME_ROOT || join(process.env.USERPROFILE || process.env.HOME || "", ".cosmic-phantom");
if (existsSync(join(HOME_ROOT, "memories"))) {
  r = run(eng, ["verify", "--root", HOME_ROOT]);
  ok("显式 --root 家目录 → mode=instance", r.json?.mode === "instance", JSON.stringify(r.json?.mode));
  ok("  total>0（读到实例卡）", (r.json?.total || 0) > 0, String(r.json?.total));
} else {
  console.log("  · 跳过 --root 实例态（本机无家目录库）");
}

// ④ 引擎态写命令 → 拒绝且非零退出
r = run(eng, ["add", "--text", "probe-should-not-write"]);
ok("引擎态 add → blocked=ENGINE_MODE_WRITE", r.json?.blocked === "ENGINE_MODE_WRITE", JSON.stringify(r.json?.blocked));
ok("  非零退出", r.code === 1, String(r.code));
ok("  未创建 memories/（没写盘）", !existsSync(join(eng, "memories")) || !existsSync(join(eng, "memories", "2026-11.md")), "memories 被创建");

// ⑤ candidate distill-events 默认只读：引擎态可进入命令本身，不被写闸误拦。
r = run(eng, ["candidate", "distill-events"]);
ok("引擎态 candidate distill-events dry-run 不被写闸拦截", r.json?.blocked !== "ENGINE_MODE_WRITE" && r.json?.code === "EVENTS_DB_MISSING", JSON.stringify(r.json));
ok("dry-run 缺库失败仍不创建候选目录", !existsSync(join(eng, "candidates")), "candidates 被创建");
r = run(eng, ["candidate", "distill-events", "--apply"]);
ok("引擎态 candidate distill-events --apply 仍被写闸拦截", r.json?.blocked === "ENGINE_MODE_WRITE" && r.code === 1, JSON.stringify(r.json));

// ⑥ 显式放行 → 允许写（用 --allow-engine-write，验证闸不是死锁）
r = run(eng, ["add", "--text", "allowed-probe", "--allow-engine-write"]);
ok("--allow-engine-write → 不再被挡", r.json?.blocked !== "ENGINE_MODE_WRITE", JSON.stringify(r.json?.blocked));

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed / ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log("  FAIL " + f); process.exit(1); }