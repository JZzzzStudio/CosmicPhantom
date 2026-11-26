# ARCHITECTURE — 数据模型、不变量与守卫映射

> 给「要改代码的人/Agent」。读完应能回答：真源在哪、哪些层可删、改一处会不会破另一处、怎么证明没破。

---

## 1. 分层与所有权

```
            ┌──────────── 只增不改 ────────────┐
events.db  ← 真源：来源实例 + 记录 ID + revision 幂等，sensitive 打标，source_root 记来源根
            └───────────────┬─────────────────┘
                            │ project（幂等，可重放）
                    daily/YYYY-MM-DD.md
                            │ distill --days 30
                    distilled/daily-*.md（归档）
                            │ 提炼（人工/收尾）
                    memories/YYYY-MM.md ← 卡片真源之二
                            ├── memory-index.db（BM25 统计，派生）
                            ├── vectors.json（bge-small-zh，派生）
                            └── links.json（双向链接，派生）
current-state.json ← 接力状态（revision 防覆盖）
```

**所有权规则**

| 层 | 可删？ | 谁写 |
|---|---|---|
| `events.db` | ❌ 不直接改写 | 适配器 / `log_turn` / 审计事件追加 |
| `daily/` | ✅ 可重放重建 | `events.js project` |
| `distilled/` | ⚠️ 归档可留，精华可重建 | `distill` |
| `candidates/` | ✅ 可拒绝、保留历史 | 旧提取器 / MCP / 迁移；三域 P1 使用隔离子目录 |
| `memories/` | ❌ 不由派生层覆盖（状态可变） | 旧版用户确认 / 受控写入；旧默认检索与注入保持兼容 |
| `domains/<domain>/memories/` | ❌ 不由派生层覆盖（状态可变） | 三域候选经显式授权确认后写入；旧默认检索/注入不读取 |
| `data/memory-audit/` | ❌ 不可当作缓存丢弃；仅保留最小审计字段 | 三域候选确认/拒绝；不保存正文 |
| `memory-index.db` / `vectors.json` / `links.json` / `views/` | ✅ 派生 | `index` / `embed build` / `relink` |

---

## 2. 不变量（改代码前先读）

1. **来源身份必须稳定且可区分**：事件唯一性至少包含来源实例、来源记录 ID 和必要的 revision；内容哈希只能做完整性校验或缺少稳定 ID 时的受限回退，不能把不同真实记录仅凭正文合并。
   重放必须幂等，不同来源记录必须保留；文件重写、插入和截断要能被检测。
2. **投影幂等**：`projection(event_id)` 表记录已投影事件；重跑不重复出 daily 行。
3. **卡片写路径唯一**：所有写入过 `validate.js`（三层校验）；`add/store/supersede/correct` 都走它。
4. **状态机单调**：`🟢当前 → ⏳待验证 / 🔜计划 / 🕰️过去 / ⚠️冲突`；`supersede` 必须「先落后删」，新卡不通过校验则拒绝改旧卡。
5. **证据分级**：`epistemic=inference|self_eval|summary` 不得与 `🟢当前 + 偏好` 同时出现（`validate.js` + F34 双保险）。
6. **检索分 ≠ 准入**：`score` 只用于排序；能否进上下文由准入闸（内容字下限 + 罕见字 + 非通用二字词）决定。
7. **评测隔离**：题集 sha256 冻结；基线只追加到 `eval/baseline-history.jsonl`，不覆盖。

---

## 3. 关键模块

