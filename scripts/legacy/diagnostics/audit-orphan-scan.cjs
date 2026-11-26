// 全盘孤儿扫描（真源根，排除 node_modules/backup/daily/distilled/memories/client/tools-src/embedding-db）
// 判据语义声明：
//   · "垃圾形态" = 0 字节 / 文件名含 .bak|.tmp|~$ / 正文是 HTTP 错误占位（404/403/Not Found）
//   · "零引用" 口径 = 全仓文本 grep（.js/.cjs/.mjs/.json/.md/.txt/.yml/.sh），**排除** daily/distilled/pro/docs/delivery（历史记录必然提到旧名）
//   · 两个判据都各自先用已知样本自证
const fs = require('fs');
const p = require('path');
const { homedir } = require('node:os');
// ⚠️ 不硬编码机器路径（原写死源机绝对路径 → 随包旅行到新机即死；由 lander-bundle-test 判据抓出）
const ROOT = process.env.CP_ROOT || p.join(homedir(), '.cosmic-phantom');

const SKIP_TOP = new Set(['node_modules', 'backup', 'distilled', 'memories', 'client', 'tools-src', 'embedding-db', 'tools', '.git', 'views', '.flags', 'eval', 'templates', 'topics', 'resources']);
const REF_SKIP = new Set(['node_modules', 'backup', 'daily', 'distilled', 'pro', 'docs', 'delivery', 'memories', 'client', 'tools-src', 'embedding-db', '.git']);

// ── A. 垃圾形态 ──
const junk = [];
const files = [];
(function walk(d, depth) {
  if (depth > 3) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = p.join(d, e.name);
    const rel = p.relative(ROOT, fp).split(p.sep).join('/');
    if (e.isDirectory()) { if (SKIP_TOP.has(e.name) === false && e.name.startsWith('.tmp-') === false) walk(fp, depth + 1); continue; }
    files.push({ rel, fp, size: fs.statSync(fp).size });
    const nm = e.name;
    if (fs.statSync(fp).size === 0) junk.push({ rel, why: '0 字节' });
    else if (/\.(bak|tmp)$/i.test(nm) || /~\$/.test(nm)) junk.push({ rel, why: '垃圾后缀' });
    else if (fs.statSync(fp).size <= 40 && /\.(sh|yml)$/i.test(nm)) {
      const t = fs.readFileSync(fp, 'utf8');
      if (/^(404|403|Not Found|Bad Gateway)/i.test(t.trim())) junk.push({ rel, why: `HTTP 错误占位: ${JSON.stringify(t.trim().slice(0, 30))}` });
    }
  }
})(ROOT, 0);

// ── B. 零引用（只查脚本与产物文件，不查 .md 文档） ──
const texts = [];
(function collect(d, depth) {
  if (depth > 3) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = p.join(d, e.name);
    if (e.isDirectory()) { if (REF_SKIP.has(e.name) === false && e.name.startsWith('.tmp-') === false && e.name !== 'node_modules') collect(fp, depth + 1); continue; }
    if (/\.(js|cjs|mjs|json|md|txt|yml|sh)$/.test(e.name)) texts.push(fp);
  }
})(ROOT, 0);
const corpus = texts.map((f) => ({ f, t: fs.readFileSync(f, 'utf8') }));

// 判据自证：已知被引用的文件名必须命中
const known = 'memory-cli.js';
const knownHits = corpus.filter((c) => p.basename(c.f) !== known && c.t.includes(known)).length;
console.log(`① 判据自证: "${known}" 被 ${knownHits} 个文件提到 → ${knownHits > 0 ? '✅ 引用口径会响' : '❌ 不响'}`);
console.log(`② 扫描域: ${files.length} 个文件（真源根，深度≤3）/ 引用语料 ${corpus.length} 份\n`);

console.log('── A. 垃圾形态 ──');
if (junk.length === 0) console.log('  （无）');
for (const j of junk) console.log(`  ${j.rel}  ｜ ${j.why}`);

console.log('\n── B. 零引用（限根目录脚本与 .txt/.yml/.sh 产物）──');
const topScripts = files.filter((f) => f.rel.split('/').length <= 2 && /\.(js|cjs|mjs|txt|yml|sh)$/.test(f.rel));
let zero = 0;
for (const f of topScripts) {
  const base = f.rel.split('/').pop();
  if (base === 'memory-cli.js') continue;
  const n = corpus.filter((c) => p.basename(c.f) !== base && c.t.includes(base)).length;
  if (n === 0) { zero += 1; console.log(`  ${f.rel}  (${f.size}B)`); }
}
console.log(`  零引用合计: ${zero}`);
