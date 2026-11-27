# 接入与配置契约

> 本文面向第一次部署 Cosmic Phantom 的维护者。它只描述引擎仓与实例数据之间的公共契约；具体 Agent 产品、内部版本和机器路径属于接入端配置，不是引擎仓的默认前提。

## 0. 两层边界

| 层 | 内容 | 是否进入代码仓 |
|---|---|---|
| 引擎仓 | 代码、协议、MCP、技能、测试、冻结题集和安装入口 | 是 |
| 实例数据根 | `events.db`、`memories/`、`candidates/`、`daily/`、`current-state.json`、派生索引 | 否，必须按用户自己的权限保存 |

**不可越过的边界**

1. `events.db` 是追加式原始证据；正常流程不直接改写历史行。
2. 自动提纯只能写 `candidates/`；只有用户明确确认才能进入 `memories/`。
3. `daily/`、索引、向量和关系图是投影或派生层，不能反向覆盖真源。
4. 缺少可选模型或宿主扩展时必须显式降级；不能把“文件存在”报告成“质量已验证”。
5. 公开文档不记录个人路径、凭据、内部宿主版本或私有接线细节。

## 1. 依赖

| 依赖 | 版本/要求 | 是否必须 | 说明 |
|---|---|---|---|
| Node.js | 22.5+，需支持 `node:sqlite` | 必须 | 使用 `node --experimental-sqlite` 运行数据库命令 |
| Git | 2.40+ | 同步必须 | 代码仓和数据仓分开同步 |
| `onnxruntime-node` | `^1.31` | 可选 | 缺失时检索回退到 BM25 |
| 本地向量模型 | 由 `binaries.manifest.json` 声明 | 可选 | 不匹配时不得进入 hybrid-ready |

GPU 不是必须条件。模型、运行时和向量库可以缺失，但 `verify` 必须报告实际模式和原因。

## 2. 从零部署

### 2.1 获取引擎

```bash
git clone https://github.com/<OWNER>/CosmicPhantom.git <CP_ENGINE>
cd <CP_ENGINE>
```

### 2.2 准备可选大件

```bash
node bootstrap.cjs --all
# 或按需：node bootstrap.cjs --only node-runtime,git-portable
```

大件落点、下载地址和校验和只以 `binaries.manifest.json` 为准。下载失败不等于引擎不可用，但向量增强会跳过或降级。

### 2.3 连接实例数据

```bash
node cp-sync.cjs data pull
```

默认数据仓位置由 `CP_DATA_DIR` 或接入端配置决定。空实例可以不执行这一步，先用 `--root <CP_ROOT>` 建立纯引擎模式。

### 2.4 首次自检

```bash
node --experimental-sqlite memory-cli.js verify --root <CP_ROOT>
```

- 纯引擎仓应报告 `mode: "engine"`，并明确哪些实例检查被跳过。
- 完整实例应报告 `mode: "instance"`，且 `stale`、`sync`、`map` 的状态可解释。
- `hybrid-ready` 不是生产质量结论；它只表示资源和指纹满足混合检索前置条件。

### 2.5 建立派生层

```bash
node --experimental-sqlite memory-cli.js index --root <CP_ROOT>
node embed.js build --root <CP_ROOT>
node --experimental-sqlite memory-cli.js maintain --root <CP_ROOT>
```

这些命令可以重跑。失败时保留原始层，修复输入后再次构建。

## 3. 接入 Agent 环境

CP 不绑定某个 Agent 产品。一个接入端至少需要完成以下四层：

| 层 | 接入端要提供什么 | CP 侧契约 | 验证 |
|---|---|---|---|
| MCP | stdio 或等价工具注册 | `resources/mcp-server/index.js --root <CP_ROOT>` | `recall_memory`、`get_current_state` 可调用 |
| 技能 | 技能目录挂载或显式读取 | 以 `skills/` 为真源 | `node skills-sync.js check` |
| 摄取 | transcript、JSONL 或手动事件适配器 | 标准事件写入 `events.db` | `events.js coverage` |
| Hook/回调 | 会话结束、压缩或任务开始回调 | fail-open；失败要计数 | `.flags/` 日志和 `verify` |

MCP 配置可参考 `templates/` 下与当前环境格式匹配的示例。所有示例都应把仓库路径替换为本机的 `<CP_ROOT>`，不要把实例数据提交进代码仓。

无 transcript 的环境使用 `session-adapter.js` 写入决策级事件；有 transcript 的环境应优先保留来源记录 ID、会话 ID 和 revision。适配器名称是实现细节，不改变统一事件契约。

## 4. 配置项

| 配置 | 作用 |
|---|---|
| `CP_ROOT` | MCP 和脚本使用的实例根；未设置时按命令帮助和当前目录解析 |
| `CP_DATA_DIR` | 数据镜像仓位置 |
| `CP_HOST` | 写入 `events.src_host` 的接入端标识；不等于权限系统 |
| `CP_GIT` | 指定 Git 可执行文件；用于受限环境 |
| `CP_USER_NAME` | 本机运行时的用户称呼，仅供 `ref-hunt` 生成 `person:` 候选；不应写入公共代码仓或共享配置 |
| `sources.json` | 实例来源注册、启用状态和 coverage 参数 |
| `hosts.json` | 实例接入端角色和规则挂载；不属于公共代码仓默认配置 |
| `reply-policy.json` | 回复规则真源；同步副本必须可回读校验 |
| `binaries.manifest.json` | 大件的 URL、版本、sha256 和校验方式 |

