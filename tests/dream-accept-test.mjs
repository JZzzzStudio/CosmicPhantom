#!/usr/bin/env node
// dream-accept-test.mjs — T12 v3 逐条接受（2026-11-19）
// 缝：acceptOp() 的接受/拒绝。覆盖：缺文本拒绝 / 缺目标拒绝 / 合并拒绝 / 合法接受带 ids / 不写盘
import { acceptOp, planReview, proposePlan } from "../dream.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? " — " + d : ""))); };
const T = mkdtempSync(join(tmpdir(), "cp-accept-"));
mkdirSync(join(T, "memories"), { recursive: true });
const card = (id, scope, extra) => ["---", "id: " + id, "status: 🟢当前", "type: 事件", "scope: " + scope].concat(extra ? [extra] : []).concat(["---", "同一主题的说明"]).join("\n");
writeFileSync(join(T, "memories", "2026-11.md"), [card("0001", "workspace", ""), card("0002", "global", "situation: 当问部署")].join("\n§§§\n"));
const snapshot = readFileSync(join(T, "memories", "2026-11.md"), "utf8");
const plan = planReview(T);
const prop = proposePlan(T, plan);
ok("scope-review 提案带真实 ids（夹具 1 张 workspace 卡）", prop.ops.some(o => o.op === "scope-review" && Array.isArray(o.ids) && o.ids.length === 1), JSON.stringify(prop.ops.find(o => o.op === "scope-review")));
let r = acceptOp(T, prop.ops.find(o => o.op === "set-situation"), {});
ok("缺 situation 文本 → 拒绝（不编造）", r.ok === false && r.refused === "set-situation", JSON.stringify(r));
r = acceptOp(T, prop.ops.find(o => o.op === "set-situation"), { situation: "当用户问部署脚本在哪" });
ok("给文本 → 接受", r.ok === true && r.situation.length > 4, JSON.stringify(r));
const scopeOp = prop.ops.find(o => o.op === "scope-review");
r = acceptOp(T, scopeOp, {});
ok("缺目标作用域 → 拒绝", r.ok === false && r.refused === "scope-review", JSON.stringify(r));
r = acceptOp(T, scopeOp, { to: "agent" });
ok("给目标 → 接受并返回受限 ids（≤50）", r.ok === true && r.ids.length <= 50 && r.to === "agent", JSON.stringify({ n: r.ids.length }));
r = acceptOp(T, { op: "merge-candidate", keep: "a", merge: ["b"] }, {});
ok("合并 → 明确拒绝（需人工）", r.ok === false && /人工/.test(r.reason), JSON.stringify(r));
ok("acceptOp 本身不写盘（正文逐字不变）", readFileSync(join(T, "memories", "2026-11.md"), "utf8") === snapshot);
rmSync(T, { recursive: true, force: true });
console.log("\n" + pass + " passed / " + fail + " failed");
if (fail) process.exit(1);
