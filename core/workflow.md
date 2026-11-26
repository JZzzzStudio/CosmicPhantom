# workflow.md — CP 四段工作流（拷问 → 规格 → 票据 → 实施）

> 建立：2026-10-28 ｜ 来源：吸收 mattpocock/skills 的 grilling / to-spec / to-tickets / implement
> 定位：需求到交付的主干流程。与 `requirement-clarify.md`（怎么问）、`rules.md`（硬纪律）、`wrap-up.cjs`（怎么收）分工，不重复。
> 核心原则：**规格是承诺，票据是路径，证据是完成。**

## 一、四段与产物

| 段 | 触发 | 输入 | 产物 | 完成判据 |
|---|---|---|---|---|
| ① 拷问 Grill | 需求/设计对话；≥3 个相互依赖的决策 | 用户意图、`CONTEXT.md` 术语 | 共识 + 决策卡 + 术语回流 | 前沿为空；用户确认"可以写规格了" |
| ② 规格 Spec | ①②之间；或用户说"写规格/出方案" | 已确认的对话 | `work/<slug>/spec.md` | `work check` 通过；用户批准 |
| ③ 票据 Tickets | 规格批准后；或用户说"拆票/排期" | spec | `work/<slug>/tickets/NN-*.md` | 图无环、无悬空；用户批准粒度 |
| ④ 实施 Implement | 有可开工票据（frontier） | 票据 + spec | 代码/文档改动 + 票据证据 | 票 done 带红绿灯证据；双轴复核过 |

小改动不强制走全链，见"规模分档"。

## 二、规模分档（防止流程形式主义）

| 规模 | 判据 | 走法 |
|---|---|---|
| 微 | ≤1 文件且 ≤30 分钟 | 直接做；收尾记 daily |
| 小 | 2-3 文件，或需要一次口头确认 | 写一页 spec（可只填问题/方案/测试决策）→ 直接实施 |
| 中 | ≥4 文件，或跨会话 | spec + tickets（≥2 张票） |
| 大 | 跨天/跨模块/多人并行 | spec + tickets + 分阶段验收；可拆多个 work 项 |

判断不了时按"中"走。探索性原型可跳过票据，但 spec 顶部标 `prototype`，且不合并进主干。

## 三、① 拷问（Grill）

两种模式，按规模选：

- **小需求**：沿用 `requirement-clarify.md` 的"一次 1-2 问 + 选项 + 推荐 + 理由"。
- **大设计**（≥3 个相互依赖的决策）：用**设计树 + 前沿轮**。
  1. 把设计拆成决策树；前沿 = 所有前置已定的问题。
  2. **一轮问完整个前沿**，每题编号 + 推荐答案；等用户答完再算下一轮。
  3. 事实自己查（文件/工具/检索），不向用户要；决策交用户。
  4. 前沿为空 = 结束，请求确认后再写规格。

格式：

```text
❓ Q1 - <问题标题>：<问题正文，可含选项>
➡️ <推荐答案与理由>
```

纪律：
- 不为凑轮次问已知答案；不把事实问题伪装成决策问题。
- 术语冲突当场指出；共识立即写回 `.context/CONTEXT.md`。
- 难逆决策（难回退 + 不看会困惑 + 真有取舍）→ 决策卡，不建 ADR（2026-08-12 用户拍板）。

## 四、② 规格（Spec）

命令：

```text
node work.cjs new <slug> --title "<标题>" --source "<会话/事件指针>"
```

七段必填（`work check` 强制）：问题 / 方案 / 用户故事 / 实现决策 / 测试决策 / 范围外 / 来源证据；备注可选。

写法纪律：
- 问题与方案写**用户视角**，不写文件路径、不贴实现代码（会过期）。
- 用户故事要长，覆盖所有使用面向；每条 `作为…我想要…以便…`。
- 实现决策写模块/接口/契约/schema；决策引用决策卡 id。
- 测试决策**先定缝**（seam）：优先复用既有缝，取最高层，越少越好（理想 1 个）；写清每个缝能抓到什么、会漏什么。
- 范围外必须写（"不做什么"和"做什么"同样重要）。
- 来源证据写 `events.db:<instance>:<mid>` 或会话 id，保证可回溯。

## 五、③ 票据（Tickets）

命令：

```text
node work.cjs ticket <slug> "<标题>" [--blocked-by 00,01] [--seams seamA,seamB]
```

切片规则（tracer bullet）：
- 每张票**垂直穿透**所有层，完成后可独立演示/验证；禁止"先写全部 schema、再写全部 API"的水平切片。
- 单张票能装进一个全新上下文窗口。
- 预重构先做（先让改动变容易，再做容易的改动）。
- **宽重构例外**：影响面横跨全库的机械改动，按 `expand（新旧并存）→ migrate（按包/目录分批）→ contract（删旧）` 排票；必要时共用一个集成分支，最后一张"集成验证"票负责全绿。

票据图：
- `blocked_by` 是硬依赖，不是偏好；无依赖写 `[]`。
- 有环、悬空引用 → `work check` 直接红。
- **前沿（frontier）** = 未完成且所有前置已完成的票；实施只从前沿取票。

用户确认：`work status <slug>` 展示粒度与依赖，用户批准后再开工。

## 六、④ 实施（Implement）

取票：

```text
node work.cjs frontier <slug>
node work.cjs todo <slug>    # 把前沿第一张票投影为 Todo 草案（只投当天一张）
```

