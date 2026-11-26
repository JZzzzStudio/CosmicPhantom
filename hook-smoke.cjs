#!/usr/bin/env node
/**
 * hook-smoke.js — ZCode hook 链路冒烟测试（2026-08-17 实装，防"装好即崩"复发）
 *
 * 背景：2026-08-17 事故——config.json Stop hook 用 tools/node（v22.12）跑 zcode-flush.cjs，
 * 顶层 require('node:sqlite') 缺 --experimental-sqlite 标志，进程一启动即崩
 * （ERR_UNKNOWN_BUILTIN_MODULE），用户原话自 08-12 起未自动落盘；install-check/install-usb
 * 28 项全绿但从不实跑 hook，故拦不住。
 *
 * 本脚本：用与 config.json 完全一致的 command/args 实跑每个 hook（空 payload，安全不写库），
 * 断言：①命令存在 ②退出码 0 ③stdout 可解析 ④依赖 node:sqlite 的脚本必须带 --experimental-sqlite。
 *
 * 用法：tools/node/node.exe hook-smoke.js --root <ROOT> [--config <zcode config.json>]
 * 输出：{"ok":bool,"checks":[{name,ok,detail}]}（exit 0 恒返回，供上层统一判定）
 */
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

// 容错加载 sqlite（默认模式无需；--deep 读 ZCode db 需要 --experimental-sqlite 启动本脚本）
let DatabaseSync = null;
try { DatabaseSync = require("node:sqlite").DatabaseSync; } catch {}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = arg("--root") || join(homedir(), ".cosmic-phantom");
const CONFIG = arg("--config") || join(homedir(), ".zcode", "cli", "config.json");
const TOOLS_NODE = join(ROOT, "tools", "node", "node.exe");
const CHECKS = [];
function ok(name, cond, detail) { CHECKS.push({ name, ok: !!cond, detail }); }

// ---- 1. config.json 可读 + hooks 段存在 ----
let config = null;
try {
  config = JSON.parse(readFileSync(CONFIG, "utf8"));
  ok("config.json 可读", true, CONFIG);
} catch (e) {
  ok("config.json 可读", false, String(e.message).slice(0, 120));
  finish();
}

const events = config?.hooks?.events || {};
const known = ["SessionStart", "UserPromptSubmit", "Stop"];
ok("hooks.events 含三事件", known.every((ev) => Array.isArray(events[ev]) && events[ev].length > 0),
  `SessionStart=${events.SessionStart?.length ?? 0} UserPromptSubmit=${events.UserPromptSubmit?.length ?? 0} Stop=${events.Stop?.length ?? 0}`);

// ---- 2. 逐事件实跑（空 payload，与配置完全一致的调用方式）----
const PAYLOADS = {
  SessionStart: JSON.stringify({ event: "SessionStart", matcher: "compact", sessionId: "smoke-test" }),
  UserPromptSubmit: JSON.stringify({ event: "UserPromptSubmit", sessionId: "smoke-test" }),
  Stop: JSON.stringify({ event: "Stop", sessionId: "smoke-test" }),
};

