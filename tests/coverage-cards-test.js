#!/usr/bin/env node
/**
 * coverage-cards-test.js — E-3 决策卡覆盖率（2026-10-28）
 *
 * 覆盖：部分覆盖 / 全覆盖 / 无 daily
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const REAL = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cp-coverage-"));
const NODE = process.execPath;
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function run(root) {
  const r = spawnSync(NODE, [path.join(REAL, "coverage-cards.cjs"), "--root", root, "--days", "30", "--json"], { encoding: "utf8", timeout: 30000 });
  try { return JSON.parse(r.stdout || "{}"); } catch { return { parse: r.stdout, stderr: r.stderr }; }
}
function writeCard(file, text) {
  fs.writeFileSync(path.join(TMP, "memories", file), `---\nid: x\ncreated: 2026-10-28\nstatus: 🟢当前\ntags: [决策]\n---\n${text}\n`, "utf8");
}

try {
  fs.mkdirSync(path.join(TMP, "daily"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "memories"), { recursive: true });
  const lines = Array.from({ length: 5 }, (_, i) => `- **⭐👤 用户（决策）**：决定第 ${i} 条：做某件重要的事`).join("\n");
  fs.writeFileSync(path.join(TMP, "daily", "2026-10-28.md"), lines + "\n", "utf8");

  writeCard("2026-10.md", "决定第 0 条：做某件重要的事");
  let r = run(TMP);
  check("T1 部分覆盖", r.decisions === 5 && r.covered === 1 && r.rate === 0.2, JSON.stringify(r));

  for (let i = 1; i < 5; i += 1) writeCard(`extra-${i}.md`, `决定第 ${i} 条：做某件重要的事`);
  r = run(TMP);
  check("T2 全覆盖", r.decisions === 5 && r.covered === 5 && r.rate === 1, JSON.stringify(r));

  const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "cp-coverage-empty-"));
  r = run(EMPTY);
  check("T3 无 daily", r.decisions === 0 && r.rate === null, JSON.stringify(r));
  fs.rmSync(EMPTY, { recursive: true, force: true });

  console.log(`\n${failures.length ? "❌" : "✅"} coverage-cards-test: ${passed} passed / ${failures.length} failed`);
  if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
} catch (e) {
  console.error(`❌ coverage-cards-test 异常：${e.stack || e.message}`);
  process.exit(1);
} finally {
  try { if (!process.env.CP_KEEP_TEST_TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
