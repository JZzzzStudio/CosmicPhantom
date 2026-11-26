#!/usr/bin/env node
/**
 * work-test.js — work.cjs 七用例（隔离临时根，不碰生产）
 *
 * 覆盖：new 模板 / 未填拒检 / 完整通过 / 悬空 blocked_by / 环 / frontier / close 归档
 */
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const ROOT = join(__dirname, "..");
const WORK = join(ROOT, "work.cjs");
const TMP = mkdtempSync(join(tmpdir(), "cp-work-test-"));
let passed = 0;
const failures = [];

function run(args) {
  const r = spawnSync(process.execPath, [WORK, ...args, "--root", TMP], { encoding: "utf8", timeout: 30000 });
  let json = null;
  try { json = JSON.parse((r.stdout || "").trim()); } catch {}
  return { status: r.status, json, stdout: r.stdout || "", stderr: r.stderr || "" };
}
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`✅ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function specText(slug, title) {
  return `---
slug: ${slug}
title: ${title}
created: 2026-10-28T14:00:00+08:00
status: draft
source: 测试
---
## 问题

测试问题描述，用户视角。

## 方案

测试方案描述，用户视角。

## 用户故事

1. 作为测试者，我想要验证 work 工具，以便确认四段闭环可运行。

## 实现决策

- 使用本地文件与 JSON 输出。

## 测试决策

- 只测 work.cjs 的公共命令行为。
- 缝：spawn 命令 + 读 JSON。

## 范围外

- 不接真实 issue tracker。

## 来源证据

- 会话：test
`;
}
function ticketText(id, title, status, blockedBy, evidence) {
  return `---
id: "${id}"
title: ${title}
status: ${status}
blocked_by: [${blockedBy.join(", ")}]
seams: []
created: 2026-10-28T14:00:00+08:00
---
# ${id}: ${title}

## 要交付什么

端到端行为：${title} 可验证。

## 验收标准

- [ ] 命令返回 ok

## 证据

