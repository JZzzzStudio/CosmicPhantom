#!/usr/bin/env node
/**
 * ⚠️ **已废弃（2026-09-19 官方关闭）**：本文件属 ZCode 时代的**旧落地通道**，生产地位已被继承包路线
 *   （`pack-bundle.cjs` + `install-bundle.cjs`）取代。**留档不删，但禁止作为现行落地路径使用**。
 *   关闭登记：本文件位于 `scripts/legacy/`，仅供历史复现；设计依据：`pro/inherit-lander-design-20260916.md`。
 *
 * install-usb.js — 复制即用落地（2026-08-12 简化版，用户要求"复制进U盘→新机复制出来→100%落地"）
 *
 * 三步操作：
 *   ① 源机：把 C:\Users\<源>\.cosmic-phantom 整个文件夹复制到 U 盘（含隐藏文件）
 *   ② 新机：从 U 盘把 .cosmic-phantom 复制到 C:\Users\<新>\.cosmic-phantom
 *   ③ 新机：node scripts\legacy\packaging\install-usb.js
 *
 * 脚本自动完成：
 *   1. 路径落地：templates/ 的 <USER_HOME> + 真源文件里的旧用户名 → 新机用户目录
 *   2. 宿主配置生成：templates/* → 新机各宿主目录（ZCode/CodeBuddy/Proma/WorkBuddy）
 *   3. 快照刷新 + manifest 重算
 *   4. 验证（arrival-check/install-check/recall/coverage）
 *
 * 用法: node install-usb.js [--home <新机用户目录>]
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const args = process.argv;
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = process.cwd();                       // 脚本运行处 = 复制出来的真源根
const HOME = get("--home") || homedir();          // 新机用户目录
const checks = [];
const ok = (name, cond, detail) => { checks.push({ name, ok: !!cond, detail }); console.log(`${cond ? "✅" : "❌"} ${name}: ${detail}`); };

// ---------- 1. 检测旧用户名（旧版路径登记（当前版本不再使用 WHERE.txt））----------
let oldUser = process.env.CP_OLD_USER || "";
try {
  const w = readFileSync(join(ROOT, "WHERE.txt"), "utf8");
  const m = w.match(/C:\\Users\\([^\\]+)\\\.cosmic-phantom/);
  if (m) oldUser = m[1];
} catch {}
console.log(`\n[1/4] 路径落地（${oldUser} / <USER_HOME> → ${HOME}）`);
const NEW_HOME = HOME.split("\\").join("/");
const rep = (s) => {
  let out = String(s);
  if (oldUser) out = out.split(`C:/Users/${oldUser}`).join(NEW_HOME).split(`C:\\Users\\${oldUser}`).join(HOME);
  return out.split("<USER_HOME>").join(NEW_HOME);
};
for (const f of ["sources.json", "project-root.json", "AGENTS.md"]) {
  const p = join(ROOT, f);
  if (existsSync(p)) { const t = readFileSync(p, "utf8"); if ((oldUser && t.includes(oldUser)) || t.includes("<USER_HOME>")) { writeFileSync(p, rep(t), "utf8"); ok(`${f} 路径落地`, true, "已替换"); } }
}
// 源目录不存在 → 自动禁用（新机未装该宿主，显式暴露不报假缺口）
try {
  const sp = join(ROOT, "sources.json");
  if (existsSync(sp)) {
    const reg = JSON.parse(readFileSync(sp, "utf8"));
    let changed = false;
    for (const s of reg.sources || []) {
      if (s.enabled !== false && s.kind === "jsonl" && s.dir && !existsSync(s.dir)) { s.enabled = false; s.note = (s.note || "") + "；落地时检测源目录不存在，已自动禁用（装好宿主后手动启用）"; changed = true; }
    }
    if (changed) { writeFileSync(sp, JSON.stringify(reg, null, 2) + "\n", "utf8"); ok("sources.json 源检测", true, "缺失源已自动禁用"); }
  }
} catch (e) { ok("sources.json 源检测", false, e.message); }

// ---------- 2. 宿主配置生成（templates → 新机）----------
console.log(`\n[2/4] 宿主配置生成（templates → ${HOME}）`);
const T = join(ROOT, "templates");
const tryWrite = (rel, content) => { try { const p = join(HOME, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, content, "utf8"); ok(rel, true, ""); } catch (e) { ok(rel, false, e.message); } };
if (existsSync(T)) {
  const files = [
    ["zcode-AGENTS.md", ".zcode/AGENTS.md"],
    ["codebuddy-mcp.json", ".codebuddy/mcp.json"],
    ["codebuddy-memory.md", ".codebuddy/rules/memory.md"],
    ["codebuddy-memory.mdc", ".codebuddy/rules/memory.mdc"],
    ["codebuddy-CODEBUDDY.md", ".codebuddy/CODEBUDDY.md"],
    ["proma-mcp.json", ".proma/agent-workspaces/workspace-1786420913794/mcp.json"],
    ["workbuddy-mcp.json", ".workbuddy/mcp.json"],
    ["workbuddy-SOUL.md", ".workbuddy/SOUL.md"],
    ["workbuddy-IDENTITY.md", ".workbuddy/IDENTITY.md"],
    ["workbuddy-USER.md", ".workbuddy/USER.md"],
  ];
  for (const [tpl, rel] of files) if (existsSync(join(T, tpl))) tryWrite(rel, rep(readFileSync(join(T, tpl), "utf8")));
  // ZCode config.json（mcp+hooks 合并）
  const zt = join(T, "zcode-config.mcp-hooks.json");
  if (existsSync(zt)) {
    const zc = JSON.parse(rep(readFileSync(zt, "utf8")));
    const zp = join(HOME, ".zcode", "cli", "config.json");
    try {
      mkdirSync(join(zp, ".."), { recursive: true });
      const cur = existsSync(zp) ? JSON.parse(readFileSync(zp, "utf8")) : { mcp: { servers: {} }, hooks: { enabled: true, events: {} } };
      if (!cur.mcp) cur.mcp = { servers: {} };
      if (!cur.mcp.servers) cur.mcp.servers = {};
      if (!cur.mcp.servers["cosmic-phantom"]) cur.mcp.servers["cosmic-phantom"] = zc.mcp.servers["cosmic-phantom"];
      if (!cur.hooks) cur.hooks = { enabled: true, events: {} };
      cur.hooks.events = { ...(cur.hooks.events || {}), ...(zc.hooks?.events || {}) };
      writeFileSync(zp, JSON.stringify(cur, null, 1) + "\n", "utf8");
      ok("zcode config.json（mcp+hooks）", true, "");
    } catch (e) { ok("zcode config.json", false, e.message); }
  }
  // skills（ZCode 用户级）
  const tz = join(T, "zcode-skills");
  if (existsSync(tz)) {
    for (const f of readdirSync(tz)) {
      const name = f.replace(/\.SKILL\.md$/, "");
      const dir = join(HOME, ".zcode", "skills", name);
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(tz, f), join(dir, "SKILL.md"));
    }
    ok("zcode skills", true, readdirSync(tz).length + " 个");
  }
}

// ---------- 3. 项目根落地 + 快照 + manifest ----------
console.log(`\n[3/4] 项目根落地 + 快照刷新 + manifest 重算`);
// project-root.json 指定项目根：新机不存在则创建 + 身份证双写（rootId 以真源为权威）
try {
  const prPath = join(ROOT, "project-root.json");
  if (existsSync(prPath)) {
    const pr = JSON.parse(readFileSync(prPath, "utf8"));
    if (pr.projectRoot) {
      const target = pr.projectRoot.split("/").join("\\");
      if (!existsSync(target)) mkdirSync(target, { recursive: true });
      const idFile = join(target, ".project-root.json");
      if (!existsSync(idFile)) {
        writeFileSync(idFile, JSON.stringify({ rootId: pr.rootId, copiedAt: new Date().toISOString(), note: "由 install-usb 从真源 project-root.json 双写" }, null, 2) + "\n", "utf8");
        ok("项目根身份证双写", true, target);
      } else ok("项目根身份证已存在", true, target);
    }
  }
} catch (e) { ok("项目根落地", false, e.message); }
const NODE = join(ROOT, "tools", "node", "node.exe");
const run = (s, extra = []) => spawnSync(NODE, [join(ROOT, s), ...extra, "--root", ROOT], { encoding: "utf8", timeout: 30000 });
const snap = run("update-snapshot.js");
ok("快照刷新", snap.status === 0, snap.stdout ? JSON.parse(snap.stdout).ok : snap.stderr?.slice(0, 80));
const rf = run("resume-context.js", ["refresh", "--actor", "install-usb"]);
ok("manifest 重算", rf.status === 0 && (rf.stdout || "").includes('"status": "fresh"'), "");

// ---------- 4. 验证 ----------
console.log(`\n[4/4] 验证`);
const ac = run("arrival-check.js");
ok("arrival-check", ac.status === 0 && (ac.stdout || "").includes('"ok": true'), "10 项");
const ic = spawnSync(NODE, [join(ROOT, "scripts", "packaging", "install-check.js"), "--root", ROOT, "--home", HOME], { encoding: "utf8", timeout: 30000 });
ok("install-check", ic.status === 0 && (ic.stdout || "").includes('"ok": true'), "宿主配置一致");
// 2026-08-17 实装：hook 链路实跑（08-12 事故根因=配置存在但一跑即崩，静态检查拦不住）
//   --deep 全真链路：需 ZCode db（新机首次跑无 ZCode 消息时 fail-open 提示，不误报）
const hs = spawnSync(NODE, ["--experimental-sqlite", join(ROOT, "hook-smoke.cjs"), "--deep", "--root", ROOT, "--config", join(HOME, ".zcode", "cli", "config.json")], { encoding: "utf8", timeout: 90000 });
let hsOk = false; let hsDetail = hs.stdout || hs.stderr || ""; try { hsOk = JSON.parse(hs.stdout).ok === true; hsDetail = `${JSON.parse(hs.stdout).checks.length} 项全绿`; } catch {}
ok("hook-smoke（三 hook 实跑）", hs.status === 0 && hsOk, hsOk ? hsDetail : String(hsDetail).slice(0, 120));
const rl = run("memory-cli.js", ["recall", "验证", "--bytes", "1500"]);
ok("recall 可跑", rl.status === 0 && (rl.stdout || "").includes("门禁"), "");
const cv = spawnSync(NODE, ["--experimental-sqlite", join(ROOT, "events.js"), "coverage", "--root", ROOT], { encoding: "utf8", timeout: 30000 });
let cvGaps = -1; try { cvGaps = JSON.parse((cv.stdout || "").split("\n").filter(Boolean).pop()).gaps.length; } catch {}
ok("coverage", cv.status === 0 && cvGaps === 0, "gaps=" + cvGaps);

// 2026-08-13 起：语义检索随包验证（模型/依赖随包，新机必须可直接激活）
const emFetch = run("embed.js", ["fetch"]);
let emActive = false; try { emActive = !!JSON.parse(emFetch.stdout).active; } catch {}
ok("embed fetch（模型资产在位）", emActive, "");
const emBuild = run("embed.js", ["build"]);
ok("embed build（向量库）", emBuild.status === 0 && (emBuild.stdout || "").includes('"built": true'), "");
const sem = run("memory-cli.js", ["search", "别老催我下班，我不想被问结束了没", "--top", "3"]);
let semHit = false; try { const j = JSON.parse(sem.stdout); semHit = j.hybrid === true && Array.isArray(j.results) && j.results.length > 0; } catch {}
ok("语义检索实测（换说法命中 + hybrid 标记）", semHit, "");
const ht = spawnSync(NODE, [join(ROOT, "tests", "hybrid-retrieval-test.js")], { encoding: "utf8", timeout: 180000 });
ok("hybrid-retrieval-test 19/19", ht.status === 0 && (ht.stdout || "").includes("19 passed / 0 failed"), "");
const gt = spawnSync(NODE, [join(ROOT, "tests", "retrieval-golden-test.js")], { encoding: "utf8", timeout: 120000 });
ok("retrieval-golden-test 19/19", gt.status === 0 && (gt.stdout || "").includes("19 passed / 0 failed"), "");

const failed = checks.filter(c => !c.ok);
console.log(`\n${failed.length ? "❌ 有失败项，见上" : "✅ 全部落地完成（100% 实装）"}`);
process.exitCode = failed.length ? 1 : 0;
