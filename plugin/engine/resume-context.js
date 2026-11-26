#!/usr/bin/env node
/**
 * resume-context.js - low-token local recovery capsule.
 *
 * Reads the compact reply policy and current-state owner, checks source hashes,
 * and renders one bounded block for a new session or post-compression recovery.
 * It never starts a watcher or writes events/daily data.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCurrentState, renderCurrentState } from "./current-state.js";

const POLICY_FILE = "reply-policy.json";
const MANIFEST_FILE = "resume-manifest.json";
// 2026-09-16 补入 .context/CONTEXT.md 与 MEMORY.md：两者是"领域共享语言/画像"的注入真源，
//   原清单只含规则三件套 → 改了这两个文件 source-status 照样报 fresh（胶囊失警）。
const SOURCE_FILES = ["core/rules.md", "core/reply-style.md", POLICY_FILE, ".context/CONTEXT.md", "MEMORY.md"];
const DEFAULT_BYTES = 4000;   // 兜底值；2026-09-01 起真实口径统一读 inject.config.json recoveryBytes（消除双口径：原此处 4000 vs inject 链 4500）

// 胶囊预算唯一真源 = inject.config.json recoveryBytes（与 inject.js 同源，单实现原则）
function configRecoveryBytes(root) {
  try {
    const cfg = JSON.parse(readFileSync(join(root, "inject.config.json"), "utf8"));
    if (Number.isFinite(cfg.recoveryBytes) && cfg.recoveryBytes > 0) return cfg.recoveryBytes;
  } catch { /* config 缺失走兜底 */ }
  return DEFAULT_BYTES;
}

function rootFromArgs() {
  const i = process.argv.indexOf("--root");
  return i >= 0 ? process.argv[i + 1] : join(homedir(), ".cosmic-phantom");
}
function sourcePath(root, relative) { return join(root, relative); }
function sha256(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function readJson(file) { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
function xml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}
function output(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }

function loadPolicy(root) {
  const file = sourcePath(root, POLICY_FILE);
  if (!existsSync(file)) return { error: `缺少 ${POLICY_FILE}` };
  try {
    const policy = readJson(file);
    if (policy.schemaVersion !== 1 || !Array.isArray(policy.rules) || !Array.isArray(policy.forbidden)) {
      return { error: `${POLICY_FILE} schema 不合格` };
    }
    return policy;
  } catch (error) { return { error: `${POLICY_FILE} 无法解析：${error.message}` }; }
}

export function inspectManifest(root) {
  const file = sourcePath(root, MANIFEST_FILE);
  const expected = {};
  const missing = [];
  for (const relative of SOURCE_FILES) {
    const absolute = sourcePath(root, relative);
    if (!existsSync(absolute)) missing.push(relative);
    else expected[relative] = sha256(absolute);
  }
  if (!existsSync(file)) return { status: "missing", missing, expected };
  try {
    const manifest = readJson(file);
    const recorded = manifest.sources || {};
    const changed = Object.keys(expected).filter(relative => recorded[relative] !== expected[relative]);
    const recordedMissing = SOURCE_FILES.filter(relative => !recorded[relative]);
    return { status: missing.length || changed.length || recordedMissing.length ? "stale" : "fresh", missing, changed, recordedMissing, expected, manifest };
  } catch (error) { return { status: "invalid", error: error.message, expected }; }
}

// ---------- T01 四项指纹（2026-11-18）----------
// 目的：换机交接时能逐项比对，而不是「看起来接上了」。四项：卡内容 / 事件条数+摘要 / 接力版本 / 两仓提交。
// 纪律：任一项算不出 = BLOCKED，并指名缺什么；绝不返回「看起来正常」的胶囊。
// 2026-11-19 修 A3：原 digest 只哈希 id 列表，改一张卡的内容、id 不变 → digest 不变（换机比对假绿）。
//   现在对 memories/*.md 的文件名 + 原始字节做有序哈希，卡内容/文件集合任何变动都会变 diges。
function memoriesDigest(root) {
  const dir = join(root, "memories");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) return null;
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\u0000");
    h.update(readFileSync(join(dir, f)));
    h.update("\u0000");
  }
  return h.digest("hex").slice(0, 16);
}
function scanCardIds(root) {
  const dir = join(root, "memories");
  if (!existsSync(dir)) return null;
  const ids = [];
  for (const f of (readdirSync(dir) || [])) {
    if (!f.endsWith(".md")) continue;
    const text = readFileSync(join(dir, f), "utf8");
    for (const line of text.split(String.fromCharCode(10))) {
      const m = line.match(/^id:\s*(\S+)\s*$/);
      if (m) ids.push(m[1]);
    }
  }
  return ids.sort();
}
function eventsCount(root) {
  const db = join(root, "events.db");
  if (!existsSync(db)) return { count: null, reason: "events.db 不存在" };
  try {
    const code = "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(process.argv[1]);const r=d.prepare(\"select count(*) c from events\").get();process.stdout.write(String(r.c));";
    const out = spawnSync(process.execPath, ["--experimental-sqlite", "-e", code, db], { encoding: "utf8", timeout: 20000 });
    const n = Number((out.stdout || "").trim());
    if (out.status === 0 && Number.isFinite(n)) return { count: n };
    return { count: null, reason: "events 读取失败" + (out.stderr ? "：" + String(out.stderr).split(String.fromCharCode(10))[0].slice(0, 60) : "") };
  } catch (e) { return { count: null, reason: "events 读取异常：" + String(e.message || e).slice(0, 60) }; }
}
function gitHead(dir) {
  if (!dir || !existsSync(join(dir, ".git"))) return null;
  try {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 15000 });
    const v = (r.stdout || "").trim();
    return r.status === 0 && v ? v : null;
  } catch { return null; }
}
export function fingerprints(root) {
  const ids = scanCardIds(root);
  const ev = eventsCount(root);
  // 2026-11-19：events.db 已纳入数据仓 → 指纹必须含其内容摘要，否则「换机一致」只证卡不证原文
  let eventsDigest = null;
  try { const dbp = join(root, "events.db"); if (existsSync(dbp)) eventsDigest = sha256(dbp).slice(0, 16); } catch {}
  let revision = null;
  try { const st = loadCurrentState(root); revision = st && !st.invalid ? st.revision : null; } catch {}
  const engineHead = gitHead(root);
  const dataDir = process.env.CP_DATA_DIR || join(homedir(), "cp-memory");
  const dataHead = gitHead(dataDir);
  const cards = ids ? { count: ids.length, digest: memoriesDigest(root) || createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16) } : { count: null, digest: null };
  const blocked = [];
  if (!ids) blocked.push("memories/ 不存在（不是完整实例）");
  if (ev.count === null) blocked.push("events 条数：" + (ev.reason || "不可用"));
  if (revision === null) blocked.push("current-state.json 的 revision 读不到");
  if (!engineHead) blocked.push("引擎仓提交读不到（非 git 或未 clone）");
  if (!dataHead) blocked.push("数据仓提交读不到（" + dataDir + "）");
  return {
    ok: blocked.length === 0,
    blocked,
    fingerprints: { cards, events: ev.count, eventsDigest, stateRevision: revision, engineHead, dataHead },
  };
}

