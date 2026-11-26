# 新环境接手指南

> 目标：把一份干净的引擎仓接到一个已经配置好的实例数据根，并用可重复检查证明它可继续维护。
> 本页不假设具体 Agent 产品、机器路径或私有数据仓名称。

## 1. 先取代码

```bash
git clone https://github.com/<OWNER>/cosmic-phantom.git <CP_ENGINE>
cd <CP_ENGINE>
node --version
git --version
```

需要 Node.js 22.5+（使用 `node:sqlite`）和 Git。便携运行时不是代码仓资产，若需要则按 `binaries.manifest.json` 和 `bootstrap.cjs` 准备。

## 2. 指定实例根

引擎仓可以独立运行，也可以连接已有实例。实例根应由当前环境显式提供，不要把个人路径写进脚本或文档：

```bash
set CP_ROOT=<INSTANCE_ROOT>       # Windows PowerShell 可改为 $env:CP_ROOT=...
node --experimental-sqlite memory-cli.js verify --root <INSTANCE_ROOT>
```

纯引擎仓报告 `mode: "engine"` 是正常的；它表示没有加载实例数据，不表示完整实例已经健康。

## 3. 接入实例数据

如果当前环境已经配置了数据镜像源，先执行：

```bash
node cp-sync.cjs data pull
```

这是覆盖式镜像。本机已有事件或记忆时，先备份并确认不会覆盖新写入。数据根的具体位置由 `CP_DATA_DIR` 或接入端配置决定。

## 4. 三项接手检查

```bash
node --experimental-sqlite memory-cli.js verify --root <INSTANCE_ROOT>
node --experimental-sqlite events.js status --root <INSTANCE_ROOT>
node resume-context.js fingerprint --root <INSTANCE_ROOT>
```

至少确认：

- `verify` 能区分引擎模式和实例模式；
- `stale`、来源 coverage、候选确认和派生层漂移都有明确结果；
- fingerprint 在停止摄取的静止时刻记录，不能拿持续写入中的数据库做跨机比较。

## 5. 接入端配置

按当前环境选择 `templates/` 中匹配的 MCP 配置示例，并把 server 的 `--root` 指向实例根。然后检查：

```bash
node skills-sync.js check
node --experimental-sqlite memory-cli.js verify --root <INSTANCE_ROOT>
```

如果当前环境明确支持仓内扩展布局，再运行：

```bash
node scripts/install-host-extensions.cjs --check
```

这个脚本只适用于它声明的扩展目录，不是所有 Agent 环境的通用安装器。缺少扩展时，仍需分别验证 MCP、手动摄取和核心检索。

## 6. 维护和交接

```bash
npm test
node scripts/check-sanitize.cjs
node scripts/check-public-surface.cjs
node cp-sync.cjs pull --dry-run
```

完成工作后，按当前环境的写入规则同步代码和实例数据；不要把 `events.db`、记忆卡、候选、日志、机器配置或评测运行结果提交到引擎仓。

## 7. 失败处理

- `verify` 报实例缺失：检查 `--root`、`CP_ROOT` 和数据源配置，不要直接创建假的健康结果。
- `coverage` 有缺口：修复来源适配器或来源注册，不能用手工记忆卡掩盖事件缺失。
- `hybrid-ready` 不存在：可以继续使用 BM25；只有模型、运行时、向量库和集合指纹匹配时才启用混合检索。
- 同步出现分叉：停止写入，保留两个数据库副本，按来源身份和 fingerprint 人工裁决；SQLite 二进制不能靠 Git 合并。
