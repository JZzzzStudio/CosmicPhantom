"use strict";

const path = require("node:path");
const { writeConfig, ensureInstance, readConfig } = require("./state.cjs");

const ADAPTERS = new Set(["manual", "jsonl", "transcript"]);
function parseAdapters(value, options = {}) {
  if (value == null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  const ids = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
  const unknown = ids.filter((id) => !ADAPTERS.has(id));
  if (unknown.length) throw new Error(`未知适配器: ${unknown.join(", ")}`);
  if (ids.includes("manual") && options.source) throw new Error("manual 适配器不接受 file 来源，请使用 ingest 或手动输入");
  if (ids.some((id) => id !== "manual") && !options.source) throw new Error("jsonl/transcript 适配器必须配置 source 文件");
  if (options.source && !path.isAbsolute(String(options.source))) throw new Error("source 必须是绝对路径");
  return ids.map((id) => ({
    id,
    enabled: true,
    config: options.source ? { file: String(options.source), sourceInstance: options.sourceInstance || id, scope: options.scope || "workspace" } : {},
  }));
}
function buildConfigInput(options) {
  const scope = options.scope || "workspace";
  const backfill = options.backfill || "none";
  const retrieval = options.retrieval || "bm25";
  if (!["global", "workspace", "agent"].includes(scope)) throw new Error("scope 必须是 global/workspace/agent");
  if (!["none", "since", "all"].includes(backfill)) throw new Error("backfill 必须是 none/since/all");
  if (backfill === "since" && !options.since) throw new Error("backfill=since 必须同时提供 --since YYYY-MM-DD");
  if (!["bm25", "hybrid"].includes(retrieval)) throw new Error("retrieval 必须是 bm25/hybrid");
  return {
    scopeDefaults: { default: scope },
    backfill: { enabled: backfill !== "none", mode: backfill, since: options.since || null },
    retrieval: { mode: retrieval, embedding: retrieval === "hybrid" ? "optional" : "disabled" },
    adapters: parseAdapters(options.adapter || "manual", options),
  };
}
function configureInstance(instanceRoot, options = {}) {
  ensureInstance(instanceRoot);
  const patch = buildConfigInput(options);
  return writeConfig(instanceRoot, patch, options.pluginVersion || "3.1.0");
}
module.exports = { ADAPTERS, buildConfigInput, configureInstance, parseAdapters, readConfig };
