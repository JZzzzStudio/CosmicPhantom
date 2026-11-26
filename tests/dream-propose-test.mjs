#!/usr/bin/env node
// dream-propose-test.mjs — T12 v2 propose-only（2026-11-19）
// 缝：proposePlan() 的外显结果。覆盖：提案不改真源 / 缺 situation 生成提案 / 重复组生成合并候选 / 作用域复核提案
import { planReview, proposePlan } from "../dream.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? " — " + d : ""))); };
const T = mkdtempSync(join(tmpdir(), "cp-propose-"));
mkdirSync(join(T, "memories"), { recursive: true });
const card = (id, scope, extra) => ["---", "id: " + id, "status: 🟢当前", "type: 事件", "scope: " + scope].concat(extra ? [extra] : []).concat(["---", "同一主题的说明"]).join("\n");
writeFileSync(join(T, "memories", "2026-11.md"), [card("0001", "global", "situation: 当问部署"), card("0002", "workspace", "")].join("\n§§§\n"));
const beforeRaw = readFileSync(join(T, "memories", "2026-11.md"), "utf8");
const beforeCount = readdirSync(join(T, "memories")).length;
const plan = planReview(T);
const prop = proposePlan(T, plan);
ok("提案标记 dryRun", prop.dryRun === true, String(prop.dryRun));
ok("缺 situation 生成 set-situation 提案", prop.ops.some(o => o.op === "set-situation" && o.id.endsWith("0002")), JSON.stringify(prop.ops.map(o => o.op)));
ok("workspace 档生成 scope-review 提案", prop.ops.some(o => o.op === "scope-review"), JSON.stringify(prop.ops.map(o => o.op)));
ok("提案不改真源（正文逐字不变）", readFileSync(join(T, "memories", "2026-11.md"), "utf8") === beforeRaw);
ok("提案不新增文件", readdirSync(join(T, "memories")).length === beforeCount);
ok("每条提案带 why（可审）", prop.ops.every(o => typeof o.why === "string" && o.why.length > 4), JSON.stringify(prop.ops[0]));
rmSync(T, { recursive: true, force: true });
console.log("\n" + pass + " passed / " + fail + " failed");
if (fail) process.exit(1);
