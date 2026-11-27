// tests/expand-test.js — 渐进展开 expand 子命令（2026-08-31 实装）
// 覆盖：--session 唯一后缀/多义报错/零命中、--evt v2 锚点反查（含 daily 文件真实锚点）、
//       --memory frontmatter 锚点解析、逐字保真（首尾空白不裁剪）、预算截断显式化、只读性（daily 与 projection 不动）。
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-expand-"));
const ROOT = path.join(SB, "root");
const MEM = path.join(ROOT, "memories");
let pass = 0, fail = 0;

function check(name, condition, detail = "") {
  if (condition) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name} -- ${detail}`); }
}
function copy(relative) {
  const target = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REAL, relative), target);
}
function run(script, args, input) {
  return spawnSync(NODE, ["--experimental-sqlite", path.join(ROOT, script), ...args, "--root", ROOT],
    { encoding: "utf8", timeout: 60000, input: input ? JSON.stringify(input) : undefined });
}
function jparse(r) {
  const s = (r.stdout || "").trim();
  const start = s.indexOf("{");
  if (start < 0) return {};
  return JSON.parse(s.slice(start));
}

(async () => {
  // ---- 沙箱搭建 ----
  for (const f of ["events.js", "memory-cli.js", "memory-retrieval.js", "link-graph.js", "skills-sync.js", "session-adapter.js", "decision-cards.js", "validate.js", "embed.js", "embed-tokenizer.js"]) copy(f);
  copy("lib/failopen.js");
  fs.writeFileSync(path.join(ROOT, "package.json"), JSON.stringify({ name: "cp-sandbox", type: "module", private: true }), "utf8");
  fs.mkdirSync(MEM, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "daily"), { recursive: true });
  // 沙箱清理（2026-08-31 挑刺 T5：原版漏清理，每次运行残留一个 cp-expand-* 目录；regression-test 同款收尾）
  const cleanup = () => { try { fs.rmSync(SB, { recursive: true, force: true }); } catch {} };
  process.on("exit", cleanup);

  // ---- 落盘两条会话（保真内容：首部空格+尾部空格+换行，K 系列教训同款断言）----
  const USER_TEXT = "  决策：expand 只做 CLI 子命令，MCP 不动  \n";
  const ACHIEVE = "🛠️ 测试成果行：expand 沙箱验证";
  const s1 = run("session-adapter.js", ["--session", "expandtest-s1"], {
    entries: [
      { role: "user", text: USER_TEXT },
      { role: "assistant", text: ACHIEVE },
    ],
    summary: "expand 沙箱会话一",
  });
  check("T0a session-adapter 落盘成功", s1.status === 0 && jparse(s1).logged === 2, JSON.stringify(jparse(s1)).slice(0, 200));
  const s2 = run("session-adapter.js", ["--session", "expandtest-s2"], {
    entries: [{ role: "user", text: "第二条会话用于多义后缀测试" }],
    summary: "expand 沙箱会话二",
  });
  check("T0b 第二会话落盘成功", s2.status === 0 && jparse(s2).logged === 1, JSON.stringify(jparse(s2)).slice(0, 200));
  const LONG_TEXT = "长内容截断测试。".repeat(300);   // ≈2.7KB，跨过 2000 字节钳制下限
  const s3 = run("session-adapter.js", ["--session", "expandtest-s3"], {
    entries: [
      { role: "user", text: "s3 第一条短消息" },
      { role: "user", text: LONG_TEXT },
      { role: "user", text: "s3 收尾行" },
    ],
    summary: "expand 沙箱会话三（截断用）",
  });
  check("T0c 第三会话落盘成功", s3.status === 0 && jparse(s3).logged === 3, JSON.stringify(jparse(s3)).slice(0, 200));

  // ---- T1 逐字保真：--session 全量流内容原样 ----
  let r = jparse(run("memory-cli.js", ["expand", "--session", "expandtest-s1"]));
  check("T1a mode=session 且事件数正确", r.mode === "session" && r.events === 2, JSON.stringify(r).slice(0, 200));
  check("T1b 用户原话逐字（首尾空白不裁剪）", r.stream?.[0]?.content === USER_TEXT, JSON.stringify(r.stream?.[0]));
  check("T1c 成果行在流中且通道为 SessionAdapter", r.stream?.[1]?.content === ACHIEVE && r.channel === "SessionAdapter", JSON.stringify(r.stream?.[1]));

  // ---- T2 --evt：从 daily 真实投影文件取锚点反查 ----
  const dailyFile = fs.readdirSync(path.join(ROOT, "daily")).filter(f => f.endsWith(".md"))[0];
  const dailyRaw = fs.readFileSync(path.join(ROOT, "daily", dailyFile), "utf8");
  const mark = (dailyRaw.match(/cp-evt-v2:[0-9a-f]{32}/) || [])[0];
  check("T2a daily 投影含 cp-evt 锚点", Boolean(mark), dailyRaw.slice(0, 300));
  r = jparse(run("memory-cli.js", ["expand", "--evt", mark, "--bytes", "5000"]));
  check("T2b 锚点反查命中且 anchor 标记正确", r.mode === "evt" && r.anchorSeq === 1 && r.stream?.[0]?.anchor === true, JSON.stringify(r).slice(0, 250));
  check("T2c 锚点会话归属正确", r.session === "session-expandtest-s1", r.session);

  // ---- T3 --memory：frontmatter source=daily 指针 → --date 会话列表 ----
  const date = dailyFile.slice(0, 10);
  fs.writeFileSync(path.join(MEM, "20260101-9999.md"),
    `---\nid: 20260101-9999\ncreated: ${date}T10:00:00+08:00\nsource: daily/${dailyFile}\nstatus: 🟢当前\ntype: 事件\ntags: [测试]\nscope: workspace\n---\nexpand 沙箱测试条目\n`, "utf8");
  r = jparse(run("memory-cli.js", ["expand", "--memory", "20260101-9999"]));
  check("T3a --memory 解析 source 锚点列当日会话", r.mode === "date" && r.date === date, JSON.stringify(r).slice(0, 200));
  check("T3b 会话清单含三条沙箱会话", (r.sessions || []).length === 3 && r.sessions.some(s => s.session === "session-expandtest-s1"), JSON.stringify(r.sessions));
  check("T3c firstUser 预览已压缩空白", r.sessions?.[0]?.firstUser === "决策：expand 只做 CLI 子命令，MCP 不动" || r.sessions?.some(s => s.firstUser === "决策：expand 只做 CLI 子命令，MCP 不动"), JSON.stringify(r.sessions?.map(s => s.firstUser)));

  // ---- T4 预算截断显式化（300 被 2000 下限钳制；长内容跨过下限，截断停在事件边界）----
  r = jparse(run("memory-cli.js", ["expand", "--session", "expandtest-s3", "--bytes", "300"]));
  check("T4 预算钳制+截断标注+边界停", r.truncated === true && r.shown === 1 && r.shown < r.events && r.budget === 2000 && r.stream?.[0]?.content === "s3 第一条短消息", JSON.stringify({ shown: r.shown, events: r.events, truncated: r.truncated, budget: r.budget }));

  // ---- T5 多义后缀与零命中 ----
  r = jparse(run("memory-cli.js", ["expand", "--session", "expandtest-s"]));
  check("T5a 多义后缀报错且列 candidates", r.error?.includes("需唯一") && (r.candidates || []).length === 3, JSON.stringify(r).slice(0, 200));
  r = jparse(run("memory-cli.js", ["expand", "--session", "no-such-session-xyz"]));
  check("T5b 零命中报错带 hint", r.error === "无会话命中" && Boolean(r.hint), JSON.stringify(r));

  // ---- T6 锚点格式不识别 ----
  r = jparse(run("memory-cli.js", ["expand", "--evt", "not-a-mark"]));
  check("T6 非法锚点格式报错", String(r.error).includes("格式不识别"), JSON.stringify(r).slice(0, 150));

  // ---- T7 只读性：expand 前后 daily 与 events 计数不变 ----
  const dailyBefore = fs.readFileSync(path.join(ROOT, "daily", dailyFile), "utf8");
  const st1 = jparse(run("memory-cli.js", ["events", "status"]));
  run("memory-cli.js", ["expand", "--session", "expandtest-s1"]);
  run("memory-cli.js", ["expand", "--evt", mark]);
  const dailyAfter = fs.readFileSync(path.join(ROOT, "daily", dailyFile), "utf8");
  const st2 = jparse(run("memory-cli.js", ["events", "status"]));
  check("T7a daily 逐字节不变", dailyBefore === dailyAfter);
  check("T7b events/projection 计数不变", st1.events === st2.events && st1.projected === st2.projected, JSON.stringify({ a: st1, b: st2 }));

  // ---- T8 敏感透明化（2026-09-01 A2）：sensitive=1 事件在展开流中带标记（内容不过滤，L3 逐字）----
  const syntheticKey = ["sk", "abcdef1234567890abcdef"].join("-");
  const sens = run("session-adapter.js", ["--session", "expandtest-sens"], {
    entries: [{ role: "user", text: `把 token 值 ${syntheticKey} 用于敏感标记测试` }],
    summary: "expand 敏感标记测试",
  });
  check("T8a 敏感行落盘", jparse(sens).logged === 1, JSON.stringify(jparse(sens)).slice(0, 160));
  r = jparse(run("memory-cli.js", ["expand", "--session", "expandtest-sens"]));
  check("T8b 展开流带 sensitive:true（内容仍逐字）", r.stream?.[0]?.sensitive === true && String(r.stream?.[0]?.content).includes(syntheticKey), JSON.stringify(r.stream?.[0]));

  console.log(`\nexpand-test: ${pass} pass, ${fail} fail, sandbox=${SB}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("expand-test 异常:", e); process.exit(1); });
