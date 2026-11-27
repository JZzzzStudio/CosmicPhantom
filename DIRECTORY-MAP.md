# 目录与联动地图

> 本文件是代码仓的结构契约：说明每个目录的真实职责、输入、输出、写入者和生命周期。
> 代码仓只提交引擎、测试、冻结题集和必要文档；个人数据、运行态、评测结果和宿主交付物不进入当前版本。
>
> 分类：`引擎` = 当前运行代码或协议；`数据` = 实例事实或工作状态；`派生` = 可由输入重建；`评测` = 题集、跑分器和指标；`档案` = 人读报告；`遗留` = 仅历史复现；`运行态` = 本机临时状态。

## ✨ 顶层目录契约

| 目录 | 分类 | 精确职责 | 主要输入 | 主要输出/消费者 | 生命周期 |
|---|---|---|---|---|---|
| `.context/` | 数据/语义源 | 项目当前有效术语、边界和工作规则 | 用户确认、需求对话 | `core/`、`work/`、公开文档用词 | 当前有效；历史补记应归档 |
| `.flags/` | 运行态 | 守卫标记、诊断现场、运行统计 | 引擎命令、宿主钩子 | `verify`、故障排查 | 可删除；不得当事实源 |
| `backup/` | 数据/档案 | 实例备份和回滚副本 | 数据维护、安装升级 | 回滚和取证 | 按保留策略清理 |
| `core/` | 引擎 | 规则、工作流、需求澄清、不变量和治理台账 | 用户决策、实现约束 | 所有 Agent、`verify`、规格流程 | 当前协议；历史条目需标状态 |
| `daily/` | 派生 | 按日期和会话投影原始事件 | `events.db` | 人读日志、决策卡候选 | 可重放重建 |
| `distilled/` | 数据/档案 | 过期日志的提纯结果和历史归档 | `daily/`、人工提纯 | 人读回顾、术语归档 | 可保留；不替代原始事件 |
| `docs/` | 档案/入口 | 当前架构、配置和使用说明；`legacy/` 是历史手册 | 代码契约和当前决策 | 用户、维护者、接入者 | 当前文档需可运行；历史文档隔离 |
| `embedding-db/` | 派生 | 本地向量模型、词表和向量库 | `memories/`、模型 | 可选语义检索 | 可重建；缺失时降级 |
| `eval/` | 评测 | 冻结题集、跑分器、指标和外部数据清单 | 记忆数据、参数、数据集 | 评测报告、质量闸 | 题集冻结；运行结果不入代码仓 |
| `host-extensions/` | 引擎 | 接入端扩展样例和公共扩展契约 | CP API、宿主事件 | 当前接入端 | 当前实现；宿主版本需单独验证 |
| `lib/` | 引擎 | 可复用的校验、同步和 fail-open 模块 | 根命令输入 | CLI、MCP、测试 | 当前实现 |
| `plugin/` | 引擎 | 通用型 Agent 插件清单、启动器、配置状态和适配器契约 | 引擎代码、用户命令 | 插件生命周期、配置向导、打包器 | 可独立打包；不含实例数据 |
| `schemas/` | 引擎 | 插件、实例和适配器契约 | 当前协议 | 校验器、打包器、测试 | 当前实现 |
| `candidates/` | 数据 | 旧版候选兼容层；三域未归类候选另存 `candidates/unclassified/` | 旧候选入口、三域 CLI | 审阅、确认或拒绝 | 旧布局保持兼容；三域迁移关闭 |
| `domains/` | 数据 | 隔离三域 P1 的候选、活跃实体和分级 README | 三域 API/CLI、用户确认 | 显式三域检索 | 新旧协议并存；不接默认 search/inject |
| `data/` | 数据/审计 | 三域候选拒绝/确认审计；不是原始事件真源，也不是可丢弃派生物 | 三域 API/CLI | 排障和生命周期追溯 | 只保存哈希、来源和审计字段，不保存正文 |
| `memories/` | 数据 | 旧版用户确认后的活跃记忆真源；三域活跃实体不写入这里 | 旧候选确认、受控写入 | 旧检索、注入、MCP | 受控演化；不由派生层覆盖 |
| `pro/` | 数据/档案 | 审计、设计、评测和技术报告 | 实测结果、决策 | 人读证据和历史追溯 | 实例档案层；不作为运行输入 |
| `resources/` | 引擎 | MCP 服务和资源入口 | CP 核心模块 | Agent 接入端 | 当前实现 |
| `scripts/` | 引擎/遗留 | 当前插件打包、校验和迁移入口；`legacy/` 仅历史脚本 | 仓库和实例参数 | 插件包、迁移、诊断 | 当前与遗留必须分开 |
| `skills/` | 引擎 | CP 核心技能真源 | 规则、流程和任务经验 | 接入端技能挂载 | 当前技能；副本必须可对账 |
| `templates/` | 引擎 | 接入配置、规格、票据和报告模板 | 当前协议和占位符 | 新机配置、`work/` 制品 | 当前模板；不得保留废止规则 |
| `tests/` | 测试 | 当前回归和故障注入；`legacy/` 为退役链 | 引擎、临时沙箱 | 通过/失败证据 | 当前测试纳入默认链；遗留显式运行 |
| `tools/` | 运行态/大件 | 便携运行时、模型辅助和系统工具 | Release 或本机安装 | 引擎命令 | 可重新下载；不入代码仓 |
| `views/` | 派生 | 记忆视图生成物 | `memories/`、关系索引 | 人读视图 | 可删除重建 |
| `work/` | 数据/在制品 | 当前规格和实施票据真源 | 用户确认、需求澄清 | 实施、测试、结案档案 | 完成后归档到 `.closed/` |
| `work/cp-memory-domains/` | 数据/在制品 | 三域记忆产品分区与跨域生命周期规格；当前为 draft | 用户已确认的域、scope、归类与 README 边界 | 规格审阅、后续实施票据 | 隔离 P1 API/CLI 已落地；默认检索/注入切换与旧数据迁移仍关闭 |

