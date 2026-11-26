import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadCurrentState } from "./current-state.js";
import { loadInjectConfig } from "./inject-config.js";

function escapeXml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function compactLines(value, maxBytes) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const lines = text.split("\n").filter(line => line.trim() && !line.startsWith("#") && !line.startsWith(">"));
  return truncateUtf8(lines.join("\n"), maxBytes);
}

function renderList(label, values, maxItems) {
  const selected = Array.isArray(values) ? values.slice(0, maxItems) : [];
  if (!selected.length) return "";
  return `${label}:\n${selected.map(value => `- ${escapeXml(value)}`).join("\n")}`;
}

// 状态段按优先级截断：下一步 > 阻塞 > 决定；summary 最后裁。
// 字段内按条保留：nextActions 第一条永远优先装入（F3 截断语义）。
function buildStateText(state, quota = 660) {
  // 2026-08-12：预算 3000 后 objective 截断上限放宽 70→300B（600B 配额下全量装入；nextActions 第一条仍优先）
  // 2026-08-17：提预算后字段上限同步放宽（消除 stateTruncated）
  // 2026-09-01 澄清：预算唯一真源 = inject.config.json identityCardBytes（当前 6000，历史注释里的 3000/4500 已过时）；字段上限随预算动态缩放（下方 flexible 配额）
  const head = [
    state.objective ? `目标: ${truncateUtf8(escapeXml(state.objective), 400)}` : "",
  ].join("\n");
  const groups = [
    { key: "nextActions", label: "下一步", values: Array.isArray(state.nextActions) ? state.nextActions.slice(0, 4) : [] },
    { key: "blockers", label: "阻塞", values: Array.isArray(state.blockers) ? state.blockers.slice(0, 3) : [] },
    { key: "decisions", label: "决定", values: Array.isArray(state.decisions) ? state.decisions.slice(0, 2) : [] },
  ];
  const summary = state.summary ? `当前状态: ${truncateUtf8(escapeXml(state.summary), 260)}` : "";
  let text = head;
  const dropped = [];
  const keptKeys = [];
  for (const group of groups) {
    if (!group.values.length) continue;
    const keptValues = [];
    for (const value of group.values) {
      const candidate = `${group.label}:\n${[...keptValues, value].map(item => `- ${escapeXml(item)}`).join("\n")}`;
      if (Buffer.byteLength(`${text}\n${candidate}`) <= quota) keptValues.push(value);
      else break;
    }
    if (keptValues.length) {
      text += `\n${group.label}:\n${keptValues.map(item => `- ${escapeXml(item)}`).join("\n")}`;
      keptKeys.push(group.key);
      if (keptValues.length < group.values.length) dropped.push(group.key);
    } else {
      dropped.push(group.key);
    }
  }
  if (summary && Buffer.byteLength(`${text}\n${summary}`) <= quota) text += `\n${summary}`;
  if (Buffer.byteLength(text) > quota) text = truncateUtf8(text, quota);
  return {
    text,
    keptKeys,
    dropped,
  };
}

// 默认身份卡只读取人工维护的画像、结构化接力状态和已确认活跃卡。
// daily 是原始/派生证据层，不能因为“最近”就绕过候选确认门进入默认上下文。
function activeMemoryBlock(root, quota = 420) {
  const memoryDir = join(root, "memories");
  if (!existsSync(memoryDir)) return "";
  try {
    const files = readdirSync(memoryDir, { recursive: true })
      .filter(file => String(file).endsWith(".md") && !String(file).split(/[\\/]/).at(-1).startsWith(".tmp-"));
    const lines = [];
    for (const relative of files) {
      const raw = readFileSync(join(memoryDir, relative), "utf8").replace(/^\uFEFF/, "");
      for (const block of raw.split(/^\s*§{3,}\s*$/m)) {
        if (!/^---\n/.test(block) || !/^status:\s*🟢当前\s*$/m.test(block)) continue;
        const body = block.replace(/^---[\s\S]*?---\s*/, "");
        const first = body.split("\n").map(line => line.trim()).find(Boolean);
        if (!first) continue;
        lines.push(`- ${escapeXml(truncateUtf8(first, 140))}`);
      }
    }
    return truncateUtf8(lines.slice(-6).join("\n"), quota);
  } catch (error) {
    return `<!-- identity-card-error: active memories unavailable: ${escapeXml(error.message || error)} -->`;
  }
}

