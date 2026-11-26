#!/usr/bin/env node
/**
 * watch-state.js — 写强制守护 v3（2026-08-08 晚：D18 最终版——对话开始拉起，被动监听，不因 ended_at 退出）
 *
 * 用法（需 --experimental-sqlite）:
 *   node --experimental-sqlite watch-state.js --db <hermes-home/state.db> [--root <cosmic根>]
 *
 * 生命周期（D18 最终决定，工程师 2026-08-08 拍板）:
 *   MCP 会话开始 → 由环境变量或宿主配置提供 state.db → 取得单实例锁（.watch.lock wx 原子 + PID 活性验证）
 *   → 拉起 watcher → 启动补漏 → fs.watch 被动监听 state.db（常驻，不因 ended_at 退出）
 *   → ended_at：只触发最终同步（最后 ingest+project 追平）+ maintain，不停止 watcher
 *   → watcher 被杀/系统重启：由下一次 MCP 会话重新拉起
 *   → 不恢复 Windows 登录自启，无时钟/心跳/轮询
 *
 * 范围收敛说明（用户原始决定"对话开始时启动"，不是"每个会话结束时关闭"；
 *   全局 watcher 无法安全绑定并发会话——取消结束自动停止是范围收敛，不是回避缺陷）
 *
 * 单实例锁（评审要求）:
 *   .watch.lock = PID 文件 + 活性验证（Get-Process）：
 *   ① A 持有锁 ② B 识别 A 存活退出 ③ A 正常结束删锁，C 可启动
 *   ④ A 被强杀：僵尸锁经活性验证清除，C 可启动 ⑤ 并发首次：wx 原子竞争，唯一获胜者
 *   PID 写入用已打开的 fd（writeSync），避免二次按路径打开（评审小修 1）
 *
 * fail-open: watch 出错记 hook-errors.log，绝不影响宿主。
 */
import { watch, existsSync, appendFileSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const NODE = join(ROOT, "tools", "node", "node.exe");
const POLL = join(ROOT, "scripts", "legacy", "hermes", "poll-state.js");
const EVENTS = join(ROOT, "events.js");
const LOCK = join(ROOT, ".watch.lock");

function logErr(m) { try { appendFileSync(join(ROOT, "hook-errors.log"), `[${new Date().toISOString()}] watch: ${m}\n`); } catch {} }
const ts = () => new Date().toISOString();

// ---------- 单实例锁（PID 文件 + 活性验证，评审 5 场景全覆盖）----------
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
// E-6（2026-10-28）：pidAlive 只能证明“PID 存在”，不能证明“它是本 root 的 watch-state”。
//   PID 被复用（旧 watcher 被杀后系统把同号给普通 node）时，原实现会误判“已有实例”并退出。
//   此处加命令行身份校验：Windows 用 cscript+WMI（wmic 在 Win11 24H2 已移除），Linux 读 /proc；
//   查不到/超时 → fail-open（保守视为存活，保持原行为）。不引入心跳/定时器。
function pidLooksLikeWatcher(pid, root) {
  try {
    if (process.platform === "win32") {
      const vbs = join(ROOT, `.watch-query-${pid}.vbs`);
      writeFileSync(vbs, `Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")\nSet ps = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE ProcessId=${pid}")\nFor Each p In ps\nWScript.Echo p.CommandLine\nNext\n`, "utf8");
      const r = spawnSync("cscript", ["//nologo", vbs], { encoding: "utf8", timeout: 5000, windowsHide: true });
      try { unlinkSync(vbs); } catch {}
      const out = String(r.stdout || "");
      if (!out.trim()) return true;   // WMI 不可用：fail-open
      return out.includes("watch-state.js") && out.includes(root);
    }
    if (process.platform === "linux") {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      return cmd.includes("watch-state.js") && cmd.includes(root);
    }
    return true;
  } catch { return true; }
}
function acquireLock() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(LOCK, "wx");          // wx：原子竞争（并发首次启动唯一获胜者）
      writeSync(fd, String(process.pid));       // 评审小修 1：用已打开的文件描述符写 PID（避免二次按路径打开）
      closeSync(fd);
      return true;
    } catch {
      let pid = 0;
      try { pid = Number(readFileSync(LOCK, "utf8").trim()); } catch {}
      if (pid && pidAlive(pid)) {
        if (pidLooksLikeWatcher(pid, ROOT)) {
          logErr(`已有 watch-state 实例 (PID ${pid}) 持有锁，本实例退出（单实例保护）`);
          process.exit(0);                        // 场景②：B 识别 A 存活退出
        }
        logErr(`锁 PID ${pid} 存活但不是本 root 的 watch-state（PID 复用），清除后重试`);
      }
      try { unlinkSync(LOCK); } catch {}
      logErr(`清除僵尸锁（PID ${pid || "未知"} 无活性）后重试`);   // 场景④：强杀后不被僵尸锁阻塞
    }
  }
  logErr("多次尝试获取单实例锁失败，退出");
  process.exit(0);
}
function releaseLock() { try { unlinkSync(LOCK); } catch {} }   // 场景③：正常结束删锁

let timer = null;
let running = false;

