#!/usr/bin/env node
/**
 * mcp-server/index.js — 宇宙幻影 MCP 服务器（8 工具契约）
 *
 * 零依赖 stdio 实现（JSON-RPC 2.0 over stdio，不依赖 @modelcontextprotocol/sdk）
 * 单实现原则：工具全部转发 memory-cli.js（MCP 只是 CLI 的协议壳，防行为分叉）
 *
 * 安全边界（v3.0 §5.2 关键实现细节）：store_memory 的 scope 只允许 global/workspace
 * 枚举值，不做路径拼接——从根上杜绝路径穿越。
 *
 * 工具:
 *   recall_memory   {query, top?}  检索（转发 CLI search）
 *   store_memory    {content, sourceRef, confidence, ...}  写入提纯候选（不直接激活）
 *   list_candidates {state?}  枚举提纯候选
 *   edit_candidate  {candidateId, content}  修改候选正文（不改来源指针）
 *   confirm_candidates {candidateIds|all}  用户确认后批量激活
 *   reject_candidates {candidateIds}  拒绝候选但保留审计记录
 *   log_turn        {transcript, session?}  写强制入口（转发 CLI log）
 *   list_memories   {scope?, status?}  枚举活跃记忆（不含候选）
 *   verify_memory    {}  审计报告（转发 CLI verify）
 *   get_current_state {}  读取跨窗口接力状态
 *   update_current_state {expectedRevision, patch, actor?, source?}  显式更新接力状态
 *   get_recovery_context {}  读取低 Token 回复规则与当前状态恢复胶囊
 *   —— 以下 4 个为只读双向链接工具（复用 link-graph.js 原语，纯查询无副作用）——
 *   memory_links   {id}      单节点出入边（superseded_by/supersedes/ref/referenced_by）
 *   memory_refs    {id}      反向反查（谁取代了本节点）
 *   memory_lineage {id}      决策演变全链路（最新→最旧）
 *   memory_graph   {entity}  按实体（ref 值子串）反查相关纸条
 */
import { readFileSync, readdirSync, existsSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { listMemoryEntries } from "../../memory-retrieval.js";
import { join, resolve, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCurrentState, updateCurrentState } from "../../current-state.js";

const ENGINE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// 双向链接层（P0 只读工具）：直接复用 link-graph.js 原语。
// 与"单实现原则"不冲突——memory-cli 的 links/refs/lineage/graph 命令也只是这些原语的薄壳，
// MCP 直接调用同一函数，零行为分叉；纯读、无副作用、不碰 events.db/memories。
import { queryLinks, queryRefs, queryLineage, queryGraph } from "../../link-graph.js";

const DEFAULT_ROOT = join(homedir(), ".cosmic-phantom");
const rootArgIndex = process.argv.indexOf("--root");
// Command-line configuration wins because some hosts do not forward MCP env values.
const ROOT = (rootArgIndex >= 0 && process.argv[rootArgIndex + 1]) || process.env.CP_ROOT || DEFAULT_ROOT;
const LOG_ROOT = process.env.CP_LOG_DIR || ROOT;
const MEM_DIR = join(ROOT, "memories");
const CLI = join(ENGINE_ROOT, "memory-cli.js");
const RESUME_CONTEXT = join(ENGINE_ROOT, "resume-context.js");
const EVENTS = join(ENGINE_ROOT, "events.js");
const NODE = existsSync(join(ENGINE_ROOT, "tools", "node", "node.exe")) ? join(ENGINE_ROOT, "tools", "node", "node.exe") : process.execPath;
const VALID_STATUS = ["🟢当前", "⏳待验证", "🔜计划", "🕰️过去"];   // ⏳=待验证池（2026-08-28）

// 日志降噪（2026-08-28 反查效率升级 E2）：MCP server 进程频繁重启导致重复行膨胀——
// 同文本 60s 内幂等不重写；append 前体量守卫（>512KB 截半保留新半），防无限膨胀
let lastLog = { text: "", at: 0 };
function logMCP(m) {
  try {
    const now = Date.now();
    if (lastLog.text === m && now - lastLog.at < 60000) return;
    lastLog = { text: m, at: now };
    const f = join(LOG_ROOT, "hook-errors.log");
    try { if (statSync(f).size > 524288) { const lines = readFileSync(f, "utf8").split("\n"); writeFileSync(f, lines.slice(Math.floor(lines.length / 2)).join("\n"), "utf8"); } } catch {}
    appendFileSync(f, `[${new Date().toISOString()}] mcp: ${m}\n`);
  } catch {}
}

function callCli(args) {
  // Preserve the selected instance root across the MCP -> CLI process boundary.
  const fullArgs = [...args, "--root", ROOT];
  const r = spawnSync(NODE, [CLI, ...fullArgs], { encoding: "utf8", timeout: 30000 });
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "" };
}

