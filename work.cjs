#!/usr/bin/env node
/**
 * work.cjs — CP 在制品区（work/<slug>）工具：规格 + 票据 + 前沿 + 结案
 *
 * 设计来源：mattpocock/skills 的 to-spec / to-tickets / implement（2026-10-28 吸收）
 * 与 CP 的差异：不引入 ADR（决策进决策卡）、不接真实 issue tracker、不起后台进程。
 *
 * 命令（零依赖，便携 node）：
 *   node work.cjs new <slug> [--title <标题>] [--source <来源>] [--root <根>]
 *   node work.cjs ticket <slug> "<标题>" [--blocked-by 00,01] [--seams a,b] [--root <根>]
 *   node work.cjs check <slug> | --all [--root <根>]
 *   node work.cjs status [slug] [--root <根>]
 *   node work.cjs frontier <slug> [--root <根>]
 *   node work.cjs todo <slug> [--root <根>]      # 投影前沿第一张票为 Todo 草案（幂等落 .flags/work-todo.json）
 *   node work.cjs close <slug> [--root <根>]
 *   node work.cjs audit [--root <根>]        # 供 verify F28 消费
 *
 * 纪律：
 *   - work/ = 在制；pro/ = 结案；close 生成 pro/work-<slug>-<日期>.md 并把目录移入 work/.closed/
 *   - 票据是 tracer-bullet 垂直切片；blocked_by 构成任务图；frontier = 所有前置已完成的票
 *   - 任何异常只影响本命令退出码，不写 memories/events
 */
const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } = require("node:fs");
const { join, basename } = require("node:path");
const { homedir } = require("node:os");

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (name) => process.argv.includes(name);
const ROOT = arg("--root") || join(homedir(), ".cosmic-phantom");
const WORK_DIR = join(ROOT, "work");
const PRO_DIR = join(ROOT, "pro");
const TPL_DIR = join(ROOT, "templates");
const SPEC_SECTIONS = ["问题", "方案", "用户故事", "实现决策", "测试决策", "范围外", "来源证据"];
const VALID_SPEC_STATUS = ["draft", "approved", "implemented"];
const VALID_TICKET_STATUS = ["ready", "in_progress", "blocked", "done"];
const PLACEHOLDER = /\{\{|待填|作为……/;

function out(value, code = 0) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); process.exit(code); }
function localNow() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}
function today() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function validSlug(slug) { return typeof slug === "string" && /^[a-z0-9][a-z0-9-]{1,60}$/.test(slug); }
function ensureDir(dir) { mkdirSync(dir, { recursive: true }); }
function itemDir(slug) { return join(WORK_DIR, slug); }
function specPath(slug) { return join(itemDir(slug), "spec.md"); }
function ticketsDir(slug) { return join(itemDir(slug), "tickets"); }

function parseFrontmatter(text) {
  const m = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { meta: {}, body: String(text || "") };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(",").map(v => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }
    meta[kv[1]] = value;
  }
  return { meta, body: String(text || "").slice(m[0].length) };
}

function parseSections(body) {
  const sections = {};
  let current = null;
  for (const line of String(body || "").split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { current = h[1]; sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join("\n").trim()]));
}

function normalizeId(value) { return String(value || "").replace(/[^0-9]/g, "").padStart(2, "0"); }

function readTickets(slug) {
  const dir = ticketsDir(slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".md") && !f.startsWith("."))
    .sort()
    .map(file => {
      const full = join(dir, file);
      const raw = readFileSync(full, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      return {
        file, path: full, meta,
        id: normalizeId(meta.id || basename(file).slice(0, 2)),
        title: meta.title || basename(file, ".md"),
        status: meta.status || "ready",
        blockedBy: (Array.isArray(meta.blocked_by) ? meta.blocked_by : String(meta.blocked_by || "").split(",")).map(v => String(v).trim()).filter(Boolean).map(normalizeId),
        seams: Array.isArray(meta.seams) ? meta.seams : [],
        sections: parseSections(body),
        mtimeMs: statSync(full).mtimeMs,
      };
    });
}

