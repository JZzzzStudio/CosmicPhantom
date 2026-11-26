# CP 通用型 Agent 插件包

CP 插件包是独立、可拔插的本地产品包，不绑定任何主流 Agent。插件包只携带引擎、启动器、适配器契约和迁移代码，不携带用户实例数据。

## 包结构

```text
plugin-package/
├── plugin.json
├── launcher.cjs
├── lib/
├── engine/
├── adapters/
└── checksums.json
```

`plugin.json` 是包身份和运行契约，`checksums.json` 用 SHA-256 记录包内文件。`events.db`、`memories/`、`candidates/`、配置、游标和派生索引都必须位于包外实例目录。

## 配置而非安装

分发层负责把包放到插件目录；CP 不实现安装向导。首次运行使用配置命令：

```bash
node plugin/launcher.cjs configure --instance <实例目录> --apply \
  --adapter jsonl --backfill none --scope workspace --retrieval bm25
```

不带 `--apply` 时只输出预览，不创建配置。配置向导目前支持 `manual`、`jsonl` 和 `transcript` 三类通用输入声明；具体来源必须自行提供可读的事件出口。

## 生命周期

```bash
node plugin/launcher.cjs status --instance <实例目录>
node plugin/launcher.cjs enable --instance <实例目录> --apply
node plugin/launcher.cjs disable --instance <实例目录> --apply
node plugin/launcher.cjs health --instance <实例目录>
node plugin/launcher.cjs verify --instance <实例目录>
node plugin/launcher.cjs ingest --instance <实例目录> --input <标准事件.jsonl>
node plugin/launcher.cjs sync --instance <实例目录>
node plugin/launcher.cjs uninstall --instance <实例目录> --yes
```

- `enable`：允许插件进入启用状态。
- `disable`：停止摄取意图，但保留全部实例数据。
- `uninstall`：只记录插件卸载状态，不删除实例数据；实际插件代码删除由分发层执行。
- `upgrade`：先做包身份检查并创建实例内备份；P0 不自动替换正在运行的插件目录，也不声称已提供分发层自动回滚。真实分发层应把新包放入临时目录，完成校验和冒烟后再切换目录；切换失败时恢复旧目录。
- 分发接口核查：本机 Cindy `0.1.146` 的 Forge `pack/install` 接受带 `ghost.json` 的 Cindy 插件源码，生成并安装 Cindy `.cindy` 插件；它不接受 CP 的 `plugin.json` 通用包。当前暴露的工具契约也没有承诺目录切换中断后的自动恢复，因此不能把 Cindy Forge 当作 CP 分发器或回滚证据。
- 删除数据不是生命周期命令；必须由独立的、明确确认的高风险操作实现。

## 标准事件

适配器输出 JSONL，每行至少包含：

```json
{
  "source_instance": "stable-source-instance",
  "source_id": "stable-record-id",
  "revision": 1,
  "session_id": "session-id",
  "role": "user",
  "content": "原始内容",
  "ts": "2026-11-23T00:00:00.000Z",
  "scope": "workspace",
  "source_kind": "jsonl",
  "source_ref": "file.jsonl#L1"
}
```

写入入口：

```bash
node --experimental-sqlite events.js ingest-normalized \
  --input <标准事件.jsonl> --root <实例目录>
```

事件身份由 `source_instance + source_id + revision` 构成。正文哈希只能用于完整性检查，不能把相同正文的两条真实记录合并。重复回放必须幂等；身份冲突必须失败并留痕。

候选提纯由包内 `engine/memory-cli.js` 调用，代码目录和实例数据目录分离：

```bash
node --experimental-sqlite engine/memory-cli.js candidate distill-events \
  --root <实例目录>                         # 默认 dry-run
node --experimental-sqlite engine/memory-cli.js candidate distill-events \
  --apply --root <实例目录>                 # 只创建 pending candidate
```

扫描超过 `--limit` 时，使用输出的 `nextAfterId` 传给 `--after-id` 继续；候选仍须经过 `candidate confirm` 才会进入 `memories/`。

## 打包和校验

```bash
npm run plugin:sync-engine
npm run plugin:check
npm run plugin:test
npm run plugin:pack -- --out <输出目录>
```

打包器先在输出目录旁边生成并校验临时包，再通过目录重命名完成输出切换；切换事务写入 `<输出目录>.cp-transaction.json`，同一输出目录同时只允许一个打包进程。若进程在旧包移走或新包换入窗口中断，下一次打包会校验事务、目标包校验和与旧包状态，并恢复到一致状态后继续。强制终止或机器故障可能留下 `<输出目录>.cp-lock`；确认锁内 PID 已退出后，分发层/操作者必须先移除该锁，再重跑打包让事务恢复，不能在未确认时强行删除。输出目录与源码重叠、指向符号链接或包含非 CP 包数据时会拒绝操作；实例数据不会被复制或清理。

P0 使用目录包作为可验证交付物；压缩归档、GitHub Release、签名发布、宿主插件目录替换和宿主级自动回滚属于后续分发层工作。这里的事务恢复只覆盖 CP 自己管理的 `--out` 包输出目录，不证明任意宿主或安装器能在插件目录切换中断后自动恢复。`tests/plugin-p0-test.mjs` 中的“隔离分发演练”证明包外实例边界、故障包可被冒烟发现、CP 包输出事务可恢复，以及恢复后实例数据不变；它仍不替代真实宿主/分发器验收。