// ---------- 工具实现 ----------
function recallMemory(params) {
  const query = (params.query || "").trim();
  if (!query) return text("空查询词", true);
  const top = Number.isInteger(params.top) && params.top > 0 ? Math.min(params.top, 50) : 5;
  const args = ["search", query, "--top", String(top)];
  if (params.since) args.push("--since", String(params.since));
  if (params.until) args.push("--until", String(params.until));
  if (params.scope === "global" || params.scope === "workspace") args.push("--scope", params.scope);
  const r = callCli(args);
  return r.ok ? text(r.out) : text(r.err || "检索失败", true);
}

function candidateCli(args, invalidMessage = "候选操作失败") {
  const r = callCli(["candidate", ...args]);
  if (!r.ok) return text(r.err || invalidMessage, true);
  const output = r.out || invalidMessage;
  try {
    const value = JSON.parse(output);
    if (value.ok === false || value.added === false || value.updated === false || value.error) return text(output, true);
  } catch {}
  return text(output, false);
}

function storeMemory(params) {
  const content = (params.content || "").trim();
  const sourceRef = String(params.sourceRef || "").trim();
  const confidence = Number(params.confidence);
  if (!content) return text("内容为空", true);
  if (!sourceRef) return text("sourceRef 不能为空：候选必须可回溯到原始事件或工具结果", true);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return text("confidence 必须是 0~1 的数字", true);
  const sourceKinds = ["user_said", "assistant_said", "told", "imagined", "inferred", "tool"];
  if (params.sourceKind !== undefined && !sourceKinds.includes(params.sourceKind)) return text("sourceKind 非法", true);
  if (params.scope !== undefined && !["global", "workspace"].includes(params.scope)) return text("scope 非法", true);
  const kind = ["term", "decision", "preference", "rule", "correction", "tool_fact", "checkpoint"].includes(params.kind)
    ? params.kind
    : params.type === "偏好" ? "preference" : params.type === "规则" ? "rule" : "decision";
  const args = ["add", content, "--kind", kind, "--source-ref", sourceRef, "--confidence", String(confidence), "--source-kind", params.sourceKind || "user_said", "--scope", params.scope === "workspace" ? "workspace" : "global"];
  if (params.situation) args.push("--situation", String(params.situation));
  if (params.actor) {
    if (/[\r\n]/.test(String(params.actor))) return text("actor 不得包含换行", true);
    args.push("--actor", String(params.actor));
  }
  return candidateCli(args, "候选写入失败");
}

function listCandidatesTool(params) {
  const args = ["list"];
  if (["candidate", "confirmed", "rejected", "conflict"].includes(params.state)) args.push("--state", params.state);
  return candidateCli(args, "候选列表读取失败");
}

function editCandidateTool(params) {
  const id = String(params.candidateId || "").trim();
  const content = String(params.content || "").trim();
  if (!id || !content) return text("candidateId 和 content 不能为空", true);
  const args = ["edit", id, content];
  if (params.actor) {
    if (/[\r\n]/.test(String(params.actor))) return text("actor 不得包含换行", true);
    args.push("--actor", String(params.actor));
  }
  return candidateCli(args, "候选修改失败");
}

function candidateActor(value) {
  const actor = String(value || "user");
  if (!actor.trim() || /[\r\n]/.test(actor) || actor.length > 120) return null;
  return actor;
}

