"use strict";

const path = require("node:path");
const fs = require("node:fs");

function absolute(value, fallback) {
  return path.resolve(value || fallback);
}

function pluginRootFrom(start) {
  let candidate = path.resolve(start || __dirname);
  for (let i = 0; i < 4; i += 1) {
    if (fs.existsSync(path.join(candidate, "plugin.json"))) return candidate;
    candidate = path.dirname(candidate);
  }
  return path.resolve(__dirname, "..");
}

function instancePaths(instanceRoot) {
  const root = path.resolve(instanceRoot);
  return {
    root,
    meta: path.join(root, ".cp"),
    config: path.join(root, ".cp", "instance-config.json"),
    state: path.join(root, ".cp", "plugin-state.json"),
    lifecycle: path.join(root, ".cp", "lifecycle.jsonl"),
    cursors: path.join(root, ".cp", "cursors"),
    backups: path.join(root, ".cp", "backups"),
  };
}

module.exports = { absolute, instancePaths, pluginRootFrom };
