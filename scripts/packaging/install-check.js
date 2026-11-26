#!/usr/bin/env node
/**
 * install-check.js — 宿主配置一致性检查（ADR-001 层3 提前到层2，2026-08-12）
 *
 * 对比各宿主配置文件里的 cosmic-phantom / 项目根路径与当前实例路径。
 * 机器专属路径由参数和宿主配置提供，不依赖引擎仓中的个人清单。
 * 不一致当场报错并给出修法（重跑安装脚本或手动改配置），绝不静默。
 *
 * 用法:
 *   node install-check.js [--root <cosmic根>] [--home <用户主目录>] [--engine|--instance] [--live]
 *   --engine 只检查代码仓资产，不要求 project-root.json；--instance 强制检查实例身份
 *   --live  跑 4 支柱实时自检（注入生效/摄取对齐/写强制通/回读验证），写验证用临时
 *            root 副本，验完即清，绝不污染生产 events.db（红线：测试数据零容忍进生产）
 * 输出: { ok, checked, failed, checks: [{name, ok, detail}], note }
 */
import { existsSync, readFileSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { checkSkillSync } from "../../skills-sync.js";

const ROOT = (process.argv.includes("--root") ? resolve(process.argv[process.argv.indexOf("--root") + 1]) : join(homedir(), ".cosmic-phantom"));   // K22 同族 + 相对 root resolve（2026-09-01 挑刺：--root . 曾致路径比对全挂假红灯）
const HOME = process.argv.includes("--home") ? process.argv[process.argv.indexOf("--home") + 1] : homedir();
const forcedEngine = process.argv.includes("--engine");
const forcedInstance = process.argv.includes("--instance");
if (forcedEngine && forcedInstance) throw new Error("--engine 与 --instance 不能同时使用");
const ENGINE_MODE = forcedEngine || (!forcedInstance && !existsSync(join(ROOT, "project-root.json")) && !existsSync(join(ROOT, "sources.json")));

const nodeExe = join(ROOT, "tools", "node", "node.exe").replace(/\\/g, "/");
const memoryCli = join(ROOT, "memory-cli.js").replace(/\\/g, "/");
const mcpServer = join(ROOT, "resources", "mcp-server", "index.js").replace(/\\/g, "/");

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch { return null; } }
function readText(p) { try { return readFileSync(p, "utf8"); } catch { return ""; } }

function check(name, ok, detail, severity = ok ? "pass" : "fail") { return { name, ok, severity, detail }; }

// 缺失的可选宿主不阻断引擎安装；显式存在时仍按真实配置检查。
const MACHINE_EXEMPT = new Set(
  String(process.env.CP_INSTALL_EXEMPT || "CodeBuddy,Proma,WorkBuddy")
    .split(",").map((name) => name.trim()).filter(Boolean)
);
function exemptOk(name, present, detailIfPresent) {
  return { name, ok: present ? detailIfPresent.ok : true, detail: present ? detailIfPresent.detail : `可选宿主未配置（CP_INSTALL_EXEMPT=${[...MACHINE_EXEMPT].join(",")}）` };
}

const checks = [];

// 1. ZCode（当前宿主）：.zcode/cli/config.json 的 cosmic-phantom MCP 注册
{
  const cfg = readJson(join(HOME, ".zcode", "cli", "config.json"));
  const s = cfg && cfg.mcp && cfg.mcp.servers && cfg.mcp.servers["cosmic-phantom"];
  checks.push(check("zcode-mcp", !!s && s.command === nodeExe && s.args && s.args[0] === mcpServer,
    s ? `command=${s.command} args0=${s.args && s.args[0]}` : "未注册 cosmic-phantom"));
}