function confirmCandidatesTool(params) {
  const ids = Array.isArray(params.candidateIds) ? params.candidateIds.map(String).filter(Boolean) : [];
  const actor = candidateActor(params.actor);
  if (!actor) return text("actor 非法：不能为空、不能包含换行且不超过 120 字符", true);
  if (params.all === true && ids.length) return text("candidateIds 与 all=true 不可并用", true);
  if (params.all !== true && !ids.length) return text("candidateIds 不能为空，或显式传 all=true", true);
  const args = ["confirm", ...(params.all === true ? ["--all"] : ids), "--actor", actor];
  if (params.previewHash !== undefined) {
    if (typeof params.previewHash !== "string" || !/^[a-f0-9]{64}$/i.test(params.previewHash)) return text("previewHash 必须是预览返回的 64 位十六进制指纹", true);
    args.push("--preview-hash", params.previewHash);
  }
  return candidateCli(args, "候选确认失败");
}

function rejectCandidatesTool(params) {
  const ids = Array.isArray(params.candidateIds) ? params.candidateIds.map(String).filter(Boolean) : [];
  const actor = candidateActor(params.actor);
  if (!actor) return text("actor 非法：不能为空、不能包含换行且不超过 120 字符", true);
  if (!ids.length) return text("candidateIds 不能为空", true);
  return candidateCli(["reject", ...ids, "--actor", actor], "候选拒绝失败");
}

function reviewCandidatesTool(params) {
  const args = ["review", "--status", params.status || "pending"];
  return candidateCli(args, "候选审阅列表读取失败");
}

function candidateSourceTool(params) {
  const id = String(params.candidateId || "").trim();
  if (!id) return text("candidateId 不能为空", true);
  const args = ["source", id];
  if (params.expand === true) {
    args.push("--expand");
    if (params.bytes !== undefined) args.push("--bytes", String(params.bytes));
  }
  return candidateCli(args, "候选来源读取失败");
}

function reviewStatusTool(params, action) {
  const ids = Array.isArray(params.candidateIds) ? params.candidateIds.map(String).filter(Boolean) : [];
  const actor = candidateActor(params.actor);
  if (!actor) return text("actor 非法：不能为空、不能包含换行且不超过 120 字符", true);
  if (!ids.length) return text("candidateIds 不能为空", true);
  return candidateCli([action, ...ids, "--actor", actor], `候选${action === "defer" ? "暂缓" : "恢复"}失败`);
}

function previewCandidateConfirmationTool(params) {
  const ids = Array.isArray(params.candidateIds) ? params.candidateIds.map(String).filter(Boolean) : [];
  if (!ids.length) return text("candidateIds 不能为空", true);
  return candidateCli(["preview", ...ids], "候选确认预检失败");
}

// 路径边界校验（v3.0 §5.2 安全边界）：path 类参数只允许落在 baseDir 内，
// 防 ../ 或绝对路径越出记忆库。2026-08-12 ponytail 阶梯审查删除：safeResolve 定义后 0 调用
// （无 path 参数工具，防御性保留 = YAGNI 死代码）；未来新增 path 参数工具时按此模式重建。

function logTurn(params) {
  const tp = params.transcript || "";
  if (!tp || !existsSync(tp)) return text("transcript 不存在", true);
  // §5.2 路径边界：拒绝记忆库内路径（防把 memories/daily 当 transcript 灌入）
  const t = resolve(tp);
  if (t.startsWith(resolve(MEM_DIR) + sep) || t.startsWith(resolve(join(ROOT, "daily")) + sep)) {
    return text("transcript 不得指向记忆库内部", true);
  }
  const r = callCli(["log", "--transcript", tp, "--session", params.session || "anon"]);
  return r.ok ? text(r.out) : text(r.err || "落盘失败", true);
}