export function refreshManifest(root, actor = "resume-context") {
  const inspected = inspectManifest(root);
  const policy = loadPolicy(root);
  if (policy.error) throw new Error(policy.error);
  const manifest = {
    schemaVersion: 1,
    policyRevision: policy.revision,
    stateFile: "current-state.json",
    policyFile: POLICY_FILE,
    sources: inspected.expected,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
    status: inspected.missing.length ? "incomplete" : "fresh",
    note: "Hashes describe local source files; refresh after an explicit policy or state change.",
  };
  const file = sourcePath(root, MANIFEST_FILE);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  try { renameSync(temp, file); }
  catch (error) { try { unlinkSync(temp); } catch {} throw error; }
  return manifest;
}

function renderPolicy(policy) {
  const rules = policy.rules.map(rule => `- ${xml(rule)}`).join("\n");
  const forbidden = policy.forbidden.map(word => `- ${xml(word)}`).join("\n");
  return [
    "【回复门禁】",
    xml(policy.opening || "先给结论，再给理由。"),
    rules,
    `禁用词：\n${forbidden}`,
  ].join("\n");
}

export function renderRecovery(root, maxBytes = DEFAULT_BYTES) {
  const policy = loadPolicy(root);
  const manifest = inspectManifest(root);
  const state = loadCurrentState(root);
  const stateBlock = renderCurrentState(root, Math.floor(maxBytes * 0.62));
  const policyBlock = policy.error ? `【回复门禁不可用】${xml(policy.error)}` : renderPolicy(policy);
  const body = `<context-recovery source="cosmic-phantom" policy-revision="${xml(policy.revision || "?")}" state-revision="${xml(state.revision)}" source-status="${xml(manifest.status)}">\n${policyBlock}\n${stateBlock}</context-recovery>\n`;
  if (Buffer.byteLength(body) <= maxBytes) return body;
  const suffix = "\n[recovery truncated; run resume-context.js show for full local state]\n</context-recovery>\n";
  const limit = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  return truncateUtf8(body, limit) + suffix;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "check";
  const root = rootFromArgs();
  const get = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
  try {
    if (command === "render" || command === "bootstrap") process.stdout.write(renderRecovery(root, Number(get("--bytes") || configRecoveryBytes(root))));
    else if (command === "show") output({ policy: loadPolicy(root), state: loadCurrentState(root), manifest: inspectManifest(root) });
    else if (command === "fingerprint") { const fp = fingerprints(root); output(fp); process.exitCode = fp.ok ? 0 : 1; }
    else if (command === "check") {
      const policy = loadPolicy(root);
      const manifest = inspectManifest(root);
      const state = loadCurrentState(root);
      const fp = fingerprints(root);
      // 契约（2026-11-18）：check 保持原有语义（政策/清单/状态），四项指纹只作附加信息；
      //   换机比对与 CI 用 --strict 才把指纹缺失视为失败。
      const strict = args.includes("--strict");
      const baseOk = !policy.error && manifest.status === "fresh" && !state.invalid && state.revision > 0;
      const ok = strict ? (baseOk && fp.ok) : baseOk;
      output({ ok, policy: policy.error ? policy.error : "valid", manifest: manifest.status, stateRevision: state.revision, missing: manifest.missing || [], changed: manifest.changed || [], fingerprints: fp.fingerprints, blocked: fp.blocked });
      process.exitCode = ok ? 0 : 1;
    } else if (command === "refresh") output(refreshManifest(root, get("--actor") || "resume-context"));
    else output({ usage: "render|bootstrap|show|check|fingerprint|refresh [--root <root>] [--bytes N]" });
  } catch (error) { output({ ok: false, error: String(error.message || error) }); process.exitCode = 1; }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) main();
