#!/usr/bin/env node
// dream-test.mjs — T12 只读反思（2026-11-19）
// 缝：planReview 的统计量。覆盖：缺 situation / 无证据 / 作用域分布 / 重复组结构 / 只读不改盘
// 注：重复组的"能真分组"由生产实测佐证（294 卡 → 29 组）；本夹具只验证结构与计数口径。
import { planReview } from "../dream.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? " — " + d : ""))); };

const T = mkdtempSync(join(tmpdir(), "cp-dream-"));
mkdirSync(join(T, "memories"), { recursive: true });

const card = (id, scope, extra) => ["---", "id: " + id, "status: 🟢当前", "type: 事件", "scope: " + scope]
  .concat(extra ? [extra] : [])
  .concat(["---", "同一主题的说明"]).join("\n");

const blocks = [
  card("0001", "global", "situation: 当用户问部署\nsource: daily/2026-11-01.md"),
  card("0002", "workspace", "situation: 当用户问部署"),
  card("0003", "global", ""),
];
writeFileSync(join(T, "memories", "2026-11.md"), blocks.join("\n§§§\n"));

const before = readdirSync(join(T, "memories")).length;
const p = planReview(T);

ok("总量 = 3", p.total === 3, String(p.total));
ok("缺 situation = 1（0003）", p.missingSituation.n === 1 && p.missingSituation.ids.some((x) => x.endsWith("0003")), JSON.stringify(p.missingSituation));
ok("无证据 = 2（只有 0001 有 source）", p.noEvidence.n === 2, String(p.noEvidence.n));
ok("作用域分布 global=2 / workspace=1", p.scopeDist.global === 2 && p.scopeDist.workspace === 1, JSON.stringify(p.scopeDist));
ok("重复组结构在（top 为数组，含 key/ids/n）", Array.isArray(p.duplicateGroups.top) && (p.duplicateGroups.top.length === 0 || ("ids" in p.duplicateGroups.top[0] && "n" in p.duplicateGroups.top[0])), JSON.stringify(p.duplicateGroups).slice(0, 120));
ok("只读：memories 文件数不变", readdirSync(join(T, "memories")).length === before, String(readdirSync(join(T, "memories")).length));

rmSync(T, { recursive: true, force: true });
console.log("\n" + pass + " passed / " + fail + " failed");
if (fail) process.exit(1);