function listMemories(params) {
  // 月度分桶（2026-09-01）：枚举改条目级（桶条目+遗留单卡通吃），file 字段 = 虚拟路径（桶文件#id）
  const entries = listMemoryEntries(MEM_DIR);
  const items = [];
  for (const e of entries) {
    const meta = e.meta || {};
    if (params.scope && meta.scope !== params.scope) continue;
    // Default list is an active-memory surface. Legacy pending/past cards remain
    // auditable only when the caller explicitly requests their status.
    if (!params.status && meta.status !== "🟢当前") continue;
    if (params.status && meta.status !== params.status) continue;
    items.push({ file: e.virtualPath, id: e.id, status: meta.status, scope: meta.scope, type: meta.type, title: meta.title, created: meta.created, candidate_id: meta.candidateId, candidate_source_ref: meta.candidateSourceRef, confirmed_by: meta.confirmedBy, confirmed_at: meta.confirmedAt, size: Buffer.byteLength(e.raw) });
  }
  return text(JSON.stringify({ count: items.length, items }, null, 2));
}

function verifyMemory() {
  const r = callCli(["verify"]);
  return r.ok ? text(r.out) : text(r.err || "审计失败", true);
}

function getCurrentState() {
  return text(JSON.stringify(loadCurrentState(process.env.CP_CURRENT_ROOT || ROOT), null, 2));
}

function getRecoveryContext() {
  // 胶囊预算统一读 inject.config.json（2026-09-01：删硬编码 --bytes 3200 第三口径）
  const child = spawnSync(NODE, [RESUME_CONTEXT, "render", "--root", ROOT], { encoding: "utf8", timeout: 30000 });
  return child.status === 0 ? text(child.stdout) : text(child.stderr || "恢复胶囊读取失败", true);
}

function updateCurrentStateTool(params) {
  if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 0) return text("expectedRevision 必须是非负整数", true);
  if (!params.patch || typeof params.patch !== "object" || Array.isArray(params.patch)) return text("patch 必须是对象", true);
  try {
    const state = updateCurrentState(process.env.CP_CURRENT_ROOT || ROOT, params.patch, {
      expectedRevision: params.expectedRevision,
      actor: params.actor || "mcp-agent",
      source: params.source || "MCP explicit update",
    });
    return text(JSON.stringify({ updated: true, state }, null, 2));
  } catch (error) {
    return text(JSON.stringify({ updated: false, code: error.code || "CURRENT_STATE_ERROR", error: String(error.message || error) }), true);
  }
}

// ---------- 双向链接只读工具（复用 link-graph.js 原语，纯查询无副作用） ----------
// 透明说明：link-graph.js 的 queryLinks 原语只返回 superseded_by/supersedes/ref，
// 不含 referenced_by（反向边属 queryRefs 原语）。memory_links 要求单节点"出入边"齐全，
// 故组合 queryLinks + queryRefs 两个读原语，未修改 link-graph.js（无静默改）。
// 验收发现（2026-08-29）：links.json 节点键=绝对路径（去 .md），工具描述却引导短 id
// → 短 id 一律 found:false。修法：工具层短 id 解析（文件名即 id 惯例：memories/<id>.md 含
// 过去/ 子目录，递归兜底），已含路径分隔/盘符的入参原样透传。
function resolveCardId(raw) {
  const id = String(raw || "").trim();
  if (!id || /[\\/:]/.test(id)) return id;
  const hit = (p) => { try { return existsSync(p) ? p.slice(0, -3) : null; } catch { return null; } };
  const direct = hit(join(ROOT, "memories", id + ".md")) || hit(join(ROOT, "memories", "过去", id + ".md"));
  if (direct) return direct;
  let found = null;
  const walk = (dir) => {
    if (found) return;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === id + ".md") { found = p.slice(0, -3); return; }
    }
  };
  walk(join(ROOT, "memories"));
  return found || id;
}

function memoryLinks(params) {
  const id = resolveCardId(params.id);
  if (!id) return text("id 为空", true);
  const q = queryLinks(ROOT, id);
  if (!q.found) return text(JSON.stringify({ id: params.id, found: false }), true);
  const r = queryRefs(ROOT, id);
  return text(JSON.stringify({
    id: q.id, found: true,
    superseded_by: q.superseded_by,   // 我取代了谁（旧）
    supersedes: q.supersedes,         // 谁取代了我（新）
    ref: q.ref,                       // 实体引用（人/项目/决策）
    referenced_by: r.referenced_by || [], // 谁 supersedes 了我（反向反查）
  }, null, 2));
}

