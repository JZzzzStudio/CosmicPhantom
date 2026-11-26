#!/usr/bin/env node
/**
 * migrate-monthly.js — memories 一卡一文件 → 月度分桶单文件 一次性迁移（2026-09-01 拍板）
 *
 * 形态：memories/YYYY-MM.md（桶头 + frontmatter 条目 + §§§ 分隔）
 * 安全：原文件移入 backup/memories-flat-<时间戳>/（相对子目录结构保留，不删除）；幂等（同 id 已入桶则跳过）
 * 用法：
 *   node migrate-monthly.js --dry-run [--root R]     # 只报告分月计划
 *   node migrate-monthly.js --apply [--root R]       # 执行迁移（含对账）
 * 迁移后须重建派生索引：node memory-cli.js index && node memory-cli.js relink && node embed.js build
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { listMemoryEntries, splitBucketBlocks, isBucketFileName } from "../../memory-retrieval.js";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const DRY = process.argv.includes("--dry-run");
const APPLY = process.argv.includes("--apply");
const MEM_DIR = join(ROOT, "memories");
const SEP = "§§§";

function localMonth(metaCreated, file) {
  const c = String(metaCreated || "").match(/^(\d{4}-\d{2})/);
  if (c) return c[1];
  try { return new Date(statSync(file).mtimeMs - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 7); } catch { return "unknown"; }
}

function out(o) { process.stdout.write(JSON.stringify(o, null, 2) + "\n"); process.exitCode = o.ok ? 0 : 1; }

const entries = existsSync(MEM_DIR) ? listMemoryEntries(MEM_DIR) : [];
const legacy = entries.filter(e => !e.bucket);
const byMonth = new Map();
for (const e of legacy) {
  const month = localMonth(e.meta.created, e.file);
  if (!byMonth.has(month)) byMonth.set(month, []);
  byMonth.get(month).push(e);
}

if (!APPLY) {
  out({
    ok: true, dryRun: true,
    legacyFiles: legacy.length, bucketFiles: entries.filter(e => e.bucket).length,
    plan: [...byMonth.entries()].sort().map(([month, list]) => ({ month, file: `${month}.md`, cards: list.length, ids: list.map(e => e.id).slice(0, 5), more: Math.max(0, list.length - 5) })),
    note: "dry-run 未写任何文件；--apply 后原文件移入 backup/memories-flat-<ts>/ 不删除",
  });
} else {
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const backupDir = join(ROOT, "backup", `memories-flat-${ts}`);
  mkdirSync(backupDir, { recursive: true });
  const moved = [], written = {}, skipped = [];
  for (const [month, list] of [...byMonth.entries()].sort()) {
    const bucketFile = join(MEM_DIR, `${month}.md`);
    const existingIds = new Set(isBucketFileName(bucketFile) && existsSync(bucketFile)
      ? splitBucketBlocks(readFileSync(bucketFile, "utf8")).map(b => (b.match(/^id:\s*(\S+)/m) || [])[1]).filter(Boolean)
      : []);
    const blocks = [], moveList = [];
    for (const e of list) {
      if (existingIds.has(e.id)) { skipped.push(`${e.id}（已入桶）`); continue; }
      blocks.push(e.raw);
      moveList.push(e);
    }
    if (!blocks.length) continue;
    // 先写桶（先落后删，DeerMem 删除保护同款哲学：桶落成并核验后才移原文件）
    const header = `# ${month} 记忆桶`;
    const prev = existsSync(bucketFile) ? readFileSync(bucketFile, "utf8") : "";
    const mergedText = prev + blocks.map(b => b.replace(/\s+$/, "") + "\n\n" + SEP + "\n").join("");
    writeFileSync(bucketFile, mergedText, "utf8");
    const inBucket = new Set(splitBucketBlocks(readFileSync(bucketFile, "utf8")).map(b => (b.match(/^id:\s*(\S+)/m) || [])[1]));
    for (const e of moveList) {
      if (!inBucket.has(e.id)) { skipped.push(`${e.id}（桶写入后核验缺失，原文件保留）`); continue; }
      const rel = relative(MEM_DIR, e.file);
      const dst = join(backupDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(e.file, dst);
      moved.push(e.id);
      written[month] = (written[month] || 0) + 1;
    }
  }
  out({
    ok: true, applied: true,
    moved: moved.length, movedIds: moved.slice(0, 10), more: Math.max(0, moved.length - 10),
    byMonth: written,
    skipped: skipped.slice(0, 10),
    backup: backupDir,
    next: "node memory-cli.js index && node memory-cli.js relink && node embed.js build（派生索引重建）",
  });
}
