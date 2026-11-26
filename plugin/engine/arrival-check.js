#!/usr/bin/env node
/**
 * arrival-check.js - read-only new-machine arrival inspection.
 *
 * It checks the portable package, continuity capsule, optional Hermes home,
 * and watcher pause state. It never starts MCP/watcher, edits config, or opens
 * the production database for writing.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadCurrentState } from "./current-state.js";

const REQUIRED = [
  "package.json",
  "current-state.js",
  "reply-policy.json",
  "resume-context.js",
  "reply-check.js",
  "inject.js",
  "memory-cli.js",
  "memory-retrieval.js",
  "sources.example.json",
  "core/rules.md",
  "core/reply-style.md",
  "candidates.js",
  "resources/mcp-server/index.js",
  "scripts/packaging/install-bundle.cjs",
  "scripts/packaging/install-check.js",
  "eval/external/manifest-check.cjs",
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function output(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
function check(name, ok, detail, severity = ok ? "pass" : "fail") { return { name, ok, severity, detail }; }
function fileText(root, relative) {
  try { return readFileSync(join(root, relative), "utf8"); } catch { return ""; }
}

export function inspectArrival(root, hermesHome) {
  const checks = [];
  const missing = REQUIRED.filter(relative => !existsSync(join(root, relative)));
  checks.push(check("required-assets", missing.length === 0, missing.length ? missing : "all required assets present"));
  const packageText = fileText(root, "package.json");
  let packageJson = null;
  try { packageJson = JSON.parse(packageText); } catch {}
  checks.push(check("esm-package", packageJson?.type === "module", packageJson?.type || "package.json parse failed"));
  const portableNode = join(root, "tools", "node", process.platform === "win32" ? "node.exe" : "node");
  checks.push(check("portable-node", existsSync(portableNode), existsSync(portableNode) ? portableNode : "未安装便携 Node；可使用系统 Node，bootstrap.cjs 可补装", "warning"));
  const state = loadCurrentState(root);
  checks.push(check("current-state", !state.invalid && state.revision > 0, state.invalid || `revision=${state.revision}`, state.invalid || state.revision <= 0 ? "warning" : "pass"));
  const resume = fileText(root, "resume-manifest.json");
  let resumeJson = null;
  try { resumeJson = JSON.parse(resume); } catch {}
  checks.push(check("resume-manifest", resumeJson?.status === "fresh", resumeJson?.status || "missing or invalid", resumeJson?.status === "fresh" ? "pass" : "warning"));
  const dbRef = fileText(root, "state-db-path.txt").replace(/^\uFEFF/, "").trim();
  // Hermes 已废弃（用户决策 2026-08-12）：state-db-path.txt 为废弃标记或指向不存在路径 → warning 而非 fail
  const hermesDeprecated = !dbRef || /废弃|deprecated/i.test(dbRef);
  checks.push(check("state-db-path", hermesDeprecated || (isAbsolute(dbRef) && existsSync(dbRef)), dbRef || "not configured (Hermes retired)", hermesDeprecated ? "warning" : "fail"));
  const paused = existsSync(join(root, ".watch-paused"));
  checks.push(check("watcher-pause", !paused, paused ? ".watch-paused present; automatic watcher launch is intentionally paused" : "automatic launch not paused", paused ? "warning" : "pass"));
  // 项目根校验（ADR-001 层2，2026-08-12）：目录存在 + 身份证 rootId 与真源登记一致 + version 文件存在
  try {
    const regText = fileText(root, "project-root.json");
    const reg = JSON.parse(regText);
    const pr = reg.projectRoot;
    const idFile = join(pr, ".project-root.json");
    const verFile = join(pr, ".version");
    if (!pr || !existsSync(pr)) {
      checks.push(check("project-root", false, `目录不存在: ${pr || "(未配置)"}`));
    } else {
      const idOk = existsSync(idFile);
      let idMatch = false;
      if (idOk) {
        try { idMatch = JSON.parse(fileText(pr, ".project-root.json")).rootId === reg.rootId; } catch {}
      }
      checks.push(check("project-root-identity", idOk && idMatch, idOk ? (idMatch ? `rootId 一致 (${reg.rootId.slice(0, 8)}…)` : `rootId 不一致！真源=${reg.rootId.slice(0, 8)}… 目录=${idOk ? "未知" : "无身份证"}`) : "目录无身份证文件（可能漏拷 .project-root.json）"));
      checks.push(check("project-root-version", existsSync(verFile), existsSync(verFile) ? "version 文件存在" : "version 文件缺失（跑 maintain 生成）", existsSync(verFile) ? "pass" : "warning"));
    }
  } catch (e) {
    checks.push(check("project-root", false, `project-root.json 解析失败: ${e.message}`, "warning"));
  }
  // 吸收源校验（ADR-001 层1）：sources.json 中 enabled jsonl 源目录必须存在，缺失显式暴露
  try {
    const srcText = fileText(root, "sources.json");
    const reg = JSON.parse(srcText);
    const srcs = Array.isArray(reg.sources) ? reg.sources : [];
    for (const s of srcs) {
      if (s.enabled !== false && s.kind === "jsonl" && s.dir) {
        checks.push(check(`source:${s.name}`, existsSync(s.dir), s.dir, existsSync(s.dir) ? "pass" : "fail"));
      }
    }
  } catch { checks.push(check("sources.json", false, "未配置实例 sources.json；仅检查代码仓模板", "warning")); }
  if (hermesHome) {
    const user = join(hermesHome, "memories", "USER.md");
    const config = join(hermesHome, "config.yaml");
    const userText = fileText(hermesHome, "memories/USER.md");
    const configText = fileText(hermesHome, "config.yaml");
    checks.push(check("hermes-user", existsSync(user) && /cosmic-phantom|回复|规则/.test(userText), user));
    checks.push(check("hermes-mcp-registration", existsSync(config) && /mcp-server[\\/]index\.js/.test(configText), config));
  } else {
    checks.push(check("hermes-home", false, "not checked; pass --hermes-home <path>", "warning"));
  }
  const failures = checks.filter(item => !item.ok && item.severity === "fail");
  return { ok: failures.length === 0, root: resolve(root), hermesHome: hermesHome || null, checks };
}

function main() {
  const root = arg("--root") || join(homedir(), ".cosmic-phantom");
  const result = inspectArrival(root, arg("--hermes-home"));
  output(result);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) main();
