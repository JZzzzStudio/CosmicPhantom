#!/usr/bin/env node
// dates-test.mjs — T05 日期语义与来源轴（2026-11-19）
import { parseDateSpec, resolveRelative, shouldFireOneoff, shouldFireAnnual, SOURCE_KINDS } from "../dates.js";
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? " — " + d : ""))); };
ok("YYYY-MM-DD → oneoff", parseDateSpec("2026-11-19").kind === "oneoff");
ok("MM-DD → annual", parseDateSpec("11-19").kind === "annual");
ok("02-29 允许（闰年基准）", parseDateSpec("02-29").kind === "annual");
ok("13-01 非法", parseDateSpec("13-01").kind === "invalid");
ok("空 → none", parseDateSpec("").kind === "none");
const base = "2026-11-18T23:30:00+08:00";
ok("明天 → 2026-11-19（按场景时间结算）", resolveRelative("明天上午提醒我", base) === "2026-11-19", resolveRelative("明天上午提醒我", base));
ok("昨天 → 2026-11-17", resolveRelative("昨天说过", base) === "2026-11-17", resolveRelative("昨天说过", base));
ok("无相对词 → null", resolveRelative("普通一句话", base) === null);
ok("一次性：前一天响", shouldFireOneoff("2026-11-19", "2026-11-18") === true);
ok("一次性：当天响", shouldFireOneoff("2026-11-19", "2026-11-19") === true);
ok("一次性：过后不响（不变成周年）", shouldFireOneoff("2026-11-19", "2026-11-20") === false);
ok("年复一年：每年同日命中", shouldFireAnnual("11-19", "2027-11-19") === true);
ok("来源轴 6 值", SOURCE_KINDS.length === 6, SOURCE_KINDS.join(","));
console.log("\n" + pass + " passed / " + fail + " failed");
if (fail) process.exit(1);