作用域 `global | workspace | agent` 表示内容适用范围，不是多用户权限模型。提纯内容的默认作用域必须由来源决定，升档要有显式动作和来源记录。

### 4.1 宿主检查是显式选择

通用引擎不会根据用户主目录猜测已安装的 Agent，也不会默认扫描未声明的 hook、transcript、技能或注入文件。需要启用这些检查时，在实例根放置 `host-checks.json`，或通过 `CP_HOST_CHECKS` 指定配置文件：

```json
{
  "hook": {
    "logDir": "<hook-log-dir>",
    "configPath": "<hook-config-file>"
  },
  "transcript": {
    "projectsDir": "<transcript-projects-dir>"
  },
  "skillMounts": {
    "home": "<skill-mount-home>"
  },
  "replyPolicyTargets": [
    { "name": "<target-name>", "path": "<reply-policy-file>" }
  ],
  "injection": {
    "userFile": "<user-injection-file>"
  }
}
```

- 配置文件中的相对路径相对于 `host-checks.json` 所在目录；环境变量中的相对路径相对于当前工作目录。
- 未提供实例级 `host-checks.json` 时，宿主检查跳过；显式指定但文件缺失或格式错误时，`verify` 和 `quota` 都会报告全部配置错误。
- 已提供 `host-checks.json` 但没有任何 `replyPolicyTargets`（也没有 `CP_REPLY_POLICY_FILE`）时，`verify` 会明确提示 F20 未配置门禁派生目标；这不是门禁通过，而是该检查没有目标可比对。
- 环境变量优先于同名 JSON 配置；空环境变量表示明确关闭该路径，不会回退到 JSON 值。
- 支持的环境变量：`CP_HOST_CHECKS`、`CP_HOOK_LOG_DIR`、`CP_HOOK_CONFIG`、`CP_CC_PROJECTS`、`CP_SKILL_HOME`、`CP_REPLY_POLICY_FILE`、`CP_REPLY_POLICY_NAME`、`CP_INJECTION_USER_FILE`。
- `CP_REPLY_POLICY_NAME` 只作为报告标签，不是文件路径；`CP_REPLY_POLICY_FILE` 才是实际检查目标。

### 4.2 技能挂载清单

技能挂载同样采用显式清单。把 `skill-mounts.json` 放在实例根，使用 `skills-sync.js check --root <instance> --home <mount-home>` 检查：

```json
{
  "mounts": [
    { "name": "agent-skills", "path": ".agent/skills" }
  ]
}
```

- `mounts` 缺失、为空或整个 `skill-mounts.json` 不存在时，不检查任何宿主目录。
- 挂载项必须有唯一的 `name` 和非空 `path`；相对 `path` 相对于 `--home`，绝对路径按原值使用。
- 清单格式错误、挂载目录不存在、技能缺失或内容不一致都会返回可读错误；不会静默改写挂载目录。
- `verify` 只有在 `CP_SKILL_HOME` 或 `host-checks.json.skillMounts.home` 显式声明挂载位置时才执行挂载一致性检查。

## 5. 验收与排障

```bash
node --experimental-sqlite memory-cli.js verify --root <CP_ROOT>
node --experimental-sqlite events.js status --root <CP_ROOT>
node resume-context.js fingerprint --root <CP_ROOT>
npm test
```

重点观察：

| 现象 | 含义 | 处理 |
|---|---|---|
| `indexDrift: true` | 派生索引和活跃卡不一致 | 重新运行 `memory-cli.js index` |
| 向量模式降级 | 模型、运行时、词表或集合指纹不匹配 | 保留 BM25；修复资源后重建并复验 |
| coverage 有缺口 | 来源存在可吸收记录但事件库没有对应事件 | 修复适配器或来源注册，不要静默补写卡片 |
| 候选未进入检索 | 候选尚未用户确认 | 使用候选确认命令，不要直接复制到 `memories/` |
| `map.ok` 为假 | 顶层目录或根脚本未登记 | 更新 `DIRECTORY-MAP.md`，或明确归档/忽略原因 |
| fail-open 计数持续增长 | 增强层一直失败，可能是死机制 | 看原因计数和降级输出，不把回退当成功 |

### 故障注入要求

新增守卫或接入层改动必须先证明故障时会变红，再证明修复后变绿。只跑绿色路径不能证明守卫已接线。

## 6. 同步和备份

```bash
node cp-sync.cjs pull --dry-run
node cp-sync.cjs engine commit -m "describe the engine change"
node cp-sync.cjs engine push
node cp-sync.cjs data push -m "describe the data change"
```

`events.db` 是二进制原始证据，多个写入端不能靠 Git 合并。切换机器或写入端前先停止摄取、拉取并核对 fingerprint；`data pull` 是覆盖式镜像，本机有新事件时先备份。

## 7. 发布前清单

- [ ] `npm test` 通过，且结果来自当前代码和固定题集。
- [ ] `node scripts/check-sanitize.cjs` 通过；个人路径和凭据不在公共文件中。
- [ ] `verify` 的降级、缺件、候选和覆盖状态都有明确解释。
- [ ] `DIRECTORY-MAP.md` 的职责、输入、输出、生命周期与实际树一致。
- [ ] 评测数字带 engine commit、数据指纹、Node 版本和参数；没有出处就不发布数字。
- [ ] 代码仓和实例数据根保持分离。
