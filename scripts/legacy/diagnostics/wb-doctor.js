#!/usr/bin/env node
/**
 * ⚠️ **已失效（2026-09-19 登记）**：WorkBuddy 宿主已于 **2026-08-29 由用户收回接入权除名**
 *   → 本工具体检的对象已不存在。**留档不删，不再维护**。关闭登记：本文件位于 `scripts/legacy/`，仅供历史复现。
 *
 * wb-doctor.js — WorkBuddy 接入层一键体检（Memorix 借鉴 1：Agent Doctor）
 *
 * 检查：node 解释器存在性 / junction / settings 路径 / mcp.json 位置 / 游标健康 / 索引一致
 * 输出 JSON，exit code 0 = 全绿；只读，不修改任何配置。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const HOME = homedir();

function check(name, ok, detail, severity = ok ? "pass" : "fail") { return { name, ok, severity, detail }; }

function main() {
  const checks = [];
  const nodeBin = join(ROOT, "tools", "node", "node.exe");
  checks.push(check("portable-node", existsSync(nodeBin), nodeBin));

  const wbTestRoot = join(HOME, ".cosmic-phantom-wb-test");
  if (existsSync(wbTestRoot)) {
    const testNode = join(wbTestRoot, "tools", "node", "node.exe");
    checks.push(check("wb-test-node", existsSync(testNode), testNode, existsSync(testNode) ? "pass" : "fail"));
  } else {
    checks.push(check("wb-test-root", false, "测试根不存在（未实装或已移除）", "warning"));
  }

  const guiSettings = join(HOME, ".workbuddy", "settings.json");
  const cliSettings = join(HOME, ".codebuddy", "settings.json");
  checks.push(check("gui-settings", existsSync(guiSettings), guiSettings));
  checks.push(check("cli-settings", existsSync(cliSettings), cliSettings));
  if (existsSync(guiSettings)) {
    const raw = readFileSync(guiSettings, "utf8");
    checks.push(check("gui-session-start-hook", /SessionStart/.test(raw), "SessionStart hook registered"));
  }

  const guiMcp = join(HOME, ".workbuddy", "mcp.json");
  const cliMcp = join(ROOT, ".mcp.json");
  checks.push(check("gui-mcp-nodot", existsSync(guiMcp), guiMcp));
  if (existsSync(guiMcp)) {
    const raw = readFileSync(guiMcp, "utf8");
    checks.push(check("gui-mcp-registered", /cosmic-phantom/.test(raw), "cosmic-phantom server present"));
  }
  checks.push(check("cli-mcp", existsSync(cliMcp), cliMcp, existsSync(cliMcp) ? "pass" : "warning"));

  const cursorFile = join(ROOT, ".wb-cursor.json");
  if (existsSync(cursorFile)) {
    try {
      const cursor = JSON.parse(readFileSync(cursorFile, "utf8"));
      const entries = Object.keys(cursor);
      checks.push(check("wb-cursor", entries.length > 0, `${entries.length} file entries`));
    } catch (error) {
      checks.push(check("wb-cursor", false, `无法解析: ${error.message}`));
    }
  } else {
    checks.push(check("wb-cursor", false, "游标文件不存在", "warning"));
  }

  const db = join(ROOT, "events.db");
  if (existsSync(db)) {
    try {
      const connection = new DatabaseSync(db, { readOnly: true });
      try {
        const events = connection.prepare("SELECT COUNT(*) AS count FROM events").get().count;
        const projected = connection.prepare("SELECT COUNT(*) AS count FROM projection").get().count;
        checks.push(check("events-health", events >= 0 && projected <= events, `events=${events} projected=${projected}`));
      } finally { try { connection.close(); } catch {} }
    } catch (error) {
      checks.push(check("events-health", false, error.message));
    }
  } else {
    checks.push(check("events-health", false, "events.db 不存在"));
  }

  const indexDb = join(ROOT, "memory-index.db");
  checks.push(check("memory-index", existsSync(indexDb), indexDb, existsSync(indexDb) ? "pass" : "warning"));

  const failures = checks.filter(item => !item.ok && item.severity === "fail");
  process.stdout.write(JSON.stringify({ ok: failures.length === 0, root: resolve(ROOT), checks }, null, 2) + "\n");
  process.exitCode = failures.length ? 1 : 0;
}

main();
