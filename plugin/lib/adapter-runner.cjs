"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeEvent, validateAdapter } = require("./adapter-contract.cjs");

function readJsonl(file) {
  const lines = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let value;
    try { value = JSON.parse(lines[index]); }
    catch (error) { const e = new Error(`JSONL 第 ${index + 1} 行无效: ${error.message}`); e.code = "INVALID_JSONL"; throw e; }
    records.push({ value, line: index + 1 });
  }
  return records;
}

function transcriptText(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts = raw.map((block) => transcriptText(block)).filter((part) => part != null);
    return parts.length ? parts.join("") : null;
  }
  if (raw && typeof raw === "object") {
    if (raw.message) return transcriptText(raw.message.content);
    if (raw.text != null) return transcriptText(raw.text);
    if (raw.thinking != null) return transcriptText(raw.thinking);
    if (raw.content != null) return transcriptText(raw.content);
  }
  return null;
}

function roleFor(raw, kind, line) {
  const explicit = raw.role || raw.message?.role;
  const type = raw.type;
  const wrapper = type === "message" && explicit;
  if (type && !wrapper && !["user", "assistant", "tool", "system"].includes(type)) {
    const error = new Error(`JSONL 第 ${line || 0} 行 type 不支持: ${type}`);
    error.code = "UNSUPPORTED_TYPE";
    throw error;
  }
  if (explicit) return explicit;
  if (type) return type;
  const error = new Error(`JSONL 第 ${line || 0} 行缺少 role/type`);
  error.code = "MISSING_ROLE";
  throw error;
}

function createJsonlAdapter(kind = "jsonl") {
  const adapter = {
    id: kind,
    version: "1.0.0",
    describe() { return { id: kind, version: this.version, input: "JSONL", output: "normalized-events" }; },
    validate(config = {}) {
      if (!config.file || !path.isAbsolute(config.file)) throw new Error("适配器 file 必须是绝对路径");
      if (!config.sourceInstance) throw new Error("适配器必须配置 sourceInstance");
      return true;
    },
    scan({ config }) {
      this.validate(config);
      return readJsonl(config.file);
    },
    normalize(record, config = {}) {
      const raw = record.value || record;
      const sourceId = raw.source_id ?? raw.sourceId ?? raw.id ?? raw.message?.id;
      if (sourceId == null || (typeof sourceId !== "string" && typeof sourceId !== "number") || !String(sourceId).trim()) { const error = new Error(`JSONL 第 ${record.line || 0} 行 source_id 必须是非空字符串或数字`); error.code = "INVALID_SOURCE_ID"; throw error; }
      const revision = raw.revision == null ? 1 : raw.revision;
      const timestamp = raw.ts || raw.created_at || raw.createdAt || raw._createdAt || raw.message?.ts || raw.message?.created_at || raw.message?.createdAt;
      if (!timestamp) { const error = new Error(`JSONL 第 ${record.line || 0} 行缺少稳定 ts`); error.code = "MISSING_TIMESTAMP"; throw error; }
      const role = roleFor(raw, kind, record.line);
      const rawContent = raw.content == null ? (raw.text == null ? transcriptText(raw) : raw.text) : raw.content;
      const content = transcriptText(rawContent);
      if (content == null && role !== "tool") {
        const error = new Error(`JSONL 第 ${record.line || 0} 行缺少可保存的文本 content`);
        error.code = "INVALID_CONTENT";
        throw error;
      }
      return normalizeEvent({
        source_instance: raw.source_instance ?? raw.sourceInstance ?? config.sourceInstance,
        source_id: sourceId,
        revision,
        session_id: raw.session_id || raw.sessionId || raw.message?.session_id || raw.message?.sessionId || config.sourceInstance,
        role,
        content,
        ts: timestamp,
        scope: raw.scope || config.scope || "workspace",
        source_kind: raw.source_kind || kind,
        source_ref: raw.source_ref || `${config.sourceInstance}#L${record.line || 0}`,
        tool_name: raw.tool_name || raw.toolName,
        tool_calls: raw.tool_calls || raw.toolCalls,
        cursor: { kind: "line", value: record.line || null },
      });
    },
    health(config = {}) {
      try { this.validate(config); return { ok: fs.existsSync(config.file), file: config.file }; }
      catch (error) { return { ok: false, code: error.code || "INVALID_CONFIG", message: error.message }; }
    },
  };
  validateAdapter(adapter);
  return adapter;
}

function scanNormalized(file, options = {}) {
  const adapter = createJsonlAdapter(options.kind || "jsonl");
  const config = { file: path.resolve(file), sourceInstance: options.sourceInstance || "source", scope: options.scope || "workspace" };
  return adapter.scan({ config }).map((record) => adapter.normalize(record, config));
}

module.exports = { createJsonlAdapter, readJsonl, scanNormalized };