for (const ev of known) {
  for (const conf of events[ev] || []) {
    for (const h of conf.hooks || []) {
      const label = `${ev}:${h.command.split(/[\\/]/).pop()}`;
      const command = h.command;
      const args = h.args || [];
      ok(`${label} 命令存在`, existsSync(command), command);
      if (!existsSync(command)) continue;

      // 静态兜底：脚本依赖 node:sqlite 则必须带 flag（防未来新脚本踩坑）
      const scriptPath = args.find((a) => /\.(c?js|mjs)$/.test(a));
      if (scriptPath && existsSync(scriptPath)) {
        const src = readFileSync(scriptPath, "utf8");
        const hasFlag = args.some((a) => /sqlite/i.test(a));
        const needsFlag = /node:sqlite/.test(src) && !hasFlag;
        ok(`${label} sqlite flag 在位`, !needsFlag,
          needsFlag ? `${scriptPath.split(/[\\/]/).pop()} require node:sqlite 但 args 无 --experimental-sqlite` : "无需 flag 或已带");
      }

      // 实跑（空 payload 安全：无真实 sessionId 不写库）
      const r = spawnSync(command, args, { input: PAYLOADS[ev] || "{}", encoding: "utf8", timeout: 20000 });
      ok(`${label} 实跑 exit=0`, r.status === 0, `status=${r.status}${r.error ? " err=" + r.error.message : ""}`);
      if (r.status === 0) {
        let parsed = null;
        try { parsed = JSON.parse((r.stdout || "").trim()); } catch {}
        ok(`${label} 输出合法 hook JSON`, parsed !== null,
          parsed !== null ? "可解析" : `stdout=${String(r.stdout || "").slice(0, 80)}`);
        if (ev === "SessionStart" || ev === "UserPromptSubmit") {
          ok(`${label} 输出含 additionalContext`, parsed && "additionalContext" in parsed, "schema 正确");
        }
      }
    }
  }
}

// ---- 3. --deep 全真链路（2026-08-17）：默认模式只测"冷路径"（空 payload 安全退出），
//        逻辑级回归（字段解析错/过滤误伤/写失败但不崩）防不住——deep 用 ZCode db 最近
//        真实 user turn 全链路跑 zcode-flush（读库→events.js 落盘→投影）。
//        幂等安全：events.js INSERT OR IGNORE（instance=zcode-msg:<id>），重跑无重复；
//        首次跑=补录真实原话（非测试数据，不违反零容忍红线）。
//        依赖 ZCode db + --experimental-sqlite：不满足 → fail-open 提示，不误报。
if (process.argv.includes("--deep")) {
  if (!DatabaseSync) {
    ok("deep:全链路(zcode-flush 真实 turn)", false, "本脚本需以 --experimental-sqlite 启动（读 ZCode db）");
  } else {
    const zdbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
    if (!existsSync(zdbPath)) {
      ok("deep:全链路(zcode-flush 真实 turn)", false, `未找到 ${zdbPath}（非 ZCode 宿主，深度验证跳过）`);
    } else {
      try {
        const zdb = new DatabaseSync(zdbPath, { readOnly: true });
        const row = zdb.prepare(`SELECT session_id sid, json_extract(data,'$.anchor.turnId') turn
          FROM message
          WHERE json_extract(data,'$.role')='user' AND json_extract(data,'$.semantics.origin')='real_user'
            AND json_extract(data,'$.anchor.turnId') IS NOT NULL
          ORDER BY time_created DESC LIMIT 1`).get();
        zdb.close();
        if (!row) {
          ok("deep:全链路(zcode-flush 真实 turn)", false, "ZCode db 无匹配真实 user 消息");
        } else {
          const r = spawnSync(TOOLS_NODE, ["--experimental-sqlite", join(ROOT, "zcode-flush.cjs"), "--root", ROOT],
            { input: JSON.stringify({ sessionId: row.sid, turnId: row.turn }), encoding: "utf8", timeout: 30000, env: { ...process.env, CP_SKIP_DECISION_CARDS: "1" } });   // 测试模式：跳过 decision-cards 真实写卡（2026-08-17）
          ok("deep:全链路(zcode-flush 真实 turn)", r.status === 0,
            r.status === 0 ? `status=0（幂等补录/跳过）` : `status=${r.status} ${String(r.stderr || r.stdout || "").slice(0, 100)}`);
        }
      } catch (e) {
        ok("deep:全链路(zcode-flush 真实 turn)", false, String(e.message || e).slice(0, 120));
      }
    }
  }
}

function finish() {
  const failed = CHECKS.filter((c) => !c.ok);
  process.stdout.write(JSON.stringify({ ok: failed.length === 0, checks: CHECKS }) + "\n");
  process.exit(failed.length === 0 ? 0 : 1);
}

finish();
