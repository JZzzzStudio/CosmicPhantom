"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { instancePaths } = require("./paths.cjs");

const STATES = new Set(["installed", "configured", "enabled", "disabled", "uninstalled", "upgrade-pending", "failed"]);
const DEFAULT_CONFIG = {
  schemaVersion: 1,
  instanceId: null,
  scopeDefaults: { default: "workspace" },
  backfill: { enabled: false, mode: "none" },
  retrieval: { mode: "bm25", embedding: "optional" },
  adapters: [],
};

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}
function atomicJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}
function ensureInstance(instanceRoot) {
  const p = instancePaths(instanceRoot);
  ensureDir(p.meta);
  ensureDir(p.cursors);
  if (!fs.existsSync(p.config)) {
    const config = { ...DEFAULT_CONFIG, instanceId: crypto.randomUUID() };
    atomicJson(p.config, config);
  }
  if (!fs.existsSync(p.state)) {
    atomicJson(p.state, {
      schemaVersion: 1,
      pluginId: "cosmic-phantom",
      installedVersion: null,
      desiredState: "installed",
      effectiveState: "installed",
      lastTransition: null,
      lastHealth: null,
      migrationVersion: 0,
    });
  }
  return p;
}
function readConfig(instanceRoot) {
  const p = instancePaths(instanceRoot);
  return readJson(p.config, null);
}
function readState(instanceRoot) {
  const p = instancePaths(instanceRoot);
  return readJson(p.state, null);
}
function writeState(instanceRoot, patch, event = "state-update") {
  const p = ensureInstance(instanceRoot);
  const previous = readJson(p.state, {});
  const next = { ...previous, ...patch, lastTransition: new Date().toISOString() };
  if (!STATES.has(next.effectiveState)) throw new Error(`非法插件状态: ${next.effectiveState}`);
  atomicJson(p.state, next);
  ensureDir(path.dirname(p.lifecycle));
  fs.appendFileSync(p.lifecycle, JSON.stringify({ at: next.lastTransition, event, from: previous.effectiveState || null, to: next.effectiveState, desiredState: next.desiredState, version: next.installedVersion }) + "\n", "utf8");
  return next;
}
function writeConfig(instanceRoot, patch, pluginVersion = "3.1.0") {
  const p = ensureInstance(instanceRoot);
  const previous = readJson(p.config, {});
  const next = { ...DEFAULT_CONFIG, ...previous, ...patch, schemaVersion: 1 };
  if (!next.instanceId) next.instanceId = crypto.randomUUID();
  if (!next.scopeDefaults || !["global", "workspace", "agent"].includes(next.scopeDefaults.default)) throw new Error("scopeDefaults.default 必须是 global/workspace/agent");
  if (!next.backfill || !["none", "since", "all"].includes(next.backfill.mode)) throw new Error("backfill.mode 必须是 none/since/all");
  if (!next.retrieval || !["bm25", "hybrid"].includes(next.retrieval.mode)) throw new Error("retrieval.mode 必须是 bm25/hybrid");
  atomicJson(p.config, next);
  const state = readState(instanceRoot);
  if (state && ["installed", "uninstalled", "failed"].includes(state.effectiveState)) writeState(instanceRoot, { effectiveState: "configured", desiredState: "configured", installedVersion: pluginVersion }, "configure");
  return next;
}
module.exports = { DEFAULT_CONFIG, STATES, atomicJson, ensureInstance, readConfig, readState, writeConfig, writeState };
