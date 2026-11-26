#!/usr/bin/env node
/**
 * skills-sync.js — skill 挂载位一致性守卫（F8，2026-08-17 实装）
 *
 * 防"同步失真"复发：2026-08-13 事故——daily 记录"ZCode 挂载位已同步且 diff 一致"，
 * 但挂载位副本 mtime 证实同步从未落盘（长期停留 30 天旧版），两次被用户抓包才暴露。
 * 守卫职责：真源 skills 下每个 SKILL.md 与各宿主挂载位副本逐字节一致，不一致显式报出。
 *
 * 用法（install-check / memory-cli verify 共用；也可直接跑）:
 *   node skills-sync.js [--root <cosmic根>] [--home <用户主目录>]
 * 输出: [{ host, skill, ok, detail }]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// 宿主注册表（2026-09-15 立）：单一真源 hosts.json，供本文件与 sync-reply-policy.mjs 共用。
// 此前为硬编码数组，与 sync-reply-policy 的 HOST_TARGETS 分叉（后者缺 Breezell），
// 新增宿主时漏改一处的症状 = 某宿主的技能/门禁不参与对账，静默无声。
// 筛选条件：挂载 skills（skills:true）且未除名（role !== "retired"）。
// 宿主无 skills 目录时仍自动跳过（未挂载 ≠ 不一致）。
function loadSkillHosts(ROOT) {
  try {
    const raw = readFileSync(join(ROOT, "hosts.json"), "utf8").replace(/^\uFEFF/, "");
    const hosts = (JSON.parse(raw).hosts || []).filter((h) => h.skills === true && h.role !== "retired");
    if (hosts.length) return hosts.map((h) => ({ name: h.name, dir: h.dir }));
  } catch { /* hosts.json 缺失/损坏 → 走兜底，宁可多查不漏查 */ }
  return [
    { name: "Claude Code", dir: ".claude" },
    { name: "ZCode", dir: ".zcode" },
    { name: "Breezell", dir: ".breezell" },
  ];
}

function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

/**
 * 检查真源 skills/ 下每个 SKILL.md 是否与各宿主挂载位副本一致。
 * 返回 [{ host, skill, ok, detail }]；挂载位缺失/不一致 → ok:false。
 */
export function checkSkillSync(ROOT, HOME = homedir()) {
  const results = [];
  const srcDir = join(ROOT, "skills");
  if (!existsSync(srcDir)) return [{ host: "真源", skill: "skills/", ok: false, detail: "真源 skills 目录不存在" }];
  const skills = readdirSync(srcDir).filter((d) => existsSync(join(srcDir, d, "SKILL.md"))).sort();
  if (!skills.length) return [{ host: "真源", skill: "skills/", ok: false, detail: "真源 skills 下无 SKILL.md" }];
  for (const h of loadSkillHosts(ROOT)) {
    const mount = join(HOME, h.dir, "skills");
    if (!existsSync(mount)) continue; // 未挂载宿主跳过，不算不一致
    for (const s of skills) {
      const src = stripBom(readFileSync(join(srcDir, s, "SKILL.md"), "utf8"));
      const dstPath = join(mount, s, "SKILL.md");
      if (!existsSync(dstPath)) {
        results.push({ host: h.name, skill: s, ok: false, detail: `挂载位缺 ${s}/SKILL.md（复制真源同步）` });
        continue;
      }
      const dst = stripBom(readFileSync(dstPath, "utf8"));
      results.push({ host: h.name, skill: s, ok: dst === src, detail: dst === src ? "一致" : "与真源不一致（复制真源同步）" });
    }
  }
  return results;
}

// 直接运行：输出 JSON（--root/--home 可覆盖）
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
  const HOME = process.argv.includes("--home") ? process.argv[process.argv.indexOf("--home") + 1] : homedir();
  process.stdout.write(JSON.stringify(checkSkillSync(ROOT, HOME), null, 2) + "\n");
}
