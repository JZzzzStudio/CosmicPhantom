/**
 * verify-absorbed.js — 吸收台账「待裁决」判定（F23 单实现）
 *
 * 2026-10-28 抽出：原逻辑内联在 memory-cli.js verify 里，无法单测；
 *   且 2026-10-28 前误取「理由列」（常含"借鉴"）导致已决项永久报红。
 * 口径：只看状态列（第 5 列）的 待裁决 / 待拍板 / 登记备选；理由列不参与判定。
 *
 * 返回：{ stale: string|null, oldest: {date, sys}|null }
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PENDING = /待裁决|待拍板|登记备选/;
const ROW = /^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*[^|]+\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]*)\|/;

export function checkAbsorbedLedger(root, now = Date.now()) {
  const file = join(root, "core", "absorbed-notes.md");
  if (!existsSync(file)) return { stale: null, oldest: null, missing: true };
  let oldest = null;
  for (const line of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = line.match(ROW);
    if (!m) continue;
    if (!PENDING.test(m[3])) continue;   // 只看状态列
    if (!oldest || m[2] < oldest.date) oldest = { date: m[2], sys: m[1].trim() };
  }
  if (!oldest) return { stale: null, oldest: null };
  const days = Math.floor((now - Date.parse(oldest.date)) / 86400000);
  if (days <= 30) return { stale: null, oldest };
  return {
    stale: `吸收台账「待裁决」最老 ${days} 天（${oldest.sys}，对标 ${oldest.date}）——卡在用户，请拍板或改判否决`,
    oldest,
  };
}
