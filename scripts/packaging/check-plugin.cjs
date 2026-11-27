#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "plugin"));
const errors = [];
const warnings = [];
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (error) { errors.push(`${path.relative(root, file)}: ${error.message}`); return null; } };
const safeRelative = (value) => typeof value === "string" && value && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..") && !value.includes("\\");
if (!fs.existsSync(root)) errors.push(`插件目录不存在: ${root}`);
const manifest = read(path.join(root, "plugin.json"));
if (manifest) {
  for (const key of ["schemaVersion", "id", "displayName", "kind", "version", "entrypoint", "engineRoot"]) if (manifest[key] == null) errors.push(`plugin.json 缺少 ${key}`);
  if (manifest.kind !== "generic-agent-plugin") errors.push("plugin.json kind 必须是 generic-agent-plugin");
  if (!Array.isArray(manifest.commands) || !manifest.commands.includes("configure")) errors.push("plugin.json commands 缺少 configure");
  if (!safeRelative(manifest.entrypoint) || !safeRelative(manifest.engineRoot)) errors.push("entrypoint/engineRoot 必须是安全相对路径");
  if (manifest.dataContract?.preserveOnUninstall?.length === 0) warnings.push("未声明卸载时保留的数据");
  const entry = path.join(root, manifest.entrypoint || "");
  if (!fs.existsSync(entry)) errors.push(`入口不存在: ${manifest.entrypoint}`);
  for (const adapter of manifest.adapters || []) {
    if (!adapter.id || !safeRelative(adapter.manifest)) errors.push(`适配器清单非法: ${JSON.stringify(adapter)}`);
    else if (!fs.existsSync(path.join(root, adapter.manifest))) errors.push(`适配器清单不存在: ${adapter.manifest}`);
  }
}
const FORBIDDEN_DIR = /^(memories|candidates|daily|distilled|domains|backup|logs|embedding-db|cursors|\.flags)$/i;
const FORBIDDEN_FILE = /(^|\/)(events\.db(-wal|-shm)?|[^/]*\.(db|sqlite|sqlite3|wal|shm)|[^/]*\.lock|hook-errors\.log|failopen-stats\.json|host-checks\.json|sources\.json|current-state\.json|state-timestamps\.json|state-poll\.json|resume-manifest\.json|hosts\.json|change-log\.jsonl|change-baseline\.json|coverage-history\.json|event-index\.json|links\.json|processed\.json|project-root\.json|state-db-path\.txt|WHERE\.txt|\.proma-cursor\.json|\.env(\.[^/]*)?|[^/]*cursor[^/]*)$/i;
const FORBIDDEN_NAME_WORD = /(^|[-_.])(credentials?|secrets?|tokens?)([-_.]|$)/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|onnx|bin|node|wasm|zip|gz|tar|pdf|mp3|mp4|woff2?|ttf|asar)$/i;
const CREDENTIAL_LITERAL = /(?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token|token)\s*[:=]\s*["']([^"'\n]{8,})["']/gi;
const PLACEHOLDER_VALUE = /^(?:<|\$\{|%|\{\{|x{4,}|\*{4,}|YOUR|REPLACE|EXAMPLE|placeholder|changeme|test|dummy|sample)/i;
const USER_HOME_PATH = /(?:[A-Za-z]:\\Users\\[^\\\s"'<>|]+|\/Users\/[^/\s"'<>|]+|\/home\/[^/\s"'<>|]+)/;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (FORBIDDEN_DIR.test(entry.name)) errors.push(`禁止打包实例数据目录: ${path.relative(root, file).replace(/\\/g, "/")}`);
      walk(file);
    }
    else if (!entry.name.endsWith(".cptmp")) files.push(path.relative(root, file).replace(/\\/g, "/"));
  }
}
walk(root);
const fileSet = new Set(files);
const checksumFile = path.join(root, "checksums.json");
if (fs.existsSync(checksumFile)) {
  const checksums = read(checksumFile);
  if (checksums) {
    if (checksums.pluginId !== manifest?.id || checksums.version !== manifest?.version) errors.push("checksums.json 身份与 plugin.json 不一致");
    const declared = checksums.files && typeof checksums.files === "object" ? checksums.files : {};
    for (const [file, expected] of Object.entries(declared)) {
      if (!safeRelative(file)) { errors.push(`checksums.json 路径非法: ${file}`); continue; }
      if (!fileSet.has(file)) { errors.push(`checksums.json 声明文件缺失: ${file}`); continue; }
      const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
      if (actual !== expected) errors.push(`checksums.json 校验失败: ${file}`);
    }
    for (const file of files.filter((item) => item !== "checksums.json")) if (!Object.prototype.hasOwnProperty.call(declared, file)) errors.push(`文件未进入 checksums.json: ${file}`);
  }
}
const relativeImport = /(?:from\s*|import\s*\(|import\s*|require\(\s*)["'](\.[^"']+)["']/g;
for (const file of files.filter((item) => /\.(?:cjs|js|mjs)$/.test(item))) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of source.matchAll(relativeImport)) {
    const request = match[1];
    const base = path.resolve(root, path.dirname(file), request);
    const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, "index.js"), path.join(base, "index.cjs")];
    if (!candidates.some((candidate) => fs.existsSync(candidate))) errors.push(`${file}: 相对依赖不存在 ${request}`);
  }
}
for (const file of files) {
  const base = path.basename(file);
  if (FORBIDDEN_FILE.test(file) || FORBIDDEN_NAME_WORD.test(base)) {
    errors.push(`禁止打包实例数据/私有文件: ${file}`);
    continue;
  }
  if (BINARY_EXT.test(file)) continue;
  const absolute = path.join(root, file);
  if (fs.statSync(absolute).size > MAX_SCAN_BYTES) { errors.push(`文件过大无法内容校验: ${file}`); continue; }
  const source = fs.readFileSync(absolute, "utf8");
  for (const match of source.matchAll(CREDENTIAL_LITERAL)) {
    if (!PLACEHOLDER_VALUE.test(match[1])) errors.push(`疑似凭据字面量: ${file}`);
  }
  if (USER_HOME_PATH.test(source)) errors.push(`字面用户目录绝对路径: ${file}`);
}
const result = { ok: errors.length === 0, root, manifest: manifest ? { id: manifest.id, version: manifest.version, kind: manifest.kind } : null, files: files.length, errors, warnings };
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exitCode = result.ok ? 0 : 1;
