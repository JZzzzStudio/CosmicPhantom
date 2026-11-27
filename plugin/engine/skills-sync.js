#!/usr/bin/env node
/**
 * Check declared skill mounts against the instance skills directory.
 *
 * Mounts are opt-in through <root>/skill-mounts.json. The absence of that
 * file means that no machine directories are inspected.
 *
 * Configuration:
 *   {
 *     "mounts": [
 *       { "name": "agent-skills", "path": ".agent/skills" }
 *     ]
 *   }
 *
 * Relative paths are resolved from --home. Absolute paths are used as-is.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function loadSkillMounts(ROOT, HOME = homedir()) {
  const configPath = join(ROOT, "skill-mounts.json");
  if (!existsSync(configPath)) return { configured: false, mounts: [] };
  let config;
  try {
    config = JSON.parse(stripBom(readFileSync(configPath, "utf8")));
  } catch (error) {
    return { configured: true, mounts: [], error: `skill-mounts.json 无法解析: ${error.message}` };
  }
  if (!config || !Array.isArray(config.mounts)) {
    return { configured: true, mounts: [], error: "skill-mounts.json 必须包含 mounts 数组" };
  }
  const seen = new Set();
  const mounts = [];
  for (const [index, item] of config.mounts.entries()) {
    const name = String(item?.name || "").trim();
    const mountPath = String(item?.path || "").trim();
    if (!name || !mountPath) return { configured: true, mounts: [], error: `skill-mounts.json mounts[${index}] 需要 name 和 path` };
    if (seen.has(name)) return { configured: true, mounts: [], error: `skill-mounts.json mounts[${index}] 的 name 重复: ${name}` };
    seen.add(name);
    mounts.push({ name, path: isAbsolute(mountPath) ? mountPath : resolve(HOME, mountPath) });
  }
  return { configured: true, mounts };
}

/**
 * Return [{ mount, skill, ok, detail }]. No config means no mount checks.
 */
export function checkSkillSync(ROOT, HOME = homedir()) {
  const config = loadSkillMounts(ROOT, HOME);
  if (!config.configured) return [];
  if (config.error) return [{ mount: "configuration", skill: "skill-mounts.json", ok: false, detail: config.error }];
  if (!config.mounts.length) return [];

  const srcDir = join(ROOT, "skills");
  if (!existsSync(srcDir)) return [{ mount: "source", skill: "skills/", ok: false, detail: "真源 skills 目录不存在" }];
  const skills = readdirSync(srcDir).filter((dir) => existsSync(join(srcDir, dir, "SKILL.md"))).sort();
  if (!skills.length) return [{ mount: "source", skill: "skills/", ok: false, detail: "真源 skills 下无 SKILL.md" }];

  const results = [];
  for (const mount of config.mounts) {
    if (!existsSync(mount.path)) {
      results.push({ mount: mount.name, skill: "skills/", ok: false, detail: `挂载目录不存在: ${mount.path}` });
      continue;
    }
    for (const skill of skills) {
      const source = stripBom(readFileSync(join(srcDir, skill, "SKILL.md"), "utf8"));
      const targetPath = join(mount.path, skill, "SKILL.md");
      if (!existsSync(targetPath)) {
        results.push({ mount: mount.name, skill, ok: false, detail: `挂载位缺 ${skill}/SKILL.md（复制真源同步）` });
        continue;
      }
      const target = stripBom(readFileSync(targetPath, "utf8"));
      results.push({ mount: mount.name, skill, ok: target === source, detail: target === source ? "一致" : "与真源不一致（复制真源同步）" });
    }
  }
  return results;
}

export { loadSkillMounts };

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const rootIndex = process.argv.indexOf("--root");
  const homeIndex = process.argv.indexOf("--home");
  const ROOT = rootIndex >= 0 && process.argv[rootIndex + 1] ? process.argv[rootIndex + 1] : join(homedir(), ".cosmic-phantom");
  const HOME = homeIndex >= 0 && process.argv[homeIndex + 1] ? process.argv[homeIndex + 1] : homedir();
  process.stdout.write(JSON.stringify(checkSkillSync(ROOT, HOME), null, 2) + "\n");
}