function policyBlock(root, quota = 520) {
  try {
    const policy = JSON.parse(readFileSync(join(root, "reply-policy.json"), "utf8").replace(/^\uFEFF/, ""));
    // 全量门禁（10 条规则 + 禁用词）逐条编号，杜绝“新会话忘回复偏好”
    const rules = Array.isArray(policy.rules) ? policy.rules.map((rule, index) => `${index + 1}.${escapeXml(rule)}`).join("\n") : "";
    const forbidden = Array.isArray(policy.forbidden) ? policy.forbidden.join(" / ") : "";
    return truncateUtf8(`回复门禁:\n${escapeXml(policy.opening || "先给结论，再给理由。")}\n${rules}${forbidden ? `\n禁用词: ${escapeXml(forbidden)}` : ""}`, quota);
  } catch (error) {
    return `<!-- identity-card-error: reply-policy unavailable: ${escapeXml(error.message || error)} -->`;
  }
}

// 不再从 daily 提取“最近工作”。当前工作只能经 current-state 显式接力，
// 长期信息只能经用户确认后的 activeMemoryBlock 进入身份卡。

function profileBlock(root, quota = 400) {
  const file = join(root, "MEMORY.md");
  if (!existsSync(file)) return "";
  try { return compactLines(readFileSync(file, "utf8"), quota); }
  catch (error) { return `<!-- identity-card-error: MEMORY.md unavailable: ${escapeXml(error.message || error)} -->`; }
}

export function buildIdentityCard(root, options = {}) {
  const config = loadInjectConfig(root);
  const budget = Number(options.maxBytes || config.identityCardBytes);
  const state = loadCurrentState(root);
  const errors = [];
  const head = `<identity-card source="cosmic-phantom" state-revision="${state.revision}">\n`;
  const tail = "\n</identity-card>\n";
  const available = Math.max(200, budget - Buffer.byteLength(head + tail));

  // 门禁全文和状态更新义务是刚性块；画像、状态、最近工作、今日索引按剩余预算等比缩放。
  // 这样规则增加时不会被固定 policy 配额静默截断。
  const policy = policyBlock(root, Number.MAX_SAFE_INTEGER);
  if (policy.includes("identity-card-error")) errors.push(policy);
  const obligation = `会话收尾: 如工作状态变化，必须调用 update_current_state，expectedRevision=${state.revision}。`;
  const flexible = { profile: 350, state: 600, active: 520 };

  const buildBody = (scale) => {
    const quotas = {};
    for (const [key, value] of Object.entries(flexible)) quotas[key] = Math.floor(value * scale);
    const profile = profileBlock(root, quotas.profile);
    const stateBuild = buildStateText(state, quotas.state);
    const active = activeMemoryBlock(root, quotas.active);
    const body = [
      profile ? `用户画像:\n${profile}` : "",
      policy,
      stateBuild.text,
      obligation,
      active ? `已确认活跃记忆:\n${active}` : "",
    ].filter(Boolean).join("\n\n");
    return { body, stateBuild };
  };

  let low = 0, high = 1, selected = buildBody(0);
  // 2026-08-17 修复：high 硬编码 1 导致预算提升时 flexible 配额永不增长（state 永远只分 600B，
  //   状态装不下 → stateTruncated 顽固；3000→6000 预算实际无效）。改为随预算动态：
  //   scale 上限 = 可用空间 / flexible 满额（预算越大，flexible 越能放大）
  const flexibleTotal = Object.values(flexible).reduce((a, b) => a + b, 0);
  high = Math.max(1, available / Math.max(1, flexibleTotal));
  for (let i = 0; i < 20; i += 1) {
    const middle = (low + high) / 2;
    const candidate = buildBody(middle);
    if (Buffer.byteLength(candidate.body) <= available) { low = middle; selected = candidate; }
    else high = middle;
  }
  let { body, stateBuild } = selected;
  if (Buffer.byteLength(policy) > available) {
    errors.push("<!-- identity-card-error: reply policy exceeds identity card budget -->");
    body = truncateUtf8(policy, available);
  }

  return {
    text: head + body + tail,
    stateRevision: state.revision,
    budget,
    bytes: Buffer.byteLength(head + body + tail),
    truncated: Buffer.byteLength(body) > available,
    stateTruncated: stateBuild.dropped.length > 0,
    errors,
  };
}
