export function uniqueBinaryNdcg(matchesByRank, expectedAnchors, k) {
  const expectedCount = Number(expectedAnchors);
  if (!Number.isInteger(expectedCount) || expectedCount < 1) return null;
  const seen = new Set();
  let dcg = 0;
  matchesByRank.slice(0, k).forEach((matches, index) => {
    const newlyMatched = [...new Set(matches)].filter(anchor => !seen.has(anchor));
    for (const anchor of newlyMatched) seen.add(anchor);
    if (newlyMatched.length) dcg += 1 / Math.log2(index + 2);
  });
  const idealCount = Math.min(expectedCount, k);
  const idcg = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, gain) => sum + gain, 0);
  return +(dcg / idcg).toFixed(4);
}
