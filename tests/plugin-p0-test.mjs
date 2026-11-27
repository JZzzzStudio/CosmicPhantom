#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, cpSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.execPath;
const LAUNCHER = join(ROOT, "plugin", "launcher.cjs");
const CHECK = join(ROOT, "scripts", "packaging", "check-plugin.cjs");
const PACK = join(ROOT, "scripts", "packaging", "pack-plugin.cjs");
const TMP = mkdtempSync(join(tmpdir(), "cp-plugin-p0-"));
const INSTANCE = join(TMP, "instance");
const EVENT_INSTANCE = join(TMP, "event-instance");
mkdirSync(EVENT_INSTANCE, { recursive: true });
const PACKAGE = join(TMP, "package");
const SOURCE_COPY = join(TMP, "source-copy");
const OLD_SOURCE = join(TMP, "old-source");
const UNSAFE_OUTPUT = join(TMP, "unrelated-output");
const INTERRUPT_OUTPUT_OLD = join(TMP, "interrupt-output-old");
const INTERRUPT_OUTPUT_NEW = join(TMP, "interrupt-output-new");
const EMPTY_OUTPUT = join(TMP, "empty-output");
const ABSENT_OUTPUT = join(TMP, "absent-output");
const INVALID_TX_OUTPUT = join(TMP, "invalid-transaction-output");
const BUSY_OUTPUT = join(TMP, "busy-output");
const OUTSIDE_CWD = join(TMP, "outside-workdir");
mkdirSync(OUTSIDE_CWD, { recursive: true });
const hashFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (script, args, extra = {}) => spawnSync(NODE, [script, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120000, env: { ...process.env, ...extra } });
const runAt = (script, args, cwd, extra = {}) => spawnSync(NODE, [script, ...args], { cwd, encoding: "utf8", timeout: 120000, env: { ...process.env, ...extra } });
const runExperimental = (script, args, extra = {}) => spawnSync(NODE, ["--experimental-sqlite", script, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120000, env: { ...process.env, ...extra } });
const runSql = (db, code) => spawnSync(NODE, ["--experimental-sqlite", "-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); ${code} db.close();`, db], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
const lastJson = (r) => {
  const text = (r.stdout || "").trim();
  for (let i = text.lastIndexOf("{"); i >= 0; i = text.lastIndexOf("{", i - 1)) {
    try { return JSON.parse(text.slice(i)); } catch {}
  }
  throw new Error(`没有 JSON 输出: status=${r.status} signal=${r.signal} stderr=${String(r.stderr || "").slice(-500)} stdout=${text.slice(-500)}`);
};
let passed = 0;
const check = (name, condition, detail = "") => { if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`); passed += 1; console.log(`  [PASS] ${name}`); };
try {
  const checked = run(CHECK, []); const cj = lastJson(checked);
  check("plugin manifest passes validation", checked.status === 0 && cj.ok === true);
  const packed = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", PACKAGE], OUTSIDE_CWD); const pj = lastJson(packed);
  check("plugin package builds from outside the repository", packed.status === 0 && pj.ok === true && existsSync(join(PACKAGE, "checksums.json")));
  console.log("=== content boundary (C 组) ===");
  const BOUNDARY_SOURCE = join(TMP, "boundary-source");
  const BOUNDARY_OUT = join(TMP, "boundary-out");
  const boundarySkeleton = () => {
    rmSync(BOUNDARY_SOURCE, { recursive: true, force: true });
    mkdirSync(join(BOUNDARY_SOURCE, "engine"), { recursive: true });
    writeFileSync(join(BOUNDARY_SOURCE, "plugin.json"), JSON.stringify({ schemaVersion: 1, id: "boundary-synthetic", displayName: "Boundary Synthetic", kind: "generic-agent-plugin", version: "1.0.0", entrypoint: "launcher.cjs", engineRoot: "engine", commands: ["configure"] }));
    writeFileSync(join(BOUNDARY_SOURCE, "launcher.cjs"), "module.exports = {};\n");
    writeFileSync(join(BOUNDARY_SOURCE, "engine", "engine.js"), "export const ok = true;\n");
  };
  const boundaryCases = [
    ["events.db", "events.db", "x"],
    ["instance directory", "memories/card.md", "x"],
    ["daily projection", "daily/2026-01-01.md", "x"],
    ["host config", "host-checks.json", "{}"],
    ["dotenv", ".env", "A=1"],
    ["secret filename", "my-secret.json", "{}"],
    ["runtime lock", ".cp-projection.lock", "1"],
    ["failopen stats", "failopen-stats.json", "{}"],
    ["credential literal", "engine/config.js", 'export const apiKey = "sk-live-abcdef123456";\n'],
    ["user home path", "engine/paths.js", 'export const home = "' + ["C:", "Users", "synthetic-user", ".cosmic-phantom"].join("\\") + '";\n'],
  ];
  for (const [name, relative, content] of boundaryCases) {
    boundarySkeleton();
    const target = join(BOUNDARY_SOURCE, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    const direct = run(CHECK, [BOUNDARY_SOURCE]);
    check(`content boundary rejects ${name} via check-plugin`, direct.status !== 0 && lastJson(direct).ok === false);
    const packedBoundary = runAt(PACK, ["--source", BOUNDARY_SOURCE, "--out", BOUNDARY_OUT], OUTSIDE_CWD);
    check(`content boundary rejects ${name} via pack-plugin`, packedBoundary.status !== 0);
  }
  boundarySkeleton();
  const cleanCheck = run(CHECK, [BOUNDARY_SOURCE]);
  check("content boundary allows a clean synthetic package", cleanCheck.status === 0 && lastJson(cleanCheck).ok === true);
  cpSync(join(ROOT, "plugin"), SOURCE_COPY, { recursive: true });
  const samePathPack = runAt(PACK, ["--source", SOURCE_COPY, "--out", SOURCE_COPY], OUTSIDE_CWD);
  const parentPathPack = runAt(PACK, ["--source", SOURCE_COPY, "--out", TMP], OUTSIDE_CWD);
  check("packaging rejects an output path equal to the source", samePathPack.status !== 0 && lastJson(samePathPack).code === "PACKAGE_PATH_OVERLAP" && existsSync(join(SOURCE_COPY, "plugin.json")));
  check("packaging rejects an output path above the source", parentPathPack.status !== 0 && lastJson(parentPathPack).code === "PACKAGE_PATH_OVERLAP" && existsSync(join(SOURCE_COPY, "plugin.json")));
  mkdirSync(UNSAFE_OUTPUT, { recursive: true });
  writeFileSync(join(UNSAFE_OUTPUT, "keep.txt"), "unrelated user data", "utf8");
  const unsafeOutputPack = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", UNSAFE_OUTPUT], OUTSIDE_CWD);
  check("packaging refuses to erase an unrelated output directory", unsafeOutputPack.status !== 0 && lastJson(unsafeOutputPack).code === "OUTPUT_NOT_PACKAGE" && readFileSync(join(UNSAFE_OUTPUT, "keep.txt"), "utf8") === "unrelated user data");
  const repackage = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", PACKAGE], OUTSIDE_CWD);
  check("packaging replaces only a validated package for the same plugin", repackage.status === 0 && lastJson(repackage).ok === true && existsSync(join(PACKAGE, "checksums.json")));
  cpSync(join(ROOT, "plugin"), OLD_SOURCE, { recursive: true });
  const oldManifestPath = join(OLD_SOURCE, "plugin.json");
  const oldManifest = JSON.parse(readFileSync(oldManifestPath, "utf8"));
  oldManifest.version = "3.0.9";
  writeFileSync(oldManifestPath, JSON.stringify(oldManifest, null, 2) + "\n", "utf8");
  const oldPackage = runAt(PACK, ["--source", OLD_SOURCE, "--out", INTERRUPT_OUTPUT_OLD], OUTSIDE_CWD);
  check("packaging creates a valid prior package for recovery", oldPackage.status === 0 && lastJson(oldPackage).ok === true && JSON.parse(readFileSync(join(INTERRUPT_OUTPUT_OLD, "plugin.json"), "utf8")).version === "3.0.9");
  const interruptedOldMove = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", INTERRUPT_OUTPUT_OLD], OUTSIDE_CWD, { CP_PACK_INTERRUPT_PHASE: "after-old-move" });
  const oldMoveResult = lastJson(interruptedOldMove);
  check("packaging leaves a recoverable transaction after old package removal", interruptedOldMove.status === 3 && oldMoveResult.code === "PACKAGE_INTERRUPTED" && !existsSync(INTERRUPT_OUTPUT_OLD) && existsSync(`${INTERRUPT_OUTPUT_OLD}.cp-transaction.json`));
  writeFileSync(`${INTERRUPT_OUTPUT_OLD}.cp-lock`, JSON.stringify({ pid: 999999, token: "stale-test-lock", createdAt: new Date().toISOString() }) + "\n", "utf8");
  const blockedByStaleLock = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", INTERRUPT_OUTPUT_OLD], OUTSIDE_CWD);
  check("packaging preserves recovery state while a stale lock is present", blockedByStaleLock.status !== 0 && lastJson(blockedByStaleLock).code === "PACKAGE_BUSY" && existsSync(`${INTERRUPT_OUTPUT_OLD}.cp-transaction.json`) && readdirSync(TMP).some((name) => name.startsWith(`.${INTERRUPT_OUTPUT_OLD.split(/[\\/]/).pop()}.cp-backup-`)));
  rmSync(`${INTERRUPT_OUTPUT_OLD}.cp-lock`, { force: true });
  const recoveredOldMove = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", INTERRUPT_OUTPUT_OLD], OUTSIDE_CWD);
  check("packaging recovers when interrupted before new package switch", recoveredOldMove.status === 0 && JSON.parse(readFileSync(join(INTERRUPT_OUTPUT_OLD, "plugin.json"), "utf8")).version === "3.1.0" && !existsSync(`${INTERRUPT_OUTPUT_OLD}.cp-transaction.json`));
  mkdirSync(EMPTY_OUTPUT, { recursive: true });
  const interruptedEmpty = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", EMPTY_OUTPUT], OUTSIDE_CWD, { CP_PACK_INTERRUPT_PHASE: "after-old-move" });
  const emptyMoveResult = lastJson(interruptedEmpty);
  check("packaging records an empty output directory in an interrupted transaction", interruptedEmpty.status === 3 && emptyMoveResult.code === "PACKAGE_INTERRUPTED" && !existsSync(EMPTY_OUTPUT) && existsSync(`${EMPTY_OUTPUT}.cp-transaction.json`));
  const recoveredEmpty = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", EMPTY_OUTPUT], OUTSIDE_CWD);
  check("packaging recovers and replaces an interrupted empty output directory", recoveredEmpty.status === 0 && JSON.parse(readFileSync(join(EMPTY_OUTPUT, "plugin.json"), "utf8")).version === "3.1.0" && !existsSync(`${EMPTY_OUTPUT}.cp-transaction.json`));
  const interruptedAbsent = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", ABSENT_OUTPUT], OUTSIDE_CWD, { CP_PACK_INTERRUPT_PHASE: "after-new-move" });
  const absentMoveResult = lastJson(interruptedAbsent);
  check("packaging records an initially absent output in its transaction", interruptedAbsent.status === 3 && absentMoveResult.code === "PACKAGE_INTERRUPTED" && existsSync(`${ABSENT_OUTPUT}.cp-transaction.json`));
  const recoveredAbsent = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", ABSENT_OUTPUT], OUTSIDE_CWD);
  check("packaging recovers an initially absent output after interruption", recoveredAbsent.status === 0 && JSON.parse(readFileSync(join(ABSENT_OUTPUT, "plugin.json"), "utf8")).version === "3.1.0" && !existsSync(`${ABSENT_OUTPUT}.cp-transaction.json`));
  const invalidTransactionPackage = runAt(PACK, ["--source", OLD_SOURCE, "--out", INVALID_TX_OUTPUT], OUTSIDE_CWD);
  const invalidTransactionHash = hashFile(join(INVALID_TX_OUTPUT, "checksums.json"));
  writeFileSync(`${INVALID_TX_OUTPUT}.cp-transaction.json`, "{broken", "utf8");
  const invalidTransactionRun = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", INVALID_TX_OUTPUT], OUTSIDE_CWD);
  check("packaging refuses a corrupt transaction without touching the existing package", invalidTransactionPackage.status === 0 && invalidTransactionRun.status !== 0 && lastJson(invalidTransactionRun).code === "PACKAGE_TRANSACTION_INVALID" && hashFile(join(INVALID_TX_OUTPUT, "checksums.json")) === invalidTransactionHash);
  const busyPackage = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", BUSY_OUTPUT], OUTSIDE_CWD);
  const busyHash = hashFile(join(BUSY_OUTPUT, "checksums.json"));
  writeFileSync(`${BUSY_OUTPUT}.cp-lock`, JSON.stringify({ pid: 1, token: "held", createdAt: new Date().toISOString() }) + "\n", "utf8");
  const busyRun = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", BUSY_OUTPUT], OUTSIDE_CWD);
  check("packaging refuses a pre-existing output lock without changing the package", busyPackage.status === 0 && busyRun.status !== 0 && lastJson(busyRun).code === "PACKAGE_BUSY" && hashFile(join(BUSY_OUTPUT, "checksums.json")) === busyHash && existsSync(`${BUSY_OUTPUT}.cp-lock`));
  rmSync(`${BUSY_OUTPUT}.cp-lock`, { force: true });
  const oldPackageAgain = runAt(PACK, ["--source", OLD_SOURCE, "--out", INTERRUPT_OUTPUT_NEW], OUTSIDE_CWD);
  check("packaging recreates a valid prior package for the second recovery window", oldPackageAgain.status === 0 && JSON.parse(readFileSync(join(INTERRUPT_OUTPUT_NEW, "plugin.json"), "utf8")).version === "3.0.9");
  const interruptedNewMove = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", INTERRUPT_OUTPUT_NEW], OUTSIDE_CWD, { CP_PACK_INTERRUPT_PHASE: "after-new-move" });
  const newMoveResult = lastJson(interruptedNewMove);
  check("packaging leaves a recoverable transaction after new package switch", interruptedNewMove.status === 3 && newMoveResult.code === "PACKAGE_INTERRUPTED" && JSON.parse(readFileSync(join(INTERRUPT_OUTPUT_NEW, "plugin.json"), "utf8")).version === "3.1.0" && existsSync(`${INTERRUPT_OUTPUT_NEW}.cp-transaction.json`));
  const recoveredNewMove = runAt(PACK, ["--source", join(ROOT, "plugin"), "--out", INTERRUPT_OUTPUT_NEW], OUTSIDE_CWD);
  check("packaging recovers when interrupted after new package switch", recoveredNewMove.status === 0 && JSON.parse(readFileSync(join(INTERRUPT_OUTPUT_NEW, "plugin.json"), "utf8")).version === "3.1.0" && !existsSync(`${INTERRUPT_OUTPUT_NEW}.cp-transaction.json`));
  check("package excludes instance data", !existsSync(join(PACKAGE, "events.db")) && !existsSync(join(PACKAGE, "memories")));
  const packageInstance = join(TMP, "package-instance");
  let r = run(join(PACKAGE, "launcher.cjs"), ["configure", "--instance", packageInstance, "--apply", "--non-interactive", "--adapter", "manual"]);
  check("packed launcher configures without source checkout", r.status === 0 && lastJson(r).ok === true);
  r = run(join(PACKAGE, "launcher.cjs"), ["health", "--instance", packageInstance]);
  check("packed launcher health is independent of project audit files", r.status === 0 && lastJson(r).code === "HEALTHY");
  const packageEvents = join(TMP, "package-events.jsonl");
  writeFileSync(packageEvents, JSON.stringify({ source_instance: "packed-source", source_id: "packed-1", revision: 1, session_id: "packed-session", role: "user", content: "packed event", ts: "2026-11-23T00:00:00Z", scope: "workspace", source_kind: "jsonl", source_ref: "packed-source#1" }) + "\n", "utf8");
  r = run(join(PACKAGE, "launcher.cjs"), ["enable", "--instance", packageInstance, "--yes"]);
  r = run(join(PACKAGE, "launcher.cjs"), ["ingest", "--instance", packageInstance, "--input", packageEvents]);
  check("packed launcher ingests standard events", r.status === 0 && lastJson(r).result.logged === 1);
  const packedEngine = join(PACKAGE, "engine");
  check("package contains candidate distillation engine", existsSync(join(packedEngine, "candidate-distill.js")));
  const packedDb = join(packageInstance, "events.db");
  const packedDbInit = runSql(packedDb, 'db.exec(' + JSON.stringify(`
    INSERT INTO events(instance, mid, session, role, content, ts, sensitive, source_id, source_revision, source_kind, source_ref, scope) VALUES('packed-source', 2, 'packed-session', 'user', '请记住：打包插件候选入口可执行', '2026-11-23T00:00:01.000Z', 0, 'packed-2', 1, 'jsonl', 'packed-source#2', 'workspace');
  `) + ');');
  check("packed event fixture initializes", packedDbInit.status === 0, packedDbInit.stderr || "");
  r = runExperimental(join(packedEngine, "memory-cli.js"), ["candidate", "distill-events", "--root", packageInstance]);
  check("packed engine runs candidate distillation dry-run", r.status === 0 && lastJson(r).wouldCreate === 1, r.stdout || r.stderr);
  r = runExperimental(join(packedEngine, "memory-cli.js"), ["candidate", "distill-events", "--apply", "--root", packageInstance]);
  check("packed engine writes only a pending candidate when applied", r.status === 0 && lastJson(r).created === 1 && existsSync(join(packageInstance, "candidates")) && (!existsSync(join(packageInstance, "memories")) || readdirSync(join(packageInstance, "memories")).length === 0), r.stdout || r.stderr);

  r = run(LAUNCHER, ["configure", "--instance", INSTANCE]);
  check("configure defaults to dry-run", r.status === 0 && lastJson(r).dryRun === true && !existsSync(join(INSTANCE, ".cp")));
  r = run(LAUNCHER, ["configure", "--instance", INSTANCE, "--apply", "--adapter", "manual", "--backfill", "none", "--scope", "workspace", "--retrieval", "bm25"]);
  const configured = lastJson(r);
  check("configure writes only instance configuration", configured.ok === true && existsSync(join(INSTANCE, ".cp", "instance-config.json")) && !existsSync(join(INSTANCE, "events.db")));
  check("configuration records generic adapter", configured.config.adapters[0].id === "manual");

  r = run(LAUNCHER, ["enable", "--instance", INSTANCE]);
  check("enable defaults to dry-run", lastJson(r).dryRun === true);
  r = run(LAUNCHER, ["enable", "--instance", INSTANCE, "--yes"]);
  check("enable changes lifecycle state", lastJson(r).state.effectiveState === "enabled");
  writeFileSync(join(INSTANCE, "events.db"), "user data sentinel", "utf8");
  mkdirSync(join(INSTANCE, "memories"), { recursive: true });
  writeFileSync(join(INSTANCE, "memories", "keep.md"), "keep", "utf8");
  r = run(LAUNCHER, ["disable", "--instance", INSTANCE, "--yes"]);
  check("disable preserves instance data", lastJson(r).state.effectiveState === "disabled" && existsSync(join(INSTANCE, "events.db")) && existsSync(join(INSTANCE, "memories", "keep.md")));
  r = run(LAUNCHER, ["uninstall", "--instance", INSTANCE]);
  check("uninstall defaults to dry-run", lastJson(r).dryRun === true && existsSync(join(INSTANCE, "events.db")));
  r = run(LAUNCHER, ["uninstall", "--instance", INSTANCE, "--yes"]);
  check("uninstall marks state but retains data", lastJson(r).state.effectiveState === "uninstalled" && existsSync(join(INSTANCE, "events.db")) && existsSync(join(INSTANCE, "memories", "keep.md")));
  const retainedInstanceId = JSON.parse(readFileSync(join(INSTANCE, ".cp", "instance-config.json"), "utf8")).instanceId;
  r = run(LAUNCHER, ["configure", "--instance", INSTANCE, "--apply", "--adapter", "manual"]);
  check("reconfigure remounts the preserved instance", r.status === 0 && lastJson(r).config.instanceId === retainedInstanceId && existsSync(join(INSTANCE, "events.db")) && existsSync(join(INSTANCE, "memories", "keep.md")));

  const source = join(TMP, "source.jsonl");
  writeFileSync(source, JSON.stringify({ id: "line-1", type: "user", content: "adapter source", ts: "2026-11-23T00:00:00Z" }) + "\n", "utf8");
  const syncInstance = join(TMP, "sync-instance");
  r = run(LAUNCHER, ["configure", "--instance", syncInstance, "--apply", "--non-interactive", "--adapter", "jsonl", "--source", source, "--source-instance", "source-file"]);
  check("configure persists an adapter source path", lastJson(r).config.adapters[0].config.file === source);
  r = run(LAUNCHER, ["sync", "--instance", syncInstance]);
  check("sync refuses a non-enabled plugin", r.status !== 0 && lastJson(r).code === "PLUGIN_DISABLED");
  r = run(LAUNCHER, ["enable", "--instance", syncInstance, "--yes"]);
  r = run(LAUNCHER, ["sync", "--instance", syncInstance]);
  const synced = lastJson(r);
  const cursorPath = join(syncInstance, ".cp", "cursors", "jsonl.json");
  const cursorBackup = readFileSync(cursorPath, "utf8");
  check("sync normalizes source records and stores cursor", synced.ok === true && synced.results[0].result.logged === 1 && existsSync(cursorPath));
  writeFileSync(cursorPath, "{broken cursor", "utf8");
  r = run(LAUNCHER, ["sync", "--instance", syncInstance]);
  check("sync rejects a malformed cursor", r.status !== 0 && lastJson(r).results[0].code === "CURSOR_INVALID");
  writeFileSync(cursorPath, cursorBackup, "utf8");
  r = run(LAUNCHER, ["sync", "--instance", syncInstance]);
  check("sync replay is idempotent", lastJson(r).results[0].result.logged === 0 && lastJson(r).results[0].result.skipped === 1);
  writeFileSync(source, [
    JSON.stringify({ id: "line-1", type: "user", content: "adapter source", ts: "2026-11-23T00:00:00Z" }),
    JSON.stringify({ id: "line-2", type: "assistant", content: "appended source", ts: "2026-11-23T00:00:01Z" }),
  ].join("\n") + "\n", "utf8");
  r = run(LAUNCHER, ["sync", "--instance", syncInstance]);
  check("sync accepts an append-only source extension", lastJson(r).results[0].result.logged === 1);
  const originalSource = readFileSync(source);
  writeFileSync(source, JSON.stringify({ id: "replacement", type: "user", content: "replaced source", ts: "2026-11-23T00:00:00Z" }) + "\n", "utf8");
  r = run(LAUNCHER, ["sync", "--instance", syncInstance]);
  check("sync blocks source replacement", r.status !== 0 && lastJson(r).results[0].code === "SOURCE_REPLACED");
  writeFileSync(source, originalSource);
  r = run(LAUNCHER, ["sync", "--instance", syncInstance]);
  check("restored source resumes from the retained cursor", r.status === 0 && lastJson(r).results[0].result.logged === 0 && lastJson(r).results[0].result.skipped === 2);

  const corruptPackage = join(TMP, "corrupt-upgrade-package");
  cpSync(PACKAGE, corruptPackage, { recursive: true });
  const corruptManifestPath = join(corruptPackage, "plugin.json");
  const corruptManifest = JSON.parse(readFileSync(corruptManifestPath, "utf8"));
  corruptManifest.version = "3.1.1";
  writeFileSync(corruptManifestPath, JSON.stringify(corruptManifest, null, 2) + "\n", "utf8");
  const corruptChecksumsPath = join(corruptPackage, "checksums.json");
  const corruptChecksums = JSON.parse(readFileSync(corruptChecksumsPath, "utf8"));
  corruptChecksums.version = corruptManifest.version;
  corruptChecksums.files["plugin.json"] = hashFile(corruptManifestPath);
  writeFileSync(corruptChecksumsPath, JSON.stringify(corruptChecksums, null, 2) + "\n", "utf8");
  writeFileSync(join(corruptPackage, "adapters", "manual", "adapter.json"), "{}\n", "utf8");
  const instanceFiles = [join(syncInstance, "events.db"), join(syncInstance, ".cp", "instance-config.json"), join(syncInstance, ".cp", "plugin-state.json"), cursorPath];
  const beforeRejectedUpgrade = instanceFiles.map(hashFile);
  r = run(LAUNCHER, ["upgrade", "--instance", syncInstance, "--package", corruptPackage, "--yes"]);
  const rejectedUpgrade = lastJson(r);
  check("upgrade checksum failure does not touch instance data", r.status !== 0 && rejectedUpgrade.code === "CHECKSUM_MISMATCH" && !existsSync(join(syncInstance, ".cp", "backups")) && instanceFiles.every((file, index) => hashFile(file) === beforeRejectedUpgrade[index]), JSON.stringify({ status: r.status, result: rejectedUpgrade, backupDirExists: existsSync(join(syncInstance, ".cp", "backups")), hashesBefore: beforeRejectedUpgrade, hashesAfter: instanceFiles.map(hashFile) }));

  const nextPackage = join(TMP, "next-upgrade-package");
  cpSync(PACKAGE, nextPackage, { recursive: true });
  const nextManifestPath = join(nextPackage, "plugin.json");
  const nextManifest = JSON.parse(readFileSync(nextManifestPath, "utf8"));
  nextManifest.version = "3.1.1";
  writeFileSync(nextManifestPath, JSON.stringify(nextManifest, null, 2) + "\n", "utf8");
  const nextChecksumsPath = join(nextPackage, "checksums.json");
  const nextChecksums = JSON.parse(readFileSync(nextChecksumsPath, "utf8"));
  nextChecksums.version = nextManifest.version;
  nextChecksums.files["plugin.json"] = hashFile(nextManifestPath);
  writeFileSync(nextChecksumsPath, JSON.stringify(nextChecksums, null, 2) + "\n", "utf8");
  const beforeReadyUpgrade = instanceFiles.map(hashFile);
  r = run(LAUNCHER, ["upgrade", "--instance", syncInstance, "--package", nextPackage, "--yes"]);
  const upgradeResult = lastJson(r);
  check("upgrade preflight leaves package replacement to the distributor", r.status === 2 && upgradeResult.code === "UPGRADE_PACKAGE_READY" && existsSync(join(upgradeResult.backup, "upgrade.json")) && instanceFiles.every((file, index) => hashFile(file) === beforeReadyUpgrade[index]));
  r = run(LAUNCHER, ["status", "--instance", syncInstance]);
  check("old plugin remains usable after upgrade preflight", r.status === 0 && lastJson(r).plugin.version === "3.1.0" && lastJson(r).state.effectiveState === "enabled");

  const mountedRoot = join(TMP, "plugin-mount");
  const mountedPackage = join(mountedRoot, "current");
  const mountedPrevious = join(mountedRoot, "previous");
  const mountedIncoming = join(mountedRoot, "incoming");
  cpSync(PACKAGE, mountedPackage, { recursive: true });
  const mountedInstance = join(TMP, "mounted-instance");
  const mountedSource = join(TMP, "mounted-source.jsonl");
  writeFileSync(mountedSource, JSON.stringify({ id: "mounted-1", type: "user", content: "mounted package event", ts: "2026-11-23T00:00:00Z" }) + "\n", "utf8");
  r = runAt(join(mountedPackage, "launcher.cjs"), ["configure", "--instance", mountedInstance, "--apply", "--non-interactive", "--adapter", "jsonl", "--source", mountedSource, "--source-instance", "mounted-source"], OUTSIDE_CWD);
  check("mounted package configures from outside the repository", r.status === 0 && lastJson(r).ok === true);
  r = runAt(join(mountedPackage, "launcher.cjs"), ["enable", "--instance", mountedInstance, "--yes"], OUTSIDE_CWD);
  check("mounted package enables from outside the repository", r.status === 0 && lastJson(r).state.effectiveState === "enabled");
  r = runAt(join(mountedPackage, "launcher.cjs"), ["sync", "--instance", mountedInstance], OUTSIDE_CWD);
  const mountedCursor = join(mountedInstance, ".cp", "cursors", "jsonl.json");
  mkdirSync(join(mountedInstance, "memories"), { recursive: true });
  writeFileSync(join(mountedInstance, "memories", "keep.md"), "mounted memory", "utf8");
  const mountedDataFiles = [join(mountedInstance, "events.db"), join(mountedInstance, ".cp", "instance-config.json"), join(mountedInstance, ".cp", "plugin-state.json"), mountedCursor, join(mountedInstance, "memories", "keep.md")];
  const mountedBeforeFailure = mountedDataFiles.map(hashFile);
  check("mounted package syncs from outside the repository", r.status === 0 && lastJson(r).results[0].result.logged === 1 && mountedDataFiles.every((file) => existsSync(file)));

  cpSync(PACKAGE, mountedIncoming, { recursive: true });
  const brokenManifestPath = join(mountedIncoming, "plugin.json");
  const brokenManifest = JSON.parse(readFileSync(brokenManifestPath, "utf8"));
  brokenManifest.version = "3.1.1";
  writeFileSync(brokenManifestPath, JSON.stringify(brokenManifest, null, 2) + "\n", "utf8");
  const brokenLauncherPath = join(mountedIncoming, "launcher.cjs");
  writeFileSync(brokenLauncherPath, "module.exports = ;\n", "utf8");
  const brokenChecksumsPath = join(mountedIncoming, "checksums.json");
  const brokenChecksums = JSON.parse(readFileSync(brokenChecksumsPath, "utf8"));
  brokenChecksums.version = brokenManifest.version;
  brokenChecksums.files["plugin.json"] = hashFile(brokenManifestPath);
  brokenChecksums.files["launcher.cjs"] = hashFile(brokenLauncherPath);
  writeFileSync(brokenChecksumsPath, JSON.stringify(brokenChecksums, null, 2) + "\n", "utf8");
  r = runAt(join(mountedPackage, "launcher.cjs"), ["upgrade", "--instance", mountedInstance, "--package", mountedIncoming, "--yes"], OUTSIDE_CWD);
  const mountedUpgrade = lastJson(r);
  check("isolated distribution rehearsal records the instance backup", r.status === 2 && mountedUpgrade.code === "UPGRADE_PACKAGE_READY" && existsSync(join(mountedUpgrade.backup, "upgrade.json")));

  renameSync(mountedPackage, mountedPrevious);
  renameSync(mountedIncoming, mountedPackage);
  const brokenSmoke = runAt(join(mountedPackage, "launcher.cjs"), ["status", "--instance", mountedInstance], OUTSIDE_CWD);
  check("isolated distribution rehearsal detects the broken replacement", brokenSmoke.status !== 0);
  rmSync(mountedPackage, { recursive: true, force: true });
  renameSync(mountedPrevious, mountedPackage);
  r = runAt(join(mountedPackage, "launcher.cjs"), ["health", "--instance", mountedInstance], OUTSIDE_CWD);
  check("isolated distribution rehearsal restores the previous package", r.status === 0 && lastJson(r).code === "HEALTHY" && lastJson(r).checks?.manifest === true);
  r = runAt(join(mountedPackage, "launcher.cjs"), ["status", "--instance", mountedInstance], OUTSIDE_CWD);
  const restoredMounted = lastJson(r);
  check("package rollback rehearsal preserves instance data and cursor", r.status === 0 && restoredMounted.plugin.version === "3.1.0" && restoredMounted.state.effectiveState === "enabled" && mountedDataFiles.every((file, index) => hashFile(file) === mountedBeforeFailure[index]));
  writeFileSync(mountedSource, [
    JSON.stringify({ id: "mounted-1", type: "user", content: "mounted package event", ts: "2026-11-23T00:00:00Z" }),
    JSON.stringify({ id: "mounted-2", type: "assistant", content: "event after package restore", ts: "2026-11-23T00:00:01Z" }),
  ].join("\n") + "\n", "utf8");
  r = runAt(join(mountedPackage, "launcher.cjs"), ["sync", "--instance", mountedInstance], OUTSIDE_CWD);
  const resumedMountedSync = lastJson(r);
  const mountedEventCount = JSON.parse(runSql(join(mountedInstance, "events.db"), 'process.stdout.write(JSON.stringify({ count: db.prepare("SELECT COUNT(*) c FROM events").get().c }));').stdout || "{}");
  check("restored package resumes the source cursor without replaying old events", r.status === 0 && resumedMountedSync.results[0].result.logged === 1 && resumedMountedSync.results[0].result.skipped === 1 && Number(mountedEventCount.count) === 2);

  const invalid = join(TMP, "invalid-events.jsonl");
  writeFileSync(invalid, JSON.stringify({ source_instance: "source-a", source_id: "bad", revision: 1, role: "garbage", content: "must reject", ts: "2026-11-23T00:00:00Z", source_kind: "jsonl", source_ref: "invalid#1" }) + "\n", "utf8");
  r = runExperimental(join(ROOT, "events.js"), ["ingest-normalized", "--input", invalid, "--root", EVENT_INSTANCE]);
  const invalidResult = lastJson(r);
  check("normalized adapter rejects invalid role before writing", invalidResult.logged === 0 && /role 非法/.test(invalidResult.error || ""));
  const engineEvents = join(ROOT, "events.js");
  const missingTimestamp = join(TMP, "missing-timestamp.jsonl");
  writeFileSync(missingTimestamp, JSON.stringify({ source_instance: "source-a", source_id: "missing-ts", revision: 1, session_id: "s1", role: "user", source_kind: "jsonl", source_ref: "source-a#missing-ts" }) + "\n", "utf8");
  r = runExperimental(engineEvents, ["ingest-normalized", "--input", missingTimestamp, "--root", EVENT_INSTANCE]);
  const missingTimestampResult = lastJson(r);
  check("normalized adapter rejects missing timestamp", r.status !== 0 && /ts/.test(missingTimestampResult.error || ""));

  const missingSourceRef = join(TMP, "missing-source-ref.jsonl");
  writeFileSync(missingSourceRef, JSON.stringify({ source_instance: "source-a", source_id: "missing-ref", revision: 1, session_id: "s1", role: "user", content: "missing ref", ts: "2026-11-23T00:00:00Z", scope: "workspace", source_kind: "jsonl" }) + "\n", "utf8");
  r = runExperimental(engineEvents, ["ingest-normalized", "--input", missingSourceRef, "--root", EVENT_INSTANCE]);
  const missingSourceRefResult = lastJson(r);
  check("normalized adapter rejects missing source_ref", r.status !== 0 && /source_kind\/source_ref/.test(missingSourceRefResult.error || ""));
  const invalidScope = join(TMP, "invalid-scope.jsonl");
  writeFileSync(invalidScope, JSON.stringify({ source_instance: "source-a", source_id: "invalid-scope", revision: 1, session_id: "s1", role: "user", content: "bad scope", ts: "2026-11-23T00:00:00Z", scope: "private", source_kind: "jsonl", source_ref: "source-a#invalid-scope" }) + "\n", "utf8");
  r = runExperimental(engineEvents, ["ingest-normalized", "--input", invalidScope, "--root", EVENT_INSTANCE]);
  check("normalized adapter rejects invalid scope", r.status !== 0 && /scope 非法/.test(lastJson(r).error || ""));

  const normalized = join(TMP, "events.jsonl");
  writeFileSync(normalized, [
    JSON.stringify({ source_instance: "source-a", source_id: "m1", revision: 1, session_id: "s1", role: "user", content: "same text", ts: "2026-11-23T00:00:00Z", scope: "workspace", source_kind: "jsonl", source_ref: "source-a#1" }),
    JSON.stringify({ source_instance: "source-a", source_id: "m2", revision: 1, session_id: "s1", role: "user", content: "same text", ts: "2026-11-23T00:00:01Z", scope: "workspace", source_kind: "jsonl", source_ref: "source-a#2" }),
  ].join("\n") + "\n", "utf8");
  r = runExperimental(engineEvents, ["ingest-normalized", "--input", normalized, "--root", EVENT_INSTANCE]);
  const ingested = lastJson(r);
  check("adapter contract accepts distinct same-content source IDs", r.status === 0 && ingested.logged === 2);
  r = runExperimental(engineEvents, ["ingest-normalized", "--input", normalized, "--root", EVENT_INSTANCE]);
  const replay = lastJson(r);
  check("normalized replay is idempotent", replay.logged === 0 && replay.skipped === 2);
  const conflict = join(TMP, "conflict.jsonl");
  writeFileSync(conflict, JSON.stringify({ source_instance: "source-a", source_id: "m1", revision: 1, session_id: "s1", role: "user", content: "changed content", ts: "2026-11-23T00:00:00Z", scope: "workspace", source_kind: "jsonl", source_ref: "source-a#1" }) + "\n", "utf8");
  r = runExperimental(engineEvents, ["ingest-normalized", "--input", conflict, "--root", EVENT_INSTANCE]);
  check("normalized ingestion rejects identity conflicts", r.status !== 0 && /来源身份冲突/.test(lastJson(r).error || ""));
  r = runExperimental(engineEvents, ["source-identity", "--root", EVENT_INSTANCE]);
  check("source identity health passes before corruption", r.status === 0 && lastJson(r).ok === true);
  const corruptIdentity = runSql(join(EVENT_INSTANCE, "events.db"), 'db.exec("DROP INDEX idx_events_source_identity"); db.prepare("INSERT INTO events(instance, mid, session, role, content, ts, source_id, source_revision, source_kind, source_ref, scope) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("source-a", 99, "s1", "user", "duplicate identity", "2026-11-23T00:00:02.000Z", "m1", 1, "jsonl", "source-a#duplicate", "workspace");');
  check("test fixture can create a duplicate identity only after dropping the index", corruptIdentity.status === 0);
  r = runExperimental(engineEvents, ["source-identity", "--root", EVENT_INSTANCE]);
  const corruptReport = lastJson(r);
  check("source identity corruption blocks writes and is diagnosable", r.status !== 0 && corruptReport.ok === false && corruptReport.before?.duplicateIdentities >= 1);
  r = runExperimental(engineEvents, ["source-identity", "--repair", "--root", EVENT_INSTANCE]);
  check("source identity repair refuses to guess which duplicate to keep", r.status !== 0 && lastJson(r).refused === true);
  const projectionInstance = join(TMP, "projection-failure-instance");
  mkdirSync(projectionInstance, { recursive: true });
  writeFileSync(join(projectionInstance, "daily"), "not a directory", "utf8");
  const projectionInput = join(TMP, "projection-failure.jsonl");
  writeFileSync(projectionInput, JSON.stringify({ source_instance: "projection-source", source_id: "projection-1", revision: 1, session_id: "projection-session", role: "user", content: "event must survive projection failure", ts: "2026-11-23T00:00:00Z", scope: "workspace", source_kind: "jsonl", source_ref: "projection-source#1" }) + "\n", "utf8");
  r = runExperimental(engineEvents, ["ingest-normalized", "--input", projectionInput, "--root", projectionInstance]);
  const projectionResult = lastJson(r);
  check("projection failure is visible without losing the event", r.status !== 0 && projectionResult.eventCommitted === true && projectionResult.projection?.ok === false);
  const projectionDb = join(projectionInstance, "events.db");
  const eventCount = JSON.parse(runSql(projectionDb, 'process.stdout.write(JSON.stringify({ count: db.prepare("SELECT COUNT(*) c FROM events").get().c }));').stdout || "{}");
  check("projection failure keeps the raw event", Number(eventCount.count) === 1);
  r = run(join(ROOT, "plugin", "launcher.cjs"), ["verify", "--instance", syncInstance]);
  check("plugin verify checks the instance without project audit files", r.status === 0 && lastJson(r).code === "VERIFIED");

  const nestedTranscript = join(TMP, "nested-transcript.jsonl");
  writeFileSync(nestedTranscript, [
    { type: "message", message: { id: "nested-1", role: "user", session_id: "session-a", ts: "2026-11-23T00:00:10Z", content: [{ type: "text", text: "nested session A" }] } },
    { type: "message", message: { id: "nested-2", role: "assistant", session_id: "session-b", ts: "2026-11-23T00:00:11Z", content: "nested session B" } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  const nestedInstance = join(TMP, "nested-instance");
  r = run(join(ROOT, "plugin", "launcher.cjs"), ["configure", "--instance", nestedInstance, "--apply", "--non-interactive", "--adapter", "transcript", "--source", nestedTranscript, "--source-instance", "nested-source"]);
  r = run(join(ROOT, "plugin", "launcher.cjs"), ["enable", "--instance", nestedInstance, "--yes"]);
  r = run(join(ROOT, "plugin", "launcher.cjs"), ["sync", "--instance", nestedInstance]);
  check("structured transcript preserves nested session identity", r.status === 0 && lastJson(r).results[0].result.logged === 2);
  const nestedSessions = JSON.parse(runSql(join(nestedInstance, "events.db"), 'process.stdout.write(JSON.stringify(db.prepare("SELECT session FROM events ORDER BY id").all().map((row) => row.session)));').stdout || "[]");
  check("nested transcript does not merge sessions", JSON.stringify(nestedSessions) === JSON.stringify(["session-a", "session-b"]));

  const objectIdentity = join(TMP, "object-identity.jsonl");
  writeFileSync(objectIdentity, JSON.stringify({ source_instance: "object-source", source_id: { id: 1 }, revision: 1, session_id: "s", role: "user", content: "must reject object identity", ts: "2026-11-23T00:00:20Z", scope: "workspace", source_kind: "jsonl", source_ref: "object#1" }) + "\n", "utf8");
  const objectInstance = join(TMP, "object-instance");
  r = run(join(ROOT, "plugin", "launcher.cjs"), ["configure", "--instance", objectInstance, "--apply", "--non-interactive", "--adapter", "jsonl", "--source", objectIdentity, "--source-instance", "object-source"]);
  r = run(join(ROOT, "plugin", "launcher.cjs"), ["enable", "--instance", objectInstance, "--yes"]);
  r = run(join(ROOT, "plugin", "launcher.cjs"), ["sync", "--instance", objectInstance]);
  check("structured source identity is rejected instead of stringified", r.status !== 0 && lastJson(r).results[0].code === "INVALID_SOURCE_ID");

  const lifecycle = readFileSync(join(INSTANCE, ".cp", "lifecycle.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  check("lifecycle history is append-only", lifecycle.some((e) => e.event === "configure") && lifecycle.some((e) => e.event === "uninstall"));
  console.log(`\nplugin-p0-test: ${passed} passed / 0 failed`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
