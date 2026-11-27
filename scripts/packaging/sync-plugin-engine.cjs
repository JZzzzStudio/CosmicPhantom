#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const target = path.join(root, "plugin", "engine");
const files = [
  "arrival-check.js", "candidate-distill.js", "candidate-review.js", "candidates.js", "current-state.js", "dates.js", "decision-cards.js",
  "dream.js", "embed-tokenizer.js", "embed.js", "events.js", "graph-edges.js", "graph-refine.js",
  "identity-card.js", "inject-config.js", "inject.js", "legacy-memory-compat.js", "link-graph.js", "log_turn.js", "memory-cli.js",
  "memory-domains.js", "memory-retrieval.js", "privacy-probe.js", "reply-check.js", "resume-context.js", "session-adapter.js",
  "skills-sync.js", "tag-normalize.js", "topic-tree.js", "validate.js",
];
const dirs = ["lib/binary-vec.js", "lib/failopen.js", "lib/memory-feedback.js", "lib/sync-check.js", "lib/verify-absorbed.js", "resources/mcp-server/index.js"];
for (const relative of [...files, ...dirs]) {
  const source = path.join(root, relative);
  const destination = path.join(target, relative);
  if (!fs.existsSync(source)) throw new Error(`引擎快照源文件缺失: ${relative}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "cosmic-phantom-engine", private: true, type: "module", version: require(path.join(root, "package.json")).version }, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ ok: true, target, files: files.length + dirs.length }));