纪律：
- 一次只做一张票；开工把票 `status` 改 `in_progress`，完成改 `done` 并填证据。
- 测试在**预先约定的缝**上；红→绿→（重构留到复核），不写实现耦合/同义反复的测试。
- 定期跑单测/类型检查，全部票据完成后跑全量测试。
- 完成后做**双轴复核**：
  - Standards：是否符合 `rules.md` 与仓库约定（含坏味自查：重复/长函数/神秘命名/推测性抽象）。
  - Spec：是否忠实实现 spec，有没有范围蔓延或漏项。
  - 两轴分开报，不合并排序。
- 证据遵循 §4.15 双向量：修复前红灯 + 修复后绿灯；纯新增用注入故障态代替红灯。

## 七、结案与收尾

```text
node work.cjs close <slug>
```

`close` 前置：`work check` 通过 + 所有票据 `done`。动作：
1. spec `status` 改 `implemented`；
2. 生成 `pro/work-<slug>-<YYYYMMDD>.md`（规格 + 票据 + 证据）；
3. 目录移入 `work/.closed/`（保留原始证据，不删）。

收尾链（`wrap-up.cjs`）不阻塞于在制品，但 `verify` 的 F28 会报：
- spec 缺段 / 票据图有环或悬空；
- `in_progress` 票 >7 天未动；
- spec `draft/approved` >14 天；
- 全部票 done 但未 close >7 天。
- 只有 `work/.closed/`、无活跃工作项时 F28 空转（不是漏检：无在制品可查）。

## 八、与既有机制的关系

| 机制 | 关系 |
|---|---|
| `requirement-clarify.md` | 本文件的①段细则；前沿轮是它的"大设计模式" |
| `.context/CONTEXT.md` | 术语唯一真源；spec 用词必须与之一致 |
| 决策卡（`decision-cards.js`） | 难逆决策的载体；spec 引用 id，不建 ADR |
| TaskCreate / Todo | 会话提醒；**work 票据才是真源**，Todo 只投影"今天要做的票" |
| `current-state.json` | 记"当前 work 项 + 下一张票"，不复制票据全文 |
| `core/rules.md` §4.15/§4.16 | 票据 done 的证据标准 |
| `pro/` | 结案档案；work 是在制，二者不混 |
| `work.cjs audit` | 供 `verify` F28 消费；无 work/ 目录时为空转 |

## 九、命令速查

```text
node work.cjs new <slug> --title "<标题>"
node work.cjs ticket <slug> "<标题>" [--blocked-by 00]
node work.cjs check <slug> | --all
node work.cjs status [slug]
node work.cjs frontier <slug>
node work.cjs todo <slug>
node work.cjs close <slug>
node work.cjs audit
```

全部命令支持 `--root <根>`；输出 JSON；`check/close/frontier` 失败退出码 1。

## 十、反模式（出现即返工）

- 规格写完才去问关键问题（顺序反了）。
- 票据按层切（"schema 票 / API 票 / UI 票"）。
- 票 done 但证据是"已实现""测试通过"这种无命令无输出的自述。
- 用 Todo 当票据真源，work/ 空着。
- 规格里塞文件路径和代码片段。
- 为了走流程，给一行改动建 spec。

## 十一、术语治理（CONTEXT.md，2026-10-28 立）

- **唯一性**：每个术语只在 `CONTEXT.md` 定义一次；同名第二次出现必须合并到首次定义处，补记段只写「新增/变更」，不重复整段定义。
- **体积**：30KB 软上限、40KB 硬上限。超软上限时，把已废弃/历史补记段归档到 `distilled/glossary-archive-YYYY-MM.md`，CONTEXT 留一行指针。
- **守卫**：`verify` 的 **F31** 报同名重复与超软上限；**F11** 仍管新鲜度（是否回流），两者分工不重叠。
- **触发**：蒸馏时顺带跑 `node context-lint.cjs`；新增术语前先查同名（`context-lint` 的 duplicates 应为 0）。

## 十二、记忆形态边界（2026-10-28 立，来源 MemT-1.0 评估）

压缩记忆（矩阵/摘要/画像）擅长“记住你是谁”，不擅长“记住上次 bug 第七行”。CP 的分工必须写死：

| 场景 | 必须用的层 | 禁止 |
|---|---|---|
| 法务条款、合同措辞 | `events` 逐字 + `expand` | 只用卡/摘要 |
| 代码具体改动、行号、报错原文 | `events` + `change-log` + `pro/` 档案 | 只用卡/摘要 |
| 财报数字、金额、日期 | `events` 逐字 + `source` 指针 | 只用卡/摘要 |
| 用户原话、决策原意 | `events` + `daily` 决策行 | 转述/摘要 |
| 偏好、画像、方向 | `MEMORY.md` + 偏好卡 | 不需要逐字 |
| 经验/SOP | 规则卡 + `pro/` 档案 + 适用条件 | 当事实证据 |

**判据**：回答里出现“原文 / 具体数字 / 第几行 / 条款号”时，必须能回指 `events.db:<instance>:<mid>` 或 `daily/<date>.md`；回指不到就降级为“印象”并明确说明，不得冒充证据。


> 检索输出 `evidence` 字段（D-20，2026-10-28）：`rounds` / `expandedTo` / `lowEvidence`。有结果但证据不足才扩 top（上限 12）；空结果不扩。
