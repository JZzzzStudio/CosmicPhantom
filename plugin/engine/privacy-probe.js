// privacy-probe.js — T13 隐私探针（F55，2026-11-19）
// 依据：MixUA 的 Aud(e) ⊆ G(e) ∩ D(e)。CP 单用户，只留一条判据：
//   **机密型内容 / 私有偏好不得出现在全局注入面**（AGENTS.md / MEMORY.md / .context/CONTEXT.md / views/*.md）。
//
// 判据为何收敛成"机密模式"而非"整句比对"（2026-11-19 生产实测）：
//   整句比对在 209 张 workspace 卡上误报 90 条 —— 因为 MEMORY.md/CONTEXT.md 本来就合法引用用户原话。
//   真正的泄漏是凭据/隐私，所以机密只认高置信度模式。
// 2026-11-19 扩展（票 25）：另加"私有偏好整句"判据，阈值 24 字起，仅在卡片 type=偏好/规则 时检查，
//   与机密泄漏分开计数（preferenceLeaks），避免两类问题混成一个数。
export const SECRET_PATTERNS = [
  { name: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "github-classic", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "openai-key", re: /sk-[A-Za-z0-9]{16,}/ },
  { name: "aws-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "assign-secret", re: /(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9\-_]{12,}/i },
  { name: "cn-id", re: /(?:身份证|护照号|银行卡号)\s*[:：]?\s*\d{6,}/ },
];
export const GLOBAL_SURFACE_FILES = ["AGENTS.md", "MEMORY.md", ".context/CONTEXT.md", "views/current.md"];

const PREF_TYPES = ["偏好", "规则"];

/** 在一段文本里找机密模式 */
export function scanText(text) {
  const hits = [];
  for (const p of SECRET_PATTERNS) {
    const m = String(text || "").match(new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g"));
    if (m) hits.push({ pattern: p.name, n: m.length, sample: String(m[0]).slice(0, 12) + "…" });
  }
  return hits;
}

function cardBody(raw) { return String(raw || "").replace(/^---[\s\S]*?---\s*/, ""); }
function squash(t) { return String(t || "").replace(/\s+/g, "").replace(/[，。；：、“”‘’（）()【】\[\]]/g, ""); }

/**
 * @param {{id:string, scope:string, raw:string}[]} entries 非 global 的条目
 * @param {string} surfacesText 全局注入面的合并文本
 */
export function probe(entries, surfacesText, options = {}) {
  const text = String(surfacesText || "");
  const inSurfaces = scanText(text);
  const leaks = [];
  let skipped = 0;
  for (const e of entries) {
    const hits = scanText(e.raw);
    if (!hits.length) { skipped += 1; continue; }
    for (const h of hits) {
      if (inSurfaces.some((s) => s.pattern === h.pattern)) {
        leaks.push({ id: e.id || "?", scope: e.scope || "?", pattern: h.pattern });
        break;
      }
    }
  }

  // 私有偏好整句泄漏：卡片 type 是偏好/规则、作用域非 global，正文整句（≥24 字）出现在全局注入面
  const prefSurface = squash(options.preferenceSurface || text);
  const preferenceLeaks = [];
  for (const e of entries) {
    const type = (String(e.raw || "").match(/^type:\s*(.+)$/m) || [])[1];
    if (!type || !PREF_TYPES.includes(type.trim())) continue;
    const sentences = cardBody(e.raw).split("。").flatMap((x) => x.split("\n"));
    for (const sent of sentences) {
      const line = sent.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
      if (line.length < 24) continue;
      if (prefSurface.includes(squash(line))) {
        preferenceLeaks.push({ id: e.id || "?", scope: e.scope || "?", excerpt: line.slice(0, 30) });
        break;
      }
    }
  }

  return { checked: entries.length, skipped, leaks, leakCount: leaks.length, preferenceLeaks, preferenceLeakCount: preferenceLeaks.length, surfaceHits: inSurfaces };
}