function memoryRefs(params) {
  const id = resolveCardId(params.id);
  if (!id) return text("id 为空", true);
  const r = queryRefs(ROOT, id);
  if (!r.found) return text(JSON.stringify({ id: params.id, found: false }), true);
  return text(JSON.stringify({ id: r.id, found: true, referenced_by: r.referenced_by }, null, 2));
}

function memoryLineage(params) {
  const id = resolveCardId(params.id);
  if (!id) return text("id 为空", true);
  const r = queryLineage(ROOT, id);
  if (!r.found) return text(JSON.stringify({ id: params.id, found: false }), true);
  return text(JSON.stringify({ id: r.id, found: true, latest: r.latest, chain: r.chain }, null, 2));
}

function memoryGraph(params) {
  const entity = (params.entity || "").trim();
  if (!entity) return text("entity 为空", true);
  const r = queryGraph(ROOT, entity);
  return text(JSON.stringify({ entity: r.entity, found: r.found, ids: r.ids }, null, 2));
}

// ---------- MCP 协议（JSON-RPC 2.0 over stdio） ----------
const TOOLS = [
  { name: "recall_memory", description: "检索已确认活跃记忆（候选和原始事件不进默认检索）", inputSchema: { type: "object", properties: { query: { type: "string", description: "查询词" }, top: { type: "integer", minimum: 1, maximum: 50, description: "返回条数，默认 5" }, since: { type: "string", description: "起始日期（含），YYYY-MM-DD 或 ISO" }, until: { type: "string", description: "截止日期（含），YYYY-MM-DD 或 ISO" }, scope: { type: "string", enum: ["global", "workspace"] } }, required: ["query"] } },
  { name: "store_memory", description: "创建提纯候选；必须提供 sourceRef 和 confidence，不会直接写入活跃记忆", inputSchema: { type: "object", properties: { content: { type: "string" }, kind: { type: "string", enum: ["term", "decision", "preference", "rule", "correction", "tool_fact", "checkpoint"] }, sourceRef: { type: "string", description: "原始事件或工具结果指针" }, sourceKind: { type: "string", enum: ["user_said", "assistant_said", "told", "imagined", "inferred", "tool"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, situation: { type: "string" }, scope: { type: "string", enum: ["global", "workspace"] }, actor: { type: "string" } }, required: ["content", "sourceRef", "confidence"] } },
  { name: "list_candidates", description: "列出提纯候选；不读取原始事件正文", inputSchema: { type: "object", properties: { state: { type: "string", enum: ["candidate", "confirmed", "rejected", "conflict"] } } } },
  { name: "review_candidates", description: "按审阅状态列出候选摘要；默认只列待审，不读取原始事件正文", inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "deferred", "confirmed", "rejected", "conflict", "all"] } } } },
  { name: "candidate_source", description: "读取候选的来源摘要；只有显式 expand=true 才返回受字节预算限制的事件流", inputSchema: { type: "object", properties: { candidateId: { type: "string" }, expand: { type: "boolean" }, bytes: { type: "integer", minimum: 2000, maximum: 8000 } }, required: ["candidateId"] } },
  { name: "edit_candidate", description: "修改候选正文；原始 sourceRef 不可覆盖，修改后仍需确认", inputSchema: { type: "object", properties: { candidateId: { type: "string" }, content: { type: "string" }, actor: { type: "string" } }, required: ["candidateId", "content"] } },
  { name: "defer_candidates", description: "暂缓候选审阅；不会激活候选", inputSchema: { type: "object", properties: { candidateIds: { type: "array", items: { type: "string" }, minItems: 1 }, actor: { type: "string" } }, required: ["candidateIds"] } },
  { name: "resume_candidates", description: "恢复暂缓候选为待审；不会激活候选", inputSchema: { type: "object", properties: { candidateIds: { type: "array", items: { type: "string" }, minItems: 1 }, actor: { type: "string" } }, required: ["candidateIds"] } },
  { name: "preview_candidate_confirmation", description: "对候选集合做完整确认预检并返回预览指纹；不激活候选", inputSchema: { type: "object", properties: { candidateIds: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["candidateIds"] } },
  { name: "confirm_candidates", description: "显式确认候选并批量物化为活跃记忆；推荐先预览，再传 previewHash，预览失效时整批拒绝", inputSchema: { type: "object", properties: { candidateIds: { type: "array", items: { type: "string" }, minItems: 1 }, all: { type: "boolean" }, previewHash: { type: "string", description: "preview_candidate_confirmation 返回的指纹；传入后启用严格预检" }, actor: { type: "string" } } } },
  { name: "reject_candidates", description: "拒绝候选但保留候选和历史记录", inputSchema: { type: "object", properties: { candidateIds: { type: "array", items: { type: "string" }, minItems: 1 }, actor: { type: "string" } }, required: ["candidateIds"] } },
  { name: "log_turn", description: "写强制入口：从 transcript 派生 daily 条目（幂等）", inputSchema: { type: "object", properties: { transcript: { type: "string" }, session: { type: "string" } }, required: ["transcript"] } },
  { name: "list_memories", description: "枚举记忆条目（可过滤 scope/status）", inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["global", "workspace"] }, status: { type: "string", enum: VALID_STATUS } } } },
  { name: "verify_memory", description: "全库审计报告（噪音率/索引一致性/待修条目）", inputSchema: { type: "object", properties: {} } },
  { name: "get_current_state", description: "读取跨窗口接力状态（目标/进度/决定/阻塞/下一步）", inputSchema: { type: "object", properties: {} } },
  { name: "get_recovery_context", description: "读取低 Token 回复规则与当前状态恢复胶囊", inputSchema: { type: "object", properties: {} } },
  {
    name: "update_current_state",
    description: "显式更新接力状态；必须携带当前 revision 防止覆盖其他 Agent",
    inputSchema: {
      type: "object",
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        actor: { type: "string" },
        source: { type: "string" },
        patch: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "blocked", "paused", "completed"] },
            objective: { type: "string" },
            summary: { type: "string" },
            completed: { type: "array", items: { type: "string" } },
            nextActions: { type: "array", items: { type: "string" } },
            blockers: { type: "array", items: { type: "string" } },
            decisions: { type: "array", items: { type: "string" } },
            workingFiles: { type: "array", items: { type: "string" } },
            verification: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      required: ["expectedRevision", "patch"],
    },
  },
  { name: "memory_links", description: "双向链接·单节点出入边（superseded_by/supersedes/ref/referenced_by）；只读，无副作用", inputSchema: { type: "object", properties: { id: { type: "string", description: "记忆纸条 id（支持短 id 如 20260811-0007 或绝对路径，短 id 自动解析）" } }, required: ["id"] } },
  { name: "memory_refs", description: "双向链接·反向反查（谁取代了本节点 referenced_by）；只读，无副作用", inputSchema: { type: "object", properties: { id: { type: "string", description: "记忆纸条 id（支持短 id，自动解析）" } }, required: ["id"] } },
  { name: "memory_lineage", description: "双向链接·决策演变全链路（沿 supersede 展开，最新→最旧）；只读，无副作用", inputSchema: { type: "object", properties: { id: { type: "string", description: "记忆纸条 id（支持短 id，自动解析）" } }, required: ["id"] } },
  { name: "memory_graph", description: "双向链接·按实体（ref 值子串）反查相关纸条；只读，无副作用", inputSchema: { type: "object", properties: { entity: { type: "string", description: "实体关键字，如 <USER> 或 2026-08-13-007" } }, required: ["entity"] } },
];