| 模块 | 职责 | 约束 |
|---|---|---|
| `events.js` | SQLite 真源、摄取/投影/索引/coverage | 只增不改；`openDb()` 负责迁移（新增列 fail-open） |
| `memory-retrieval.js` | 分词、BM25/TF、折叠、准入闸、hybrid 融合 | 纯函数优先，便于单测；不得依赖网络 |
| `memory-cli.js` | 旧版命令及隔离的 `domains` 子命令 | 输出 JSON 到 stdout；旧 `search` / `inject` 不读取三域目录 |
| `memory-domains.js` | 三域候选生命周期、显式域检索和纠错版本 | 写操作要求 `--user-confirmed --actor`；域检索必须指定单域或显式跨域 |
| `embed.js` | onnxruntime + BGE 向量 | 模型/运行时缺失 → `null`，调用方降级 |
| `link-graph.js` | `superseded_by` / `ref` 图 | 只读查询 + 重建，不发明关系 |
| `resources/mcp-server/index.js` | 12 个 MCP 工具 | 所有写操作转发 CLI，不重复实现校验 |
| `<host>-adapter.js` | 一类 JSONL 或 transcript 会话源 → events | 适配器必须保留来源实例、记录 ID 和 revision；内容哈希不能单独充当身份 |
| `cp-autopilot`（hook） | 每轮 auto-ingest + 回复质检 + 提醒注入 | fail-open，绝不阻塞会话 |

---

## 4. 守卫与机制映射

| 守卫 | 守护对象 | 故障注入方式（自证） |
|---|---|---|
| F05–F09 | 库健康 / 索引一致 / 技能挂载 | 改一个 SKILL.md → 应报红 |
| F11 / F15 / F17 | CONTEXT 回流 / 状态 TTL / 盲测基线 | 回拨 mtime |
| F23 | 吸收台账双向对账 | 删一行 jsonl → missing+1 |
| F28 | 在制品票据健康 | 空证据 close → 拒绝 |
| F29 / F30 | 技能留痕 / 蒸馏后置 | 改技能名 / 改 manifest |
| F31 | CONTEXT 容积 | 追加 2KB 术语 |
| F33 | **宿主接线**（asar / 扩展 / MCP / 技能） | 改名 `extensions/` → 报红 |
| F34 | **证据分级** | 写一张 `inference + 🟢当前` 卡 |
| F35 | **纠错时效** | `correct` 一张卡并把时间回拨 31 天 |

新增守卫的验收标准：**先让它红，再让它绿**；只绿不红 = 没接上线。

---

## 5. 故障模型

| 故障 | 表现 | 设计对策 |
|---|---|---|
| 向量模型缺失 | 检索退化 | `mode=bm25` 显式暴露，不静默；F17 指标会掉 |
| onnxruntime 不在 | 同上 | `embedText` 返回 `null`，调用方 fail-open |
| 宿主升级 | hook 不加载 | F33 检查 asar 补丁标记；补丁与版本绑定 |
| 宿主扩展加载器独占安装包 | 替换失败 | 先等锁释放再写；失败自动回滚 |
| 会话文件被重写 | 吸收超额或身份漂移 | 依赖稳定来源记录 ID 与 revision；检测插入、截断和重写，不能用正文哈希静默合并不同记录 |
| 并发写卡 | 分桶竞争 | `mutateEntryById` 加锁写；先落后删 |
| 检索噪声 | 无关命中 | 准入闸 + 意图路由 + tag 加权上限 |

---

## 6. 扩展点（加东西时照这个来）

1. **新接入端**：写 `<host>-adapter.js`，落稳定来源身份；在 `hosts.json` 注册；在 `sources.json` 声明；跑 `coverage` 对齐。
2. **新守卫**：写进 `verify`，配故障注入用例（`tests/` 或 guard-selftest）；在 `AGENT-CONFIG.md` §5 加一行对照表。
3. **新 MCP 工具**：只做转发，不复制业务校验；工具描述里写清参数白名单。
4. **新评测题集**：放 `eval/`，跑 `suite-lock accept` 冻结；基线写 `baseline-history.jsonl`。

---

## 7. 已知边界（不打算做的）

- 不做服务端多租户 / 权限模型（单人本地系统，`cp-memory` 私有即是边界）。
- 不做 LLM 在线摘要当记忆（会产生「不可追溯的第二真源」）。
- 不做自动大规模认知自演化（先可信，再自演化）。
- 不把 `events.db` 放进 git（膨胀 + 敏感）。