function rootArg() {
  const ri = process.argv.indexOf("--root");
  return ri > 0 ? process.argv[ri + 1] : undefined;   // K23：显式判断，防 argv[0] 污染
}

function runOnce(why) {
  if (running) return null;
  running = true;
  try {
    const dbPath = process.argv[process.argv.indexOf("--db") + 1];
    const pollArgs = ["--experimental-sqlite", POLL, "--db", dbPath];
    const ra = rootArg();
    if (ra) pollArgs.push("--root", ra);
    const r = spawnSync(NODE, pollArgs, { encoding: "utf8", timeout: 60000 });
    if (r.status !== 0) logErr(`落盘失败 status=${r.status} stderr=${(r.stderr || "").slice(0, 200)}`);
    if (r.stdout && r.stdout.trim()) process.stdout.write(`[${ts()}] ${r.stdout.trim()}\n`);
    if (r.stdout) {
      try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
    }
  } catch (e) { logErr(String(e.message || e)); }
  finally { running = false; }
  return null;
}

function runMaintain() {
  const mArgs = [join(ROOT, "memory-cli.js"), "maintain"];
  const ra = rootArg();
  if (ra) mArgs.push("--root", ra);
  const m = spawnSync(NODE, mArgs, { encoding: "utf8", timeout: 300000 });
  process.stdout.write(`[${ts()}] 会话结束触发整理: ${m.status === 0 ? "完成" : "失败"}\n`);
  if (m.status !== 0) logErr(`整理失败: ${(m.stderr || "").slice(0, 200)}`);   // 失败单独记录，不掩盖原始事件
}

function eventsStatus() {
  const evArgs = ["--experimental-sqlite", EVENTS, "status"];
  const ra = rootArg();
  if (ra) evArgs.push("--root", ra);
  const r = spawnSync(NODE, evArgs, { encoding: "utf8", timeout: 30000 });
  try { return JSON.parse((r.stdout || "").trim()); } catch { return null; }
}

function srcMaxId(dbPath) {
  try {
    const src = new DatabaseSync(dbPath, { readOnly: true });
    const m = src.prepare("SELECT MAX(id) m FROM messages").get().m || 0;
    src.close();
    return m;
  } catch { return -1; }
}

// 会话结束（ended_at）：最终同步 + maintain，**不停止 watcher**（D18 最终版：全局 watcher 不绑定单个并发会话）
function finalizeSync() {
  const dbPath = process.argv[process.argv.indexOf("--db") + 1];
  process.stdout.write(`[${ts()}] 检测到 sessions.ended_at → 执行最终同步\n`);
  runOnce("final");                       // 最终 ingest + project（ended_at 后可能还有消息）
  const st = eventsStatus();
  const maxId = srcMaxId(dbPath);
  const active = st && Number.isFinite(Number(st.active)) ? Number(st.active) : Number(st?.events || 0);
  const caughtUp = st && Number(st.cursor) === maxId && Number(st.projected) === active;
  if (caughtUp) {
    process.stdout.write(`[${ts()}] 最终同步完成：events 游标 ${st.cursor} == 真源 ${maxId}，无待投影（watcher 保持运行）\n`);
  } else {
    logErr(`最终同步未完全追平：cursor=${st ? st.cursor : "?"} 真源=${maxId} events=${st ? st.events : "?"} active=${st ? active : "?"} projected=${st ? st.projected : "?"}——原始事件保留，后续触发继续补`);
  }
  runMaintain();                          // ended_at 同时触发整理（maintain 失败单独记录，不掩盖原始事件）
}

function trigger(why) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const j = runOnce(why);
    if (j && j.endedNew > 0) finalizeSync();       // ended_at：最终同步 + maintain，不停止
    else if (j && j.endedSemantic) runMaintain();  // 语义词：只整理
  }, 2000);
}

const dbPath = process.argv[process.argv.indexOf("--db") + 1];
if (!dbPath || !existsSync(dbPath)) { logErr(`缺 --db 或文件不存在: ${dbPath}`); process.exit(0); }

acquireLock();   // 场景①⑤：持锁启动 / 并发原子竞争

// 启动补漏（启动前积累的消息全部摄入并投影）
const startJ = runOnce("startup");
if (startJ && startJ.endedNew > 0) finalizeSync();       // 启动即遇 ended_at：最终同步 + maintain，不退出
else if (startJ && startJ.endedSemantic) runMaintain();

// 监听 state.db 家族（事件驱动，无时钟兜底）
const dir = dirname(dbPath);
const name = (f) => String(f || "").replace(/\\/g, "/").split("/").pop();
try {
  const watcher = watch(dir, { persistent: true }, (event, filename) => {
    const f = name(filename);
    if (/^state\.db(-wal|-shm)?$/.test(f)) trigger("file-change");
  });
  watcher.on("error", (e) => logErr(`watch 错误: ${e.message}`));
  process.stdout.write(`[${ts()}] watch-state 就绪，监听 ${dir}（事件驱动落盘，无时钟兜底；ended_at 仅最终同步，watcher 保持运行）\n`);
} catch (e) {
  logErr(`watch 启动失败: ${e.message}`);
  releaseLock();
  process.exit(0);
}