function detectCycles(tickets) {
  const byId = new Map(tickets.map(t => [t.id, t]));
  const state = new Map(); // 0=未访问 1=栈中 2=完成
  const cycles = [];
  const visit = (id, stack) => {
    if (state.get(id) === 1) { cycles.push([...stack.slice(stack.indexOf(id)), id].join(" -> ")); return; }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    for (const dep of (byId.get(id)?.blockedBy || [])) if (byId.has(dep)) visit(dep, [...stack, id]);
    state.set(id, 2);
  };
  for (const t of tickets) if (!state.has(t.id)) visit(t.id, []);
  return cycles;
}

function checkItem(slug) {
  const problems = [];
  const warnings = [];
  if (!validSlug(slug)) return { ok: false, problems: ["slug 非法（小写字母/数字/连字符，2-61 位）"], warnings };
  if (!existsSync(specPath(slug))) return { ok: false, problems: [`spec 不存在：${specPath(slug)}`], warnings };

  const specRaw = readFileSync(specPath(slug), "utf8");
  const { meta, body } = parseFrontmatter(specRaw);
  const sections = parseSections(body);
  if (!VALID_SPEC_STATUS.includes(meta.status)) problems.push(`spec status 非法：${meta.status || "(空)"}（合法：${VALID_SPEC_STATUS.join("/")}）`);
  if (meta.slug && meta.slug !== slug) problems.push(`spec.slug(${meta.slug}) ≠ 目录名(${slug})`);
  if (!meta.title) problems.push("spec 缺 title");
  if (!meta.created) problems.push("spec 缺 created");
  for (const name of SPEC_SECTIONS) {
    const value = sections[name];
    if (value === undefined) { problems.push(`spec 缺段：## ${name}`); continue; }
    if (!value) { problems.push(`spec 段为空：## ${name}`); continue; }
    if (PLACEHOLDER.test(value)) problems.push(`spec 段仍是模板占位：## ${name}`);
  }

  const tickets = readTickets(slug);
  if (!tickets.length) warnings.push("还没有票据：用 `work ticket <slug> \"<标题>\"` 建第一张");
  const ids = new Set();
  for (const t of tickets) {
    if (ids.has(t.id)) problems.push(`票据 id 重复：${t.id}`);
    ids.add(t.id);
    if (!/^\d{2}-.+\.md$/.test(t.file)) problems.push(`票据文件名应为 NN-slug.md：${t.file}`);
    if (basename(t.file).slice(0, 2) !== t.id) problems.push(`票据 id(${t.id}) 与文件名(${t.file}) 不一致`);
    if (!VALID_TICKET_STATUS.includes(t.status)) problems.push(`票据 ${t.id} status 非法：${t.status}`);
    if (!t.sections["要交付什么"]) problems.push(`票据 ${t.id} 缺"要交付什么"`);
    else if (PLACEHOLDER.test(t.sections["要交付什么"])) problems.push(`票据 ${t.id} 的"要交付什么"仍是模板占位`);
    const ac = t.sections["验收标准"] || "";
    if (!/- \[[ xX]\]/.test(ac)) problems.push(`票据 ${t.id} 缺验收标准复选框`);
    if (t.status === "done") {
      const ev = (t.sections["证据"] || "").trim();
      if (!ev || PLACEHOLDER.test(ev)) problems.push(`票据 ${t.id} 已完成但证据为空（§4.15 要求红绿灯证据）`);
    }
  }
  for (const t of tickets) {
    for (const dep of t.blockedBy) if (!ids.has(dep)) problems.push(`票据 ${t.id} 的 blocked_by 指向不存在的票：${dep}`);
  }
  for (const cycle of detectCycles(tickets)) problems.push(`票据图有环：${cycle}`);

  // 前沿：未完成且所有前置已完成
  const done = new Set(tickets.filter(t => t.status === "done").map(t => t.id));
  const frontier = tickets.filter(t => t.status !== "done" && t.blockedBy.every(d => done.has(d))).map(t => t.id);
  return { ok: problems.length === 0, problems, warnings, spec: { meta, sections }, tickets, frontier };
}

