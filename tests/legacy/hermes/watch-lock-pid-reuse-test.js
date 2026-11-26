#!/usr/bin/env node
/**
 * watch-lock-pid-reuse-test.js — E-6 单实例锁 PID 复用复现（2026-10-28）
 *
 * 实验：
 *   T1 假锁（锁里写“存活的普通 node PID”，不是 watch-state）→ 当前实现会误判“已有实例”退出
 *   T2 僵尸锁（不存在的 PID）→ 应清除并启动
 * 只读/临时根，不碰生产。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");

const REAL = path.join(__dirname, "..", "..", "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cp-watch-lock-"));
const NODE = process.execPath;
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function setup() {
  fs.mkdirSync(path.join(TMP, "daily"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "memories"), { recursive: true });
  for (const f of ["watch-state.js", "poll-state.js"]) {
    fs.copyFileSync(path.join(REAL, "scripts", "legacy", "hermes", f), path.join(TMP, f));
  }
  for (const f of ["events.js", "log_turn.js", "memory-cli.js", "memory-retrieval.js"]) {
    fs.copyFileSync(path.join(REAL, f), path.join(TMP, f));
  }
  fs.writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "cp-watch-lock", type: "module", private: true }), "utf8");
  const db = path.join(TMP, "state.db");
  fs.writeFileSync(path.join(TMP, "init.cjs"), `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2]);
db.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, tool_calls TEXT); CREATE TABLE sessions(id TEXT, ended_at TEXT);");
db.close();
`, "utf8");
  spawnSync(NODE, ["--experimental-sqlite", path.join(TMP, "init.cjs"), db], { encoding: "utf8", timeout: 30000 });
  return db;
}
function startWatcher(db) {
  return spawn(NODE, ["--experimental-sqlite", path.join(TMP, "watch-state.js"), "--db", db, "--root", TMP], { stdio: "ignore", windowsHide: true });
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function logText() {
  const f = path.join(TMP, "hook-errors.log");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}

(async () => {
  try {
    const db = setup();

    // T1 假锁：写当前测试进程 PID（存活，但不是 watch-state）
    fs.writeFileSync(path.join(TMP, ".watch.lock"), String(process.pid), "utf8");
    let w = startWatcher(db);
    await wait(2500);
    const exited = w.exitCode !== null;
    check("T1 假锁（普通 node PID）被识别为 PID 复用并清除", !exited && logText().includes("PID 复用"), `exit=${w.exitCode} log=${logText().slice(-200)}`);
    if (!exited) w.kill();

    // T2 僵尸锁：不存在的 PID → 应清除并启动
    fs.writeFileSync(path.join(TMP, ".watch.lock"), "999999", "utf8");
    w = startWatcher(db);
    await wait(2500);
    const alive = w.exitCode === null;
    check("T2 僵尸锁被清除且 watcher 启动", alive && logText().includes("清除僵尸锁"), `exit=${w.exitCode} log=${logText().slice(-160)}`);
    if (alive) w.kill();

    // T3 真实例：A 启动后 B 应退出（单实例保护仍有效）
    const a = startWatcher(db);
    await wait(2500);
    const b = startWatcher(db);
    await wait(2500);
    const bExited = b.exitCode !== null;
    check("T3 真实例仍拦截第二个 watcher", bExited && logText().includes("已有 watch-state 实例"), `bExit=${b.exitCode} log=${logText().slice(-200)}`);
    if (a.exitCode === null) a.kill();
    if (b.exitCode === null) b.kill();

    console.log(`\n${failures.length ? "❌" : "✅"} watch-lock-pid-reuse-test: ${passed} passed / ${failures.length} failed`);
    if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
  } catch (e) {
    console.error(`❌ 异常：${e.stack || e.message}`);
    process.exit(1);
  } finally {
    try { if (!process.env.CP_KEEP_TEST_TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