function text(t, isError = false) {
  return { content: [{ type: "text", text: t }], isError };
}

// ---------- 会话开场自动注入（强执行，2026-08-12） ----------
// MCP 协议标准：initialize 响应的 instructions 字段会被客户端注入系统提示（不靠 Agent 自觉）。
// 每次 MCP 连接（= 每次会话开始）动态生成最新状态摘要，低 Token（~900B）。
function buildInstructions() {
  const parts = [];
  try {
    const st = JSON.parse(readFileSync(join(ROOT, "current-state.json"), "utf8"));
    parts.push(`【宇宙幻影接力状态 revision ${st.revision}】`);
    if (st.objective) parts.push(`目标: ${st.objective}`);
    if (st.summary) parts.push(`现状: ${st.summary}`);
    if (Array.isArray(st.nextActions) && st.nextActions.length) parts.push(`下一步: ${st.nextActions.slice(0, 2).join(" / ")}`);
    if (Array.isArray(st.decisions) && st.decisions.length) parts.push(`最近决策: ${st.decisions.slice(-2).join(" / ")}`);
  } catch (error) {
    parts.push(`接力状态读取失败: ${String(error.message || error).slice(0, 160)}`);
  }
  try {
    const r = spawnSync(NODE, ["--experimental-sqlite", EVENTS, "coverage", "--root", ROOT], { encoding: "utf8", timeout: 20000 });
    if (r.status !== 0 || r.error) {
      parts.push(`吸收覆盖率读取失败: ${String(r.error?.message || r.stderr || `退出码 ${r.status}`).trim().replace(/\s+/g, " ").slice(0, 160)}`);
    } else {
      const raw = (r.stdout || "").split("\n").filter(Boolean).pop() || "";
      const j = JSON.parse(raw);
      if (!Number.isFinite(j.aligned) || !Number.isFinite(j.checked) || !Array.isArray(j.gaps)) throw new Error("覆盖率输出缺少完整字段");
      const bad = j.gaps.filter(g => g.gap !== null && g.gap > 1).map(g => `${g.name}(${g.gap})`).join("、");
      parts.push(`吸收: ${j.aligned}/${j.checked} 源对齐${bad ? `；缺口 ${bad}` : ""}`);
    }
  } catch (error) {
    parts.push(`吸收覆盖率读取失败: ${String(error.message || error).slice(0, 160)}`);
  }
  // daily/events are evidence-layer data. MCP initialize is a default system-prompt
  // surface, so it must not replay raw user decisions before candidate confirmation.
  return parts.join("\n");
}