function cmdNew() {
  const slug = process.argv[3];
  if (!validSlug(slug)) out({ ok: false, error: "用法：work new <slug>（小写字母/数字/连字符）" }, 1);
  if (existsSync(specPath(slug))) out({ ok: false, error: `已存在：${specPath(slug)}` }, 1);
  const title = arg("--title") || slug;
  const source = arg("--source") || "用户需求（待补会话/事件指针）";
  ensureDir(ticketsDir(slug));
  const tpl = readFileSync(join(TPL_DIR, "spec.md"), "utf8")
    .replace(/\{\{SLUG\}\}/g, slug)
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{DATE\}\}/g, localNow())
    .replace(/\{\{SOURCE\}\}/g, source);
  writeFileSync(specPath(slug), tpl, "utf8");
  out({ ok: true, slug, spec: specPath(slug), tickets: ticketsDir(slug), next: `填 spec.md，然后 work ticket ${slug} "<标题>"` });
}

function cmdTicket() {
  const slug = process.argv[3];
  const title = process.argv[4] || arg("--title");
  if (!validSlug(slug) || !title) out({ ok: false, error: "用法：work ticket <slug> \"<标题>\" [--blocked-by 00,01]" }, 1);
  if (!existsSync(specPath(slug))) out({ ok: false, error: `spec 不存在：${specPath(slug)}` }, 1);
  ensureDir(ticketsDir(slug));
  const existing = readTickets(slug);
  const max = existing.reduce((n, t) => Math.max(n, Number(t.id) || 0), -1);
  const id = String(max + 1).padStart(2, "0");
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ticket";
  const file = `${id}-${ascii}.md`;
  const blockedBy = (arg("--blocked-by") || "").split(",").map(v => v.trim()).filter(Boolean).map(normalizeId);
  const seams = (arg("--seams") || "").split(",").map(v => v.trim()).filter(Boolean);
  const tpl = readFileSync(join(TPL_DIR, "ticket.md"), "utf8")
    .replace(/\{\{ID\}\}/g, id)
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{DATE\}\}/g, localNow())
    .replace(/^blocked_by: \[\]$/m, `blocked_by: [${blockedBy.join(", ")}]`)
    .replace(/^seams: \[\]$/m, `seams: [${seams.join(", ")}]`);
  writeFileSync(join(ticketsDir(slug), file), tpl, "utf8");
  out({ ok: true, slug, id, file: join(ticketsDir(slug), file), blocked_by: blockedBy, seams });
}

function cmdCheck() {
  if (has("--all")) {
    const items = listItems().map(slug => { const r = checkItem(slug); return { slug, ok: r.ok, problems: r.problems, warnings: r.warnings }; });
    return out({ ok: items.every(i => i.ok), items });
  }
  const slug = process.argv[3];
  if (!validSlug(slug)) out({ ok: false, error: "用法：work check <slug> | --all" }, 1);
  const r = checkItem(slug);
  out({ ok: r.ok, slug, problems: r.problems, warnings: r.warnings, tickets: r.tickets.length, frontier: r.frontier }, r.ok ? 0 : 1);
}

function listItems() {
  if (!existsSync(WORK_DIR)) return [];
  return readdirSync(WORK_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith("."))
    .map(d => d.name)
    .filter(validSlug)
    .sort();
}

function itemStatus(slug) {
  const r = checkItem(slug);
  const tickets = r.tickets.map(t => ({ id: t.id, title: t.title, status: t.status, blocked_by: t.blockedBy, mtime: new Date(t.mtimeMs).toISOString() }));
  return {
    slug, ok: r.ok, title: r.spec?.meta?.title || slug, specStatus: r.spec?.meta?.status || "?",
    total: tickets.length, done: tickets.filter(t => t.status === "done").length,
    frontier: r.frontier, problems: r.problems, warnings: r.warnings, tickets,
  };
}

