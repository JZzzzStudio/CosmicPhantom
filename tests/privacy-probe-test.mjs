#!/usr/bin/env node
// privacy-probe-test.mjs — T13 F55（2026-11-19）
// 缝：probe()/scanText() 的外显结果。覆盖：无机密=0 / 机密进全局面=命中 / 仅局部机密不算泄漏 / 普通长句不误报
import { probe, scanText } from "../privacy-probe.js";
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? " — " + d : ""))); };
const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const e = (id, scope, raw) => ({ id, scope, raw: "---\nid: " + id + "\nscope: " + scope + "\n---\n" + raw });
ok("普通长句不误报（防 209 卡 90 条假阳性重演）", scanText("这条记忆记录的是某个只在私有作用域里成立的诊断结论，长度足够").length === 0);
ok("能识别 github classic token", scanText("值：" + TOKEN).length === 1);
let r = probe([e("a", "agent", "无机密内容")], "");
ok("无机密 → leakCount 0", r.leakCount === 0, JSON.stringify(r));
r = probe([e("b", "workspace", "配置里有 " + TOKEN)], "全局面\n" + TOKEN + "\n");
ok("机密进全局面 → 命中并指名", r.leakCount === 1 && r.leaks[0].id === "b" && r.leaks[0].pattern === "github-classic", JSON.stringify(r.leaks));
r = probe([e("c", "agent", "配置里有 " + TOKEN)], "全局面很干净");
ok("机密只在局部 → 不算泄漏", r.leakCount === 0 && r.skipped === 0, JSON.stringify({ l: r.leakCount }));
r = probe([e("d", "agent", "普通内容")], "");
ok("无机密卡被跳过 → checked 1 / skipped 1", r.checked === 1 && r.skipped === 1, JSON.stringify({ c: r.checked, s: r.skipped }));
console.log("\n" + pass + " passed / " + fail + " failed");
if (fail) process.exit(1);
