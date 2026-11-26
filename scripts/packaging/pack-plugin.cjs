#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const source = path.resolve(arg("--source") || path.join(__dirname, "..", "..", "plugin"));
const out = path.resolve(arg("--out") || path.join(process.cwd(), "dist", "cosmic-phantom-plugin"));
const parent = path.dirname(out);
const transactionPath = `${out}.cp-transaction.json`;
const lockPath = `${out}.cp-lock`;
const lockToken = crypto.randomBytes(16).toString("hex");
let ownsLock = false;
const lexists = (file) => { try { fs.lstatSync(file); return true; } catch { return false; } };
const remove = (file) => { if (lexists(file)) fs.rmSync(file, { recursive: true, force: true }); };
const nonce = () => `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

function canonicalPath(file) {
  const tail = [];
  let current = file;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return file;
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...tail);
}
function contains(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}
function fail(code, message) {
  process.stdout.write(JSON.stringify({ ok: false, code, message, source, out }, null, 2) + "\n");
  process.exit(1);
}
function acquireLock() {
  let fd;
  try { fd = fs.openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") fail("PACKAGE_BUSY", `输出目录已有打包锁，拒绝并发或覆盖操作: ${lockPath}`);
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: lockToken, createdAt: new Date().toISOString() }) + "\n", "utf8"); }
  finally { fs.closeSync(fd); }
  ownsLock = true;
  process.once("exit", () => {
    if (!ownsLock) return;
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (lock.token === lockToken) fs.unlinkSync(lockPath);
    } catch {}
  });
}
function fileHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function checkedPackage(root) {
  const result = spawnSync(process.execPath, [path.join(__dirname, "check-plugin.cjs"), root], { encoding: "utf8" });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch {}
  return { ok: result.status === 0 && report?.ok === true, report, result };
}
function writeTransaction(transaction) {
  const temporary = `${transactionPath}.tmp-${nonce()}`;
  fs.writeFileSync(temporary, JSON.stringify(transaction, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, transactionPath);
}
function readTransaction() {
  try {
    const stat = fs.lstatSync(transactionPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("PACKAGE_TRANSACTION_INVALID", "打包事务标记必须是普通文件");
    return JSON.parse(fs.readFileSync(transactionPath, "utf8"));
  } catch (error) { fail("PACKAGE_TRANSACTION_INVALID", `打包事务标记不可读取: ${error.message}`); }
}
function validateTransaction(transaction, manifest) {
  const sameParent = (file) => typeof file === "string" && path.dirname(path.resolve(file)) === path.dirname(out);
  const temporaryName = (file, kind) => typeof file === "string" && path.basename(file).startsWith(`.${path.basename(out)}.cp-${kind}-`);
  if (transaction?.schemaVersion !== 1 || !["prepared", "old-moved", "new-moved"].includes(transaction.phase) || transaction.pluginId !== manifest.id || typeof transaction.version !== "string" || !/^[a-f0-9]{64}$/.test(transaction.targetChecksumsSha256 || "") || !["absent", "empty", "package"].includes(transaction.previousOutput) || path.resolve(transaction.out || "") !== out || !sameParent(transaction.backup) || !sameParent(transaction.staging) || !temporaryName(transaction.backup, "backup") || !temporaryName(transaction.staging, "staging") || path.resolve(transaction.backup) === out || path.resolve(transaction.staging) === out) {
    fail("PACKAGE_TRANSACTION_INVALID", "打包事务标记的插件身份、路径或版本非法");
  }
}
function recoverTransaction(manifest) {
  if (!lexists(transactionPath)) return;
  const transaction = readTransaction();
  validateTransaction(transaction, manifest);
  const outExists = lexists(out);
  const backupExists = lexists(transaction.backup);
  const stagingExists = lexists(transaction.staging);
  if (stagingExists) {
    const stagingStat = fs.lstatSync(transaction.staging);
    if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) fail("PACKAGE_RECOVERY_UNSAFE", "待清理的暂存包不是普通目录");
    const stagedPackage = checkedPackage(transaction.staging);
    const stagedChecksums = path.join(transaction.staging, "checksums.json");
    if (!stagedPackage.ok || stagedPackage.report?.manifest?.id !== manifest.id || stagedPackage.report?.manifest?.version !== transaction.version || !fs.existsSync(stagedChecksums) || fileHash(stagedChecksums) !== transaction.targetChecksumsSha256) {
      fail("PACKAGE_RECOVERY_UNSAFE", "待清理的暂存目录不是事务记录中的目标包，已保留现场");
    }
  }
  let backupPackage = null;
  if (backupExists) {
    const backupStat = fs.lstatSync(transaction.backup);
    if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) fail("PACKAGE_RECOVERY_UNSAFE", "待恢复的备份不是普通目录");
    if (transaction.previousOutput === "empty" && fs.readdirSync(transaction.backup).length === 0) {
      backupPackage = { ok: true, report: { manifest: { id: manifest.id } }, empty: true };
    } else {
      backupPackage = checkedPackage(transaction.backup);
      if (transaction.previousOutput !== "package" || !backupPackage.ok || backupPackage.report?.manifest?.id !== manifest.id) fail("PACKAGE_RECOVERY_UNSAFE", "待恢复的备份不是当前插件的有效旧输出");
    }
  }
  let current = null;
  if (outExists) {
    const stat = fs.lstatSync(out);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("PACKAGE_RECOVERY_UNSAFE", "待恢复的输出路径不是普通目录");
    current = checkedPackage(out);
  }
  const currentChecksums = path.join(out, "checksums.json");
  const currentIsTarget = current?.ok === true && current.report?.manifest?.id === manifest.id && current.report?.manifest?.version === transaction.version && fs.existsSync(currentChecksums) && fileHash(currentChecksums) === transaction.targetChecksumsSha256;

  if (outExists && backupExists) {
    if (currentIsTarget) {
      remove(transaction.backup);
    } else {
      fail("PACKAGE_RECOVERY_CONFLICT", "输出目录和旧包备份同时存在，但输出不是本次目标包；两者均已保留，请人工检查");
    }
  } else if (!outExists && backupExists) {
    fs.renameSync(transaction.backup, out);
  } else if (outExists && !backupExists && current?.ok !== true) {
    if (transaction.previousOutput !== "empty" || fs.readdirSync(out).length !== 0) {
      fail("PACKAGE_RECOVERY_REQUIRED", "打包事务缺少可恢复的旧输出，当前输出也未通过校验");
    }
  } else if (!outExists && !backupExists && transaction.previousOutput !== "absent") {
    fail("PACKAGE_TRANSACTION_LOST", "打包事务标记存在，但旧输出和备份都不存在");
  }
  remove(transaction.staging);
  remove(transactionPath);
}
function maybeInterrupt(phase) {
  if (process.env.CP_PACK_INTERRUPT_PHASE !== phase) return;
  process.stdout.write(JSON.stringify({ ok: false, code: "PACKAGE_INTERRUPTED", phase, transaction: transactionPath }, null, 2) + "\n");
  process.exit(3);
}

if (fs.existsSync(source)) {
  const sourcePath = canonicalPath(source);
  const outPath = canonicalPath(out);
  if (contains(sourcePath, outPath) || contains(outPath, sourcePath)) {
    fail("PACKAGE_PATH_OVERLAP", "输出目录不能与插件源码目录相同、嵌套或互为上级目录");
  }
}
const sourceCheck = checkedPackage(source);
if (!sourceCheck.ok) {
  process.stdout.write(sourceCheck.result.stdout || sourceCheck.result.stderr || "");
  process.exit(sourceCheck.result.status || 1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(source, "plugin.json"), "utf8"));
fs.mkdirSync(parent, { recursive: true });
acquireLock();
recoverTransaction(manifest);

if (lexists(out)) {
  const outStat = fs.lstatSync(out);
  if (!outStat.isDirectory() || outStat.isSymbolicLink()) fail("OUTPUT_PATH_UNSAFE", "输出路径必须是普通目录，不能是文件或符号链接");
  if (fs.readdirSync(out).length > 0) {
    const existing = checkedPackage(out);
    if (!existing.ok || existing.report?.manifest?.id !== manifest.id || !fs.existsSync(path.join(out, "checksums.json"))) {
      fail("OUTPUT_NOT_PACKAGE", "非空输出目录必须是同一插件 ID 的有效旧包才能重打包");
    }
  }
}

const staging = path.join(parent, `.${path.basename(out)}.cp-staging-${nonce()}`);
const backup = path.join(parent, `.${path.basename(out)}.cp-backup-${nonce()}`);
function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (["checksums.json", ".git"].includes(entry.name)) continue;
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`插件包不允许符号链接: ${src}`);
    if (entry.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copyTree(src, dst); }
    else if (entry.isFile()) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
    else throw new Error(`插件包包含不支持的文件类型: ${src}`);
  }
}
function digestTree(dir, root, checksums) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) digestTree(file, root, checksums);
    else if (entry.name !== "checksums.json") checksums[path.relative(root, file).replace(/\\/g, "/")] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
}

let staged = false;
try {
  fs.mkdirSync(staging, { recursive: false });
  staged = true;
  copyTree(source, staging);
  const checksums = {};
  digestTree(staging, staging, checksums);
  fs.writeFileSync(path.join(staging, "checksums.json"), JSON.stringify({ schemaVersion: 1, pluginId: manifest.id, version: manifest.version, files: checksums }, null, 2) + "\n", "utf8");
  const stagedCheck = checkedPackage(staging);
  if (!stagedCheck.ok || stagedCheck.report?.manifest?.id !== manifest.id) throw new Error("旁路构建产物未通过插件包校验");

  const previousOutput = !lexists(out) ? "absent" : fs.readdirSync(out).length === 0 ? "empty" : "package";
  const transaction = { schemaVersion: 1, phase: "prepared", out, staging, backup, previousOutput, pluginId: manifest.id, version: manifest.version, targetChecksumsSha256: fileHash(path.join(staging, "checksums.json")), createdAt: new Date().toISOString() };
  writeTransaction(transaction);
  let movedOld = false;
  let movedNew = false;
  try {
    if (lexists(out)) {
      fs.renameSync(out, backup);
      movedOld = true;
    }
    maybeInterrupt("after-old-move");
    writeTransaction({ ...transaction, phase: "old-moved" });
    fs.renameSync(staging, out);
    movedNew = true;
    maybeInterrupt("after-new-move");
    writeTransaction({ ...transaction, phase: "new-moved" });
  } catch (error) {
    try {
      if (movedNew && lexists(out)) remove(out);
      if (movedOld && lexists(backup)) fs.renameSync(backup, out);
      remove(staging);
      remove(transactionPath);
    } catch (restoreError) {
      throw new Error(`${error.message}; 回滚失败: ${restoreError.message}`);
    }
    throw error;
  }
  remove(backup);
  remove(transactionPath);
  staged = false;
} catch (error) {
  if (staged && lexists(staging)) remove(staging);
  fail("PACKAGE_BUILD_FAILED", error.message);
}

const finalCheck = checkedPackage(out);
if (!finalCheck.ok) fail("PACKAGE_OUTPUT_INVALID", "最终输出目录未通过插件包校验");
const checksums = JSON.parse(fs.readFileSync(path.join(out, "checksums.json"), "utf8"));
const result = { ok: true, source, out, plugin: manifest.id, version: manifest.version, files: Object.keys(checksums.files || {}).length, checksums: path.join(out, "checksums.json") };
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
