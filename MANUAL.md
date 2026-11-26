# CP 维护手册

> 本页描述引擎仓的维护边界。实例数据、具体 Agent 产品和机器路径由接入端配置提供，不在这里固定。

## 工作区规则

- **单一真源**：所有接入端都指向同一个 CP 实例根；接入端自己的记忆缓存不是事实源。
- **四段工作流**：需求澄清 → 规格 → 票据 → 实施；规格和票据放在 `work/<slug>/`，结案档案放在实例档案层。
- **差异留在接入层**：MCP、技能、摄取适配器和 hook 可以因环境不同而不同，但不能改变事件、候选、活跃记忆和检索契约。
- **收尾**：优先运行 `node --experimental-sqlite wrap-up.cjs --root <CP_ROOT>`；没有自动摄取回调时，先运行当前环境对应的适配器。
- **来源标识**：`CP_HOST` 只是来源归因字段，不等于权限模型；写入和同步前必须确认当前用户拥有实例和仓库权限。
- **运行环境**：先检查 `node --version` 和 `git --version`；便携运行时只按 `binaries.manifest.json` 和本机配置使用，不把机器路径写入公共文档。
- **数据同步**：`events.db` 是 SQLite 二进制原始证据，写入端切换前必须停止摄取、拉取并核对 fingerprint；代码仓同步不代替实例数据同步。

## 健康判据

```bash
node --experimental-sqlite memory-cli.js verify --root <CP_ROOT>
node --experimental-sqlite events.js status --root <CP_ROOT>
node resume-context.js fingerprint --root <CP_ROOT>
npm test
```

- `verify` 负责报告格式、来源覆盖、派生层漂移、候选确认、隐私出口、同步和 fail-open 统计。
- `hybrid-ready` 只代表向量资源和指纹满足前置条件，不代表答案质量或生产完备性。
- 绿色测试、文件存在和命令能启动都不能替代同集对比、故障注入和来源证据。

## 变更纪律

- 原始事件只能通过追加式事件或审计墓碑处理；不要直接 UPDATE/DELETE 历史行。
- 自动提纯只写 `candidates/`；用户明确确认后才能写入 `memories/`。
- 派生索引、向量和关系图可以删除重建，不能反向覆盖真源。
- 新守卫必须先证明故障会红，再证明修复会绿；持续 fail-open 必须计数并暴露原因。
- 修改目录、根脚本、公共术语或接入契约时，同步更新 `DIRECTORY-MAP.md`、`docs/TERMINOLOGY.md` 和相关测试。

## 多机切换

1. 停止旧写入端的摄取。
2. 执行 `node cp-sync.cjs pull --dry-run`，确认不会覆盖本机新事件。
3. 拉取并完成 `verify`、fingerprint 和来源覆盖检查。
4. 只允许一个写入端恢复摄取；分叉的 SQLite 文件不能靠 Git 合并。

详细部署契约见 `docs/AGENT-CONFIG.md`；数据模型见 `docs/ARCHITECTURE.md`；目录关系见 `DIRECTORY-MAP.md`。