function handle(method, params, id) {
  try {
    switch (method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, instructions: buildInstructions(), serverInfo: { name: "cosmic-phantom-mcp", version: "3.0.0" } } };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": {
        const name = params?.name, args = params?.arguments || {};
        let result;
        if (name === "recall_memory") result = recallMemory(args);
        else if (name === "store_memory") result = storeMemory(args);
        else if (name === "list_candidates") result = listCandidatesTool(args);
        else if (name === "review_candidates") result = reviewCandidatesTool(args);
        else if (name === "candidate_source") result = candidateSourceTool(args);
        else if (name === "edit_candidate") result = editCandidateTool(args);
        else if (name === "defer_candidates") result = reviewStatusTool(args, "defer");
        else if (name === "resume_candidates") result = reviewStatusTool(args, "resume");
        else if (name === "preview_candidate_confirmation") result = previewCandidateConfirmationTool(args);
        else if (name === "confirm_candidates") result = confirmCandidatesTool(args);
        else if (name === "reject_candidates") result = rejectCandidatesTool(args);
        else if (name === "log_turn") result = logTurn(args);
        else if (name === "list_memories") result = listMemories(args);
        else if (name === "verify_memory") result = verifyMemory(args);
        else if (name === "get_current_state") result = getCurrentState();
        else if (name === "get_recovery_context") result = getRecoveryContext();
        else if (name === "update_current_state") result = updateCurrentStateTool(args);
        else if (name === "memory_links") result = memoryLinks(args);
        else if (name === "memory_refs") result = memoryRefs(args);
        else if (name === "memory_lineage") result = memoryLineage(args);
        else if (name === "memory_graph") result = memoryGraph(args);
        else result = text(`未知工具 ${name}`, true);
        return { jsonrpc: "2.0", id, result };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `未知方法 ${method}` } };
    }
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } };
  }
}

// 逐行读 stdin（MCP stdio 传输：每条消息一行 JSON）
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") return;  // 通知无响应
  const resp = handle(msg.method, msg.params, msg.id);
  if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
});
rl.on("close", () => process.exit(0));