function cmdStatus() {
  const slug = process.argv[3];
  if (slug && validSlug(slug)) return out({ ok: true, items: [itemStatus(slug)] });
  const items = listItems().map(itemStatus);
  out({ ok: true, items, open: items.filter(i => i.specStatus !== "implemented").length });
}

function cmdFrontier() {
  const slug = process.argv[3];
  if (!validSlug(slug)) out({ ok: false, error: "用法：work frontier <slug>" }, 1);
  const r = checkItem(slug);
  const pick = r.tickets.filter(t => t.status !== "done" && r.frontier.includes(t.id));
  out({ ok: r.ok, slug, frontier: pick.map(t => ({ id: t.id, title: t.title, status: t.status, blocked_by: t.blockedBy })) }, r.ok ? 0 : 1);
}

// D-03（2026-10-28）：work 是票据真源，Todo 只投影「今天要做的票」——一次一张，不复制全图。
function cmdTodo() {
  const slug = process.argv[3];
  if (!validSlug(slug)) out({ ok: false, error: "用法：work todo <slug>" }, 1);
  const r = checkItem(slug);
  if (!r.ok) return out({ ok: false, error: "校验未过，不能投影", problems: r.problems }, 1);
  if (!r.frontier.length) return out({ ok: false, error: "前沿为空（没有可开工的票）" }, 1);
  const id = r.frontier[0];
  const t = r.tickets.find(x => x.id === id);
  const file = join(ROOT, ".flags", `work-todo-${slug}.json`);
  let prev = null;
  try { prev = JSON.parse(readFileSync(file, "utf8")); } catch {}
  const already = !!(prev && prev.slug === slug && prev.ticketId === id);
  const todo = {
    title: `[${slug}] ${id}: ${t.title}`,
    notes: `工作项：work/${slug}/\n票据：tickets/${t.file}\n前沿：${r.frontier.join(", ")}\n完成后：把票 status 改 done 并填证据（命令+输出）`,
    dueAt: null,
  };
  if (!already) {
    ensureDir(join(ROOT, ".flags"));
    writeFileSync(file, JSON.stringify({ slug, ticketId: id, projectedAt: new Date().toISOString(), todo }, null, 2) + "\n", "utf8");
  }
  out({ ok: true, slug, ticket: { id, title: t.title, blocked_by: t.blockedBy }, todo, alreadyProjected: already, file }, 0);
}

function slugifyTitle(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "work"; }

function buildArchive(slug, r) {
  const meta = r.spec.meta;
  const lines = [
    `# 工作项结案：${meta.title || slug}`,
    "",
    `> slug：${slug} ｜ 状态：${meta.status} ｜ 创建：${meta.created} ｜ 结案：${today()}`,
    `> 来源：${meta.source || "(未填)"}`,
    "",
    "## 规格",
    "",
    ...SPEC_SECTIONS.filter(name => r.spec.sections[name]).flatMap(name => [`### ${name}`, "", r.spec.sections[name], ""]),
  ];
  if (r.spec.sections["备注"]) lines.push("### 备注", "", r.spec.sections["备注"], "");
  lines.push("## 票据", "");
  for (const t of r.tickets) {
    lines.push(`### ${t.id}: ${t.title}`, "", `- 状态：${t.status}`, `- 被阻塞：${t.blockedBy.length ? t.blockedBy.join(", ") : "无"}`, `- 测试缝：${t.seams.length ? t.seams.join(", ") : "未声明"}`, "");
    if (t.sections["要交付什么"]) lines.push(`**要交付什么**：${t.sections["要交付什么"]}`, "");
    if (t.sections["验收标准"]) lines.push("**验收标准**：", "", t.sections["验收标准"], "");
    if (t.sections["证据"]) lines.push("**证据**：", "", t.sections["证据"], "");
  }
  return lines.join("\n") + "\n";
}

