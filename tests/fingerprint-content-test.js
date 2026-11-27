// tests/fingerprint-content-test.js — A3 回归：卡片内容变了、id 不变 → cards.digest 必须变
// 背景（pro/audit-2026-11-19.md A3）：旧实现 digest = sha256(ids.join(","))，改正文不报警 → 换机比对假绿。
// 判据：只测公共接口（resume-context.js fingerprint 的 JSON 输出），不测内部函数。
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writePublicState, writePublicMemory, writePublicContext, writePublicCore } = require("./fixtures/public-fixtures.cjs");

const REAL = path.resolve(__dirname, "..");
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-fp-"));
let pass = 0, fail = 0;
function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail}`); }
}

function copy(relative) {
  const target = path.join(SB, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REAL, relative), target);
}
for (const f of ["resume-context.js", "current-state.js", "reply-policy.json", "inject.config.json", "package.json"]) copy(f);
writePublicState(SB);
writePublicMemory(SB);
writePublicContext(SB);
writePublicCore(SB);
fs.mkdirSync(path.join(SB, "memories"), { recursive: true });

const CARD = (id, body) => [
  "---",
  `id: ${id}`,
  "created: 2026-11-19T10:00:00+08:00",
  "type: 规则",
  "scope: workspace",
  "tags: [回归, 测试]",
  "status: 🟢当前",
  "---",
  body,
  "",
].join("\n");

const FILE = path.join(SB, "memories", "2026-11.md");
fs.writeFileSync(FILE, [CARD("20261119-9001", "第一条正文 alpha"), "§§§", ""].join("\n"), "utf8");

function fingerprint() {
  const r = spawnSync(NODE, [path.join(SB, "resume-context.js"), "fingerprint", "--root", SB], { encoding: "utf8", timeout: 30000 });
  try { return JSON.parse(r.stdout); } catch { return { parseFailed: r.stdout + r.stderr }; }
}

console.log("=== 卡片内容指纹（A3 回归） ===");
const fp1 = fingerprint();
const d1 = fp1.fingerprints && fp1.fingerprints.cards;
check("1. 指纹可算出（count=1 / digest 非空）", !!d1 && d1.count === 1 && !!d1.digest, JSON.stringify(d1));

// 只改正文，id 不动 —— 这正是旧实现会漏掉的场景
fs.writeFileSync(FILE, [CARD("20261119-9001", "第一条正文 beta（内容已改）"), "§§§", ""].join("\n"), "utf8");
const fp2 = fingerprint();
const d2 = fp2.fingerprints && fp2.fingerprints.cards;
check("2. 改正文、id 不变 → digest 必须变", !!d2 && d2.count === 1 && d2.digest !== d1.digest, `before=${d1 && d1.digest} after=${d2 && d2.digest}`);

// 加一张卡 → 数量与摘要都要变
fs.writeFileSync(FILE, [CARD("20261119-9001", "第一条正文 beta（内容已改）"), "§§§", CARD("20261119-9002", "第二条正文"), "§§§", ""].join("\n"), "utf8");
const fp3 = fingerprint();
const d3 = fp3.fingerprints && fp3.fingerprints.cards;
check("3. 加卡 → count=2 且 digest 变", !!d3 && d3.count === 2 && d3.digest !== d2.digest, JSON.stringify(d3));

// 同内容重算 → 摘要稳定（不能引入随机量）
const fp4 = fingerprint();
const d4 = fp4.fingerprints && fp4.fingerprints.cards;
check("4. 同内容重算结果稳定", !!d4 && d4.digest === d3.digest, `${d3 && d3.digest} vs ${d4 && d4.digest}`);

// 回到最初内容 → 摘要应与第一次相同（说明摘要只取决于内容）
fs.writeFileSync(FILE, [CARD("20261119-9001", "第一条正文 alpha"), "§§§", ""].join("\n"), "utf8");
const fp5 = fingerprint();
const d5 = fp5.fingerprints && fp5.fingerprints.cards;
check("5. 内容回滚 → digest 回到原值", !!d5 && d5.digest === d1.digest, `${d1 && d1.digest} vs ${d5 && d5.digest}`);

fs.rmSync(SB, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);