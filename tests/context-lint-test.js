#!/usr/bin/env node
/**
 * context-lint-test.js — CONTEXT 术语治理三态（D-07，2026-10-28）
 *
 * 覆盖：无重复未超限 / 同名重复 / 超软上限
 * 用临时根，不碰生产。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const REAL = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cp-context-lint-"));
const NODE = process.execPath;
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function writeContext(text) {
  fs.mkdirSync(path.join(TMP, ".context"), { recursive: true });
  fs.writeFileSync(path.join(TMP, ".context", "CONTEXT.md"), text, "utf8");
}
function lint() {
  const r = spawnSync(NODE, [path.join(REAL, "context-lint.cjs"), "--root", TMP, "--json"], { encoding: "utf8", timeout: 30000 });
  try { return JSON.parse(r.stdout || "{}"); } catch { return { parseError: r.stdout, stderr: r.stderr }; }
}

try {
  writeContext("## 术语\n\n- 术语：甲\n  定义：甲的说明。\n\n- 术语：乙\n  定义：乙的说明。\n");
  let r = lint();
  check("T1 无重复未超限 → ok", r.ok === true && r.duplicates.length === 0 && r.overSoft === false, JSON.stringify(r).slice(0, 200));

  writeContext("## 术语\n\n- 术语：甲\n  定义：甲的说明。\n\n## 补记\n\n- 术语：甲\n  定义：甲的另一处说明。\n");
  r = lint();
  check("T2 同名重复 → duplicates 1", r.duplicates && r.duplicates.length === 1 && r.duplicates[0].key === "甲", JSON.stringify(r.duplicates));

  const filler = "填充".repeat(16000); // ~32KB
  writeContext(`## 术语\n\n- 术语：甲\n  定义：${filler}\n`);
  r = lint();
  check("T3 超软上限 → overSoft true", r.overSoft === true && r.bytes > 30720, JSON.stringify({ bytes: r.bytes, overSoft: r.overSoft }));

  console.log(`\n${failures.length ? "❌" : "✅"} context-lint-test: ${passed} passed / ${failures.length} failed`);
  if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
} catch (e) {
  console.error(`❌ context-lint-test 异常：${e.stack || e.message}`);
  process.exit(1);
} finally {
  try { if (!process.env.CP_KEEP_TEST_TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
