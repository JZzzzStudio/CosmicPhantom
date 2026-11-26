// tests/validate-drift-audit.js — 校验器漂移审计（validateInline vs validate.js check）
// 合并前：对同一批样例跑两实现，列出一切差异（根治"两份校验悄悄不一致"）
// 合并后：memory-cli.js 不再含 validateInline → 全 PASS = 单实现达成（守卫）
// 用法: node tests/validate-drift-audit.js
// 零副作用：临时目录构造样例 + 只读生产 memories
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const REAL = path.join(os.homedir(), ".cosmic-phantom");
const NODE = path.join(REAL, "tools", "node", "node.exe");
const CLI_SRC = fs.readFileSync(path.join(REAL, "memory-cli.js"), "utf8");

// ---- 从 memory-cli.js 源码提取 validateInline 及其依赖（不复制实现，避免自身漂移）----
function extractBalanced(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return null;
  const open = src.indexOf("{", i);
  let depth = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(i, j + 1);
}
const fnSrc = extractBalanced(CLI_SRC, "function validateInline(file)");
const normSrc = extractBalanced(CLI_SRC, "function normalize(");
const statusArr = (CLI_SRC.match(/const VALID_STATUS = (\[[^\]]*\])/) || [])[1];
const typeArr = (CLI_SRC.match(/const VALID_TYPES = (\[[^\]]*\])/) || [])[1];
const hasInline = fnSrc !== null;

let pass = 0, fail = 0, diffCount = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} -- ${detail || ""}`); }
}

// ---- 样例（正/反全覆盖）----
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "cp-drift-"));
function w(name, content) { const p = path.join(SB, name); fs.writeFileSync(p, content); return p; }
const okFm = "id: 20260811-0001\ncreated: 2026-08-11T00:00:00+08:00\nstatus: 🟢当前\ntype: 偏好\ntags: [测试]\nscope: global\n";
const samples = [
  ["01-合法条目", w("ok.md", `---\n${okFm}---\n这是一条完全合法的记忆条目内容。`)],
  ["02-缺id", w("noid.md", "---\ncreated: 2026-08-11T00:00:00+08:00\nstatus: 🟢当前\ntags: [x]\nscope: global\n---\n缺少 id 的条目")],
  ["03-id格式非法", w("badid.md", "---\nid: abc\ncreated: 2026-08-11T00:00:00+08:00\nstatus: 🟢当前\ntags: [x]\nscope: global\n---\nid 格式错误的条目")],
  ["04-非法status", w("badstatus.md", "---\nid: 20260811-0002\ncreated: 2026-08-11T00:00:00+08:00\nstatus: 非法\ntags: [x]\nscope: global\n---\n非法状态条目")],
  ["05-非法type", w("badtype.md", "---\nid: 20260811-0003\ncreated: 2026-08-11T00:00:00+08:00\nstatus: 🟢当前\ntype: 玄学\ntags: [x]\nscope: global\n---\n非法类型条目")],
  ["06-非法scope", w("badscope.md", "---\nid: 20260811-0004\ncreated: 2026-08-11T00:00:00+08:00\nstatus: 🟢当前\ntags: [x]\nscope: 全球\n---\n非法 scope 条目")],
  ["07-source非法", w("badsrc.md", "---\nid: 20260811-0005\ncreated: 2026-08-11T00:00:00+08:00\nstatus: 🟢当前\ntags: [x]\nscope: global\nsource: events.db:bad\n---\nsource 格式错误条目")],
  ["08-正文过短无tags", w("short.md", "---\nid: 20260811-0006\ncreated: 2026-08-11T00:00:00+08:00\nstatus: 🟢当前\nscope: global\n---\n短")],
  ["09-正文过短有tags", w("shorttags.md", "---\nid: 20260811-0007\ncreated: 2026-08-11T00:00:00+08:00\nstatus: 🟢当前\ntags: [x]\nscope: global\n---\n短")],
  ["10-标题复制", w("copy.md", "---\nid: 20260811-0008\ncreated: 2026-08-11T00:00:00+08:00\nstatus: 🟢当前\ntags: [x]\nscope: global\ntitle: 记忆标题\n---\n记忆标题记忆标题记忆标题")],
  ["11-超25KB", w("big.md", `---\n${okFm}---\n` + "x".repeat(26 * 1024))],
  ["12-BOM文件", w("bom.md", `\uFEFF---\n${okFm}---\n带 BOM 的合法条目`)],
  ["13-CRLF文件", w("crlf.md", `---\r\n${okFm.replace(/\n/g, "\r\n")}---\r\nCRLF 换行的合法条目`)],
  ["14-二进制垃圾", w("bin.md", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))],
  ["15-缺frontmatter", w("nofm.md", "没有任何元数据的裸文本")],
];
try {
  for (const f of fs.readdirSync(path.join(REAL, "memories")).filter(f => f.endsWith(".md")))
    samples.push([`prod:${f}`, path.join(REAL, "memories", f)]);
} catch {}

// ---- 两实现 ----
function runValidate(file) {
  const r = spawnSync(NODE, [path.join(REAL, "validate.js"), "check", file], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return { crash: true, err: (r.stderr || r.stdout || "").slice(0, 120) };
  try { return JSON.parse(r.stdout); } catch { return { crash: true, err: "非JSON输出" }; }
}
function runInline(file) {
  if (!hasInline) return null; // 合并后：validateInline 不存在 → 单实现
  const ctx = {
    statSync: fs.statSync,
    readFileSync: (p) => fs.readFileSync(p, "utf8"),
    VALID_STATUS: eval(statusArr), VALID_TYPES: eval(typeArr),
    normalize: eval("(" + normSrc + ")"), console, Buffer, process,
  };
  try {
    vm.createContext(ctx);
    const fn = vm.runInContext(fnSrc + "; validateInline", ctx);
    return fn(file);
  } catch (e) { return { crash: true, err: String(e).slice(0, 120) }; }
}
const reasonsOf = (r) => r && r.reasons ? r.reasons : (r && r.crash ? ["crash:" + r.err] : []);

// ---- 对比 ----
console.log(hasInline ? "=== 合并前：validateInline 存在，跑差异基线 ===" : "=== 合并后：validateInline 已移除 → 单实现守卫 ===");
for (const [name, file] of samples) {
  const a = runValidate(file);
  const b = runInline(file);
  if (!b) { check(`${name}: 单实现达成（inline 已移除）`, true); continue; }
  const same = (a.crash === b.crash) && (a.ok === b.ok) && JSON.stringify(reasonsOf(a)) === JSON.stringify(reasonsOf(b));
  if (same) check(`${name}: 两实现一致`, true, JSON.stringify(reasonsOf(a)));
  else {
    diffCount++;
    console.log(`  [DIFF] ${name}`);
    console.log(`    validate.js  : ok=${!a.crash && a.ok} reasons=${JSON.stringify(reasonsOf(a))}`);
    console.log(`    validateInline: ok=${!b.crash && b.ok} reasons=${JSON.stringify(reasonsOf(b))}`);
  }
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败 / 差异 ${diffCount} 处`);
console.log("预期差异（已知 3 类）：id 格式校验（validate.js 独有）/ 标题复制（validate.js 独有）/ 短正文文案措辞");
fs.rmSync(SB, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
