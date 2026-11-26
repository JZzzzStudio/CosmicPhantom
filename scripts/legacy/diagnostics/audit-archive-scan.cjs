// 重扫：pro/ + docs/ 里含"吸收/借鉴/对标"字样、但**未被 absorbed-notes 登记**的档案
// 判据语义声明（§4.13）：关键词正则为**非贪婪无关**的字面包含；文件名比对**区分大小写**（文件名本身大小写敏感）
const fs = require('fs');
const p = require('path');
const { homedir } = require('node:os');
// ⚠️ 不硬编码机器路径（原写死源机绝对路径 → 随包旅行到新机即死；由 lander-bundle-test 判据抓出）
const ROOT = process.env.CP_ROOT || p.join(homedir(), '.cosmic-phantom');

const notes = fs.readFileSync(p.join(ROOT, 'core', 'absorbed-notes.md'), 'utf8');

// ① 已登记 = absorbed-notes 正文里出现过的档案文件名
const registered = new Set();
for (const m of notes.matchAll(/([A-Za-z0-9._\u4e00-\u9fa5-]+\.md)/g)) registered.add(m[1]);

// ② 扫描域
const targets = [];
for (const d of ['pro', 'docs']) {
  const dir = p.join(ROOT, d);
  if (fs.existsSync(dir) === false) continue;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) continue;
    if (ent.name.endsWith('.md') === false) continue;
    targets.push({ rel: d + '/' + ent.name, name: ent.name, abs: p.join(dir, ent.name) });
  }
}

// ③ 判据自证：先用一个**已知会命中**的样本证明正则会响
const KW = /吸收|借鉴|对标/;
const selfTest = KW.test('本档案吸收了某系统的做法');
console.log('① 判据自证: 关键词正则在已知样本上 →', selfTest ? '✅ 会响' : '❌ 不响，结论无效');

const hit = [], unreg = [];
for (const t of targets) {
  const text = fs.readFileSync(t.abs, 'utf8');
  if (KW.test(text) === false) continue;
  hit.push(t.rel);
  if (registered.has(t.name) === false) unreg.push(t.rel);
}
console.log(`② 扫描域: pro/*.md + docs/*.md 共 ${targets.length} 个档案`);
console.log(`③ 含"吸收/借鉴/对标"字样: ${hit.length} 个`);
console.log(`④ 其中**未登记**于 absorbed-notes: ${unreg.length} 个`);
console.log('---- 未登记清单 ----');
for (const u of unreg) console.log('  ' + u);
