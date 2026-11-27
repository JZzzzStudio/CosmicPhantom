// tests/insufficient-gate-test.js — 票 16：查不到就直说查不到
// 判据（三档）：垃圾查询为空；正常查询有证据；已有证据不被弃权闸误杀。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL = path.resolve(__dirname, '..');
const NODE = process.execPath;
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-insufficient-gate-'));
const ROOT = path.join(SB, 'root');
fs.mkdirSync(path.join(ROOT, 'memories'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'lib'), { recursive: true });
for (const file of ['memory-cli.js', 'memory-retrieval.js', 'link-graph.js', 'skills-sync.js', 'package.json']) {
  fs.copyFileSync(path.join(REAL, file), path.join(ROOT, file));
}
fs.copyFileSync(path.join(REAL, 'lib', 'failopen.js'), path.join(ROOT, 'lib', 'failopen.js'));

const syntheticCards = [
  ['守护', '守护进程应在 Agent 会话开始时启动。'],
  ['同步', '另一台机器的最新成果通过同步和吸收进入当前实例。'],
  ['恢复', '上下文压缩后通过恢复流程找回关键消息。'],
  ['约束', '门禁约束用于保护流程，同时保留 Agent 的自由度。'],
  ['记忆', '跨 Agent 接续依赖记忆同步。'],
  ['注入', '会话开始时自动注入已确认记忆并提供召回。'],
  ['候选', '候选记忆必须经过用户确认才能激活。'],
  ['来源', '原始事件是可追溯记忆的来源真源。'],
  ['检索', '生产检索优先使用混合检索，缺少模型时回退 BM25。'],
  ['作用域', '记忆作用域区分 global 与 workspace。'],
  ['审计', '公开候选需要通过历史和文件审计。'],
  ['降级', '依赖不可用时系统应 fail-open 并记录降级。'],
  ['纠错', '纠错会保留来源并生成新的版本。'],
  ['事件', '事件账本按来源实例、记录 ID 和修订版本标识事件。'],
  ['插件', '插件代码与实例数据必须物理隔离。'],
  ['确认', '只有明确确认才能把候选写入活跃记忆。'],
  ['安全', '敏感来源展开需要明确请求并受到字节预算限制。'],
  ['测试', '公开测试使用固定 synthetic fixture，不读取生产运行态。'],
];
for (const [id, body] of syntheticCards) {
  fs.writeFileSync(
    path.join(ROOT, 'memories', `synthetic-${id}.md`),
    `---\nid: synthetic-${id}\ncreated: 2026-01-01T00:00:00Z\nstatus: 🟢当前\ntype: 事件\nscope: global\ntags: [public-test]\n---\n${body}\n`,
    'utf8',
  );
}

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + ' -- ' + detail); }
};
function search(q, extra = []) {
  const r = spawnSync(NODE, [
    '--experimental-sqlite', path.join(ROOT, 'memory-cli.js'), 'search', q,
    '--abstain', '--top', '5', '--root', ROOT, ...extra,
  ], { encoding: 'utf8', timeout: 60000 });
  try { return JSON.parse(r.stdout); }
  catch { return { parseFailed: String(r.stdout || r.stderr).slice(0, 200) }; }
}

console.log('=== 弃权闸（票 16） ===');
const junk = search('那个怎么弄的');
check('1. 垃圾查询 → no_evidence 且 0 条', junk.verdict === 'no_evidence' && junk.count === 0, JSON.stringify(junk).slice(0, 160));

const normal = search('门禁 约束');
check('2. 正常查询 → 有证据（answerable 或 low_coverage）且非空', normal.verdict !== 'no_evidence' && normal.count > 0, JSON.stringify(normal).slice(0, 160));

(async () => {
  const { retrieveMemories } = await import('file://' + path.join(REAL, 'memory-retrieval.js').replace(/\\/g, '/'));
  const cases = [
    '守护进程 会话开始', '最新成果 同步 当前实例', '上下文 压缩 恢复', '门禁 约束 自由度',
    '跨 Agent 记忆 同步', '自动 注入 召回', '候选 用户 确认', '原始 事件 来源',
    '生产 检索 BM25', '记忆 作用域 workspace', '公开 历史 审计', '不可用 fail-open 降级',
    '纠错 来源 版本', '来源 实例 修订 事件', '插件 实例 隔离', '候选 激活 确认',
    '敏感 来源 字节预算', '公开测试 synthetic fixture',
  ];
  let killed = 0;
  const killedList = [];
  for (const query of cases) {
    const base = retrieveMemories(query, { memoryDir: path.join(ROOT, 'memories'), top: 5 });
    const gated = retrieveMemories(query, { memoryDir: path.join(ROOT, 'memories'), top: 5, abstain: true });
    if ((base.results || []).length > 0 && (gated.results || []).length === 0) {
      killed += 1;
      killedList.push(query);
    }
  }
  check(`3. 合成回归集 ${cases.length} 题：原本有结果的被误杀 = ${killed}（要求 0）`, killed === 0, killedList.join(','));

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + '/' + (pass + fail));
  fs.rmSync(SB, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})();
