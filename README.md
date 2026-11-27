# 🌌 Cosmic Phantom（CP）

**让 Agent 记住该记的，记错后真正改过来。**

English: [README.en.md](README.en.md)

长期使用 Agent 的人会反复遇到同一个问题：新会话要重新交代已经决定过的事；更糟的是，Agent 可能把一次临时说法、误解或过期决策带进下一次工作，用户只能反复纠正。CP 的目标不是让 Agent 无限制地多记，而是让长期记忆在生效前可确认、出错后可纠正，并验证旧内容不再继续误导。

CP 采用可回放的原始事件、用户确认的活跃记忆和有界检索：先保留证据，再形成候选；只有明确确认的内容才影响未来任务；纠正后沿来源和版本关系验证旧记忆已停止作为当前有效结果。

```text
Agent 接入端
  ↓ 适配器 / MCP / Hook
原始事件层：events.db
  ↓ 可重放投影
daily/ 工作日志
  ↓ 用户确认或受控提纯
memories/ 活跃记忆
  ↓ 词法检索 + 可选本地向量
证据准入与主题折叠
  ↓ 有界注入
身份卡 / 接力状态 / 相关记忆
```

## ✨ 适合解决什么问题

- **跨会话接力**：保存当前目标、下一步和阻塞，不靠聊天窗口本身记住上下文。
- **长期记忆治理**：候选先隔离，用户确认后才进入活跃记忆。
- **可追溯检索**：结果可以回到记忆卡、工作日志和原始事件。
- **安全降级**：本地向量资源缺失时回退词法检索，并显示降级原因。
- **故障自证**：一致性、来源覆盖、隐私出口和同步状态都有检查入口。

CP 的边界也很明确：它不是云端多租户平台，不把在线 LLM 摘要当作第二真源，也不把“资源存在”误报成“质量已验证”。

## 🧱 核心原则

- **原始记录优先**：`events.db` 保存可重放的事件；正常流程不物理改写原始行。
- **确认门**：提纯候选与活跃记忆物理分离；未确认内容不进入默认注入。
- **单一真源**：接入端只连接 CP，不建立自己的记忆副本。
- **热路径无云端模型**：默认使用确定性的词法检索；本地向量是可选增强层。
- **失败显式化**：回退、缺件、低证据和冲突都应被报告，而不是伪装成成功。

## 🚀 快速开始

前提：Node.js 22.5+、Git。GPU 不是必需条件；没有本地向量模型时仍可使用词法检索。

```bash
git clone https://github.com/JZzzzStudio/cosmic-phantom.git cosmic-phantom
cd cosmic-phantom
npm install
node --experimental-sqlite memory-cli.js verify --root .
```

这是代码仓的自检，不会自动带入个人会话数据。要使用已有实例，应按部署环境配置数据根和来源，再执行：

```bash
node --experimental-sqlite memory-cli.js verify --root <CP_ROOT>
node resume-context.js fingerprint --root <CP_ROOT>
```

需要本地语义检索时，再准备模型和向量库：

```bash
node embed.js fetch --root <CP_ROOT>
node embed.js build --root <CP_ROOT>
```

模型、运行时和向量库不匹配时，CP 会回退到词法检索；`verify` 应报告实际模式。

## 🗃️ 数据分层

| 对象 | 角色 | 输入 | 输出/消费者 | 生命周期 |
|---|---|---|---|---|
| `events.db` | 原始事件真源 | 接入端标准事件 | `daily/`、coverage、导出审计 | 长期保留 |
| `daily/` | 日期投影 | `events.db` | 人读日志、决策卡候选 | 可重放 |
| `candidates/` | 待确认候选 | 提取器、MCP、迁移 | 用户确认动作 | 可拒绝、保留审计 |
| `memories/` | 活跃记忆真源 | 已确认候选、受控写入 | 检索、注入、MCP | 受控演化 |
| `current-state.json` | 接力状态真源 | 用户/Agent 明确更新 | 恢复胶囊、身份卡 | revision 保护 |
| `memory-index.db` | 词法派生索引 | `memories/` | BM25 检索 | 可删除重建 |
| `embedding-db/` | 语义检索派生资源 | 模型、词表、`memories/` | 向量检索 | 可重建、可缺省 |
| `links.json` | 关系派生索引 | 卡片关系字段 | 关系查询、重链 | 可删除重建 |

