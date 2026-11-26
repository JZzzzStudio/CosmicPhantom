#!/usr/bin/env node
/**
 * compaction-inject.cjs — 压缩后自动注入恢复胶囊（2026-08-12 实装）
 *
 * ZCode SessionStart(compact) hook 输出端：压缩发生后会话以 compact 模式重启，
 * 本脚本把恢复胶囊（resume-context render）包成 hook 标准输出
 * `{"additionalContext": "..."}` → ZCode 自动注入会话上下文。
 * 压缩恢复从"自觉触发 skill"升级为"自动注入"，不靠 Agent 自觉。
 *
 * 安全/纪律：
 * - 只读（resume-context render 不写任何数据），fail-open（hook 失败只记录，不阻塞会话）
 * - 严格 schema：只输出 additionalContext 一个键（ZCode hook JSON 校验，多余键失败）
 * - 输出大小受限：maxOutputBytes 由 hook 配置控制（config.json 实测 8192，非默认 60000——
 *   2026-08-17 修正注释），此处恢复胶囊 ~3.3KB 安全；输出前自检接近上限即嵌警告
 */
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

const rootArgIndex = process.argv.indexOf("--root");
const ROOT = (rootArgIndex >= 0 && process.argv[rootArgIndex + 1]) || join(homedir(), ".cosmic-phantom");
const NODE = join(ROOT, "tools", "node", "node.exe");

function main() {
  // 恢复胶囊（门禁 + 接力状态 + 最近工作），3200B 预算
  const r = spawnSync(NODE, [join(ROOT, "resume-context.js"), "render", "--root", ROOT], { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0 || !r.stdout) {
    // fail-open：输出空 additionalContext（空输出合法，会话正常继续）
    process.stdout.write(JSON.stringify({ additionalContext: "【压缩恢复注入失败】" + String(r.stderr || "").slice(0, 200) }) + "\n");
    return;
  }
  // 输出上限自检（2026-08-17）：config.json hooks.maxOutputBytes 实测 8192；>90% 时胶囊内嵌警告
  let cap = 8192;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".zcode", "cli", "config.json"), "utf8"));
    const v = cfg && cfg.hooks && cfg.hooks.maxOutputBytes;
    if (Number.isFinite(v) && v > 0) cap = v;
  } catch {}
  const text = r.stdout.trim();
  const len = Buffer.byteLength(text);
  const body = len > cap * 0.9
    ? `⚠️ 恢复胶囊接近 hook 输出上限（${len}/${cap}B），平台可能截断恢复信息；考虑精简 current-state.summary\n\n${text}`
    : text;
  process.stdout.write(JSON.stringify({ additionalContext: body }) + "\n");
}

main();
