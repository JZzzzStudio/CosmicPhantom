// lib/graph-refine.js — 查询时证据精炼（T03，2026-11-18）
//
// 参考 ActionRAG（arXiv 2610.32752 §3.3）：初始检索只是提案，用局部图结构回溯修正分数。
// 论文要点（照抄的部分）：
//   · 亲和 A_ij = exp(-β·d_ij)·r_ij（d = 最短跳数，r = 路径上最强相关度，共享端点 r=1）
//   · 接收者归一 P = D⁻¹A（方向不可反，反了就成「概率搬砖」而非「证据平滑」）
//   · 定点 x = α(I-(1-α)P)⁻¹s（此处用 12 轮迭代近似闭式解）
//   · 种子保护 K = {i: x_i ≥ ε·max(x)} ∪ Top_S(s)，max=0 时只留 Top_S(s)
//   · 枢纽惩罚 h = min(1, 1/log(max(deg,2)))
//   · 物化：保留项之间路径上的缺失项按 flux 补入，只改本次候选集，不写存储
//
// 纪律：纯函数、零 IO、异常一律 fail-open（调用方拿回原始排序）。

export const DEFAULTS = { alpha: 0.5, beta: 1.0, hops: 2, eps: 0.15, protect: 5, materialize: 3, maxNodes: 200, iterations: 12, hubCut: 50 };

/**
 * 在局部子图上做接收者归一化扩散。
 * @param {Map<string,number>} seed   id → 原始分（非负）
 * @param {Map<string,{to:string,w:number}[]>} edges  id → 邻居
 * @param {object} opts
 * @returns {{scores:Map<string,number>, protected:Set<string>, materialized:{id:string,flux:number}[]}}
 */
// lib/failopen.js 是可选依赖：沙箱只复制根文件时会缺 lib/，缺了就退化为不计数（绝不因此禁用图精炼）
let recordFallback = () => {};
try { ({ recordFallback } = await import("./lib/failopen.js")); } catch { /* 无 lib 则不计数 */ }

export function refine(seed, edges, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  // 入口护栏（fail-open 的第一层）：坏输入直接退化为「无结果」，绝不抛
  if (!seed || typeof seed.entries !== "function") return { scores: new Map(), protected: new Set(), materialized: [] };
  const edgesSafe = (edges && typeof edges.get === "function") ? edges : new Map();
  try {
    // 0) 候选集：按种子分取前 maxNodes（含一对一跳邻居），硬上限防爆炸
    const byScore = [...seed.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const keep = new Set(byScore.slice(0, Math.min(byScore.length, Math.max(8, Math.floor(o.maxNodes / 2)))).map(([id]) => id));
    for (const id of [...keep]) {
      const nb = edgesSafe.get(id) || [];
      // 扩展截断（论文 expansion cutoff）：超高度节点不参与扩展，防止枢纽把候选池灌满
      if (nb.length > o.hubCut) continue;
      for (const e of nb) { if (keep.size >= o.maxNodes) break; keep.add(e.to); }
    }
    const ids = [...keep];
    const idx = new Map(ids.map((id, i) => [id, i]));
    const n = ids.length;
    if (n === 0) return { scores: new Map(), protected: new Set(), materialized: [] };

    // 1) 亲和矩阵（按跳数衰减；两跳内通过中间节点连接）
    const A = Array.from({ length: n }, () => new Float64Array(n));
    const deg = new Array(n).fill(0);
    const bestW = new Map();   // "i:j" → 最强边权（作为 r）
    const record = (a, b, w, d) => {
      const i = idx.get(a), j = idx.get(b);
      if (i === undefined || j === undefined || i === j || d > o.hops) return;
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      const prev = bestW.get(key);
      const r = Math.max(prev?.r || 0, Math.min(1, w));
      bestW.set(key, { r, d: Math.min(prev?.d ?? 9, d) });
    };
    for (const id of ids) for (const e of (edgesSafe.get(id) || [])) {
      record(id, e.to, e.w, 1);
      for (const e2 of (edgesSafe.get(e.to) || [])) record(id, e2.to, Math.min(e.w, e2.w), 2);
    }
    for (const [key, v] of bestW) {
      const [i, j] = key.split(":").map(Number);
      const a = Math.exp(-o.beta * v.d) * v.r;
      A[i][j] = a; A[j][i] = a;
      if (a > 0) { deg[i] += 1; deg[j] += 1; }
    }

    // 2) 种子向量 + 迭代 x = αs + (1-α)Px，P 行内按接收者归一（P = D⁻¹A）
    const s = ids.map((id) => Math.max(0, seed.get(id) || 0));
    let x = s.slice();
    for (let it = 0; it < o.iterations; it += 1) {
      const nx = new Array(n).fill(0);
      for (let i = 0; i < n; i += 1) {
        let acc = 0, den = 0;
        for (let j = 0; j < n; j += 1) if (A[i][j] > 0) { acc += A[i][j] * x[j]; den += A[i][j]; }
        nx[i] = o.alpha * s[i] + (1 - o.alpha) * (den > 0 ? acc / den : 0);
      }
      x = nx;
    }

    // 3) 种子保护 + 剪枝
    const maxX = Math.max(...x, 0);
    const protIdx = [...ids.keys()]
      .sort((a, b) => s[b] - s[a] || String(ids[a]).localeCompare(String(ids[b])))
      .slice(0, o.protect);
    const keepIdx = new Set(protIdx);
    if (maxX > 0) x.forEach((v, i) => { if (v >= o.eps * maxX) keepIdx.add(i); });

    // 4) 物化：保留项之间、但不在候选里的桥接项（按 flux 排序取前 L）
    const retained = [...keepIdx].map((i) => ids[i]);
    const inSet = new Set(retained);
    const flux = new Map();
    for (let a = 0; a < retained.length; a += 1) for (let b = a + 1; b < retained.length; b += 1) {
      const i = idx.get(retained[a]), j = idx.get(retained[b]);
      const Ai = A[i][j];
      if (!Ai) continue;
      const h = (k) => Math.min(1, 1 / Math.log(Math.max(deg[k], 2)));
      const base = (x[i] + x[j]) * Ai * h(i) * h(j);
      for (const mid of (edgesSafe.get(retained[a]) || [])) {
        if (!inSet.has(mid.to) && (edgesSafe.get(mid.to) || []).some((e) => e.to === retained[b])) {
          flux.set(mid.to, Math.max(flux.get(mid.to) || 0, base * mid.w));
        }
      }
    }
    const materialized = [...flux.entries()].sort((p, q) => q[1] - p[1]).slice(0, o.materialize)
      .map(([id, f]) => ({ id, flux: +f.toFixed(4) }));

    const scores = new Map();
    for (const id of retained) scores.set(id, +(x[idx.get(id)] || 0).toFixed(6));
    for (const m of materialized) if (!scores.has(m.id)) scores.set(m.id, 0.0001);
    return { scores, protected: new Set(retained), materialized };
  } catch {
    // fail-open：任何异常都退回「只按原始分」
    recordFallback("graph.refine", "exception");
    const sorted = [...seed.entries()].sort((a, b) => b[1] - a[1]);
    return { scores: new Map(sorted), protected: new Set(sorted.map(([k]) => k)), materialized: [] };
  }
}