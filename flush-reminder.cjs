#!/usr/bin/env node
/**
 * flush-reminder.cjs — 落盘提醒 hook（2026-08-13 实装，补上 AGENTS.md 记载的纸面机制）
 *
 * ZCode UserPromptSubmit hook 输出端：查 events.db 最近一条 🛠️ 成果行，
 * 距上次落盘 >30 分钟（或从未落过成果行）→ 输出提醒注入上下文；
 * 30 分钟内 → 输出空 additionalContext（不打扰）。
 * 机制兜底不靠自觉：Stop hook 万一静默失败，用户下一句话就会触发提醒。
 *
 * 纪律：
 * - 只读 events.db，fail-open（任何失败输出空 additionalContext，不阻塞会话）
 * - 严格 schema：只输出 additionalContext 一个键（ZCode hook JSON 校验）
 */
const { DatabaseSync } = require("node:sqlite");
const { join } = require("node:path");
const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");

const rootArgIndex = process.argv.indexOf("--root");
const ROOT = (rootArgIndex >= 0 && process.argv[rootArgIndex + 1]) || join(homedir(), ".cosmic-phantom");
const minutesArgIndex = process.argv.indexOf("--minutes");
const THRESHOLD_MIN = minutesArgIndex >= 0 ? Math.max(1, Number(process.argv[minutesArgIndex + 1]) || 30) : 30;

function out(additionalContext) {
  process.stdout.write(JSON.stringify({ additionalContext }) + "\n");
}

function main() {
  const dbPath = join(ROOT, "events.db");
  if (!existsSync(dbPath)) { out("🛠️ 落盘提醒：events.db 尚不存在（本机还没落过盘），实质成果/决策记得即时落盘。"); return; }
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { out(""); return; }
  try {
    const row = db.prepare("SELECT MAX(ts) t FROM events WHERE role='assistant' AND content LIKE '🛠️%'").get();
    const last = row && row.t ? Date.parse(row.t) : 0;
    const now = Date.now();
    if (!Number.isFinite(last) || last <= 0) {
      out("🛠️ 落盘提醒：本机 events.db 尚无 🛠️ 成果行记录，本会话实质成果/决策记得即时落盘（session-adapter 🛠️ 行 + current-state update）。");
      return;
    }
    const gapMin = Math.round((now - last) / 60000);
    if (gapMin > THRESHOLD_MIN) {
      out(`🛠️ 落盘提醒：距上次成果落盘已 ${gapMin} 分钟（阈值 ${THRESHOLD_MIN}），本会话实质成果/决策记得即时落盘（session-adapter 🛠️ 行 + current-state update）。`);
      return;
    }
    // P2-7(2026-08-29 实装):蒸馏到期提醒——判据=distilled/manifest.json lastRun ≥7 天且 events.db
    //   有新增事件(count > eventsAtRun)。事件驱动查询(禁轮询铁律),不改变蒸馏触发制:
    //   机器只负责到期可见,执行仍走收工语义识别/用户手动(生成性环节留人工触发)。
    try {
      const mf = join(ROOT, "distilled", "manifest.json");
      if (existsSync(mf)) {
        const m = JSON.parse(readFileSync(mf, "utf8"));
        if (m && m.lastRun) {
          const days = (now - Date.parse(m.lastRun)) / 86400000;
          if (Number.isFinite(days) && days >= 7) {
            const cnt = db.prepare("SELECT COUNT(*) c FROM events").get().c;
            const base = Number(m.eventsAtRun || 0);
            if (cnt > base) {
              out(`🗓️ 蒸馏到期提醒:距上次蒸馏 ${Math.floor(days)} 天(≥7)且有新增事件(${cnt - base} 条)——收工语义时执行 distill-conversation,或用户说"蒸馏"触发。`);
              return;
            }
          }
        }
      }
    } catch { /* fail-open */ }
    // 用户原话新鲜度（2026-08-17 实装：Stop hook 静默空转兜底——08-12 事故形态就是"原话丢、成果行没丢"）。
    // 对比 ZCode db 最近真实 user 消息 vs events.db 最近 user 原话：仅当 ZCode 有更晚消息但 events.db 没跟上才报
    // （用户不说话时两边都不更新，不误报）。
    try {
      const zdbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
      if (existsSync(zdbPath)) {
        const zdb = new DatabaseSync(zdbPath, { readOnly: true });
        try {
          const zrow = zdb.prepare("SELECT MAX(time_created) t FROM message WHERE json_extract(data,'$.role')='user' AND json_extract(data,'$.semantics.origin')='real_user'").get();
          if (zrow && zrow.t) {
            const zLast = Number(zrow.t) < 1e12 ? Number(zrow.t) * 1000 : Number(zrow.t);
            const urow = db.prepare("SELECT MAX(ts) t FROM events WHERE role='user'").get();
            const uLast = urow && urow.t ? Date.parse(urow.t) : 0;
            if (Number.isFinite(uLast) && uLast > 0) {
              const lagMin = Math.round((zLast - uLast) / 60000);
              if (lagMin > THRESHOLD_MIN) {
                out(`🛠️ 落盘提醒：ZCode 最近用户消息比 events.db 用户原话新 ${lagMin} 分钟（阈值 ${THRESHOLD_MIN}；Stop hook 可能静默空转，跑 hook-smoke.cjs --deep 排查）。`);
                return;
              }
            }
          }
        } finally { zdb.close(); }
      }
    } catch { /* fail-open */ }
    out("");
  } catch { out(""); } finally { try { db.close(); } catch {} }
}

main();
