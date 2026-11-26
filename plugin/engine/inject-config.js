import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const INJECT_CONFIG_FILE = "inject.config.json";

export const DEFAULT_INJECT_CONFIG = Object.freeze({
  identityCardBytes: 1800,
  recoveryBytes: 1800,
  memoryTop: 2,
  memoryBytes: 1200,
  warnAt: 0.9,
});

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function ratio(value, fallback) {
  return typeof value === "number" && value > 0 && value <= 1 ? value : fallback;
}

export function loadInjectConfig(root) {
  const file = join(root, INJECT_CONFIG_FILE);
  if (!existsSync(file)) return { ...DEFAULT_INJECT_CONFIG, source: "default", errors: [`missing ${INJECT_CONFIG_FILE}`] };

  try {
    const raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return {
      identityCardBytes: positiveInteger(raw.identityCardBytes, DEFAULT_INJECT_CONFIG.identityCardBytes),
      recoveryBytes: positiveInteger(raw.recoveryBytes, DEFAULT_INJECT_CONFIG.recoveryBytes),
      memoryTop: positiveInteger(raw.memoryTop, DEFAULT_INJECT_CONFIG.memoryTop),
      memoryBytes: positiveInteger(raw.memoryBytes, DEFAULT_INJECT_CONFIG.memoryBytes),
      warnAt: ratio(raw.warnAt, DEFAULT_INJECT_CONFIG.warnAt),
      source: file,
      errors: [],
    };
  } catch (error) {
    return { ...DEFAULT_INJECT_CONFIG, source: file, errors: [String(error.message || error)] };
  }
}
