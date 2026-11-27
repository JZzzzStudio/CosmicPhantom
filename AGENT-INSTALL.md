# 给 Agent 的安装指引（一粘贴）

> 用途：把本段整段交给任意具备「文件/命令」能力的 Agent，它会完成安装与自检。
> 本文件只写可执行步骤；尖括号中的值需要替换为当前环境配置。任何步骤失败必须停下并报 `BLOCKED: <原因>`，不许跳过。

## 0. 你要先确认的三件事（缺一就停）

```bash
node --version        # 需要 >= 22.5（verify 用 node:sqlite；22.12 / 24.18 已实测）
git --version         # 自备（tools/ 未入仓）
```

- Git 自备（`tools/` 未入仓）
- 磁盘剩余 ≥ 1.5GB（引擎 + 数据 + 可选模型）
- 网络：`github.com` 可访问（推/拉）；**拉不到大件不阻塞安装**，只影响向量增强

任一不满足 → 输出 `BLOCKED: <缺什么>`，直接结束，不要继续。

## 1. 取代码

```bash
git clone https://github.com/<OWNER>/cosmic-phantom.git <CP_ENGINE>
cd <CP_ENGINE>
```

引擎仓包含代码、技能、测试和协议。实例数据根由当前环境单独配置；不要把个人数据仓名称或机器路径写进代码仓。

## 2. 把数据源接成当前实例

```bash
node cp-sync.cjs data pull
```

`data pull` 是覆盖式镜像，会把配置的数据源同步到实例根。已有事件或记忆时先备份并确认不会覆盖本机新写入。

## 3. 装大件（可选，但强烈建议）

```bash
node bootstrap.cjs --all
```

- 装 node 便携运行时 / git 便携版 / 向量模型。
- 若清单里仍是占位地址，会打印 `⚠️ 未安装` 并列出未完成项——**这是显式失败，不是成功**。
- 没有向量模型时检索自动降级为 BM25（可用，只是语义弱）。

## 4. 自检（唯一判据）

```bash
node --experimental-sqlite memory-cli.js verify
```

期望：

- `"mode": "instance"`（若为 `engine`，说明第 2 步没做或做错目录）
- `"stale": []`（非空就按提示逐条修，不要忽略）
- `"sync": { "ok": true }`（两仓都已推、工作区干净）

## 5. 接到当前 Agent 环境

1. 选择与当前环境格式匹配的 `templates/*-mcp.json` 或 MCP 配置模板，把 server 指向 `resources/mcp-server/index.js`，并把 `--root` 指到实例目录。
2. 如需宿主健康检查，在实例根创建 `host-checks.json`，只填写当前环境真实存在的路径；也可用 `CP_HOST_CHECKS` 指向显式配置文件。未配置时不会扫描用户主目录。
3. 如需技能挂载检查，在实例根创建 `skill-mounts.json`，再运行 `node skills-sync.js check --root <实例目录> --home <挂载基准目录>`；没有清单时不会检查任何宿主技能目录。
4. 如当前环境支持扩展目录，再运行 `node scripts/install-host-extensions.cjs --check`；该脚本只适用于它声明的扩展布局，不要把它当作所有环境的通用安装器。
5. 重启或重新加载当前环境后，确认 `recall_memory`、`get_current_state` 两个工具可调用，并检查 `events.js coverage` 是否有缺口。

`host-checks.json` 支持 `hook.logDir`、`hook.configPath`、`transcript.projectsDir`、`skillMounts.home`、`replyPolicyTargets` 和 `injection.userFile`；对应环境变量为 `CP_HOST_CHECKS`、`CP_HOOK_LOG_DIR`、`CP_HOOK_CONFIG`、`CP_CC_PROJECTS`、`CP_SKILL_HOME`、`CP_REPLY_POLICY_FILE`、`CP_REPLY_POLICY_NAME`、`CP_INJECTION_USER_FILE`。完整示例见 [`docs/AGENT-CONFIG.md`](docs/AGENT-CONFIG.md)。

## 6. 收尾

```bash
cd <CP_ENGINE> && node cp-sync.cjs doctor
```

两仓 `ok:true` 才算装完并可交接。之后每次收尾只需一条：

```bash
node cp-sync.cjs all      # 或直接运行 SYNC.cmd
```

## 常见失败与处置

| 现象 | 原因 | 处置 |
|---|---|---|
| `verify` 报 `mode: engine` | 数据仓没拉下来 | 重跑第 2 步 |
| `verify` 报 `[F50] 未同步` | 有提交没推 / 工作区脏 | `node cp-sync.cjs all` |
| `verify` 报 `[F51] ... 未入 DIRECTORY-MAP` | 顶层目录变了没更新地图 | 更新 `DIRECTORY-MAP.md`，或把已删目录移入「已核销」 |
| `bootstrap` 打 `⚠️ 未安装` | 清单是占位地址 | 从发布页取资产，或跳过（检索降级但不崩） |
| `add` 被拒 `ENGINE_MODE_WRITE` | 当前目录是引擎仓不是实例 | 用 `--root <实例目录>`，或确属测试就加 `--allow-engine-write` |