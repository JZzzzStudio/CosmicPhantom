// backfill-entities.mjs — 给提到常见实体名的卡片补 entities 字段（规则抽取，非模型）
// 纪律：只认白名单实体（避免把人名/普通词当实体）；只补缺该字段的卡。
import fs from 'node:fs';
import { listMemoryFiles } from '../memory-retrieval.js';

const APPLY = process.argv.includes('--apply');
const CONFIRM = process.argv.includes('--confirm');

const ENTITIES = [
  'GitHub', 'cp-memory', 'LoCoMo', 'LongMemEval', 'ONNX', 'MCP', 'SQLite', 'Windows', 'Node',
  'Cosmic Phantom', 'CP', 'Obsidian', 'Telegram', 'Feishu', '飞书',
];

const files = listMemoryFiles('memories');
const changes = [];
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const blocks = raw.split(/^\s*§{3,}\s*$/m);
  const next = blocks.map((block) => {
    if (/^entities:/m.test(block)) return block;
    const body = block.replace(/^---[\s\S]*?---\s*/, '');
    const found = ENTITIES.filter((e) => new RegExp('(^|[^A-Za-z0-9_-])' + e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_-]|$)').test(body));
    if (!found.length) return block;
    changes.push({ id: (block.match(/^id:\s*(\S+)/m) || [])[1], entities: found });
    return block.replace(/^scope:.*$/m, (m) => 'entities: [' + found.join(', ') + ']\n' + m);
  });
  if (APPLY && CONFIRM && next.join('\n§§§\n') !== raw) fs.writeFileSync(f, next.join('\n§§§\n'), 'utf8');
}

console.log(JSON.stringify({ dryRun: !(APPLY && CONFIRM), changed: changes.length, sample: changes.slice(0, 5) }, null, 2));