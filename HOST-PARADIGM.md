# 接入范式

> 本文描述任意 Agent 环境接入 Cosmic Phantom 时必须遵守的边界。具体产品、挂载目录和扩展加载方式由接入端自己提供。

## 一、单一真源

接入端可以有缓存或平台内置记忆，但不能建立第二套事实源。

| 层 | 内容 | 权威 |
|---|---|---|
| 接入端缓存 | 平台自动召回、身份文件、当前会话状态 | 否；可丢失、可重建 |
| CP 证据层 | `events.db` 中的原始事件和来源身份 | 是；追加式记录 |
| CP 活跃层 | 用户明确确认后的 `memories/` 记忆卡 | 是；受控演化 |
| CP 接力层 | `current-state.json` 中的目标、下一步和阻塞 | 是；revision 防覆盖 |
| CP 候选层 | `candidates/` 中尚未确认的提案 | 否；不得进入默认注入 |

## 二、五条分工原则

1. **事件先落盘**：接入端把 transcript、JSONL 或手动记录转换成统一事件；原始正文和来源身份由 CP 保存。
2. **候选先隔离**：自动提取、摘要、推断和压缩结果只能进入 `candidates/`；用户明确确认后才能物化到 `memories/`。
3. **注入按需组合**：身份卡、恢复胶囊和相关记忆按任务需要组合；候选、敏感原文和不适用作用域不进入默认模型面。
4. **状态单独管理**：跨窗口接力写 `current-state.json`，每次更新带 `expectedRevision`；当前状态不冒充长期记忆。
5. **接入差异留在边界**：MCP 注册、技能挂载、摄取适配器和 hook 可以不同，但都必须遵守同一事件、候选、活跃记忆和检索契约。

## 三、接入清单

1. **注册 MCP**：把 `resources/mcp-server/index.js` 作为工具入口，显式传入实例根。
2. **挂载技能**：以 `skills/` 为真源，检查副本是否一致。
3. **接收事件**：适配器保留来源实例、来源记录 ID 和 revision；正文哈希不能单独充当身份。
4. **接收候选**：写入候选时保留 `source_ref`、`source_kind`、`confidence` 和合法 `scope`。
5. **确认记忆**：只有用户明确确认动作能把候选提升到活跃层，并记录确认人和时间。
6. **验证回退**：接入端故障时 fail-open，不阻塞会话；同时记录调用、回退和失败原因。

## 四、禁止事项

- 不把平台缓存当作跨 Agent 的事实源。
- 不把候选、每日原文或敏感事件写进默认身份卡和恢复胶囊。
- 不直接 UPDATE/DELETE `events.db` 的历史事件；敏感内容走审计墓碑或受控导出。
- 不用绿色测试、文件存在或 `hybrid-ready` 单独宣称生产质量。
- 不把具体产品名称、内部版本或机器路径写入公开首页和文档入口。

## 五、验证命令

```bash
node --experimental-sqlite memory-cli.js verify --root <CP_ROOT>
node --experimental-sqlite events.js status --root <CP_ROOT>
node resume-context.js fingerprint --root <CP_ROOT>
node scripts/check-public-surface.cjs
```

如果接入端没有 transcript，使用 `session-adapter.js` 写入决策级事件；如果有 transcript，优先使用来源记录 ID 和 revision，保证重放幂等且能检测来源替换。