function cmdClose() {
  const slug = process.argv[3];
  if (!validSlug(slug)) out({ ok: false, error: "用法：work close <slug>" }, 1);
  const r = checkItem(slug);
  if (!r.ok) return out({ ok: false, error: "校验未过，不能结案", problems: r.problems }, 1);
  if (!r.tickets.length) return out({ ok: false, error: "没有票据，不能结案" }, 1);
  const undone = r.tickets.filter(t => t.status !== "done");
  if (undone.length) return out({ ok: false, error: "还有未完成票据", undone: undone.map(t => t.id) }, 1);
  // D-04（2026-10-28）：done 票的证据必须有命令/红绿灯标记，否则“已实现/测试通过”这类自述不算证据（§4.15）。
  const weak = r.tickets.filter(t => t.status === "done" && !/(命令|红灯|绿灯|\$ |node |npm |git |pwsh |cmd )/i.test(t.sections["证据"] || ""));
  if (weak.length) return out({ ok: false, error: "票据证据缺少命令/红绿灯标记（§4.15）", weak: weak.map(t => t.id) }, 1);

  const meta = r.spec.meta;
  if (meta.status !== "implemented") {
    const next = readFileSync(specPath(slug), "utf8").replace(/^status:\s*.+$/m, "status: implemented");
    writeFileSync(specPath(slug), next, "utf8");
  }
  ensureDir(PRO_DIR);
  const base = `work-${slug}-${today().replace(/-/g, "")}`;
  let archive = join(PRO_DIR, `${base}.md`);
  for (let i = 2; existsSync(archive); i += 1) archive = join(PRO_DIR, `${base}-${i}.md`);
  writeFileSync(archive, buildArchive(slug, { ...r, spec: { meta: { ...meta, status: "implemented" }, sections: r.spec.sections } }), "utf8");

  const closedDir = join(WORK_DIR, ".closed");
  ensureDir(closedDir);
  let dest = join(closedDir, `${slug}-${today().replace(/-/g, "")}`);
  for (let i = 2; existsSync(dest); i += 1) dest = join(closedDir, `${slug}-${today().replace(/-/g, "")}-${i}`);
  renameSync(itemDir(slug), dest);
  out({ ok: true, slug, archive, movedTo: dest });
}

function cmdAudit() {
  const items = [];
  for (const slug of listItems()) {
    const r = checkItem(slug);
    const problems = [...r.problems];
    const created = Date.parse(r.spec?.meta?.created || "");
    const ageDays = Number.isFinite(created) ? (Date.now() - created) / 86400000 : 0;
    if (["draft", "approved"].includes(r.spec?.meta?.status) && ageDays > 14) {
      problems.push(`spec ${r.spec.meta.status} 已 ${ageDays.toFixed(1)} 天（>14 天）——推进或关闭`);
    }
    for (const t of r.tickets) {
      const idle = (Date.now() - t.mtimeMs) / 86400000;
      if (t.status === "in_progress" && idle > 7) problems.push(`票据 ${t.id} in_progress 已 ${idle.toFixed(1)} 天未动（>7 天）`);
    }
    const allDone = r.tickets.length > 0 && r.tickets.every(t => t.status === "done");
    if (allDone && r.spec?.meta?.status !== "implemented") {
      const last = Math.max(...r.tickets.map(t => t.mtimeMs));
      const idle = (Date.now() - last) / 86400000;
      if (idle > 7) problems.push(`全部票据已完成但 spec 未结案 ${idle.toFixed(1)} 天（>7 天）——跑 work close ${slug}`);
    }
    items.push({ slug, ok: problems.length === 0, problems, warnings: r.warnings });
  }
  out({ ok: items.every(i => i.ok), items, checked: items.length });
}

const cmd = process.argv[2];
if (cmd === "new") cmdNew();
else if (cmd === "ticket") cmdTicket();
else if (cmd === "check") cmdCheck();
else if (cmd === "status") cmdStatus();
else if (cmd === "frontier") cmdFrontier();
else if (cmd === "todo") cmdTodo();
else if (cmd === "close") cmdClose();
else if (cmd === "audit") cmdAudit();
else out({ usage: "new|ticket|check|status|frontier|todo|close|audit（见文件头注释）" });
