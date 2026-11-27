# dream 流定档规则（票 12）

> 2026-11-19 定。只写规则，不写代码：分档与合并必须先提案、后人工接受。

## 一、新卡默认档位

| 来源 | 默认 scope | 说明 |
|---|---|---|
| 会话流（daily / 摄取） | `workspace` | 单机单宿主下等价于全局；接第二宿主前升 `agent` |
| 由用户原话直接提炼的偏好 | `global` | 跨项目成立的口径才升；不确定就留 workspace |
| 宿主/工具专属配置（宿主私有接线、MCP 等） | `agent` | 换宿主即失效，不该污染全局 |

## 二、升档与并档

- 升档（workspace → global）必须显式动作，并在卡面写 `promoted_at` 与理由。
- 同 topicKey 多卡 = **合并候选**，不是自动合并：`dream --propose` 产出 `merge-candidate`，accept 一律拒绝，人工判断保留哪条。
- 冲突 = 两条并列（`status: ⚠️冲突` + `conflicts_with`），不判输赢。

## 三、周期 review

- `maintain` 末尾自动刷新 `pro/dream-<date>.md`（只读报告）。
- 提案写入 `pro/dream/proposals-<date>.json`；接受记录写 `pro/dream/accepts-<date>.jsonl`。
- events 永不改写：分档/合并只动卡片层。

## 四、纪律

1. 不自动编造 `situation`；只接受显式文本（`--situation`），否则拒绝。
2. 任何一次接受都必须可回退（改前内容在 git 与提案文件里）。
3. 报告与提案都是**数据层**，随数据仓同步，不放 `.flags`。
