#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline");
const { pluginRootFrom, instancePaths } = require("./lib/paths.cjs");
const { ensureInstance, readConfig, readState, writeState, atomicJson } = require("./lib/state.cjs");
const { configureInstance } = require("./lib/config.cjs");
const { createJsonlAdapter } = require("./lib/adapter-runner.cjs");

const PLUGIN_ROOT = pluginRootFrom(__dirname);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "plugin.json"), "utf8"));
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const command = process.argv[2] || "status";
const json = process.argv.includes("--json") || process.env.CP_JSON === "1";
const dryRun = process.argv.includes("--dry-run");
const yes = process.argv.includes("--yes");
const instance = path.resolve(arg("--instance") || process.env.CP_INSTANCE || path.join(os.homedir(), ".cp-instance"));
const output = (value) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const fail = (code, message, details = {}) => { const result = { ok: false, code, message, ...details }; output(result); process.exitCode = 1; return result; };
const info = (message) => { if (!json) process.stdout.write(message + "\n"); };
function engineRoot() { return path.join(PLUGIN_ROOT, MANIFEST.engineRoot); }
function runEngine(args) {
  const script = path.join(engineRoot(), "memory-cli.js");
  if (!fs.existsSync(script)) return { ok: false, error: "ENGINE_MISSING", message: `引擎文件缺失: ${script}` };
  const r = spawnSync(process.execPath, ["--experimental-sqlite", script, ...args, "--root", instance], { encoding: "utf8", timeout: 120000 });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}
