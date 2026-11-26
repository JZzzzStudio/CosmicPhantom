#!/usr/bin/env node
/**
 * f23-test.js — F23 吸收台账三态回归（D-01，2026-10-28）
 *
 * 覆盖：已决不报 / 待裁决报 / 挂起不报 / 混合取最老 / 缺文件不报
 * 用临时根，不碰生产。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkAbsorbedLedger } from "../lib/verify-absorbed.js";

const TMP = mkdtempSync(join(tmpdir(), "cp-f23-test-"));
let passed = 0;
const failures = [];

function writeLedger(rows) {
  mkdirSync(join(TMP, "core"), { recursive: true });
  writeFileSync(join(TMP, "core", "absorbed-notes.md"), [
    "| # | 来源 | 出处 | 日期 | 状态 | 理由 | 档案 |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n") + "\n", "utf8");
}
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const OLD = "2026-09-01";

try {
  // T1 已决：状态列不含待裁决，理由列含"借鉴" → 不报
  writeLedger([`| 24 | context-mode | src | ${OLD} | 明确否决引入 + 3 项已决 | **借鉴**：①A ②B | x.md |`]);
  let r = checkAbsorbedLedger(TMP);
  check("T1 已决不报（理由列含借鉴）", r.stale === null, JSON.stringify(r));

  // T2 待裁决：状态列含待裁决，日期 >30 天 → 报
  writeLedger([`| 31 | Utopia | src | ${OLD} | **待裁决**（等 W2） | 候选借鉴 2 | x.md |`]);
  r = checkAbsorbedLedger(TMP);
  check("T2 待裁决报出", typeof r.stale === "string" && r.stale.includes("Utopia"), JSON.stringify(r));

  // T3 挂起：状态列含挂起、理由含借鉴 → 不报
  writeLedger([`| 32 | Foo | src | ${OLD} | **挂起—等 W2** | 借鉴 A/B | x.md |`]);
  r = checkAbsorbedLedger(TMP);
  check("T3 挂起不报", r.stale === null, JSON.stringify(r));

  // T4 混合：两条待裁决，取最老日期
  writeLedger([
    `| 40 | Newer | src | 2026-09-20 | 待裁决 | x | x.md |`,
    `| 41 | Older | src | 2026-08-01 | 待裁决 | x | x.md |`,
  ]);
  r = checkAbsorbedLedger(TMP);
  check("T4 取最老待裁决", r.oldest?.sys === "Older", JSON.stringify(r.oldest));

  // T5 无文件：不报
  rmSync(join(TMP, "core", "absorbed-notes.md"));
  r = checkAbsorbedLedger(TMP);
  check("T5 缺文件不报", r.stale === null && r.missing === true, JSON.stringify(r));

  console.log(`\n${failures.length ? "❌" : "✅"} f23-test: ${passed} passed / ${failures.length} failed`);
  if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
} catch (e) {
  console.error(`❌ f23-test 异常：${e.stack || e.message}`);
  process.exit(1);
} finally {
  try { if (!process.env.CP_KEEP_TEST_TMP) rmSync(TMP, { recursive: true, force: true }); } catch {}
}
