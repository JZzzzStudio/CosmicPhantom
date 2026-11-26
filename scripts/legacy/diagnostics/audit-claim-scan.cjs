// Task#3：含"声称词"的消息随机抽 20 条算误报率（§4.13 声称强度纪律的自查）
// 判据语义声明：
//   · 声称词表取自 core/rules.md §4.13：齐/全/全部/测试链/全绿/已修完/无遗漏
//   · 单字「全」「齐」会产生大量撞车（如"全部"已含"全"；"安全""完整"等）→ **按 §4.13 原文口径**保留，
//     但**逐条人工判**其是否**真的构成整体性声称**（这正是本次要测的"误报率"来源之一）
//   · 匹配用 GLOB（SQLite LIKE 对 ASCII 不敏感，这里虽为中文，仍统一用 GLOB 声明语义）
const { DatabaseSync } = require('node:sqlite');
const { homedir } = require('node:os');
const { join } = require('node:path');
// ⚠️ 不硬编码机器路径（铁律：禁硬编码机器绝对路径）——原写法把源机绝对路径写死，
//   随继承包旅行到新机就是死路径（被 lander-bundle-test 的"非预期源机用户名残留"判据抓出）。
//   （连注释里也不留具体路径：那个判据是**文本匹配**，不区分代码还是注释。）
const ROOT = process.env.CP_ROOT || join(homedir(), '.cosmic-phantom');
const DB = join(ROOT, 'events.db');
const db = new DatabaseSync(DB, { readOnly: true });

const WORDS = ['齐', '全', '全部', '测试链', '全绿', '已修完', '无遗漏'];

// 判据自证：先用一个必然命中的串证明查询口径会响
const self = db.prepare("SELECT COUNT(*) c FROM events WHERE role='assistant' AND content GLOB '*测试链*'").get().c;
const anyAsst = db.prepare("SELECT COUNT(*) c FROM events WHERE role='assistant'").get().c;
console.log(`① 判据自证: assistant 消息总数 ${anyAsst}；含「测试链」${self} 条 → ${self > 0 ? '✅ 口径会响' : '❌ 不响'}`);

const where = WORDS.map(() => "content GLOB ?").join(' OR ');
const args = WORDS.map((w) => '*' + w + '*');
const rows = db.prepare(`SELECT id, ts, session, content FROM events WHERE role='assistant' AND (${where}) ORDER BY id`).all(...args);
console.log(`② 命中「任意声称词」的助手消息: ${rows.length} 条（§4.13 记载的 195 条口径）`);

// 按词统计（说明撞车面）
for (const w of WORDS) {
  const n = db.prepare("SELECT COUNT(*) c FROM events WHERE role='assistant' AND content GLOB ?").get('*' + w + '*').c;
  console.log(`   「${w}」 ${n}`);
}

// 随机抽 20（无随机源改用等距抽样：把样本空间均匀切成 20 段各取 1 —— 可复跑、不依赖 RNG）
const N = 20;
const step = rows.length / N;
const sample = [];
for (let i = 0; i < N; i += 1) sample.push(rows[Math.floor(i * step)]);
console.log(`\n③ 等距抽样 ${sample.length} 条（步长 ${step.toFixed(1)}，可复跑）`);
for (const s of sample) {
  const hit = WORDS.filter((w) => s.content.includes(w)).join('/');
  const t = s.content.replace(/\s+/g, ' ');
  const idx = WORDS.map((w) => t.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const seg = t.slice(Math.max(0, idx - 55), idx + 75);
  console.log(`\n#${s.id} [${String(s.ts).slice(0, 10)}] 词:${hit}\n   …${seg}…`);
}
db.close();
