#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EVENTS = join(ROOT, "events.js");
const TMP = mkdtempSync(join(tmpdir(), "cp-event-concurrency-"));
const INSTANCE = join(TMP, "instance");
mkdirSync(INSTANCE, { recursive: true });
const jobs = 8;

function runSql(code) {
  return spawnSync(process.execPath, ["--experimental-sqlite", "-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); ${code} db.close();`, join(INSTANCE, "events.db")], { encoding: "utf8", timeout: 120000 });
}
function runJob(index) {
  const input = join(TMP, `input-${index}.jsonl`);
  writeFileSync(input, JSON.stringify({
    source_instance: "concurrent-source",
    source_id: `event-${index}`,
    revision: 1,
    session_id: `session-${index}`,
    role: "user",
    content: `concurrent event ${index}`,
    ts: `2026-11-23T00:00:${String(index).padStart(2, "0")}Z`,
    scope: "workspace",
    source_kind: "jsonl",
    source_ref: `concurrent-source#${index}`,
  }) + "\n", "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-sqlite", EVENTS, "ingest-normalized", "--input", input, "--root", INSTANCE], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let result = null;
      try { result = JSON.parse(lines[lines.length - 1] || "{}"); } catch (error) { return reject(new Error(`job ${index} 无 JSON: ${error.message}; stderr=${stderr}`)); }
      resolve({ status, result, stderr });
    });
  });
}

try {
  const results = await Promise.all(Array.from({ length: jobs }, (_, index) => runJob(index)));
  assert.equal(results.filter(({ result }) => result.eventCommitted === true).length, jobs, JSON.stringify(results));
  const countResult = runSql('process.stdout.write(JSON.stringify({ events: db.prepare("SELECT COUNT(*) c FROM events WHERE instance = \'concurrent-source\'").get().c }));');
  const count = JSON.parse(countResult.stdout || "{}");
  // Normalized events use source_instance as events.instance; no writer may disappear under BEGIN IMMEDIATE.
  assert.equal(Number(count.events), jobs, JSON.stringify(count));
  const status = spawnSync(process.execPath, ["--experimental-sqlite", EVENTS, "status", "--root", INSTANCE], { encoding: "utf8", timeout: 120000 });
  const statusJson = JSON.parse(status.stdout.trim().split(/\r?\n/).pop() || "{}");
  assert.equal(statusJson.sourceIdentity?.ok, true, JSON.stringify(statusJson));
  assert.equal(existsSync(join(INSTANCE, ".cp-projection.lock")), false, "投影锁未释放");
  console.log(`event-concurrency-test: ${jobs} parallel writers preserved all raw events`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
