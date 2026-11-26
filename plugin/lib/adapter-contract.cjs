"use strict";

const crypto = require("node:crypto");

const ROLES = new Set(["user", "assistant", "tool", "system"]);
const SCOPES = new Set(["global", "workspace", "agent"]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function scalarText(value, field, { required = true } = {}) {
  if (value == null || value === "") {
    if (required) fail(`MISSING_${field.toUpperCase()}`, `缺少 ${field}`);
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") fail("INVALID_" + field.toUpperCase(), `${field} 必须是字符串或数字`);
  const text = String(value).trim();
  if (!text && required) fail(`MISSING_${field.toUpperCase()}`, `缺少 ${field}`);
  return text || null;
}
function normalizeEvent(input) {
  if (!input || typeof input !== "object") fail("INVALID_EVENT", "事件必须是对象");
  const sourceInstance = scalarText(input.source_instance, "source_instance");
  const sourceId = scalarText(input.source_id, "source_id");
  const revision = Number(input.revision);
  const role = scalarText(input.role, "role");
  let content = null;
  if (input.content != null) {
    if (typeof input.content !== "string") fail("INVALID_CONTENT", "content 必须是字符串或 null");
    content = input.content;
  }
  const ts = new Date(input.ts);
  if (!sourceInstance) fail("MISSING_SOURCE_INSTANCE", "缺少 source_instance");
  if (!sourceId) fail("MISSING_SOURCE_ID", "缺少 source_id");
  if (!Number.isInteger(revision) || revision < 1) fail("INVALID_REVISION", "revision 必须是正整数");
  if (!ROLES.has(role)) fail("INVALID_ROLE", `role 非法: ${role}`);
  if (typeof input.ts !== "string" || !input.ts.trim() || Number.isNaN(ts.getTime())) fail("INVALID_TIMESTAMP", "ts 必须是显式有效时间");
  const scope = input.scope == null ? "workspace" : scalarText(input.scope, "scope");
  if (!SCOPES.has(scope)) fail("INVALID_SCOPE", `scope 非法: ${scope}`);
  const sessionId = scalarText(input.session_id, "session_id");
  const sourceKind = scalarText(input.source_kind, "source_kind");
  const sourceRef = scalarText(input.source_ref, "source_ref");
  return {
    source_instance: sourceInstance,
    source_id: sourceId,
    revision,
    session_id: sessionId,
    role,
    content,
    ts: ts.toISOString(),
    scope,
    source_kind: sourceKind,
    source_ref: sourceRef,
    tool_name: input.tool_name == null ? null : String(input.tool_name),
    tool_calls: input.tool_calls == null ? null : typeof input.tool_calls === "string" ? input.tool_calls : JSON.stringify(input.tool_calls),
    cursor: input.cursor == null ? null : input.cursor,
  };
}
function eventIdentity(event) {
  const e = normalizeEvent(event);
  return `${e.source_instance}\0${e.source_id}\0${e.revision}`;
}
function eventDigest(event) {
  return crypto.createHash("sha256").update(eventIdentity(event) + "\0" + String(event.content || "")).digest("hex");
}
function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") fail("INVALID_ADAPTER", "适配器必须是对象");
  for (const name of ["id", "version", "describe", "validate", "scan", "normalize", "health"]) {
    if (typeof adapter[name] !== "function" && !(name === "id" || name === "version")) fail("INVALID_ADAPTER", `适配器缺少 ${name}`);
  }
  return true;
}
module.exports = { ROLES, SCOPES, eventDigest, eventIdentity, fail, normalizeEvent, validateAdapter };