## 🔗 核心联动关系

```text
接入端 / MCP / Hook / 手动适配器
                │ 标准事件
                ▼
        events.db（原始事件真源）
          ├── project ───────► daily/
          ├── coverage/verify ► 来源覆盖与健康检查
          ├── export/redact ─► 安全出口
          └── replay ─────────► 可重建投影

提纯或 MCP store_memory
                │ 未确认
                ▼
        candidates/（旧版兼容）
        candidates/unclassified/ + domains/*/candidates/（三域 P1）
                │ 用户明确确认
                ▼
        memories/（旧版活跃真源）
        domains/<primary_domain>/memories/（三域单实体真源）
          ├── index ─────────► memory-index.db
          ├── embed build ────► embedding-db/vectors.json
          ├── relink ─────────► links.json
          └── search/recall ──► inject / MCP / 身份卡

reply-policy.json
  ├── sync-reply-policy ───► 接入端规则文件
  ├── reply-check ─────────► 回复质检
  └── identity-card/inject ─► 模型上下文

.context/CONTEXT.md
  ├── requirement-clarify ─► 需求术语和共识
  ├── workflow ────────────► work/<slug>/ 规格与票据
  └── 文档审计 ────────────► README / DIRECTORY-MAP / 架构说明
```

### 联动规则

| 关系 | 方向 | 是否可反向覆盖 | 失败行为 |
|---|---|---|---|
| `events.db` → `daily/` | 原始事件到日期投影 | 不允许 | 保留事件，修复后重放 |
| `candidates/ → memories/` | 旧版候选确认后物化 | 只允许旧版确认动作 | 候选保持 pending，不进入默认面 |
| `domains/*/candidates/ → domains/*/memories/` | 三域候选经用户确认后物化 | 只允许三域确认动作 | 未归类或未确认不参与三域检索 |
| `domains/*/memories/ → 三域显式 search` | 三域活跃实体到显式检索 | 默认旧版 search/inject 不读取 | 旧版本和冲突由三域 API 报告 |
| `memories/ → index/vectors/links` | 活跃卡到派生层 | 不允许派生层改卡 | 缺失或漂移由 `verify` 报告 |
| `reply-policy.json → 接入端规则` | 真源同步到副本 | 不允许副本反写 | 同步检查报不一致 |
| `.context/CONTEXT.md → 文档/规格` | 语义源到消费方 | 消费方不改定义 | 术语冲突由 `context-lint` 报告 |
| `work/<slug>/ → 实施/结案` | 在制品到代码和档案 | 代码不反向伪造规格 | 未完成票据不得关闭 |
| `work/cp-memory-domains/spec.md → 三域实施` | 用户确认的产品边界到候选/记忆/检索规格 | 未批准的 draft 不授权数据迁移 | 域字段、路径或检索越界时规格审查失败 |

## 🧭 根目录脚本分组

以下根脚本由 `verify` 的目录地图检查登记；新增或删除根脚本时必须同步本表。

### 运行、写入和恢复

`arrival-check.js`、`candidate-distill.js`、`candidates.js`、`current-state.js`、`events.js`、`identity-card.js`、`inject-config.js`、`inject.js`、`legacy-memory-compat.js`、`log_turn.js`、`memory-cli.js`、`memory-domains.js`、`memory-retrieval.js`、`<host>-adapter.js`、`reply-check.js`、`resume-context.js`、`session-adapter.js`、`validate.js`、`wrap-up.cjs`