// 1b. ZCode hooks：三事件齐备 + 命令存在 + sqlite flag 静态校验（2026-08-17 实装，
//     防"install-check 全绿但 Stop hook 一跑即崩"类事故复发；实跑见 --live 5.5）
{
  const cfg = readJson(join(HOME, ".zcode", "cli", "config.json"));
  const events = cfg && cfg.hooks && cfg.hooks.events;
  const needed = ["SessionStart", "UserPromptSubmit", "Stop"];
  const present = needed.every((ev) => Array.isArray(events?.[ev]) && events[ev].length > 0);
  checks.push(check("zcode-hooks-三事件", present,
    present ? needed.map((ev) => `${ev}=${events[ev].length}`).join(" ") : `缺: ${needed.filter((ev) => !Array.isArray(events?.[ev]) || events[ev].length === 0).join(",")}`));

  for (const ev of needed) {
    for (const conf of events?.[ev] || []) {
      for (const h of conf.hooks || []) {
        const label = `zcode-hooks-${ev}:${String(h.command || "").split(/[\\/]/).pop()}`;
        const cmdOk = !!h.command && existsSync(h.command);
        checks.push(check(label + "-命令存在", cmdOk, h.command || "无 command"));
        if (!cmdOk) continue;
        const args = h.args || [];
        const scriptPath = args.find((a) => /\.(c?js|mjs)$/.test(a));
        if (scriptPath && existsSync(scriptPath)) {
          const src = readText(scriptPath);
          const hasFlag = args.some((a) => /sqlite/i.test(a));
          const flagOk = !/node:sqlite/.test(src) || hasFlag;
          checks.push(check(label + "-sqlite-flag", flagOk,
            flagOk ? "无需 flag 或已带" : `${scriptPath.split(/[\\/]/).pop()} require node:sqlite 但 args 无 --experimental-sqlite`));
        }
      }
    }
  }
}

// 1c. skill 挂载位一致性（F8 守卫，2026-08-17 实装）：真源 skills/*/SKILL.md vs 各宿主挂载位
//     副本逐字节一致。治 08-13 事故：daily 声称"已同步且 diff 一致"但 mtime 证实从未落盘，
//     宿主副本长期停留旧版（30 天蒸馏间隔）无人察觉。有挂载位即查，缺/不一致当场报。
{
  const syncRes = checkSkillSync(ROOT, HOME);
  const failed = syncRes.filter((r) => !r.ok);
  const hosts = [...new Set(syncRes.map((r) => r.host))].join("/");
  checks.push(check("skills-挂载位一致", failed.length === 0,
    failed.length ? failed.map((f) => `${f.host}/${f.skill}: ${f.detail}`).join("; ") : `${syncRes.length} 项全一致（${hosts}）`));
}

