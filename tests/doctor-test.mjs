#!/usr/bin/env node
// doctor-test.mjs — T02 双仓体检（2026-11-18）
// 缝：doctor() 的返回对象。覆盖：干净=ok / 脏=不 ok / 内容分歧被列出 / link 演练不动手 / 冲突拒绝替换
import { doctor, link } from "../doctor.cjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? " — " + d : ""))); };
const T = mkdtempSync(join(tmpdir(), "cp-doctor-"));
const root = join(T, "root"), data = join(T, "data");
for (const d of [root, data]) { mkdirSync(d, { recursive: true }); spawnSync("git", ["-C", d, "init", "-q"]); spawnSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@local", "commit", "-q", "--allow-empty", "-m", "i"]); }
// 造一份一致的 memories
for (const d of [root, data]) { mkdirSync(join(d, "memories"), { recursive: true }); writeFileSync(join(d, "memories", "a.md"), "x"); }
// 让两仓都有 upstream（doctor 要求 head==upstream 且工作区干净）
for (const d of [root, data]) { spawnSync("git", ["-C", d, "add", "-A"]); spawnSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@local", "commit", "-q", "-m", "files"]); spawnSync("git", ["-C", d, "update-ref", "refs/remotes/origin/master", "HEAD"]); spawnSync("git", ["-C", d, "config", "user.name", "t"]); spawnSync("git", ["-C", d, "config", "user.email", "t@local"]); }
let r = doctor({ root, dataDir: data, gitBin: "git" });
ok("干净且一致 → ok", r.ok === true, JSON.stringify({ e: r.engine, d: r.data, div: r.diverged }));
ok("  已识别身份", !!r.identity.name, JSON.stringify(r.identity));
// 制造内容分歧
writeFileSync(join(root, "memories", "a.md"), "different-length-content");
r = doctor({ root, dataDir: data, gitBin: "git" });
ok("内容分歧 → ok:false 且列出 daily/memories 之一", r.ok === false && r.diverged.length > 0, JSON.stringify(r.diverged));
const l = link({ root, dataDir: data, apply: false });
const conflict = l.plan.find(p => p.item === "memories");
ok("link 演练：分歧项标记 conflict 且不动手", conflict && conflict.action === "conflict", JSON.stringify(conflict));
ok("  演练未产生链接目录", l.apply === false && !!l.hint, JSON.stringify(l.hint));
// 一致项给出 would-replace
writeFileSync(join(root, "memories", "a.md"), "x");
const l2 = link({ root, dataDir: data, apply: false });
const same = l2.plan.find(p => p.item === "memories");
ok("一致项 → would-replace（等待 --apply）", same && same.action === "would-replace", JSON.stringify(same));
rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