`daily/`、索引、向量和关系图不是新的事实来源。它们都必须能从真源或明确输入重新生成；不能反向覆盖原始事件或未经确认的记忆。

## 🔄 写入和确认流程

```text
接入端消息
  → 标准化事件
  → events.db
  → daily/ 投影

提纯候选
  → candidates/（pending）
  → 用户确认
  → memories/（active）
  → index / vector / links 派生层
```

候选默认不会进入普通检索、自动注入、身份卡或恢复胶囊。确认后会保留来源指针、作用域和确认人/时间，便于后续审计。

明确写入旧版长期记忆时，仍可使用兼容入口；它不写入三域产品目录：

```bash
node --experimental-sqlite memory-cli.js add "明确要长期保留的内容" --scope workspace --root <CP_ROOT>
```

三域 P1 目前作为隔离的新 API/CLI 运行：只写 `candidates/unclassified/`、`domains/` 和 `data/memory-audit/`。未归类候选不参与检索；新检索必须明确指定域或显式跨域。旧版 `search`、`inject` 和根级候选命令保持原行为；三域活跃记忆暂不进入默认检索/注入。创建、归类、确认、编辑、暂缓、恢复、拒绝和纠错都要求 `--user-confirmed --actor <id>`。三域规格仍为 draft，真实旧数据迁移未实现。

## 🔎 检索和证据

查询链路为：

```text
查询规范化
  → 时间 / scope 过滤
  → 词法检索
  → 可选本地向量检索
  → 融合排序
  → 证据准入
  → 主题折叠与有界输出
```

- **词法检索**：负责明确词面、中文单字、时间、作用域、流程和规则信号。
- **本地向量**：补充表达不同但语义接近的候选，不代替证据判断。
- **证据准入**：把排序分数与“能否进入上下文”分开，区分 `answerable`、`low_coverage` 和 `no_evidence`。
- **渐进展开**：默认先给记忆卡，需要时再回链工作日志和原始事件。
- **安全边界**：待确认候选、敏感原文和不适用作用域不进入默认模型面。

## 🧠 接入端得到什么

CP 不绑定任何主流 Agent，属于通用型 Agent 插件。任何接入端都只需要完成四件事：

1. 把消息转换为统一事件并写入 CP；
2. 在需要时读取身份卡、恢复胶囊或相关记忆；
3. 把用户确认的候选提升为活跃记忆；
4. 在会话结束或状态变化时提交成果和接力状态。

接入差异属于适配层，不改变 CP 的数据真源、确认门和检索契约。

## 🛡️ 安全与健康检查

`verify` 不是装饰性报告，它会检查：

- 卡片字段、状态和来源完整性；
- 索引、向量和关系派生层是否漂移；
- 来源文件与事件库是否覆盖一致；
- 待确认、冲突、替代和作用域状态；
- 普通出口是否出现敏感内容；
- 引擎仓和数据仓的同步状态；
- 目录地图和 fail-open 统计是否可信。

最低验收标准：

```text
回归测试通过
+ 同集前后对照不下降
+ 失败路径能回退并留痕
+ verify 不把失效机制报成正常
```

## 🔧 常用命令

