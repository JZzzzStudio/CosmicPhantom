#!/usr/bin/env node
/**
 * reply-check.js - local reply policy checker.
 *
 * This is a preflight report, not a host send gate. It never starts background
 * processes and never changes memory data. Connect it to the host send出口 for
 * hard rejection; otherwise treat the result as an explicit warning.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadCurrentState } from "./current-state.js";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const POLICY = join(ROOT, "reply-policy.json");
const BANNED_OPENINGS = ["你说得对", "有道理", "确实", "没错", "言之有理"];
const ENGLISH_ONLY = /(^|[。！？\n])\s*[A-Za-z][A-Za-z\s,:;.!?/-]{20,}(?=$|[。！？\n])/;
const TECHNICAL = /(代码|脚本|配置|测试|迁移|部署|接口|数据库|MCP|Node|PowerShell|schema|bug|修复)/i;
const CORRECTION = /(不对|不是|错了|你搞错|有问题|不符合|弹窗|忘了|没有)/;

function get(key) { const i = process.argv.indexOf(key); return i >= 0 ? process.argv[i + 1] : undefined; }
function out(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
function policy() {
  try { return JSON.parse(readFileSync(POLICY, "utf8")); }
  catch { return { forbidden: BANNED_OPENINGS }; }
}
function checkReply(text, options = {}) {
  const p = policy();
  const violations = [];
  const forbidden = Array.isArray(p.forbidden) ? p.forbidden : BANNED_OPENINGS;
  for (const word of forbidden) if (text.includes(word)) violations.push({ code: "FORBIDDEN_AGREEMENT", detail: word });
  const first = text.trim().split(/\r?\n/)[0] || "";
  if (!first) violations.push({ code: "EMPTY_REPLY", detail: "回复为空" });
  if (BANNED_OPENINGS.some(word => first.startsWith(word))) violations.push({ code: "BAD_OPENING", detail: "开头使用空泛附和" });
  const correctedDirectly = /(错|问题|不符合|遗漏|根因)/.test(first) && /(修|改|调整|删除|增加|改为|处理方式)/.test(first);
  if (options.corrected && !correctedDirectly) violations.push({ code: "CORRECTION_NOT_DIRECT", detail: "被纠正时第一句没有同时说明错误点和修法" });
  if (ENGLISH_ONLY.test(text) && !/[\u4e00-\u9fff]/.test(text)) violations.push({ code: "UNTRANSLATED_ENGLISH", detail: "回复主体没有中文解释" });
  if (options.technical && TECHNICAL.test(text) && !/📌|✅|⚠️|🔧|🎯|📋|##/.test(text)) violations.push({ code: "MISSING_STRUCTURE", detail: "技术回复缺少语义区块锚点" });
  return { ok: violations.length === 0, violations, stateRevision: loadCurrentState(ROOT).revision };
}

function main() {
  const file = get("--file");
  const text = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  out(checkReply(text, { corrected: process.argv.includes("--corrected"), technical: process.argv.includes("--technical") }));
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) main();
export { checkReply };