${evidence || ""}
`;
}

try {
  // 准备临时根：模板 + pro/
  mkdirSync(join(TMP, "templates"), { recursive: true });
  cpSync(join(ROOT, "templates", "spec.md"), join(TMP, "templates", "spec.md"));
  cpSync(join(ROOT, "templates", "ticket.md"), join(TMP, "templates", "ticket.md"));
  mkdirSync(join(TMP, "pro"), { recursive: true });

  // T1 new
  let r = run(["new", "demo", "--title", "演示工作项"]);
  check("T1 new 生成 spec", r.status === 0 && r.json?.ok === true && existsSync(join(TMP, "work", "demo", "spec.md")));
  const created = readFileSync(join(TMP, "work", "demo", "spec.md"), "utf8");
  check("T1 模板字段", created.includes("slug: demo") && created.includes("status: draft") && created.includes("## 问题"), created.slice(0, 80));

  // T2 未填拒检
  r = run(["check", "demo"]);
  check("T2 未填拒绝", r.status === 1 && (r.json?.problems || []).some(p => p.includes("模板占位")), JSON.stringify(r.json?.problems));

  // T3 完整通过
  writeFileSync(join(TMP, "work", "demo", "spec.md"), specText("demo", "演示工作项"), "utf8");
  mkdirSync(join(TMP, "work", "demo", "tickets"), { recursive: true });
  writeFileSync(join(TMP, "work", "demo", "tickets", "00-base.md"), ticketText("00", "基础", "ready", []), "utf8");
  r = run(["check", "demo"]);
  check("T3 完整通过", r.status === 0 && r.json?.ok === true, JSON.stringify(r.json?.problems));

  // T4 悬空 blocked_by
  writeFileSync(join(TMP, "work", "demo", "tickets", "01-dangling.md"), ticketText("01", "悬空", "ready", ["99"]), "utf8");
  r = run(["check", "demo"]);
  check("T4 悬空 blocked_by", r.status === 1 && (r.json?.problems || []).some(p => p.includes("不存在")), JSON.stringify(r.json?.problems));
  rmSync(join(TMP, "work", "demo", "tickets", "01-dangling.md"));

  // T5 环
  writeFileSync(join(TMP, "work", "demo", "tickets", "01-a.md"), ticketText("01", "A", "ready", ["02"]), "utf8");
  writeFileSync(join(TMP, "work", "demo", "tickets", "02-b.md"), ticketText("02", "B", "ready", ["01"]), "utf8");
  r = run(["check", "demo"]);
  check("T5 环检测", r.status === 1 && (r.json?.problems || []).some(p => p.includes("有环")), JSON.stringify(r.json?.problems));
  rmSync(join(TMP, "work", "demo", "tickets", "01-a.md"));
  rmSync(join(TMP, "work", "demo", "tickets", "02-b.md"));

  // T5b ticket 命令建票：保留 00 依赖（防 normalize 把合法 00 当空值过滤）
  r = run(["ticket", "demo", "命令建票", "--blocked-by", "00"]);
  const madeFile = r.json?.file;
  check("T5b ticket 保留 00 依赖", r.status === 0 && madeFile && readFileSync(madeFile, "utf8").includes("blocked_by: [00]"), JSON.stringify(r.json));
  if (madeFile) rmSync(madeFile);

  // T6 frontier
  writeFileSync(join(TMP, "work", "demo", "tickets", "00-base.md"), ticketText("00", "基础", "done", [], "命令：node work.cjs check demo → ok"), "utf8");
  writeFileSync(join(TMP, "work", "demo", "tickets", "01-next.md"), ticketText("01", "下一步", "ready", ["00"]), "utf8");
  writeFileSync(join(TMP, "work", "demo", "tickets", "02-last.md"), ticketText("02", "最后", "ready", ["01"]), "utf8");
  r = run(["frontier", "demo"]);
  check("T6 frontier 只出 01", r.status === 0 && r.json?.frontier?.length === 1 && r.json.frontier[0].id === "01", JSON.stringify(r.json?.frontier));

  // T6b todo 投影（前沿第一张票 + 幂等）
  r = run(["todo", "demo"]);
  const todoFile = join(TMP, ".flags", "work-todo-demo.json");
  check("T6b todo 投影 01", r.status === 0 && r.json?.ticket?.id === "01" && existsSync(todoFile), JSON.stringify(r.json));
  r = run(["todo", "demo"]);
  check("T6c todo 幂等", r.status === 0 && r.json?.alreadyProjected === true, JSON.stringify(r.json));

  // T7 close：未完成拒绝 → 弱证据拒绝 → 完整证据归档
  r = run(["close", "demo"]);
  check("T7 未完成拒绝结案", r.status === 1 && String(r.json?.error || "").includes("未完成"), JSON.stringify(r.json));
  writeFileSync(join(TMP, "work", "demo", "tickets", "01-next.md"), ticketText("01", "下一步", "done", ["00"], "已实现"), "utf8");
  writeFileSync(join(TMP, "work", "demo", "tickets", "02-last.md"), ticketText("02", "最后", "done", ["01"], "测试通过"), "utf8");
  r = run(["close", "demo"]);
  check("T7b 弱证据拒绝", r.status === 1 && String(r.json?.error || "").includes("证据"), JSON.stringify(r.json));
  writeFileSync(join(TMP, "work", "demo", "tickets", "01-next.md"), ticketText("01", "下一步", "done", ["00"], "命令：node work.cjs frontier demo → ok"), "utf8");
  writeFileSync(join(TMP, "work", "demo", "tickets", "02-last.md"), ticketText("02", "最后", "done", ["01"], "命令：node work.cjs close demo → ok"), "utf8");
  r = run(["close", "demo"]);
  const archives = existsSync(join(TMP, "pro")) ? readdirSync(join(TMP, "pro")).filter(f => f.startsWith("work-demo-")) : [];
  check("T7 归档 + 移目录", r.status === 0 && r.json?.ok === true && archives.length === 1 && !existsSync(join(TMP, "work", "demo")) && existsSync(join(TMP, "work", ".closed")), JSON.stringify(r.json));

  console.log(`\n${failures.length ? "❌" : "✅"} work-test: ${passed} passed / ${failures.length} failed`);
  if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
} catch (e) {
  console.error(`❌ work-test 异常：${e.stack || e.message}`);
  process.exit(1);
} finally {
  try { if (!process.env.CP_KEEP_TEST_TMP) rmSync(TMP, { recursive: true, force: true }); } catch {}
}
