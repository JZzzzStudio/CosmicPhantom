// fusion-sweep.cjs — 票 31：融合参数扫参（只读，不改文件）
// 目标：heldout ≥ 0.6666 且 golden MRR ≥ 0.787，两侧都不许退。
const { spawnSync } = require('node:child_process');

const NODE = process.execPath;
function evalSet(set, env) {
  const args = ['eval/eval-retrieval.js', '--k', '5'];
  if (set) args.push('--set', set);
  const r = spawnSync(NODE, args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
  try {
    const s = r.stdout.slice(r.stdout.indexOf('{'));
    const j = JSON.parse(s);
    return { recall: j.summary.recallAtK, mrr: j.summary.mrr, mode: j.summary.mode };
  } catch { return { recall: null, mrr: null, err: String(r.stdout || r.stderr).slice(0, 120) }; }
}

const combos = [];
for (const lexW of [1, 1.5, 2, 3]) for (const vecW of [1, 0.7]) for (const k of [30, 60]) combos.push({ lexW, vecW, k });

const rows = [];
for (const c of combos) {
  const env = { CP_LEX_W: String(c.lexW), CP_VEC_W: String(c.vecW), CP_RRF_K: String(c.k) };
  const h = evalSet('heldout', env);
  const g = evalSet(null, env);
  rows.push({ ...c, hRecall: h.recall, hMrr: h.mrr, gRecall: g.recall, gMrr: g.mrr });
  console.log(`lexW=${c.lexW} vecW=${c.vecW} k=${c.k} | heldout ${h.recall}/${h.mrr} | golden ${g.recall}/${g.mrr}`);
}
const ok = rows.filter((r) => (r.hRecall || 0) >= 0.6666 && (r.gMrr || 0) >= 0.787 && (r.gRecall || 0) >= 1);
console.log('\n满足两侧的候选：', ok.length);
ok.forEach((r) => console.log('  ', JSON.stringify(r)));