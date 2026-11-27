#!/usr/bin/env node
/**
 * session-adapter.js — 无 transcript 宿主会话落盘适配器
 *
 * 部分宿主没有逐字会话 transcript，因此采用"决策级落盘"：
 * 会话结束时，把本会话的用户关键指令/决策/成果
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
 * 契约与 events.js manual 入口一致：写入幂等（fingerprint 可跳过），
 * 失败写 hook-errors.log + 结构化 error/decisionCards 字段 + failopen 计数，退出码非零；
 * 已写入事件不回滚（fail-open = 不崩宿主、不回滚真源，但失败必须可见）。
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recordCall, recordFallback } from "./lib/failopen.js";

const ENGINE_ROOT = dirname(fileURLToPath(import.meta.url));
const rootIndex = process.argv.indexOf("--root");
const ROOT = (rootIndex >= 0 ? process.argv[rootIndex + 1] : "") || process.env.CP_ROOT || join(homedir(), ".cosmic-phantom");
process.env.CP_ROOT = ROOT;
const NODE = process.env.CP_NODE || process.execPath;
const EVENTS = join(ENGINE_ROOT, "events.js");
const DECISION_CARDS = join(ENGINE_ROOT, "decision-cards.js");
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
    process.exitCode = 1;
    return;
  }
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  if (!entries.length && payload.summary) entries.push({ role: "user", text: `[摘要] ${payload.summary}` });
  if (!entries.length) {
    process.stdout.write(JSON.stringify({ source: "session", error: "无 entries/summary 可落盘" }) + "\n");
    process.exitCode = 1;
    return;
  }

  // 构造标准 JSONL（events.js manual 契约），逐字写入用户条目
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
    process.exitCode = 1;
    return;
  }
  // P1-6：决策卡自动同步覆盖非单日接入端——摄取完成后 --all 全量扫 daily（幂等），
  //   历史会话的决策行散布多天，单日模式会漏。
  let cards;
  try {
    cards = spawnSync(NODE, ["--experimental-sqlite", DECISION_CARDS, "--all", "--root", ROOT], { encoding: "utf8", timeout: 120000 });
  } catch (error) {
    cards = { status: null, error, stderr: "" };
  }
  const cardsOk = cards.status === 0 && !cards.error;
  const cardsError = cardsOk ? null : (cards.error ? cards.error.message : "status=" + cards.status + " stderr=" + (cards.stderr || "").slice(0, 200));
  recordCall("session-adapter.decision-cards");
  if (!cardsOk) {
    logErr("decision-cards sync failed: " + cardsError);
    recordFallback("session-adapter.decision-cards", String(cardsError).slice(0, 60));
  }
  let manual = {};
  try { manual = JSON.parse((result.stdout || "").split("\n").filter(Boolean).pop() || "{}"); } catch {}
  process.stdout.write(JSON.stringify({ source: "session", session: "session-" + session, entries: entries.length, logged: manual.logged || 0, skipped: manual.skipped ?? 0, projected: manual.projected ?? 0, empty: manual.empty ?? false, decisionCards: { ok: cardsOk, status: cards.status, ...(cardsOk ? {} : { error: cardsError }) }, at: new Date().toISOString() }, null, 2) + "\n");
  if (!cardsOk) process.exitCode = 1;
}

try { main(); } catch (error) { logErr("异常: " + error.message); process.stdout.write(JSON.stringify({ source: "session", error: error.message }) + "\n"); process.exitCode = 1; }
