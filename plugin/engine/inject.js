#!/usr/bin/env node
/**
 * inject.js — 读强制：代码检索 + 预注入（模型无选择）
 *
 * 用法:
 *   node inject.js --hint "<当前上下文关键词>" [--top 3] [--bytes 2048]
 *
 * 输出: 固定格式注入块 <memory-injected>...</memory-injected>
 * 语义: fail-open——任何异常输出空块，进程退出码 0，绝不阻塞主流程
 *
 * 吸收点 C（TencentDB Agent Memory 实测）：文档数 <10 时 IDF 失真（每词都显稀有），
 * 放弃 IDF 直接按 TF 排序——东西少时用笨办法反而更准。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { renderRecovery } from "./resume-context.js";
import { buildIdentityCard } from "./identity-card.js";
import { loadInjectConfig } from "./inject-config.js";
import { retrieveMemories, retrieveMemoriesHybrid, truncateUtf8 } from "./memory-retrieval.js";

// K17/K18 同族补丁：支持 --root（INSTALL §4.1"所有脚本支持 --root"契约一致化）
const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const MEM_DIR = join(ROOT, "memories");

const INJECT_BLOCK = (items, meta, memoryBytes) => {
  const head = `<memory-injected source="cosmic-phantom" count="${items.length}">\n${meta || ""}`;
  const tail = "\n（如需更多相关记忆，可用 search 命令扩大检索）\n</memory-injected>\n";
  const budget = Math.max(0, memoryBytes - Buffer.byteLength(head + tail));
  const inner = truncateUtf8(items.map(i => `- [${i.status}] ${i.title} (${i.path})\n  ${i.snippet}`).join("\n"), budget);
  return head + inner + tail;
};

// §4.6 心跳（镜像最近时间）+ §3.1 ④ 最近日志摘要（压缩恢复兜底）：fail-open，失败返回空串
function buildMeta() {
  try {
    const parts = [];
    const lm = join(ROOT, "backup", "last-mirror.txt");
    if (existsSync(lm)) parts.push(`（系统心跳：镜像 ${readFileSync(lm, "utf8").trim()}）`);
    // daily/events are evidence-layer data. Never copy even session headings into the
    // default injection block; explicit expand remains the evidence access path.
    return parts.length ? parts.join("\n") + "\n" : "";
  } catch { return ""; }
}

function verify() {
  const config = loadInjectConfig(ROOT);
  const card = buildIdentityCard(ROOT);
  const recovery = renderRecovery(ROOT, config.recoveryBytes);
  const report = {
    ok: card.bytes <= card.budget && card.errors.length === 0 && Buffer.byteLength(recovery) <= config.recoveryBytes,
    identityCard: { bytes: card.bytes, budget: card.budget, stateRevision: card.stateRevision, truncated: card.truncated, stateTruncated: card.stateTruncated, errors: card.errors },
    recoveryBytes: Buffer.byteLength(recovery),
    configErrors: config.errors,
  };
  // 预算告警消费方（2026-08-17）：warn/truncated 落 stderr，跑 inject 的 Agent 必见（此前 warn 字段无人消费，静默降级）
  if (card.truncated || card.stateTruncated) {
    process.stderr.write(`⚠️ 身份卡截断（bytes ${card.bytes}/${card.budget}，truncated=${card.truncated} stateTruncated=${card.stateTruncated}）——profile/recent 被缩放，最近工作可能缺失；考虑精简 reply-policy/状态摘要\n`);
  } else if (card.bytes > card.budget * config.warnAt) {
    process.stderr.write(`⚠️ 身份卡接近预算（${card.bytes}/${card.budget}B，warnAt ${config.warnAt}）——随内容增长将触发截断\n`);
  }
  if (Buffer.byteLength(recovery) > config.recoveryBytes * config.warnAt) {
    process.stderr.write(`⚠️ 恢复胶囊接近预算（${Buffer.byteLength(recovery)}/${config.recoveryBytes}B）\n`);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.ok ? 0 : 1;
}

function reportUsage() {
  const config = loadInjectConfig(ROOT);
  const card = buildIdentityCard(ROOT);
  const recovery = renderRecovery(ROOT, config.recoveryBytes);
  const cardWarn = card.bytes > card.budget * config.warnAt;
  const recWarn = Buffer.byteLength(recovery) > config.recoveryBytes * config.warnAt;
  if (cardWarn || recWarn) {
    process.stderr.write(`⚠️ 注入预算告警：身份卡 ${card.bytes}/${card.budget}B${cardWarn ? " ⚠️接近上限" : ""}；恢复 ${Buffer.byteLength(recovery)}/${config.recoveryBytes}B${recWarn ? " ⚠️接近上限" : ""}\n`);
  }
  process.stdout.write(JSON.stringify({
    identityCard: { bytes: card.bytes, budget: card.budget, warn: card.bytes > card.budget * config.warnAt },
    recovery: { bytes: Buffer.byteLength(recovery), budget: config.recoveryBytes, warn: Buffer.byteLength(recovery) > config.recoveryBytes * config.warnAt },
    memory: { budget: config.memoryBytes, top: config.memoryTop, warnAt: config.warnAt },
    configErrors: config.errors,
  }, null, 2) + "\n");
}

function escapeXmlLens(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function main() {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const hint = get("--hint") || "";
  const lens = get("--lens") || "";
  const config = loadInjectConfig(ROOT);
  const topValue = Number(get("--top"));
  const top = Number.isInteger(topValue) && topValue > 0 ? Math.min(topValue, 50) : config.memoryTop;

  if (args.includes("--verify")) { verify(); return; }
  if (args.includes("--report")) { reportUsage(); return; }

  const query = hint || lens || "当前工作";
  const opts = {
    memoryDir: MEM_DIR,
    top,
    snippetBytes: Math.max(160, Math.floor(config.memoryBytes / Math.max(1, top))),
  };
  // 混合检索（2026-08-13）：向量层就绪自动启用；null/异常回退纯 BM25（top-level await）
  retrieveMemoriesHybrid(query, opts)
    .then(result => renderInject(result || retrieveMemories(query, opts)))
    .catch(() => renderInject(retrieveMemories(query, opts)));

  function renderInject(result) {
    try {
      const card = buildIdentityCard(ROOT);
      const recovery = renderRecovery(ROOT, config.recoveryBytes);
      const items = result.results.map(item => ({ status: item.status, title: item.title, path: item.path, snippet: item.snippet }));
      const memoryBlock = INJECT_BLOCK(items, buildMeta(), config.memoryBytes);
      const lensBlock = lens
        ? `<task-lens task="${escapeXmlLens(lens)}">\n围绕当前任务推进；回复门禁与接力状态必须遵守，不要遗忘近期工作。\n</task-lens>\n`
        : "";
      // 预算告警（2026-08-17）：默认文本模式也落 stderr（Agent 跑 inject 必见，不再静默降级）
      if (card.truncated || card.stateTruncated) {
        process.stderr.write(`⚠️ 身份卡截断（bytes ${card.bytes}/${card.budget}，truncated=${card.truncated} stateTruncated=${card.stateTruncated}）——profile/recent 被缩放；考虑精简 reply-policy/状态摘要\n`);
      } else if (card.bytes > card.budget * config.warnAt) {
        process.stderr.write(`⚠️ 身份卡接近预算（${card.bytes}/${card.budget}B，warnAt ${config.warnAt}）\n`);
      }
      if (Buffer.byteLength(recovery) > config.recoveryBytes * config.warnAt) {
        process.stderr.write(`⚠️ 恢复胶囊接近预算（${Buffer.byteLength(recovery)}/${config.recoveryBytes}B）\n`);
      }
      process.stdout.write(`${card.text}\n${lensBlock}${recovery}\n${memoryBlock}`);
    } catch (error) {
      const card = buildIdentityCard(ROOT);   // 身份卡失败自带 error 标记
      process.stdout.write(`${card.text}\n<!-- inject-error: ${String(error.message || error).replace(/</g, "&lt;")} -->\n`);
    }
  }
}
main();
