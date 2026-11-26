#!/usr/bin/env node
// Cross-process fail-open counter regression: calls and fallbacks must not be lost.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "cp-failopen-"));
const modulePath = pathToFileURL(join(process.cwd(), "lib", "failopen.js")).href;
const children = 6;
const iterations = 12;
const script = `import { recordCall, recordFallback } from ${JSON.stringify(modulePath)};\nfor (let i = 0; i < ${iterations}; i += 1) { recordCall("counter-test"); recordFallback("counter-test", "parallel"); }`;

function runChild() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CP_ROOT: root };
    delete env.CP_FAILOPEN_DISABLE;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`child exited ${code} ${signal || ""}: ${stderr}`)));
  });
}

try {
  await Promise.all(Array.from({ length: children }, runChild));
  const stats = JSON.parse(readFileSync(join(root, "failopen-stats.json"), "utf8"));
  const row = stats["counter-test"] || {};
  const expected = children * iterations;
  const pass = row.calls === expected && row.fallbacks === expected && row.reasons?.parallel === expected;
  console.log(`${pass ? "PASS" : "FAIL"} fail-open counter: calls=${row.calls || 0}/${expected} fallbacks=${row.fallbacks || 0}/${expected}`);
  if (!pass) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
