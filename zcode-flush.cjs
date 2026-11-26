#!/usr/bin/env node
/**
 * zcode-flush.cjs - ZCode Stop hook auto-flush.
 *
 * The Stop payload identifies the current session/turn. This adapter reads only
 * that interactive turn from ZCode's SQLite store, preserves the original input
 * text and timestamp, then writes through events.js using the source message ID
 * as the idempotency key. Replaying one Stop event is harmless; two distinct
 * messages with identical text remain two events.
 */
const { DatabaseSync } = require("node:sqlite");
const { appendFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { homedir, tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = arg("--root") || join(homedir(), ".cosmic-phantom");
const ZCODE_DB = arg("--zcode-db") || process.env.CP_ZCODE_DB || join(homedir(), ".zcode", "cli", "db", "db.sqlite");
const NODE = process.env.CP_NODE || join(ROOT, "tools", "node", "node.exe");
const LOG = join(ROOT, "hook-errors.log");

function logErr(message) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] zcode-flush: ${message}\n`, "utf8"); } catch {}
}

function readStdin() {
  try {
    const raw = require("node:fs").readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    logErr(`Stop payload parse failed: ${e.message}`);
    return {};
  }
}

function parseData(raw) {
  try { return typeof raw === "string" ? JSON.parse(raw) : (raw || {}); }
  catch { return {}; }
}

function originalText(data) {
  const input = data?.metadata?.inputIntent?.text;
  if (typeof input === "string") return input;
  const conversation = data?.metadata?.conversationInputIntent?.text;
  return typeof conversation === "string" ? conversation : null;
}

function sourceRows(db, sessionId, turnId) {
  const base = `
    SELECT m.id, m.session_id, m.sequence, m.time_created, m.data
    FROM message m
    JOIN session s ON s.id = m.session_id
    WHERE m.session_id = ?
      AND s.task_type = 'interactive'
      AND json_extract(m.data, '$.role') = 'user'
      AND json_extract(m.data, '$.semantics.origin') = 'real_user'
      AND json_extract(m.data, '$.semantics.kind') = 'user_prompt'
      AND COALESCE(json_extract(m.data, '$.synthetic'), 0) <> 1
      AND COALESCE(json_extract(m.data, '$.visibility'), '') <> 'model-only'
      AND COALESCE(json_extract(m.data, '$.source'), '') NOT IN ('todo_reminder', 'background_task', 'legacy_synthetic')`;
  if (turnId) return db.prepare(`${base} AND json_extract(m.data, '$.anchor.turnId') = ? ORDER BY m.sequence, m.id`).all(sessionId, turnId);
  return db.prepare(`${base} ORDER BY m.sequence DESC, m.id DESC LIMIT 1`).all(sessionId).reverse();
}

function toIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// P0-1/P0-3(2026-08-29 实装):Stop 侧确定性守卫,只读不写库,CP_SKIP_STOP_CHECKS=1 跳过。
//   ①门禁机器校验:本轮最终 assistant 回复过 reply-check.js(禁用词/开头/结构锚点),
//     违规留痕 hook-errors.log(F7 可见)并经 additionalContext 注入警告——补上门禁 13 条
//     唯一无机器校验的环(reply-check 头部自述"not a host send gate",此处即为挂载点)。
//   ②成果行检测:本 session 有 tool 实质工作但零 🛠️ 成果行 → 提醒一次
//     (.flags/<session>.stop-remind 防每轮重复;落盘后自然静默)。
function stopChecks(sessionId, turnId) {
  const notices = [];
  if (process.env.CP_SKIP_STOP_CHECKS === "1") return notices;
  try {
    let replyText = "";
    let toolCount = 0;
    const db = new DatabaseSync(ZCODE_DB, { readOnly: true });
    try {
      const rows = turnId
        ? db.prepare(`SELECT id FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' AND json_extract(data,'$.anchor.turnId')=? ORDER BY time_created DESC, id DESC LIMIT 10`).all(sessionId, turnId)
        : db.prepare(`SELECT id FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' ORDER BY time_created DESC, id DESC LIMIT 10`).all(sessionId);
      // 最终回复 = 倒序第一条带非空 text part 的 assistant 消息(跳过纯工具步骤消息)
      for (const row of rows) {
        const parts = db.prepare("SELECT data FROM part WHERE message_id=? ORDER BY sequence, id").all(row.id);
        const texts = [];
        for (const p of parts) {
          try {
            const j = JSON.parse(p.data);
            if (j.type === "text" && typeof j.text === "string") texts.push(j.text);
            if (j.type === "tool") toolCount++;
          } catch {}
        }
        if (texts.join("").trim()) { replyText = texts.join("\n"); break; }
      }
    } finally {
      db.close();
    }
    if (replyText.trim()) {
      const tmp = mkdtempSync(join(tmpdir(), "cp-replychk-"));
      try {
        const f = join(tmp, "reply.txt");
        writeFileSync(f, replyText, "utf8");
        const r = spawnSync(NODE, ["--experimental-sqlite", join(ROOT, "reply-check.js"), "--file", f, "--technical", "--root", ROOT], { encoding: "utf8", timeout: 15000 });
        let verdict = null;
        try { verdict = JSON.parse((r.stdout || "").trim()); } catch {}
        if (verdict && verdict.ok === false && Array.isArray(verdict.violations) && verdict.violations.length) {
          logErr(`reply-check violations: ${verdict.violations.map((v) => `${v.code}:${v.detail}`).join("; ")}`);
          notices.push(`⚠️ 门禁机器校验违规:${verdict.violations.map((v) => v.detail).join("、")}——已留痕 hook-errors.log,下轮回复修正。`);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    if (toolCount > 0) {
      try {
        const ev = new DatabaseSync(join(ROOT, "events.db"), { readOnly: true });
        try {
          const done = ev.prepare("SELECT COUNT(*) c FROM events WHERE session=? AND role='assistant' AND content LIKE '🛠️%'").get(sessionId).c;
          const flagDir = join(ROOT, ".flags");
          const flag = join(flagDir, `${sessionId}.stop-remind`);
          if (!done && !existsSync(flag)) {
            try { mkdirSync(flagDir, { recursive: true }); writeFileSync(flag, new Date().toISOString(), "utf8"); } catch {}
            notices.push("🛠️ 本会话已有实质工作(tool 调用)但尚未落成果行——收尾时以 🛠️ 行落盘(做了什么/改了哪些文件/验证结果)。");
          }
        } finally {
          ev.close();
        }
      } catch (e) {
        logErr(`stopChecks events read failed: ${e.message}`);
      }
    }
  } catch (e) {
    logErr(`stopChecks failed: ${e.message}`);
  }
  return notices;
}

function main() {
  const payload = readStdin();
  const sessionId = payload.sessionId || payload.session_id || process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  const turnId = payload.turnId || payload.turn_id || null;
  if (!sessionId || !existsSync(ZCODE_DB)) {
    if (!sessionId) logErr("Stop payload has no session ID");
    process.stdout.write("{}");
    return;
  }

  let entries = [];
  try {
    const db = new DatabaseSync(ZCODE_DB, { readOnly: true });
    try {
      entries = sourceRows(db, sessionId, turnId).map((row) => {
        const data = parseData(row.data);
        return {
          sourceId: row.id,
          session: row.session_id,
          content: originalText(data),
          ts: toIso(row.time_created ?? data?.time?.created),
        };
      }).filter((entry) => typeof entry.content === "string" && entry.content.trim() !== "" && entry.ts);
    } finally {
      db.close();
    }
  } catch (e) {
    logErr(`ZCode database read failed: ${e.message}`);
    process.stdout.write("{}");
    return;
  }

  if (!entries.length) {
    process.stdout.write("{}");
    return;
  }

  let tmp = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), "cp-zflush-"));
    const source = join(tmp, "zcode-events.jsonl");
    writeFileSync(source, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    const result = spawnSync(NODE, ["--experimental-sqlite", join(ROOT, "events.js"), "zcode", "--source", source, "--root", ROOT], {
      encoding: "utf8",
      timeout: 20000,
      // M1 修复(2026-08-29):显式传宿主标识。config.json 的 env.CP_HOST 只挂在 MCP server 条目下,
      // hook 子进程继承 ZCode 主进程 env(实测无 CP_HOST)→ events.js 摄取时 process.env.CP_HOST=null → src_host 全空。
      // 本脚本为 ZCode 专属 flush(文件名/Stop hook 挂载点即 zcode),fallback "zcode" 语义正确,不依赖宿主重启。
      env: { ...process.env, CP_HOST: process.env.CP_HOST || "zcode" },
    });
    let output = null;
    try { output = JSON.parse((result.stdout || "").trim()); } catch {}
    if (result.status !== 0 || output?.error) logErr(`events.js zcode failed status=${result.status}: ${(result.stderr || result.stdout || "").slice(0, 400)}`);
  } catch (e) {
    logErr(`flush failed: ${e.message}`);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  // 决策卡自动同步（2026-08-17 实装，自动管道防断档）：每次 ZCode 收尾后同步当日决策行→记忆卡。
  //   与 daily 同款"断不了档"哲学：daily 由本 hook 自动落，决策卡由本步自动生成（原文保真+幂等）。
  //   CP_SKIP_DECISION_CARDS=1 为测试模式（hook-smoke --deep 使用），防测试触发生产写卡。
  try {
    if (process.env.CP_SKIP_DECISION_CARDS !== "1") {
      spawnSync(NODE, [join(ROOT, "decision-cards.js"), "--root", ROOT], { encoding: "utf8", timeout: 30000 });
    }
  } catch (e) {
    logErr(`decision-cards sync failed: ${e.message}`);
  }
  // AITEAM 面板数据保鲜(2026-08-29 用户指令"实时更新"):每轮回复结束从真实数据源重建
  //   team-state.json(前端 poll 5s 轮询,数据一变 5 秒内上屏)。fail-open,不阻塞收尾链。
  try {
    const builder = join("D:", "AITEAM", "panel", "state-builder.cjs");
    if (existsSync(builder)) spawnSync(NODE, ["--experimental-sqlite", builder], { encoding: "utf8", timeout: 20000 });
  } catch (e) {
    logErr(`state-builder sync failed: ${e.message}`);
  }
  const notices = stopChecks(sessionId, turnId);
  process.stdout.write(JSON.stringify(notices.length ? { additionalContext: notices.join("\n") } : {}));
}

main();
