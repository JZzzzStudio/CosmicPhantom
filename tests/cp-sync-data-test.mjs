#!/usr/bin/env node
// Data-repository guard: vectors are tracked; model weights remain ignored.
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const data = mkdtempSync(join(tmpdir(), "cp-sync-data-"));
const sync = join(root, "cp-sync.cjs");
const git = process.env.CP_GIT || join(root, "tools", "git", "cmd", "git.exe");
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`PASS ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}
function gitCheck(paths) {
  return spawnSync(git, ["-C", data, "check-ignore", ...paths], { encoding: "utf8" });
}
try {
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, ".gitignore"), "embedding-db/\n", "utf8");
  const run = spawnSync(process.execPath, [sync, "data", "status"], {
    cwd: root,
    env: { ...process.env, CP_DATA_DIR: data },
    encoding: "utf8",
    timeout: 60000,
  });
  const ignore = readFileSync(join(data, ".gitignore"), "utf8").split(/\r?\n/).filter(Boolean);
  check("old whole-directory ignore is repaired", ignore.includes("embedding-db/models/") && !ignore.includes("embedding-db/"), run.stderr);

  mkdirSync(join(data, "embedding-db", "models"), { recursive: true });
  writeFileSync(join(data, "embedding-db", "vectors.json"), "{}", "utf8");
  writeFileSync(join(data, "embedding-db", "models", "model.onnx"), "model", "utf8");
  const vectors = gitCheck(["embedding-db/vectors.json"]);
  const model = gitCheck(["embedding-db/models/model.onnx"]);
  check("vectors.json is not ignored", vectors.status !== 0, vectors.stdout || vectors.stderr);
  check("model weights remain ignored", model.status === 0, model.stdout || model.stderr);
} finally {
  rmSync(data, { recursive: true, force: true });
}
if (failed) process.exit(1);
