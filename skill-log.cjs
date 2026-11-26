#!/usr/bin/env node
/**
 * skill-log.cjs — 技能执行留痕（D-11，2026-10-28 立）
 *
 * 病根：CP 的 skills 是"宿主挂载 + Agent 自觉读取"，执行了但无机器证据；与"机器强制 > 自觉"冲突。
 * 本工具在执行技能后追加一条记录（技能名/SKILL.md 路径/sha256/字节/时间/备注），供 verify F29 对账。
 *
 * 用法：
 *   node skill-log.cjs <skill-name> [--note "本轮做了什么"] [--root <根>]
 *   node skill-log.cjs --list [--limit 10] [--root <根>]
 *
 * 输出：JSON 到 stdout；失败 exit 1。
 * 纪律：记录只追加、不改写；日志加锁不必要（单进程短写）。
 */
const { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { createHash } = require("node:crypto");

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg("--root") || join(homedir(), ".cosmic-phantom");
const FILE = join(ROOT, ".flags", "skill-runs.jsonl");

if (process.argv.includes("--list")) {
  const limit = Number(arg("--limit") || 10);
  if (!existsSync(FILE)) { process.stdout.write(JSON.stringify({ ok: true, entries: [], note: "暂无记录" }, null, 2) + "\n"); process.exit(0); }
  const lines = readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean).slice(-limit).reverse();
  const entries = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  process.stdout.write(JSON.stringify({ ok: true, entries }, null, 2) + "\n");
  process.exit(0);
}

const skill = process.argv[2];
if (!skill || skill.startsWith("--")) {
  process.stdout.write(JSON.stringify({ ok: false, error: "用法：node skill-log.cjs <skill-name> [--note ...] | --list" }, null, 2) + "\n");
  process.exit(1);
}
const skillFile = join(ROOT, "skills", skill, "SKILL.md");
if (!existsSync(skillFile)) {
  process.stdout.write(JSON.stringify({ ok: false, error: `SKILL.md 不存在：${skillFile}` }, null, 2) + "\n");
  process.exit(1);
}
const raw = readFileSync(skillFile);
const entry = {
  at: new Date().toISOString(),
  skill,
  path: skillFile,
  sha256: createHash("sha256").update(raw).digest("hex"),
  bytes: statSync(skillFile).size,
  note: arg("--note") || "",
};
mkdirSync(join(ROOT, ".flags"), { recursive: true });
appendFileSync(FILE, JSON.stringify(entry) + "\n");
process.stdout.write(JSON.stringify({ ok: true, ...entry, file: FILE }, null, 2) + "\n");