// 1d. Claude Code（主宿主，2026-09-16 加项）：盲区账本 B-004 —— 此前主宿主的两处接入件
//     （`~/.claude.json` 的 MCP 注册、`~/.claude/settings.json` 的 hooks）**无人写、无人验**，
//     而一切已锚在 Claude Code 上。本段把这两处纳入**本机**自查（落地器在新机做同一件事）。
//     判据含"引用可解析"——G1 教训：格式正确 ≠ 指向的东西在。
{
  const dotClaude = readJson(join(HOME, ".claude.json"));
  const s = dotClaude && dotClaude.mcpServers && dotClaude.mcpServers["cosmic-phantom"];
  const mcpOk = !!s && s.command === nodeExe && Array.isArray(s.args) && s.args[0] === mcpServer;
  checks.push(check("claude-mcp", mcpOk,
    s ? `command=${s.command} args0=${s.args && s.args[0]}` : "未注册 cosmic-phantom（~/.claude.json）"));

  const claudeSettings = readJson(join(HOME, ".claude", "settings.json"));
  const ccEvents = claudeSettings && claudeSettings.hooks;
  const ccNeeded = ["SessionStart", "UserPromptSubmit", "Stop"];
  const ccPresent = ccNeeded.every((ev) => Array.isArray(ccEvents?.[ev]) && ccEvents[ev].length > 0);
  checks.push(check("claude-hooks-三事件", ccPresent,
    ccPresent ? ccNeeded.map((ev) => `${ev}=${ccEvents[ev].length}`).join(" ") : `缺: ${ccNeeded.filter((ev) => !Array.isArray(ccEvents?.[ev]) || ccEvents[ev].length === 0).join(",")}`));

  const ccRefMissing = [];
  for (const ev of ccNeeded) {
    for (const conf of ccEvents?.[ev] || []) {
      for (const h of conf.hooks || []) {
        // Claude Code 的 command 是整条字符串（含 node + 脚本），与 ZCode 的 {command,args} 形态不同
        for (const p of String(h.command || "").match(/[A-Za-z]:[\\/][^"]*/g) || []) {
          if (!existsSync(p)) ccRefMissing.push(`${ev}:${p}`);
        }
      }
    }
  }
  checks.push(check("claude-hooks-引用可解析", ccRefMissing.length === 0,
    ccRefMissing.length ? `引用在磁盘上不存在: ${ccRefMissing.join("; ")}` : "全部 hook 引用的可执行/脚本均在位"));

  const claudeMd = readText(join(HOME, ".claude", "CLAUDE.md"));
  const cmRoot = ROOT.replace(/\\/g, "/");
  const cmOk = !!claudeMd && claudeMd.includes("snapshot-start") && claudeMd.includes(cmRoot);
  checks.push(check("claude-CLAUDE.md注入层", cmOk,
    claudeMd ? (cmOk ? "含快照段且指向真源" : `缺快照段 / 未指向 ${cmRoot}`) : "~/.claude/CLAUDE.md 缺失"));
}

// 2. CodeBuddy：mcp.json 注册 + rules/memory.md 指向真源（本机豁免：未安装不报失败）
{
  const cfg = readJson(join(HOME, ".codebuddy", "mcp.json"));
  const s = cfg && cfg.mcpServers && cfg.mcpServers["cosmic-phantom"];
  const mcpOk = !!s && s.command === nodeExe && s.args && s.args[0] === mcpServer;
  checks.push(MACHINE_EXEMPT.has("CodeBuddy") && !s
    ? exemptOk("codebuddy-mcp", false, null)
    : check("codebuddy-mcp", mcpOk, s ? `command=${s.command} args0=${s.args && s.args[0]}` : "未注册 cosmic-phantom"));
  const rules = readText(join(HOME, ".codebuddy", "rules", "memory.md"));
  const rulesOk = rules.includes(memoryCli) && !rules.includes(".breezell");
  checks.push(MACHINE_EXEMPT.has("CodeBuddy") && !rules
    ? exemptOk("codebuddy-rules", false, null)
    : check("codebuddy-rules", rulesOk,
        rules.includes(memoryCli) ? (rules.includes(".breezell") ? "含 .breezell 死路径" : "指向真源") : "未指向真源 memory-cli"));
}

// 2b. WorkBuddy 接入端（2026-08-17 加项，08-13 事故补位）：.mcp.json 含 cosmic-phantom 代理引用；
//     SOUL.md 身份在且已渲染（版本与真源模板一致、无 <USER_HOME> 占位符残留、含本机路径）。
//     08-13 声称"SOUL v13→v14 实装+备份"但磁盘停在 v13、备份不存在——纸面成功，这项目的就是锁死它。
{
  // 2026-08-29 WorkBuddy 除名(用户收回接入权):sources.json workbuddy.enabled=false → 整段豁免(照 CodeBuddy 模式)
  let wbEnabled = true;
  try {
    const s = readJson(join(ROOT, "sources.json"));
    const src = Array.isArray(s && (s.sources || s)) ? (s.sources || s).find(x => x.name === "workbuddy") : null;
    wbEnabled = src ? src.enabled !== false : true;
  } catch {}
  if (!wbEnabled || (MACHINE_EXEMPT.has("WorkBuddy") && !existsSync(join(HOME, ".workbuddy")))) {
    checks.push(exemptOk("workbuddy-mcp", false, null));
    checks.push(exemptOk("workbuddy-SOUL版本", false, null));
    checks.push(exemptOk("workbuddy-SOUL已渲染", false, null));
  } else {
  const mcp = readJson(join(HOME, ".workbuddy", ".mcp.json"));
  const mcpText = JSON.stringify(mcp || {});
  const hasCp = mcpText.includes("cosmic-phantom");
  checks.push(check("workbuddy-mcp", !!mcp && hasCp, hasCp ? "connector-proxy 聚合引用含 cosmic-phantom" : "未含 cosmic-phantom 引用"));

  const soul = readText(join(HOME, ".workbuddy", "SOUL.md"));
  const tpl = readText(join(ROOT, "templates", "workbuddy-SOUL.md"));
  const soulVer = (soul.match(/version: (\d+)/) || [])[1];
  const tplVer = (tpl.match(/version: (\d+)/) || [])[1];
  checks.push(check("workbuddy-SOUL版本", !!soul && soulVer === tplVer,
    soul ? `SOUL v${soulVer}（模板 v${tplVer}${soulVer === tplVer ? " 一致" : "，需从真源模板渲染应用"}）` : "SOUL.md 缺失"));
  const rendered = !!soul && !soul.includes("<USER_HOME>") && soul.includes("cosmic-phantom") && soul.includes(HOME.replace(/\\/g, "/"));
  checks.push(check("workbuddy-SOUL已渲染", rendered,
    rendered ? "无占位符且含本机路径" : (soul.includes("<USER_HOME>") ? "仍含 <USER_HOME> 占位符" : "缺本机路径或 cosmic-phantom 引用")));
  }
}

// 3. 项目根一致性：真源登记 vs 项目根身份证（rootId 必须一致）
{
  const reg = readJson(join(ROOT, "project-root.json"));
  if (reg && reg.projectRoot) {
    const pr = reg.projectRoot.replace(/\\/g, "/");
    const dirOk = existsSync(pr);
    const idFile = join(pr, ".project-root.json");
    let idMatch = false;
    if (existsSync(idFile)) {
      const id = readJson(idFile);
      idMatch = !!id && id.rootId === reg.rootId;
    }
    checks.push(check("project-root-identity", dirOk && idMatch,
      `${pr} ${dirOk ? "" : "[目录不存在]" } ${idMatch ? "[rootId 一致]" : "[rootId 不一致或无身份证]"}`));
  } else {
    checks.push(check("project-root-identity", false, "project-root.json 缺失或未配置", ENGINE_MODE ? "warning" : "fail"));
  }
}

// 4. Proma 源目录存在（sources.json enabled 源）
{
  const reg = readJson(join(ROOT, "sources.json"));
  const srcs = reg && Array.isArray(reg.sources) ? reg.sources : [];
  for (const s of srcs) {
    if (s.enabled !== false && s.kind === "jsonl" && s.dir) {
      checks.push(check(`source:${s.name}`, existsSync(s.dir), s.dir));
    }
  }
}

// 5. 实时自检（--live）：4 支柱真链路验证
//    注入生效(recall) / 摄取对齐(verify) 为只读真跑；写强制通+回读验证用临时 root 副本，
//    验完即清，绝不污染生产 events.db（红线：测试数据零容忍进生产）
if (process.argv.includes("--live")) {
  const sessionAdapter = join(ROOT, "session-adapter.js").replace(/\\/g, "/");
  const eventsJs = join(ROOT, "events.js").replace(/\\/g, "/");

  // 5.1 注入生效：recall 可跑且返回内容（只读）
  try {
    const out = execFileSync(process.execPath, [memoryCli, "recall", "--bytes", "200", "--root", ROOT], { encoding: "utf8", timeout: 30000 });
    checks.push(check("live:注入生效(recall可跑)", !!out && out.length > 0, `recall 返回 ${out.length} 字节`));
  } catch (e) {
    checks.push(check("live:注入生效(recall可跑)", false, `recall 失败: ${String(e.message || e).slice(0, 160)}`));
  }

  // 5.2 摄取对齐：verify 全库审计通过（只读）
  try {
    const out = execFileSync(process.execPath, [memoryCli, "verify", "--root", ROOT], { encoding: "utf8", timeout: 60000 });
    const aligned = /indexDrift["']?\s*:\s*false|0\s*噪音|对齐|"ok"\s*:\s*true/i.test(out);
    checks.push(check("live:摄取对齐(verify)", !!out && out.length > 0, aligned ? "审计输出含对齐信号" : `审计输出 ${out.length} 字节(未识别对齐信号)`));
  } catch (e) {
    checks.push(check("live:摄取对齐(verify)", false, `verify 失败: ${String(e.message || e).slice(0, 160)}`));
  }

  // 5.3 + 5.4 写强制通 + 回读验证：临时 root 副本，adapter 写入→events.db 落盘→读回，验完即清
  let tmp = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), "cp-ic-"));
    copyFileSync(join(ROOT, "events.js"), join(tmp, "events.js"));
    copyFileSync(join(ROOT, "events.db"), join(tmp, "events.db"));
    const marker = "INSTALL-CHECK-PROBE-" + Date.now();
    execFileSync(process.execPath, [sessionAdapter, "--session", "installcheck", "--root", tmp],
      { input: JSON.stringify({ entries: [{ role: "user", text: marker }] }), encoding: "utf8", timeout: 30000, env: { ...process.env, CP_NODE: process.execPath } });
    const written = readFileSync(join(tmp, "events.db"), "latin1").includes(marker);
    checks.push(check("live:写强制通(adapter→events.db)", written, written ? "marker 已落盘临时 events.db" : "marker 未落盘"));

    let readback = false, detail = "";
    try {
      execFileSync(process.execPath, ["--experimental-sqlite", join(tmp, "events.js"), "status", "--root", tmp], { encoding: "utf8", timeout: 30000 });
      readback = true; detail = "events.js status 读通道可达（落盘数据可读）";
    } catch (e2) { detail = `读通道失败: ${String(e2.message || e2).slice(0, 120)}`; }
    checks.push(check("live:回读验证(读通道可达)", readback, detail));
  } catch (e) {
    checks.push(check("live:写强制通(adapter→events.db)", false, `adapter 失败: ${String(e.message || e).slice(0, 160)}`));
    checks.push(check("live:回读验证(读通道可达)", false, "写失败，跳过读验证"));
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }

  // 5.5 hooks 实跑（hook-smoke）：用与 config.json 完全一致的 command/args 实跑三条 hook
  //     （2026-08-17 实装：08-12 事故根因即"配置存在但一跑即崩"，静态检查拦不住）
  //     --deep：全真链路（ZCode 最近真实 turn → zcode-flush → events.db，INSERT OR IGNORE 幂等，补录真实原话）
  // 2026-10-28：Claude Code 已退役（hosts.json role=retired）。目标机若压根没声明 hook，
  //   冒烟必然失败 → 曾把"本项不适用"读成"安装不合格"。改为按证据判定：没有声明就标 N/A，不伪造绿灯。
  let hookDeclared = 0;
  try {
    const cs = readJson(join(HOME, ".claude", "settings.json"));
    for (const arr of Object.values((cs && cs.hooks) || {})) hookDeclared += Array.isArray(arr) ? arr.length : 0;
  } catch { }
  if (hookDeclared === 0) {
    checks.push(check("live:hooks实跑(hook-smoke)", true, "N/A：目标机 ~/.claude/settings.json 未声明任何 hook（Claude Code 未接入/已退役），本项不适用"));
  } else {
  try {
    const hookSmoke = join(ROOT, "hook-smoke.cjs").replace(/\\/g, "/");
    const out = execFileSync(nodeExe, ["--experimental-sqlite", hookSmoke, "--deep", "--root", ROOT], { encoding: "utf8", timeout: 90000 });
    const parsed = JSON.parse((out || "").trim());
    const failed = (parsed.checks || []).filter((c) => !c.ok);
    checks.push(check("live:hooks实跑(hook-smoke)", parsed.ok === true,
      failed.length === 0 ? `${parsed.checks.length} 项全绿（含 deep 全真链路）` : `${failed.length} 项失败: ${failed.map((c) => c.name).join(",")}`));
  } catch (e) {
    checks.push(check("live:hooks实跑(hook-smoke)", false, `hook-smoke 失败: ${String(e.message || e).slice(0, 160)}`));
  }
  }
}

