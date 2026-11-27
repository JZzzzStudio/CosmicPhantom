"use strict";

const fs = require("node:fs");
const childProcess = require("node:child_process");
const auditFile = process.env.CP_PROCESS_AUDIT_LOG;

function record(method, file, args) {
  if (!auditFile) return;
  try {
    fs.appendFileSync(auditFile, `${JSON.stringify({
      pid: process.pid,
      method,
      file: String(file || ""),
      args: Array.isArray(args) ? args.map((value) => String(value)) : [],
    })}\n`, "utf8");
  } catch {}
}

for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[method];
  if (typeof original !== "function") continue;
  childProcess[method] = function auditedChildProcess(file, args, ...rest) {
    record(method, file, Array.isArray(args) ? args : []);
    return original.call(this, file, args, ...rest);
  };
}
