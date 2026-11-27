#!/usr/bin/env node
"use strict";
// 引擎一致性守卫（2026-11-27 挑刺审计根因）：
//   去品牌曾只改根级、plugin/engine 未同步而静默漏网；本守卫让该类漏网必红。
//   (a) 根↔plugin 引擎逐文件哈希一致（与 sync-plugin-engine.cjs 同清单）
//   (b) 公开树不得有宿主品牌命名文件（宿主集成属私有档案）
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const errors = [];
const files = [
  "arrival-check.js", "candidate-distill.js", "candidate-review.js", "candidates.js", "current-state.js", "dates.js", "decision-cards.js",
  "dream.js", "embed-tokenizer.js", "embed.js", "events.js", "graph-edges.js", "graph-refine.js",
  "identity-card.js", "inject-config.js", "inject.js", "legacy-memory-compat.js", "link-graph.js", "log_turn.js", "memory-cli.js",
  "memory-domains.js", "memory-retrieval.js", "privacy-probe.js", "reply-check.js", "resume-context.js", "session-adapter.js",
  "skills-sync.js", "tag-normalize.js", "topic-tree.js", "validate.js",
  "lib/binary-vec.js", "lib/failopen.js", "lib/sync-check.js", "lib/verify-absorbed.js", "resources/mcp-server/index.js",
];
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
for (const rel of files) {
  const plug = path.join(ROOT, "plugin", "engine", rel);
  if (!fs.existsSync(plug)) { errors.push("plugin 引擎缺文件: " + rel); continue; }
  if (hash(path.join(ROOT, rel)) !== hash(plug)) errors.push("根↔plugin 引擎不同步: " + rel);
}
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const brandFile = /(^|\/)(proma|zcode|claude|workbuddy|codebuddy|hermes|wb-|host-extensions)/i;
for (const file of tracked) if (brandFile.test(file)) errors.push("宿主品牌命名文件: " + file);
const result = { ok: errors.length === 0, engineFiles: files.length, tracked: tracked.length, errors };
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exitCode = result.ok ? 0 : 1;
