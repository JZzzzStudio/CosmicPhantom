#!/usr/bin/env node
/**
 * session-adapter.js — 无 transcript 宿主会话落盘适配器
 *
 * 部分宿主没有逐字会话 transcript（与 Proma/WorkBuddy 不同），
 * 因此采用"决策级落盘"：会话结束时，把本会话的用户关键指令/决策/成果
 * 逐字写入 events.db（instance=session-<session>）→ daily 投影。
 * 新会话身份卡（inject.js）的"最近工作"块从 daily 提取这些行，恢复"说过什么"。
 *
 * 成果行约定（2026-08-12）：entries 支持 role=assistant，文本以 "🛠️" 开头
 * 的条目投影为 daily 的"🛠️ Agent（成果）"行（events.js 摄取+投影双段已支持）；
 * 收尾时除用户原话外，务必把本会话关键成果（做了什么/改了哪些文件/验证结果）带上。
 *
 * 用法:
 *   node --experimental-sqlite session-adapter.js --session <id> [--root <根>] [--file <json>]
 *   从 --file 或 stdin 读 JSON: { "entries": [{"role":"user","text":"..."}], "summary": "..." }
 *
 * 契约与 proma-adapter 一致：events.js manual 幂等（fingerprint 可跳过），
 * 失败只写 hook-errors.log，fail-open。
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const NODE = process.env.CP_NODE || process.execPath;
const EVENTS = join(ROOT, "events.js");
const LOG = join(ROOT, "hook-errors.log");

function logErr(message) { try { appendFileSync(LOG, `[${new Date().toISOString()}] session-adapter: ${message}\n`); } catch {} }
function get(key) { const i = process.argv.indexOf(key); return i >= 0 ? process.argv[i + 1] : undefined; }

function main() {
  const session = get("--session") || "session";
  const file = get("--file");
  let payload;
  try {
    const raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
    payload = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    process.stdout.write(JSON.stringify({ source: "session", error: `输入不是合法 JSON: ${error.message}` }) + "\n");
    return;
  }
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  if (!entries.length && payload.summary) entries.push({ role: "user", text: `[摘要] ${payload.summary}` });
  if (!entries.length) {
    process.stdout.write(JSON.stringify({ source: "session", error: "无 entries/summary 可落盘" }) + "\n");
    return;
  }

  // 构造 Proma 兼容 JSONL（events.js manual 契约），逐字写入用户条目
  const now = new Date().toISOString();
  const lines = entries.map((entry) => {
    const type = entry.role === "assistant" ? "assistant" : "user";
    const text = String(entry.text || "");
    return JSON.stringify({
      type,
      message: { content: [{ type: "text", text }] },
      _createdAt: entry.ts || now,
    });
  });
  const tmpDir = mkdtempSync(join(tmpdir(), "cp-session-"));
  const transcript = join(tmpDir, "transcript.jsonl");
  writeFileSync(transcript, lines.join("\n") + "\n", "utf8");

  const result = spawnSync(NODE, ["--experimental-sqlite", EVENTS, "manual", "--transcript", transcript, "--session", `session-${session}`, "--root", ROOT], { encoding: "utf8", timeout: 30000 });
  rmSync(tmpDir, { recursive: true, force: true });
  if (result.status !== 0) {
    logErr(`events manual 失败 status=${result.status} stderr=${(result.stderr || "").slice(0, 200)}`);
    process.stdout.write(JSON.stringify({ source: "session", error: "events manual 失败", stderr: (result.stderr || "").slice(0, 200) }) + "\n");
    return;
  }
  // P1-6(2026-08-29):决策卡自动同步覆盖非 ZCode 通道——摄取完成后 --all 全量扫 daily(幂等),
  //   历史会话的决策行散布多天,单日模式会漏;与 zcode-flush 同款"断不了档"哲学。
  try {
    spawnSync(NODE, ["--experimental-sqlite", join(ROOT, "decision-cards.js"), "--all", "--root", ROOT], { encoding: "utf8", timeout: 120000 });
  } catch (e) {
    logErr(`decision-cards sync failed: ${e.message}`);
  }
  let manual = {};
  try { manual = JSON.parse((result.stdout || "").split("\n").filter(Boolean).pop() || "{}"); } catch {}
  process.stdout.write(JSON.stringify({ source: "session", session: `session-${session}`, entries: entries.length, logged: manual.logged || 0, skipped: manual.skipped ?? 0, projected: manual.projected ?? 0, empty: manual.empty ?? false, at: new Date().toISOString() }, null, 2) + "\n");
}

try { main(); } catch (error) { logErr(`异常: ${error.message}`); process.stdout.write(JSON.stringify({ source: "session", error: error.message }) + "\n"); }