### 治理、检索和关系

`audit-due.cjs`、`change-ledger.cjs`、`context-lint.cjs`、`coverage-cards.cjs`、`dates.js`、`decision-cards.js`、`doctor.cjs`、`dream.js`、`embed-tokenizer.js`、`embed.js`、`graph-edges.js`、`graph-refine.js`、`link-graph.js`、`privacy-probe.js`、`tag-normalize.js`、`topic-tree.js`、`update-snapshot.js`、`work.cjs`

### 接入、同步和运行配置

`bootstrap.cjs`、`<host>-flush.cjs`、`<host>-hook-wrap.cjs`、`compaction-inject.cjs`、`cp-exec.cjs`、`cp-sync.cjs`、`flush-reminder.cjs`、`hook-smoke.cjs`、`mcp-smoke.cjs`、`precompact-probe.cjs`、`skill-log.cjs`、`skills-sync.js`、`sync-reply-policy.mjs`、`task-card-gate.cjs`、`plugin/launcher.cjs`、`scripts/packaging/check-plugin.cjs`、`scripts/packaging/pack-plugin.cjs`、`scripts/packaging/sync-plugin-engine.cjs`

## 📦 当前低频入口与历史入口

### `scripts/packaging/`：当前安装和打包

- `install-bundle.cjs`：继承包落地器，默认 dry-run，`--apply` 才写入。
- `install-check.js`：按 `--engine` 或 `--instance` 检查引擎资产和实例身份。
- `migrate-monthly.js`：一次性迁移旧单卡到月度分桶。
- `pack-bundle.cjs`：私有继承/迁移工具，会读取本机宿主配置与广泛实例状态；不是通用插件打包器，通用打包用 `pack-plugin.cjs`。
- `pack-<host>.cjs` / `install-<host>.cjs`：特定接入端的独立交付逻辑，不是 CP 核心真源；具体名称只在实现和历史档案中保留。

### `scripts/legacy/`：历史复现

- `diagnostics/`：旧审计、体检、交付检查和旧宿主诊断。
- `legacy/<watcher>/`：旧 watcher/poll 链，仅供历史复现，默认不启用。
- `legacy/hosts/<integration>/`：退役接入适配器；具体名称只保留在档案和实现目录中。
- `packaging/`：旧 USB、升级和迁移通道，禁止作为当前安装入口。

对应历史回归测试在 `tests/legacy/`，不纳入默认 `npm test`；显式运行只代表历史兼容，不代表当前生产入口。

## 🧪 测试与评测边界

- `npm test`：当前候选链、隔离三域 P1、核心运行时、MCP、检索、同步、隐私和恢复测试。
- `npm run test:memory-domains`：只运行三域 API/CLI 沙箱；验证授权门、新旧路径隔离、显式域检索、纠错和旧默认面不变。
- `npm run plugin:test`：通用插件清单、配置、生命周期、数据保留和标准事件幂等测试。
- `npm run plugin:check` / `npm run plugin:pack`：插件包校验和可分发目录包生成。
- `tests/legacy/`：旧接入端、旧 watcher 和旧打包链测试。
- `eval/golden-*.json`、`eval/procedural-set.json`：可提交的冻结题集。
- `eval/eval-retrieval.js`、`eval/*-run.mjs`：可重跑评测器。
- `eval/external/data/`：外部数据下载目录，按 `eval/external/manifest.json` 校验；不入 Git。
- `eval/external/experiments/`、`eval/external/result-*`：评测运行产物，不保留在当前版本。

## 📚 文档入口

- `README.md`：公开定位、快速开始、核心边界和常用命令。
- `MANUAL.md`：仓库红线和维护手册。
- `docs/ARCHITECTURE.md`：数据模型、不变量和守卫映射。
- `docs/AGENT-CONFIG.md`：接入配置契约，不绑定具体 Agent 产品。
- `AGENT-BOOTSTRAP.md` / `AGENT-INSTALL.md`：接手和安装步骤。
- `docs/legacy/`：历史安装、升级和验证文档，不是当前入口。

## 🔐 Git 与数据边界

代码仓不跟踪 `events.db`、`memories/`、`candidates/`、`daily/`、`distilled/`、实例档案、`.context/`、`work/`、`views/`、`delivery/`、`tools/`、`embedding-db/`、`node_modules/` 及评测运行产物。多机数据同步使用 `cp-sync.cjs`；代码仓推送不替代实例数据同步。

目录地图只登记职责和边界，不把私有运行态写成代码仓资产；`checkMap()` 还会检查根脚本是否在地图中登记。
