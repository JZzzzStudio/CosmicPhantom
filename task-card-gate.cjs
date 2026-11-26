#!/usr/bin/env node
/**
 * task-card-gate.cjs — 派单任务卡机器门(2026-08-29 用户拍板:hook 机器强制,非自觉)
 *
 * 背景(铁律靠自觉论):rules 4.12 任务卡纪律原为纸面纪律=靠自觉=不可靠。
 * 本脚本挂 ZCode PreToolUse,拦截 Agent(子代理)调用,校验 prompt 是否含任务卡四要素(修复单#6a 加④):
 *   ①范围路径(绝对路径,防子代理冷启动摸索) ②产出契约(结构/字数/落盘) ③防编造条款(证据路径强制) ④审查档位(分档防审查本身变性能黑洞)
 * 缺任一 → 阻断,原因喂回模型补卡重发;脚本自身异常 → fail-open 放行+留痕(F7 可见),不瘫派单通道。
 *
 * 输出协议:阻断 = stdout JSON {"decision":"block","reason":...};放行 = stdout "{}"。
 */
let raw = "";
try { raw = require("node:fs").readFileSync(0, "utf8"); } catch {}
let payload = {};
try { payload = JSON.parse(raw); } catch {}
try {
  const tool = payload.tool_name || "";
  if (tool !== "Agent") { process.stdout.write("{}"); return; }
  const prompt = String((payload.tool_input && payload.tool_input.prompt) || "");
  if (!prompt.trim()) { process.stdout.write("{}"); return; }   // 空 prompt 非本门管辖

  const checks = [
    { key: "范围路径", re: /[A-Za-z]:[\/\\]|\/tmp\/|\/home\//, why: "缺预置范围路径(子代理无上下文,必须给绝对路径+读法,禁它自己摸索)" },
    { key: "产出契约", re: /(产出|输出|报告)[^。\n]{0,30}(契约|结构|格式|字)|≤\s*\d+\s*字|不超过\s*\d+\s*字/, why: "缺产出契约(结构/字数上限/落盘路径,防报告不可回溯)" },
    { key: "防编造条款", re: /防编造|证据文件路径|没读到|未读到/, why: "缺防编造条款(每条结论带证据文件路径+没读到要如实写)" },
    { key: "审查档位", re: /(审查档位|审查方式：|审查方式:|内联抽查|断言复跑|🟥|🟨|🟩)/, why: "缺审查档位标注（按 CONTEXT.md 审查节点分档，防审查本身变性能黑洞）" },
  ];
  const missing = checks.filter(c => !c.re.test(prompt));
  if (missing.length) {
    const reason = "🚫 任务卡门(机器强制,铁律靠自觉论):子代理派单缺 " + missing.map(m => `【${m.key}】${m.why}`).join("；") + " —— 补全任务卡四要素后重发。模板见 core/rules.md §4.12 与 pro/audit-20260829-reverse-skill.md 经验档。";
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    require("node:fs").appendFileSync(join0(), `[${new Date().toISOString()}] task-card-gate: blocked Agent call (missing: ${missing.map(m => m.key).join("/")})\n`);
    return;
  }
  process.stdout.write("{}");
} catch (e) {
  try { require("node:fs").appendFileSync(join0(), `[${new Date().toISOString()}] task-card-gate fail-open: ${e.message}\n`); } catch {}
  process.stdout.write("{}");   // fail-open:门自身故障不瘫派单通道,留痕 F7 可见
}
function join0() {
  const { join } = require("node:path");
  const { homedir } = require("node:os");
  const root = process.env.CP_ROOT || join(homedir(), ".cosmic-phantom");
  return join(root, "hook-errors.log");
}
