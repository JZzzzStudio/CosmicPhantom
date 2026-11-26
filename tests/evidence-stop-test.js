#!/usr/bin/env node
/**
 * evidence-stop-test.js — D-20 证据够了就停（2026-10-28）
 *
 * 覆盖：命中即停（rounds=1）/ 空结果扩展一次（rounds=2, lowEvidence）
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const REAL = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cp-evidence-stop-"));
const NODE = process.execPath;
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function run(args) {
  const r = spawnSync(NODE, ["--experimental-sqlite", path.join(TMP, "memory-cli.js"), ...args, "--root", TMP], { encoding: "utf8", timeout: 60000 });
  try { return JSON.parse((r.stdout || "").trim()); } catch { return { parse: r.stdout, stderr: r.stderr }; }
}

try {
  fs.mkdirSync(path.join(TMP, "memories"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "memories", "2026-10.md"), "---\nid: 20261028-0001\ncreated: 2026-10-28T10:00:00+08:00\nstatus: 🟢当前\ntags: [测试]\ntitle: 证据停测试\n---\n独特词A：用于证据停测试的卡片。\n", "utf8");
  fs.mkdirSync(path.join(TMP, "lib"), { recursive: true });
  for (const f of ["memory-cli.js", "memory-retrieval.js", "link-graph.js", "skills-sync.js", "lib/failopen.js"]) fs.copyFileSync(path.join(REAL, f), path.join(TMP, f));
  fs.writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "cp-evidence-stop", type: "module", private: true }), "utf8");

  let r = run(["search", "独特词A", "--top", "1", "--bm25-only"]);
  check("T1 命中即停", r.evidence?.rounds === 1 && r.evidence?.lowEvidence === false && r.count >= 1, JSON.stringify(r).slice(0, 240));

  r = run(["search", "zzqqxxvvuu", "--top", "1", "--bm25-only"]);
  check("T2 空结果不扩展", r.evidence?.rounds === 1 && r.evidence?.lowEvidence === true, JSON.stringify(r).slice(0, 240));

  console.log(`\n${failures.length ? "❌" : "✅"} evidence-stop-test: ${passed} passed / ${failures.length} failed`);
  if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
} catch (e) {
  console.error(`❌ evidence-stop-test 异常：${e.stack || e.message}`);
  process.exit(1);
} finally {
  try { if (!process.env.CP_KEEP_TEST_TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
