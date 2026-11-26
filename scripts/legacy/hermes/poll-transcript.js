#!/usr/bin/env node
/**
 * poll-transcript.js — 写强制适配器：轮询 Hermes request_dump，增量派生 daily 条目
 *
 * 用法:
 *   node poll-transcript.js --sessions-dir <hermes-home/sessions> [--once] [--root <cosmic根>]
 *
 * 机制:
 *   1. 扫描 sessions 目录下 request_dump_*.json（新 dump 每轮生成）
 *   2. 每个 dump 是单 JSON：request.body.messages = OpenAI 格式完整消息序列
 *   3. 增量指针 processed.json（session_id → 已处理消息数）：只提取新增消息
 *   4. 新增消息转 JSONL → 调 log_turn.js --force 落盘（幂等由本脚本指针保证）
 *   5. 模型零参与：写决策纯代码派生（写强制语义）
 *
 * fail-open: 任何异常记 hook-errors.log，绝不影响主流程
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const PROCESSED = join(ROOT, "processed.json");
const LOG_TURN = join(ROOT, "log_turn.js");
const NODE = join(ROOT, "tools", "node", "node.exe");
const DECISION_TRIGGERS = /(记住|以后|决定|不要|必须|改成|改为|偏好|禁止|每次|一律|规则|记一下)/;
const WRITE_TOOLS = /(write_file|apply_patch|bash|edit|Set-Content|git\s+commit)/i;

function logErr(m) { try { appendFileSync(join(ROOT, "hook-errors.log"), `[${new Date().toISOString()}] ${m}\n`); } catch {} }

function loadProcessed() {
  try { return JSON.parse(readFileSync(PROCESSED, "utf8")); } catch { return {}; }
}
function saveProcessed(p) { writeFileSync(PROCESSED, JSON.stringify(p, null, 2), "utf8"); }

// OpenAI 格式消息 → log_turn JSONL 行
function toLine(msg) {
  const role = msg.role || "";
  if (role === "system") return null;
  if (role === "user") return [JSON.stringify({ type: "user", message: { content: msg.content } })];   // K13：统一返回数组，防 ...展开成字符
  if (role === "assistant") {
    // 仅保留工具调用摘要（写类工具）与显式 [摘要] 文本
    const lines = [];
    const text = typeof msg.content === "string" ? msg.content : (Array.isArray(msg.content) ? msg.content.map(c => c.type === "text" ? c.text : "").join("") : "");
    if (text && text.includes("[摘要]")) lines.push(JSON.stringify({ type: "assistant", message: { content: text } }));
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name || "";
        if (WRITE_TOOLS.test(name)) lines.push(JSON.stringify({ type: "tool", message: { name, is_error: false } }));
      }
    }
    return lines;
  }
  if (role === "tool") {
    const name = msg.name || "";
    const err = !!(msg.is_error || (msg.content && String(msg.content).startsWith("Error")));
    if (WRITE_TOOLS.test(name)) return [JSON.stringify({ type: "tool", message: { name, is_error: err } })];
    return null;
  }
  return null;
}

function poll(sessionsDir) {
  if (!existsSync(sessionsDir)) { logErr(`poll: sessions dir missing ${sessionsDir}`); return; }
  const dumps = readdirSync(sessionsDir).filter(f => /^request_dump_.*\.json$/.test(f)).sort();
  if (!dumps.length) return;
  const processed = loadProcessed();
  let wrote = 0, skipped = 0;

  for (const f of dumps) {
    const path = join(sessionsDir, f);
    let dump;
    try { dump = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); } catch { skipped++; continue; }
    const sid = dump.session_id || f.replace(/^request_dump_/, "").slice(0, 20);
    const messages = dump.request?.body?.messages;
    if (!Array.isArray(messages)) { skipped++; continue; }

    const prev = processed[sid]?.count || 0;
    if (messages.length <= prev) { skipped++; continue; }        // 无新消息
    const fresh = messages.slice(prev);
    const lines = [];
    for (const m of fresh) {
      const ls = toLine(m);
      if (ls) lines.push(...ls);
    }
    if (!lines.length) { processed[sid] = { count: messages.length, lastTs: dump.timestamp || new Date().toISOString() }; skipped++; continue; }

    // 写临时 JSONL → log_turn --force 落盘
    const tmp = join(ROOT, `.poll-${Date.now()}.jsonl`);
    writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
    const r = spawnSync(NODE, [LOG_TURN, "--transcript", tmp, "--session", sid, "--force"], { encoding: "utf8", timeout: 30000 });
    try { spawnSync("cmd", ["/c", "del", tmp]); } catch {}
    // 校验 stdout 含 "logged" 才算成功（K12：log_turn 曾静默空写而退出码仍为 0）
    if (r.status === 0 && (r.stdout || "").includes("logged")) { processed[sid] = { count: messages.length, lastTs: dump.timestamp || new Date().toISOString() }; wrote++; }
    else { logErr(`poll: 未写入 ${sid} status=${r.status} error=${r.error ? r.error.message : "无"} stdout=${(r.stdout || "").trim().slice(0, 100)} stderr=${(r.stderr || "").slice(0, 200)} node=${NODE} log=${LOG_TURN}`); }
  }
  saveProcessed(processed);
  // no-agent cron 语义：空 stdout = 静默，仅在有实际写入时输出（防每 5 分钟打扰）
  if (wrote > 0) process.stdout.write(JSON.stringify({ polled: dumps.length, wrote, skipped, at: new Date().toISOString() }) + "\n");
}

const sessionsDir = process.argv[process.argv.indexOf("--sessions-dir") + 1];
if (!sessionsDir) { process.stdout.write(JSON.stringify({ error: "缺 --sessions-dir" }) + "\n"); process.exit(0); }
poll(sessionsDir);
