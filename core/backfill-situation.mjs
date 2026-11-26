// backfill-situation.cjs — 按「标签域 → 适用场景」的固定映射给规则/偏好卡补 situation
// 纪律：只对 type=规则/偏好 的卡补；文本来自映射表（不是逐卡编造）；写入时带 situation_source: tag-map。
// 用法：node core/backfill-situation.cjs [--apply --confirm]
import fs from 'node:fs';
import { listMemoryFiles } from '../memory-retrieval.js';

const APPLY = process.argv.includes('--apply');
const CONFIRM = process.argv.includes('--confirm');

const MAP = [
  { tags: ['检索', '记忆卡', '蒸馏', '术语'], text: '当需要找回某条记忆、核对旧结论或解释术语时' },
  { tags: ['门禁', '守卫', '审计', '验收闸', '用词规范'], text: '当写回复、改规则或判断某个做法是否合规范时' },
  { tags: ['宿主', '技能', '运行'], text: '当换机、配宿主、装扩展或接新工具时' },
  { tags: ['同步', '迁移包', '归档', '备份'], text: '当推送、换机或恢复数据时' },
  { tags: ['交付', '决策', '方法论', '记录'], text: '当定方案、拆票或复盘一次交付时' },
  { tags: ['偏好', '需求'], text: '当要按用户口味做取舍（排版、措辞、流程）时' },
];

const files = listMemoryFiles('memories');
const changes = [];
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const blocks = raw.split(/^\s*§{3,}\s*$/m);
  const next = blocks.map((block) => {
    if (!/^type:\s*(规则|偏好)\s*$/m.test(block)) return block;
    if (/^situation:/m.test(block)) return block;
    const tags = (block.match(/^tags:\s*\[(.*)\]$/m) || [])[1] || '';
    const hit = MAP.find((m) => m.tags.some((t) => tags.includes(t)));
    if (!hit) return block;
    changes.push({ file: f, id: (block.match(/^id:\s*(\S+)/m) || [])[1], situation: hit.text });
    const line = 'situation: ' + hit.text + '\nsituation_source: tag-map';
    return block.replace(/^scope:.*$/m, (m) => line + '\n' + m);
  });
  if (next.join('\n§§§\n') !== raw) {
    if (APPLY && CONFIRM) fs.writeFileSync(f, next.join('\n§§§\n'), 'utf8');
  }
}

console.log(JSON.stringify({ dryRun: !(APPLY && CONFIRM), changed: changes.length, sample: changes.slice(0, 6) }, null, 2));