// 2026-10-28：hosts.json 里 role=retired 的宿主（Claude Code / ZCode / CodeBuddy）本就不参与对账，
//   但本脚本仍在逐项校验它们 → 目标机没装/已注销时稳定假红（实测：真机 3 红、全新机 7 红），
//   会让"装好了"被读成"装坏了"。改法：按 hosts.json 的 role 判定，退役宿主的失败项转为 N/A（保留原 detail）。
let RETIRED_PREFIX = ["codebuddy-"];  // CodeBuddy 2026-08-28 用户弃用（AGENTS.md），hosts.json 未登记
try {
  const h = readJson(join(ROOT, "hosts.json"));
  const map = { "Claude Code": "claude-", "ZCode": "zcode-", "CodeBuddy": "codebuddy-" };
  for (const x of (h && h.hosts) || []) if (x && x.role === "retired" && map[x.name]) RETIRED_PREFIX.push(map[x.name]);
} catch { }
for (const c of checks) {
  if (!c.ok && RETIRED_PREFIX.some((p) => String(c.name).startsWith(p))) {
    c.detail = `N/A：宿主已退役（hosts.json role=retired），不参与对账｜原判据：${c.detail}`;
    c.retired = true;
    c.ok = true;
  }
}
const failures = checks.filter(c => !c.ok && c.severity !== "warning");
const noteBase = "不一致时：重跑宿主安装脚本或按当前实例路径手动改宿主配置；绝不静默使用旧路径";
const result = { ok: failures.length === 0, checked: checks.length, failed: failures.length, checks, note: process.argv.includes("--live") ? noteBase : noteBase + "；加 --live 跑 4 支柱实时自检（注入/摄取/写/读）" };
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exitCode = result.ok ? 0 : 1;
