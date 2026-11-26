#!/usr/bin/env node
/**
 * validate.js — 反作弊三层校验（校验内容有效性，而非存在性）
 *
 * 用法:
 *   node validate.js check <md文件>     # 单条校验（add/log 前置）
 *   node validate.js check-all          # 全库逐条校验（verify 批量用，一次进程替代逐文件 spawn）
 *   node validate.js audit --all        # 全库审计（每周调度）
 * 输出: JSON {ok, reasons[], suggestion?}
 *
 * 吸收点 B（记忆分三类）：type 字段可选，合法值 偏好/事件/规则，非法拒写
 * 吸收点 F（超限显式报错，Claude Auto Memory 同款精神）：文件 >25KB 拒写并报原因，不静默截断
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { listMemoryEntries } from "./memory-retrieval.js";

// K17/K18 同族补丁：支持 --root（INSTALL §4.1"所有脚本支持 --root"契约一致化）
const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const VALID_STATUS = ["🟢当前", "⏳待验证", "🔜计划", "🕰️过去", "⚠️冲突"];   // ⚠️冲突=争议态待裁决（S2-3 2026-11-18）   // ⏳待验证=自动管道产卡（2026-08-28 拍板：自动提取+待验证池），确认后转 🟢
const VALID_TYPES = ["偏好", "事件", "规则"];          // 吸收点 B：三分类
const MAX_FILE_BYTES = 25 * 1024;                      // 吸收点 F：25KB 上限
// 吸收点 H 豁免（2026-08-17）：决策卡同步器走 --skip-ephemeral——决策原文保真优先，
// 不受临时性门拦截；手动 add/store_memory 默认生效（临时性内容指引落 daily）。
const SKIP_EPHEMERAL = process.argv.includes("--skip-ephemeral");

function tokenize(text) {
  const latin = (text.toLowerCase().match(/[a-z0-9_]+/g) || []);
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []);
  return [...latin, ...cjk];
}

function diceOverlap(a, b) {                       // V2: 字符级 Dice 系数
  const sa = new Set(tokenize(a)), sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let hit = 0; for (const t of sa) if (sb.has(t)) hit++;
  return (2 * hit) / (sa.size + sb.size);
}

function check(file) {
  const reasons = [];
  // 吸收点 F：超限显式报错，不静默截断
  let size;
  try {
    size = statSync(file).size;
    if (size > MAX_FILE_BYTES) reasons.push(`文件超上限（${size} 字节 > 25KB），须蒸馏拆分后再写`);
  } catch { reasons.push("文件不可读"); return { ok: false, reasons, suggestion: "检查文件存在与权限" }; }
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  return checkText(raw, size);
}

// 条目文本校验（月度分桶 2026-09-01：check 主体从文件解耦，桶条目/单卡文件共用同一套规则）
function checkText(raw, sizeBytes) {
  const reasons = [];
  if (sizeBytes > MAX_FILE_BYTES) reasons.push(`文件超上限（${sizeBytes} 字节 > 25KB），须蒸馏拆分后再写`);
  // V1 schema
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { ok: false, reasons: ["缺 frontmatter"] };
  const meta = fm[1];
  for (const k of ["id", "created", "status", "tags"]) {
    if (!new RegExp(`^${k}:`, "m").test(meta)) reasons.push(`缺字段 ${k}`);
  }
  const status = (meta.match(/^status:\s*(.+)$/m) || [])[1];
  if (status && !VALID_STATUS.includes(status)) reasons.push(`非法状态 ${status}`);
  // 冲突态校验（S2-3）：⚠️冲突 必须写明与谁冲突，否则无法裁决
  if (status && status.includes("冲突")) {
    const cw = (meta.match(/^conflict_with:\s*(.+)$/m) || [])[1];
    if (!cw) reasons.push("status ⚠️冲突 时必须写 conflict_with: <对方id>（否则无法定位争议对象）");
  }
  const type = (meta.match(/^type:\s*(.+)$/m) || [])[1];   // 吸收点 B
  if (type && !VALID_TYPES.includes(type)) reasons.push(`非法类型 ${type}（合法值：偏好/事件/规则）`);
  // epistemic 分级（S1-3，2026-11-18，Mnemosyne 借鉴）：事实/推断/摘要/自评必须分开
  const EPISTEMIC = ["fact", "inference", "summary", "self_eval", "unknown"];
  const epi = (meta.match(/^epistemic:\s*(.+)$/m) || [])[1];
  if (epi && !EPISTEMIC.includes(epi)) reasons.push(`非法 epistemic ${epi}（合法值：${EPISTEMIC.join("/")}）`);
  // 铁律：推断/自评/摘要不得直接作为「当前有效的用户偏好」
  if (epi && ["inference", "self_eval", "summary"].includes(epi) && status && status.includes("当前") && type === "偏好") {
    reasons.push(`epistemic=${epi} 的条目不得直接标为「🟢当前 偏好」——要么降为 ⏳待验证，要么补用户原话证据后改 fact`);
  }
  const scope = (meta.match(/^scope:\s*(.+)$/m) || [])[1];
  if (scope && !["global", "workspace", "agent"].includes(scope)) reasons.push(`非法 scope ${scope}`);
  // T05（2026-11-19）：来源轴与确定性分开——推断不得冒充原话
  const srcKind = (meta.match(/^source_kind:\s*(.+)$/m) || [])[1];
  const KINDS = ["user_said", "assistant_said", "told", "imagined", "inferred", "tool"];
  if (srcKind && !KINDS.includes(srcKind.trim())) reasons.push(`非法 source_kind ${srcKind}（可选 ${KINDS.join("/")}）`);
  const conf = (meta.match(/^confidence:\s*(.+)$/m) || [])[1];
  if (conf !== undefined) {
    const n = Number(conf);
    if (!Number.isFinite(n) || n < 0 || n > 1) reasons.push(`confidence 必须是 0~1 的数字（收到 ${conf}）`);
  }
  const id = (meta.match(/^id:\s*(.+)$/m) || [])[1];
  if (id && !/^\d{8}-\d{4}$/.test(id.trim())) reasons.push(`id 格式非法（应为 YYYYMMDD-NNNN）`);
  // source 格式（graphiti provenance 轻量版）：events.db: 前缀必须带 instance 与数字 mid
  const source = (meta.match(/^source:\s*(.+)$/m) || [])[1];
  if (source && source.trim().startsWith("events.db:")) {
    const sp = source.trim().slice("events.db:".length).split(":");
    if (sp.length < 2 || !sp[0].trim() || !/^\d+$/.test(sp[sp.length - 1].trim())) reasons.push(`source 格式非法（应为 events.db:<instance>:<mid>，mid 必须为数字）`);
  }
  // V2 信息量（v3.0 §4.4 逆向反思 1：过短但带 tags/source 即有字段价值，不误杀短偏好）
  const body = raw.replace(/^---[\s\S]*?---/, "").replace(/\s+/g, "");
  if (body.length < 20) {
    const hasTags = /^tags:/m.test(meta), hasSource = /^source:/m.test(meta);
    if (!hasTags && !hasSource) reasons.push("正文过短（<20 字）且无 tags/source，疑似无价值条目");
  }
  const title = (meta.match(/^title:\s*(.+)$/m) || [])[1] || "";
  if (title && diceOverlap(title, raw) > 0.85) reasons.push("疑似标题复制");
  // 吸收点 G（密钥零容忍→代码事实，2026-08-17）：记忆条目层硬拦截"密钥形态"字面值。
  //   只拦高确定性密钥形态（sk- 前缀 / ghp_ / AKIA / PEM / JWT / Bearer 长串），
  //   不拦论述性词语（"token"、"password"这类讨论词）；events 逐字层不受影响（原话保真红线）。
  const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{16,}/,                    // OpenAI/Anthropic 等 sk- 前缀密钥
    /\bghp_[A-Za-z0-9]{30,}/,                     // GitHub Personal Access Token
    /\bAKIA[0-9A-Z]{14,}/,                        // AWS access key
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,         // PEM 私钥
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,  // JWT
    /\bBearer [A-Za-z0-9._-]{20,}/,               // Bearer token
  ];
  const secretHit = SECRET_PATTERNS.find((p) => p.test(raw));
  if (secretHit) reasons.push(`命中疑似密钥形态（${secretHit}）——密钥/令牌不入记忆条目；原话可在 events 层保留`);
  // 吸收点 H（写入门·临时性门，2026-08-17，DeerMem 写入门启发）：
  //   手动提炼卡只收"稳定、可长期"内容——临时语境开头且无持久语境词的 → 拒写并指引落 daily。
  //   豁免：--skip-ephemeral flag（决策卡同步器）或 tags 含"决策"（决策卡属性，与 verify 批量校验对称）
  if (!SKIP_EPHEMERAL) {
    const tagsLine = (meta.match(/^tags:\s*(.+)$/m) || [])[1] || "";
    const isDecisionCard = /决策/.test(tagsLine);
    if (!isDecisionCard) {
      const bodyText = raw.replace(/^---[\s\S]*?---/, "").trim();
      const eph = (bodyText.match(/^(这次|本次|暂时|临时|先这样|先不|先别|一次性|仅限(?:这|本)次|今天先)/) || [])[1];
      const durable = /(长期|以后|未来|规则|决定|永远|始终|每次|一律|禁止|必须)/.test(bodyText);
      if (eph && !durable) reasons.push(`疑似临时性内容（以"${eph}"开头且无持久语境）——作用域=当前对话，应落 daily 不写记忆卡；若为长期决策请补充长期表述`);
    }
  }
  return { ok: reasons.length === 0, reasons, suggestion: reasons.length ? "重写或合并" : undefined };
}

function audit() {
  const entries = listMemoryEntries(join(ROOT, "memories"));
  let noise = 0, empty = 0;
  const bad = [];
  for (const e of entries) {
    const r = checkText(e.raw, Buffer.byteLength(e.raw));
    if (!r.ok) { noise++; if (r.reasons.includes("正文过短")) empty++; bad.push({ file: e.id, reasons: r.reasons }); }
  }
  const total = entries.length;
  process.stdout.write(JSON.stringify({
    auditedAt: new Date().toISOString(),
    total, noise, empty,
    noiseRate: total ? +(noise / total).toFixed(3) : 0,
    bad: bad.slice(0, 20),
  }, null, 2));
}
// check-all：一次进程批量校验全部 memories（verify 效率优化，2026-08-16）
// 月度分桶（2026-09-01）：枚举改走 listMemoryEntries（桶条目+遗留单卡通吃），结果键 = 条目 id。
function checkAll() {
  const memDir = join(ROOT, "memories");
  const results = listMemoryEntries(memDir).map(e => {
    const r = checkText(e.raw, Buffer.byteLength(e.raw));
    return { file: e.id, ok: r.ok, reasons: r.reasons, suggestion: r.suggestion };
  });
  process.stdout.write(JSON.stringify({ checked: results.length, results }, null, 2));
}
const cmd = process.argv[2];
if (cmd === "check") process.stdout.write(JSON.stringify(check(process.argv[3]), null, 2));
else if (cmd === "check-all") checkAll();
else if (cmd === "audit") audit();