function ensureConfigured() {
  const config = readConfig(instance);
  if (!config) return fail("NOT_CONFIGURED", "实例尚未配置，请先运行 configure --apply", { instance });
  return config;
}
function parseLastJson(text) {
  const value = String(text || "").trim();
  for (let i = value.lastIndexOf("{"); i >= 0; i = value.lastIndexOf("{", i - 1)) {
    try { return JSON.parse(value.slice(i)); } catch {}
  }
  return null;
}
function status() {
  const state = readState(instance);
  const config = readConfig(instance);
  const result = { ok: true, plugin: { id: MANIFEST.id, version: MANIFEST.version }, instance, configured: !!config, state: state || { effectiveState: "uninstalled" }, data: { events: fs.existsSync(path.join(instance, "events.db")), memories: fs.existsSync(path.join(instance, "memories")), candidates: fs.existsSync(path.join(instance, "candidates")) } };
  output(result);
}
function inspectPlugin() {
  const required = [
    "memory-cli.js",
    "events.js",
    "memory-retrieval.js",
    "skills-sync.js",
    "lib/failopen.js",
  ];
  const missing = required.filter((file) => !fs.existsSync(path.join(engineRoot(), file)));
  return { missing, manifest: MANIFEST.kind === "generic-agent-plugin", engineFiles: missing.length === 0 };
}
function inspectEventsDatabase() {
  const events = path.join(instance, "events.db");
  if (!fs.existsSync(events)) return { ok: true, present: false, integrity: null, count: 0, error: null };
  const probe = `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check; const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get(); const columns = table ? new Set(db.prepare("PRAGMA table_info(events)").all().map((row) => row.name)) : new Set(); const required = ["instance", "mid", "session", "role", "content", "ts", "source_id", "source_revision", "source_kind", "source_ref", "scope"]; const missingColumns = required.filter((name) => !columns.has(name)); const index = db.prepare("SELECT name, [unique] FROM pragma_index_list('events') WHERE name='idx_events_source_identity'").get(); const indexColumns = index ? db.prepare("SELECT name FROM pragma_index_info('idx_events_source_identity') ORDER BY seqno").all().map((row) => row.name) : []; const validIndex = !!index && Number(index.unique) === 1 && JSON.stringify(indexColumns) === JSON.stringify(["instance", "source_id", "source_revision"]); const duplicate = table && !missingColumns.length ? Number(db.prepare("SELECT COUNT(*) c FROM (SELECT instance, source_id, source_revision FROM events WHERE source_id IS NOT NULL GROUP BY instance, source_id, source_revision HAVING COUNT(*) > 1)").get().c || 0) : null; const count = table ? Number(db.prepare("SELECT COUNT(*) c FROM events").get().c) : 0; console.log(JSON.stringify({ integrity, table: !!table, count, missingColumns, sourceIdentityIndex: validIndex, sourceIdentityIndexColumns: indexColumns, duplicateIdentities: duplicate })); db.close();`;
  const result = spawnSync(process.execPath, ["--experimental-sqlite", "-e", probe, events], { encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) return { ok: false, present: true, integrity: null, count: null, error: (result.stderr || "SQLite health probe failed").trim().slice(-1000) };
  try {
    const value = JSON.parse(result.stdout.trim());
    const schemaOk = value.table === true && value.missingColumns.length === 0;
    const identityOk = value.sourceIdentityIndex === true && value.duplicateIdentities === 0;
    return { ok: value.integrity === "ok" && schemaOk && identityOk, present: true, integrity: value.integrity, count: value.count, missingColumns: value.missingColumns, sourceIdentityIndex: value.sourceIdentityIndex, duplicateIdentities: value.duplicateIdentities, error: !value.table ? "events 表不存在" : !schemaOk ? `events 表缺少列: ${value.missingColumns.join(", ")}` : !identityOk ? "来源身份索引缺失或存在重复身份" : null };
  } catch (error) { return { ok: false, present: true, integrity: null, count: null, error: error.message }; }
}
function health() {
  const config = ensureConfigured();
  if (!config || config.ok === false) return;
  const plugin = inspectPlugin();
  const db = inspectEventsDatabase();
  const checks = { manifest: plugin.manifest, engineFiles: plugin.engineFiles, instanceConfig: !!config, instanceMeta: fs.existsSync(instancePaths(instance).meta), sqlite: db.ok };
  const ok = Object.values(checks).every(Boolean);
  output({ ok, code: ok ? "HEALTHY" : "PLUGIN_HEALTH_FAILED", instance, state: readState(instance), checks, missing: plugin.missing, database: db });
  if (!ok) process.exitCode = 1;
}
function verify() {
  const config = ensureConfigured();
  if (!config || config.ok === false) return;
  const plugin = inspectPlugin();
  const db = inspectEventsDatabase();
  const state = readState(instance);
  const checks = {
    plugin: plugin.manifest && plugin.engineFiles,
    config: !!config,
    state: !!state && state.pluginId === MANIFEST.id,
    database: db.ok,
  };
  const ok = Object.values(checks).every(Boolean);
  output({ ok, code: ok ? "VERIFIED" : "PLUGIN_VERIFY_FAILED", instance, state, checks, missing: plugin.missing, database: db, data: { memories: fs.existsSync(path.join(instance, "memories")), candidates: fs.existsSync(path.join(instance, "candidates")) } });
  if (!ok) process.exitCode = 1;
}
async function promptConfig() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (question, fallback) => new Promise((resolve) => rl.question(`${question} [${fallback}]: `, (answer) => resolve(answer.trim() || fallback)));
  try {
    const adapter = await ask("适配器（manual/jsonl/transcript）", "manual");
    const source = adapter === "manual" ? "" : await ask("来源 JSONL/transcript 文件绝对路径", "");
    const scope = await ask("默认作用域（global/workspace/agent）", "workspace");
    const backfill = await ask("回填策略（none/since/all）", "none");
    const since = backfill === "since" ? await ask("回填起始日期（YYYY-MM-DD）", "") : undefined;
    const retrieval = await ask("检索模式（bm25/hybrid）", "bm25");
    return { adapter, source, sourceInstance: arg("--source-instance") || adapter, scope, backfill, since, retrieval };
  } finally { rl.close(); }
}
async function configure() {
  const explicitConfig = ["--adapter", "--source", "--source-instance", "--scope", "--backfill", "--since", "--retrieval"].some((flag) => process.argv.includes(flag));
  const interactive = process.argv.includes("--interactive") || (!explicitConfig && !process.argv.includes("--non-interactive") && process.stdin.isTTY && !process.argv.includes("--dry-run"));
  const input = interactive
    ? await promptConfig()
    : { scope: arg("--scope"), backfill: arg("--backfill"), since: arg("--since"), retrieval: arg("--retrieval"), adapter: arg("--adapter"), source: arg("--source"), sourceInstance: arg("--source-instance") };
  if (dryRun) return output({ ok: true, dryRun: true, action: "configure", instance, proposed: input });
  if (!yes && !process.argv.includes("--apply")) return output({ ok: true, dryRun: true, action: "configure", instance, hint: "加 --apply（或 --yes）才写入配置", proposed: input });
  try { output({ ok: true, action: "configure", instance, config: configureInstance(instance, { ...input, pluginVersion: MANIFEST.version }) }); }
  catch (error) { fail(error.code || "CONFIG_INVALID", error.message); }
}
function transition(next, event) {
  const current = readState(instance);
  if (!current) return fail("NOT_CONFIGURED", "实例尚未配置，请先运行 configure --apply", { instance });
  if (dryRun || (!yes && !process.argv.includes("--apply"))) return output({ ok: true, dryRun: true, action: event, instance, from: current.effectiveState, to: next, hint: "加 --apply（或 --yes）才写入生命周期状态" });
  output({ ok: true, action: event, instance, state: writeState(instance, { desiredState: next, effectiveState: next, installedVersion: MANIFEST.version }, event) });
}
function uninstall() {
  const current = readState(instance);
  if (!current) return output({ ok: true, action: "uninstall", instance, preserved: [], note: "实例未配置，未删除数据" });
  if (dryRun || !yes) return output({ ok: true, dryRun: true, action: "uninstall", instance, preserve: ["events.db", "memories", "candidates", ".cp"], hint: "加 --yes 才会标记插件卸载；本命令不会删除实例数据" });
  output({ ok: true, action: "uninstall", instance, state: writeState(instance, { desiredState: "uninstalled", effectiveState: "uninstalled", installedVersion: null }, "uninstall"), preserved: fs.existsSync(instance) ? fs.readdirSync(instance).filter((name) => name !== ".cp") : [] });
}
function sync() {
  const config = ensureConfigured();
  if (!config || config.ok === false) return;
  const state = readState(instance);
  if (state.effectiveState !== "enabled") return fail("PLUGIN_DISABLED", "插件未启用，sync 不摄取事件", { state: state.effectiveState });
  const targets = (config.adapters || []).filter((adapter) => adapter.enabled !== false && ["jsonl", "transcript"].includes(adapter.id) && adapter.config && adapter.config.file);
  if (!targets.length) return output({ ok: true, action: "sync", instance, logged: 0, skipped: 0, reason: "没有配置带文件来源的适配器" });
  const paths = instancePaths(instance);
  fs.mkdirSync(paths.cursors, { recursive: true });
  const hashBytes = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  const results = [];
  for (const adapterConfig of targets) {
    const file = path.resolve(adapterConfig.config.file);
    if (!fs.existsSync(file)) { results.push({ adapter: adapterConfig.id, ok: false, code: "SOURCE_MISSING", file }); continue; }
    try {
      const cursorFile = path.join(paths.cursors, `${adapterConfig.id}.json`);
      let previousCursor = null;
      if (fs.existsSync(cursorFile)) {
        try { previousCursor = JSON.parse(fs.readFileSync(cursorFile, "utf8")); }
        catch (error) { results.push({ adapter: adapterConfig.id, ok: false, code: "CURSOR_INVALID", message: `游标文件无效: ${error.message}`, file }); continue; }
      }
      const sourceBytes = fs.readFileSync(file);
      const sourceHash = hashBytes(sourceBytes);
      const statBefore = fs.statSync(file);
      if (previousCursor && previousCursor.sourceInstance !== adapterConfig.config.sourceInstance) {
        results.push({ adapter: adapterConfig.id, ok: false, code: "SOURCE_INSTANCE_CHANGED", message: "已有游标的 sourceInstance 与当前配置不一致，请显式重新挂载来源", file });
        continue;
      }
      if (previousCursor && previousCursor.file !== file) {
        results.push({ adapter: adapterConfig.id, ok: false, code: "SOURCE_REPLACED", message: "同一 sourceInstance 更换了来源文件", file });
        continue;
      }
      const previousSize = Number(previousCursor?.size || 0);
      const priorHash = previousCursor?.prefixHash || previousCursor?.contentHash;
      const observedPriorHash = previousCursor && statBefore.size >= previousSize
        ? previousCursor.hashVersion === 2
          ? hashBytes(sourceBytes.subarray(0, previousSize))
          : previousCursor.prefixHash
            ? hashBytes(sourceBytes.subarray(0, Math.min(4096, previousSize)))
            : hashBytes(sourceBytes.subarray(0, previousSize))
        : null;
      if (previousCursor && previousCursor.sourceInstance === adapterConfig.config.sourceInstance && (statBefore.size < previousSize || (priorHash && observedPriorHash !== priorHash))) {
        results.push({ adapter: adapterConfig.id, ok: false, code: "SOURCE_REPLACED", message: "来源文件前缀或长度发生不可回放变化", file });
        continue;
      }
      const snapshot = path.join(instance, `.source-${adapterConfig.id}-${process.pid}.jsonl`);
      fs.writeFileSync(snapshot, sourceBytes);
      let normalized;
      try {
        const adapter = createJsonlAdapter(adapterConfig.id === "transcript" ? "transcript" : "jsonl");
        normalized = adapter.scan({ config: { ...adapterConfig.config, file: snapshot } }).map((record) => adapter.normalize(record, { ...adapterConfig.config, file: snapshot }));
      } finally { try { fs.rmSync(snapshot, { force: true }); } catch {} }
      if (hashBytes(fs.readFileSync(file)) !== sourceHash) {
        results.push({ adapter: adapterConfig.id, ok: false, code: "SOURCE_CHANGED_DURING_SYNC", message: "来源文件在快照后发生变化，请重试", file });
        continue;
      }
      const temp = path.join(instance, `.normalized-${adapterConfig.id}-${process.pid}.jsonl`);
      fs.writeFileSync(temp, normalized.map((event) => JSON.stringify(event)).join("\n") + (normalized.length ? "\n" : ""), "utf8");
      const engine = path.join(engineRoot(), "events.js");
      const r = spawnSync(process.execPath, ["--experimental-sqlite", engine, "ingest-normalized", "--input", temp, "--root", instance], { encoding: "utf8", timeout: 120000 });
      try { fs.rmSync(temp, { force: true }); } catch {}
      const result = parseLastJson(r.stdout) || { raw: r.stdout.slice(-1000) };
      const changedAfterIngest = !fs.existsSync(file) || hashBytes(fs.readFileSync(file)) !== sourceHash;
      if (changedAfterIngest) {
        results.push({ adapter: adapterConfig.id, ok: false, code: "SOURCE_CHANGED_DURING_SYNC", message: "来源文件在摄取期间发生变化，游标未推进，请重试", file });
        continue;
      }
      const projectionFailed = result.projection?.ok === false;
      const eventCommitted = result.eventCommitted === true;
      const cursor = { adapter: adapterConfig.id, sourceInstance: adapterConfig.config.sourceInstance, file, size: sourceBytes.length, mtimeMs: statBefore.mtimeMs, hashVersion: 2, prefixHash: sourceHash, contentHash: sourceHash, records: normalized.length, updatedAt: new Date().toISOString() };
      // Projection is rebuildable: a committed raw event is enough to advance the source cursor,
      // while the command still reports degraded projection health for repair/retry visibility.
      const cursorSafe = !result.error && (r.status === 0 || eventCommitted);
      const ok = r.status === 0 && !result.error && !projectionFailed;
      if (cursorSafe) atomicJson(path.join(paths.cursors, `${adapterConfig.id}.json`), cursor);
      results.push({ adapter: adapterConfig.id, ok, eventCommitted, projectionHealthy: !projectionFailed, cursorAdvanced: cursorSafe, result, cursor: cursorSafe ? cursor : null, stderr: r.stderr.slice(-500) });
    } catch (error) {
      results.push({ adapter: adapterConfig.id, ok: false, code: error.code || "ADAPTER_FAILED", message: error.message, file });
    }
  }
  const ok = results.every((item) => item.ok);
  output({ ok, action: "sync", instance, results });
  if (!ok) process.exitCode = 1;
}
function ingest() {
  const config = ensureConfigured();
  if (!config || config.ok === false) return;
  const state = readState(instance);
  if (state.effectiveState !== "enabled") return fail("PLUGIN_DISABLED", "插件未启用，ingest 不摄取事件", { state: state.effectiveState });
  const input = arg("--input");
  if (!input) return fail("MISSING_INPUT", "ingest 需要 --input <标准事件 JSONL>");
  if (!fs.existsSync(input)) return fail("INPUT_MISSING", `输入不存在: ${input}`);
  const engine = path.join(engineRoot(), "events.js");
  const r = spawnSync(process.execPath, ["--experimental-sqlite", engine, "ingest-normalized", "--input", path.resolve(input), "--root", instance], { encoding: "utf8", timeout: 120000 });
  const result = parseLastJson(r.stdout) || { raw: r.stdout.slice(-1000) };
  const projectionFailed = result.projection?.ok === false;
  const eventCommitted = result.eventCommitted === true;
  const ok = r.status === 0 && !result.error && !projectionFailed;
  output({ ok, action: "ingest", instance, eventCommitted, projectionHealthy: !projectionFailed, result, stderr: r.stderr.slice(-1000) });
  if (!ok) process.exitCode = 1;
}
function upgrade() {
  const packageDir = arg("--package");
  if (!packageDir) return fail("MISSING_PACKAGE", "upgrade 需要 --package <插件目录>");
  const source = path.resolve(packageDir);
  const sourceManifest = path.join(source, "plugin.json");
  if (!fs.existsSync(sourceManifest)) return fail("INVALID_PACKAGE", "插件目录缺少 plugin.json");
  let incoming;
  try { incoming = JSON.parse(fs.readFileSync(sourceManifest, "utf8")); } catch (error) { return fail("INVALID_PACKAGE", error.message); }
  if (incoming.id !== MANIFEST.id) return fail("PLUGIN_ID_MISMATCH", `插件 ID 不匹配: ${incoming.id}`);
  if (!/^\d+\.\d+\.\d+$/.test(String(incoming.version || ""))) return fail("INVALID_VERSION", "插件版本必须是 x.y.z");
  const currentVersion = String(MANIFEST.version);
  const versionParts = (value) => String(value).split(".").map(Number);
  const incomingParts = versionParts(incoming.version);
  const currentParts = versionParts(currentVersion);
  const versionDelta = incomingParts.findIndex((part, index) => part !== currentParts[index]);
  if (versionDelta < 0 || incomingParts[versionDelta] < currentParts[versionDelta]) return fail("VERSION_NOT_INCREMENTED", "升级版本必须高于当前插件版本");
  if (versionDelta >= 0 && incomingParts[versionDelta] === currentParts[versionDelta]) return fail("VERSION_NOT_INCREMENTED", "升级版本必须高于当前插件版本");
  const checksumsFile = path.join(source, "checksums.json");
  if (!fs.existsSync(checksumsFile)) return fail("CHECKSUMS_MISSING", "升级包缺少 checksums.json");
  let checksums;
  try { checksums = JSON.parse(fs.readFileSync(checksumsFile, "utf8")); } catch (error) { return fail("CHECKSUMS_INVALID", error.message); }
  if (checksums.pluginId !== incoming.id || checksums.version !== incoming.version || !checksums.files || typeof checksums.files !== "object") return fail("CHECKSUMS_INVALID", "checksums.json 身份或文件表无效");
  const declaredFiles = new Set(Object.keys(checksums.files));
  for (const [relative, expected] of Object.entries(checksums.files)) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || relative.includes("\\")) return fail("CHECKSUMS_INVALID", `校验路径非法: ${relative}`);
    const file = path.join(source, relative);
    if (!fs.existsSync(file) || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== expected) return fail("CHECKSUM_MISMATCH", `升级包文件校验失败: ${relative}`);
  }
  const packageFiles = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name !== "checksums.json") packageFiles.push(path.relative(source, file).replace(/\\/g, "/")); } };
  walk(source);
  for (const relative of packageFiles) if (!declaredFiles.has(relative)) return fail("CHECKSUMS_INCOMPLETE", `升级包文件未校验: ${relative}`);
  const current = readState(instance);
  if (!current) return fail("NOT_CONFIGURED", "实例尚未配置");
  const backup = path.join(instancePaths(instance).backups, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`);
  if (dryRun || !yes) return output({ ok: true, dryRun: true, action: "upgrade", from: current.installedVersion, to: incoming.version, backup, preserve: ["events.db", "memories", "candidates", ".cp"] });
  fs.mkdirSync(backup, { recursive: true });
  atomicJson(path.join(backup, "upgrade.json"), { from: current.installedVersion, to: incoming.version, createdAt: new Date().toISOString(), pluginRoot: PLUGIN_ROOT });
  output({ ok: false, code: "UPGRADE_PACKAGE_READY", message: "P0 已完成升级预检和备份目录创建；实际替换插件目录需由分发层执行，未触碰实例数据。", backup, instance });
  process.exitCode = 2;
}
async function main() {
  if (command === "status") return status();
  if (command === "health" || command === "doctor") return health();
  if (command === "verify") return verify();
  if (command === "configure") return configure();
  if (command === "enable") return transition("enabled", "enable");
  if (command === "disable") return transition("disabled", "disable");
  if (command === "sync") return sync();
  if (command === "ingest") return ingest();
  if (command === "uninstall") return uninstall();
  if (command === "upgrade") return upgrade();
  return fail("UNKNOWN_COMMAND", `未知命令: ${command}`, { commands: MANIFEST.commands });
}
Promise.resolve(main()).catch((error) => fail(error.code || "PLUGIN_ERROR", error.message));