```bash
# 检索和注入
node --experimental-sqlite memory-cli.js search "当前任务的相关记忆" --top 5 --root <CP_ROOT>
node --experimental-sqlite memory-cli.js inject --hint "当前任务上下文" --root <CP_ROOT>

# 候选和记忆
node --experimental-sqlite memory-cli.js candidate distill-events --root <CP_ROOT>  # 默认 dry-run
node --experimental-sqlite memory-cli.js candidate distill-events --apply --root <CP_ROOT>  # 只创建待确认候选
node --experimental-sqlite memory-cli.js candidate list --root <CP_ROOT>
node --experimental-sqlite memory-cli.js candidate confirm <candidate-id> --root <CP_ROOT>
node --experimental-sqlite memory-cli.js compatibility report --root <CP_ROOT>  # 只读检查旧根级记忆/候选的三域兼容状态

# 隔离三域 P1（不接旧默认 search/inject）
node --experimental-sqlite memory-cli.js domains candidate create --content "待审候选" --source-ref "manual:example" --user-confirmed --actor user --root <CP_ROOT>
node --experimental-sqlite memory-cli.js domains candidate list --root <CP_ROOT>
node --experimental-sqlite memory-cli.js domains candidate classify --id <candidate-id> --domain project --user-confirmed --actor user --root <CP_ROOT>
node --experimental-sqlite memory-cli.js domains candidate confirm --id <candidate-id> --user-confirmed --actor user --root <CP_ROOT>
node --experimental-sqlite memory-cli.js domains search --query "当前任务" --domain project --root <CP_ROOT>
node --experimental-sqlite memory-cli.js domains search --query "当前任务" --cross-domain --root <CP_ROOT>
# 单独运行隔离验收
npm run test:memory-domains

# 扫描超出 limit 时，使用输出的 nextAfterId 和 --after-id 继续
node --experimental-sqlite memory-cli.js index --root <CP_ROOT>
node embed.js build --root <CP_ROOT>

# 健康和恢复
node --experimental-sqlite memory-cli.js verify --root <CP_ROOT>
node --experimental-sqlite events.js status --root <CP_ROOT>
node resume-context.js fingerprint --root <CP_ROOT>

# 回归
npm test
```

## 📁 仓库结构

- `core/`：规则、工作流、需求澄清和项目不变量。
- `lib/`：可复用的校验、同步和 fail-open 模块。
- `resources/`：MCP 服务和资源入口。
- `skills/`：核心技能真源。
- `host-extensions/`：接入端扩展样例与公共协议适配。
- `plugin/`：通用型 Agent 插件清单、启动器、配置状态和适配器契约；不含实例数据。
- `scripts/packaging/`：当前插件打包和校验入口。
- `scripts/legacy/`：历史脚本，只用于复现，不是当前入口。
- `tests/`：当前回归测试；`tests/legacy/` 是退役链测试。
- `eval/`：冻结题集、评测器和指标口径。
- `docs/`：当前架构和配置说明；历史文档在 `docs/legacy/`。
- `.context/`：项目共享语言的运行时语义源，不是代码模块目录。
- `work/`、`pro/`、`daily/`、`memories/`：实例工作、档案和数据层，默认不进入公开代码提交。

完整的输入、输出、写入方向和生命周期见 [`DIRECTORY-MAP.md`](DIRECTORY-MAP.md)。

## ⚠️ 当前限制

- 事件身份、来源替换、完整隐私删除和跨作用域保护仍在持续硬化，不宣称已经达到生产级完备。
- 本地向量检索是可选增强层，当前质量必须用固定题集与词法基线同集比较。
- 召回率、端到端答对率和读者上限不是同一个指标，不能混用。
- 单人本地系统不等于多租户权限系统；`scope` 是内容作用域，不是账号权限。
- 关系图默认不参与答案生成，避免弱关联扩散为噪声。

## 📚 继续阅读

| 目标 | 文档 |
|---|---|
| 数据模型和不变量 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| 首版产品闭环和完成标准 | [`docs/PRODUCT-DESIGN.md`](docs/PRODUCT-DESIGN.md) |
| 目录和联动关系 | [`DIRECTORY-MAP.md`](DIRECTORY-MAP.md) |
| 宿主接入契约 | [`docs/AGENT-CONFIG.md`](docs/AGENT-CONFIG.md) |
| 回复规则和项目护栏 | [`core/rules.md`](core/rules.md) |
| 公开术语表 | [`docs/TERMINOLOGY.md`](docs/TERMINOLOGY.md) |
| 实例共享语言 | 由实例数据根中的 `.context/CONTEXT.md` 提供，不随引擎仓公开 |
| 文档导航 | [`docs/README.md`](docs/README.md) |
| 评测口径 | [`eval/METRICS.md`](eval/METRICS.md) |
| 安全与隐私 | [`SECURITY.md`](SECURITY.md) |
| 参与贡献 | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

## 📄 许可

引擎代码采用 MIT。个人实例数据不随代码仓公开分发。

**Built for local-first, auditable memory workflows.**

> 公开入口使用接入端中立语言；具体环境的挂载方式请参考 `docs/AGENT-CONFIG.md`，不要把个人实例路径提交到代码仓。
