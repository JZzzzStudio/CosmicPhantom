#!/usr/bin/env node
/**
 * events.js — 原始事件层（权威真源）+ daily 可读投影（2026-08-08 双轨方案）
 *
 * 两段契约（P0 修复核心）：
 *   段1 ingest：state.db → events.db
 *     单事务：事件 INSERT（UNIQUE(source_instance, mid) 去重）+ 游标 UPDATE 原子提交
 *     原始事件未持久化 → 游标不前进（崩溃回滚，重放安全）
 *   段2 project：events.db → daily
 *     可重放投影：projection 表 + 精确事件摘要标记（cp-evt-v2）双查幂等
 *     daily 已写/投影状态未提交 → 重放靠 daily 标记去重不重复
 *     daily 写入失败 → 原始事件保留（events.db），修复后重跑 project 恢复
 *
 * 事件唯一键 = sourceInstanceId + messageId：
 *   sourceInstanceId 首次接入真源时生成（UUID，持久化于 events.db meta），
 *   真源身份 = state.db messages 首个 session_id（换库/迁移后不同 → 自动换新实例，防 id 重号冲突）
 *   manual 手动输入流（log_turn 直调）用固定实例 "manual" + 自增序号
 *
 * 保真：content 原样存储（不 trim、不改写）；daily 投影同样不 trim（只做结构性展示）
 * 敏感边界：content 命中敏感模式（key/secret/token/cookie/password/authorization/bearer）标记 sensitive=1，
 *   默认保留（第一性原理：原话不丢），purge --sensitive-only 可清理（用户显式删除/撤回通道）
 *
 * 用法（需 --experimental-sqlite）：
 *   node --experimental-sqlite events.js poll  --db <state.db> [--root <r>]   # 段1+段2
 *   node --experimental-sqlite events.js ingest --db <state.db> [--root <r>]  # 段1
 *   node --experimental-sqlite events.js project [--root <r>]                 # 段2
 *   node --experimental-sqlite events.js status [--root <r>]
 *   node --experimental-sqlite events.js purge --before <YYYY-MM-DD> [--sensitive-only] [--root <r>]
 *   node --experimental-sqlite events.js export --out <dir> [--root <r>]
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(homedir(), ".cosmic-phantom");
const EVENTS_DB = join(ROOT, "events.db");
const DAILY_DIR = join(ROOT, "daily");
const PROJECTION_LOCK = join(ROOT, ".cp-projection.lock");
const LOG = join(ROOT, "hook-errors.log");
const END_WORDS = /(今天就到这|今天到这|收工|再见|不聊了|先这样|结束|休息|晚安|明天见|暂停|拜拜|\bbye\b|\bend\b|\bstop\b)/i; // K21：\b 边界
const SENSITIVE = /(api[_-]?key|secret|passw(or)?d|token|cookie|authorization|bearer\s+\S)/i;
// 2026-08-17 收紧：删"不要"（否定指令/质疑高频误标，如"不要再让我指出来"被标决策）；
//   触发词只留确定性决策语义；提问/质疑类由 decision-cards 侧二次过滤
const DECISION = /(记住|记一下|改成|改为|偏好|禁止|一律|(决定|拍板|约定)[:：])/;   // 2026-09-01 词表收紧(用户拍板)：去掉 以后/必须/每次/规则/裸决定 宽命中(治决策卡滥产)，决定/拍板/约定 仅冒号显式形态命中 // ⭐决策触发词
const WRITE_TOOLS = /(write_file|apply_patch|bash|edit|Set-Content|git\s+commit|patch)/i;   // 投影只记写类工具

// 恢复文件识别（F18 同族，2026-08-29）：首行 _recovered 溯源标记 → coverage 豁免（行号与原文件不同，对账必然三计数爆炸）
function isRecovered(file) {
  try { return readFileSync(file, "utf8").slice(0, 600).includes('"_recovered"'); } catch { return false; }
}

function logErr(m) { try { appendFileSync(LOG, `[${new Date().toISOString()}] events: ${m}\n`); } catch {} }
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function acquireProjectionLock() {
  const token = `${process.pid}:${Date.now()}`;
  try {
    writeFileSync(PROJECTION_LOCK, token, { flag: "wx" });
    return { ok: true, release: () => { try { if (readFileSync(PROJECTION_LOCK, "utf8") === token) unlinkSync(PROJECTION_LOCK); } catch {} } };
  } catch (error) {
    if (error.code !== "EEXIST") return { ok: false, error: `投影锁创建失败: ${error.message}` };
    try {
      const [pidText, startedText] = readFileSync(PROJECTION_LOCK, "utf8").trim().split(":");
      const stale = !pidAlive(Number(pidText));
      if (stale) { unlinkSync(PROJECTION_LOCK); return acquireProjectionLock(); }
    } catch {}
    return { ok: false, error: "投影正在由另一个进程执行，请稍后重试", code: "PROJECTION_BUSY" };
  }
}
function localDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return localDate(new Date());
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function today() { return localDate(); }
function markerV2(event) {
  return `cp-evt-v2:${createHash("sha256").update(`${event.instance}\0${event.mid}`).digest("hex").slice(0, 32)}`;
}
function legacyMarker(event) { return `${String(event.instance).slice(0, 8)}:${event.mid}`; }
function markerTokens(text) {
  const tokens = new Set();
  for (const m of String(text).matchAll(/(?:cp-evt-v2:[0-9a-f]{32}|[A-Za-z0-9_-]{1,64}:-?\d+)/g)) tokens.add(m[0]);
  return tokens;
}

function openDb() {
  const db = new DatabaseSync(EVENTS_DB);
  // 并发防护（2026-08-28 外审预检）：events.db 有 5 个写入方（Stop hook/MCP/双 adapter/维护），
  //   默认 busy_timeout=0 → 并发收尾即 SQLITE_BUSY 崩、丢写。5s 等锁是纯收益。
  //   WAL 不开：主库文件会滞后于 -wal 文件，U 盘跨机拷贝会缺最新提交（权衡交底，待配合 checkpoint 策略再启用）。
  db.exec("PRAGMA busy_timeout = 5000;");
  // WAL（2026-08-29 外审整改）：并发读写不互斥（busy_timeout 只解决写写等锁）；
  //   副作用=主库文件滞后于 -wal，已确认全系统无流程物理拷贝 events.db（跨机走 export jsonl），
  //   export 前强制 wal_checkpoint(TRUNCATE) 作防御（见 exportInternal）。
  try { db.exec("PRAGMA journal_mode = WAL;"); } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance TEXT NOT NULL,
      mid INTEGER NOT NULL,
      session TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      tool_calls TEXT,
      ts TEXT NOT NULL,
      sensitive INTEGER DEFAULT 0,
      src_host TEXT,
      source_root TEXT,
      source_machine TEXT,
      source_id TEXT,
      source_revision INTEGER DEFAULT 1,
      source_kind TEXT,
      source_ref TEXT,
      scope TEXT DEFAULT 'workspace',
      UNIQUE(instance, mid)
    );
    CREATE TABLE IF NOT EXISTS projection (event_id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS event_tombstones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance TEXT NOT NULL,
      mid TEXT NOT NULL,
      action TEXT NOT NULL,
      content_sha256 TEXT,
      reason TEXT NOT NULL,
      audit_mid TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(instance, mid, action)
    );
    CREATE INDEX IF NOT EXISTS idx_tombstones_target ON event_tombstones(instance, mid);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_role_ts ON events(role, ts);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session);
  `);
  // 迁移(REVIEW 2026-08-29 🔴修复):旧库无 src_host 列时补列;已手工加列的库 ALTER 报错静默跳过(fail-open)。
  try { db.exec("ALTER TABLE events ADD COLUMN src_host TEXT"); } catch {}
  // 来源根独立性（S2-1，2026-11-18）：同一 session 换宿主/换适配器再导入 ≠ 独立证据。
  //   source_root 取 session（原始会话标识），NULL 时惰性回填；只动未填的行，不重写历史。
  try {
    db.exec("ALTER TABLE events ADD COLUMN source_root TEXT");
  } catch {}
  // 2026-11-19 修（挑刺）：source_root 的既有语义是「原始会话标识」，不是机器。
  //   机器级来源改用独立列 source_machine，避免两种语义混在一列。
  try { db.exec("ALTER TABLE events ADD COLUMN source_machine TEXT"); } catch {}
  try { db.exec("ALTER TABLE events ADD COLUMN source_id TEXT"); } catch {}
  try { db.exec("ALTER TABLE events ADD COLUMN source_revision INTEGER DEFAULT 1"); } catch {}
  try { db.exec("ALTER TABLE events ADD COLUMN source_kind TEXT"); } catch {}
  try { db.exec("ALTER TABLE events ADD COLUMN source_ref TEXT"); } catch {}
  try { db.exec("ALTER TABLE events ADD COLUMN scope TEXT DEFAULT 'workspace'"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_identity ON events(instance, source_id, source_revision) WHERE source_id IS NOT NULL"); } catch (e) { logErr(`来源身份索引未建立: ${e.message}`); }
  try {
    const pending = db.prepare("SELECT COUNT(*) c FROM events WHERE source_root IS NULL").get().c;
    if (pending > 0) db.exec("UPDATE events SET source_root = session WHERE source_root IS NULL");
  } catch {}
  return db;
}
function metaGet(db, k) { const r = db.prepare("SELECT value FROM meta WHERE key=?").get(k); return r ? r.value : undefined; }
function metaSet(db, k, v) { db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v)); }

function sourceIdentityHealth(db) {
  try {
    const indexes = db.prepare("PRAGMA index_list('events')").all();
    const index = indexes.find((row) => row.name === "idx_events_source_identity");
    const columns = index
      ? db.prepare("PRAGMA index_info('idx_events_source_identity')").all().sort((a, b) => a.seqno - b.seqno).map((row) => row.name)
      : [];
    const expected = ["instance", "source_id", "source_revision"];
    const validIndex = !!index && Number(index.unique) === 1 && JSON.stringify(columns) === JSON.stringify(expected);
    const duplicate = Number(db.prepare("SELECT COUNT(*) c FROM (SELECT instance, source_id, source_revision FROM events WHERE source_id IS NOT NULL GROUP BY instance, source_id, source_revision HAVING COUNT(*) > 1)").get().c || 0);
    return { ok: validIndex && duplicate === 0, index: validIndex, indexColumns: columns, duplicateIdentities: duplicate };
  } catch (error) {
    return { ok: false, index: false, indexColumns: [], duplicateIdentities: null, error: error.message };
  }
}

function sourceIdentityInternal(repair = false) {
  if (!existsSync(EVENTS_DB)) return { ok: true, present: false, repaired: false, duplicateIdentities: 0 };
  const db = openDb();
  try {
    const before = sourceIdentityHealth(db);
    if (repair && before.duplicateIdentities > 0) {
      return { ok: false, present: true, repaired: false, refused: true, reason: "存在重复来源身份，只能人工决定如何保留；未自动改写事件", before };
    }
    if (repair && !before.ok) {
      db.exec("DROP INDEX IF EXISTS idx_events_source_identity; CREATE UNIQUE INDEX idx_events_source_identity ON events(instance, source_id, source_revision) WHERE source_id IS NOT NULL;");
    }
    const after = sourceIdentityHealth(db);
    return { ok: after.ok, present: true, repaired: repair && after.ok && !before.ok, before, after };
  } finally { try { db.close(); } catch {} }
}

// 实例初始化/换库检测：返回 {instance, short, cursor, isNew} 或 null（空库）
function ensureInstance(db, srcDb) {
  let instance = metaGet(db, "instance_id");
  const sigNow = (srcDb.prepare("SELECT MIN(session_id) s FROM messages").get().s) || "";
  if (!instance) {
    const mx = srcDb.prepare("SELECT MAX(id) m FROM messages").get().m || 0;
    if (mx === 0) return null; // 空库推迟建实例
    instance = randomUUID();
    metaSet(db, "instance_id", instance);
    metaSet(db, "instance_short", instance.slice(0, 8));
    metaSet(db, "source_signature", sigNow);
    metaSet(db, "cursor", 0);
    return { instance, short: instance.slice(0, 8), cursor: 0, isNew: true };
  }
  const sig = metaGet(db, "source_signature") || "";
  let cursor = Number(metaGet(db, "cursor") || 0);
  if (sigNow !== sig) {
    // 换库/迁移：新真源实例（id 可能重新从小值开始，必须换唯一键前缀）
    instance = randomUUID();
    metaSet(db, "instance_id", instance);
    metaSet(db, "instance_short", instance.slice(0, 8));
    metaSet(db, "source_signature", sigNow);
    metaSet(db, "cursor", 0);
    logErr(`真源实例更换：新实例 ${instance.slice(0, 8)}（签名 ${sig || "(空)"} → ${sigNow || "(空)"}）`);
    // swapped=true：新实例事件从未投影，必须正常投影（不做迁移防重复标记——那是"全新接入"的语义）
    return { instance, short: instance.slice(0, 8), cursor: 0, isNew: true, swapped: true };
  }
  return { instance, short: metaGet(db, "instance_short") || instance.slice(0, 8), cursor, isNew: false };
}

// 段1内部实现：返回 {instance, cursor, ingested, endedNew, endedSemantic, at} 或 {error}
// 通道名映射(2026-08-29):instance 前缀 → 宿主展示名(daily 段头"通道：xxx")。
//   C 方案修正(2026-08-29 WB 事故):写入侧 instance 恒守约定(manual 池为对账锚点,还原 WB 的
//   写入侧改动),通道精确化只在展示层——instance=manual 且 session 带 session- 前缀 = 经
//   session-adapter 手动落盘的宿主会话,标 SessionAdapter;纯 manual(无前缀)= 通用手动落盘。
function channelName(instance, session) {
  const s = String(instance || "");
  if (s === "manual" && String(session || "").startsWith("session-")) return "SessionAdapter";
  if (s.startsWith("zcode")) return "ZCode";
  if (s.startsWith("proma")) return "Proma";
  if (s.startsWith("wb-") || s.startsWith("workbuddy")) return "WorkBuddy";
  if (s.startsWith("session-")) return "SessionAdapter";
  if (s === "manual") return "Manual";
  return s || "未知";
}

// P1-5(2026-08-29):proma midCheck 的 mid 口径=内容 hash。规格与 proma-adapter.js hashMid
//   逐字一致(sha256(role+"\n"+content) hex 前 12 位转 48bit 整数);两处实现漂移由 midCheck 对账自动暴露。
function hashMid(role, content) {
  return parseInt(createHash("sha256").update(`${role}\n${content || ""}`).digest("hex").slice(0, 12), 16);
}

function ingestInternal(dbPath) {
  if (!existsSync(dbPath)) { logErr(`ingest: db missing ${dbPath}`); return { error: "db missing" }; }
  let src;
  try { src = new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { logErr(`ingest: open failed ${e.message}`); return { error: "db open failed" }; }
  const db = openDb();
  try {
    const identityHealth = sourceIdentityHealth(db);
    if (!identityHealth.ok) return { error: "来源身份完整性失败: " + JSON.stringify(identityHealth) };
    const inst = ensureInstance(db, src);
    if (!inst) return { instance: null, cursor: 0, ingested: 0, endedNew: 0, endedSemantic: false, at: new Date().toISOString() };
    const rows = src.prepare("SELECT id, session_id, role, content, tool_name, tool_calls FROM messages WHERE id > ? ORDER BY id ASC").all(inst.cursor);
    // K24：结束语义检测（每会话增量最后一条 ≤200 字纯文本 user 消息）
    let endedSemantic = false;
    const lastUser = {};
    for (const r of rows) if (r.role === "user" && typeof r.content === "string") lastUser[r.session_id] = r.content;
    for (const c of Object.values(lastUser)) {
      if (c.length <= 200 && !/[{}\":\\]/.test(c) && END_WORDS.test(c)) { endedSemantic = true; break; }
    }
    // 游标超前告警（库被清空/消息被删 → 空转暴露，不静默）
    if (!rows.length) {
      const mx = src.prepare("SELECT MAX(id) m FROM messages").get().m || 0;
      if (mx < inst.cursor) logErr(`游标超前告警：真源 MAX(id)=${mx} < 游标=${inst.cursor}，需人工检查 events.db meta.cursor`);
    }
    let ingested = 0;
    const now = new Date().toISOString();
    if (rows.length) {
      db.exec("BEGIN IMMEDIATE")   // IMMEDIATE：写锁提前获取，受 busy_timeout 管（DEFERRED 升级锁 BUSY 不等待，2026-08-29 压测实证丢写）;
      try {
        const ins = db.prepare("INSERT OR IGNORE INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive, src_host, source_root, source_machine, source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
        for (const r of rows) {
          const info = ins.run(inst.instance, r.id, r.session_id, r.role,
            typeof r.content === "string" ? r.content : (r.content ? JSON.stringify(r.content) : null),
            r.tool_name || null, r.tool_calls || null, now, SENSITIVE.test(r.content || "") ? 1 : 0, null, r.session_id, localSourceRoot(), String(r.id));
          ingested += Number(info.changes);
        }
        // 游标与事件同事务提交：事件未持久化 → 游标不前进（窗口 a）
        metaSet(db, "cursor", rows[rows.length - 1].id);
        // 首次接入（全新 events.db，非换库）：升级场景防重复——读旧指针 state-poll.json 的 maxId
        // 作为"历史基线"，仅标记 mid ≤ 基线的已摄取事件为已投影（旧 daily 已有其内容）；
        // 无基线（纯新系统）→ 全部正常投影。换库（swapped）永不标记（新实例事件从未投影）。
        // 与游标同事务 → 崩溃不会留下中间态（2026-08-08 三次迭代定稿）
        if (inst.isNew && !inst.swapped) {
          let base = 0;
          try {
            const sp = JSON.parse(readFileSync(join(ROOT, "state-poll.json"), "utf8"));
            if (sp && /^\d+$/.test(String(sp.maxId || ""))) base = Number(sp.maxId);
          } catch {}
          if (base > 0) {
            db.prepare("INSERT OR IGNORE INTO projection(event_id) SELECT id FROM events WHERE instance=? AND mid <= ?").run(inst.instance, base);
          }
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        logErr(`ingest 事务失败已回滚: ${e.message}`);
        return { error: `ingest 事务回滚: ${e.message}` };
      }
    }
    // 结束信号（K20：ended_at 事件）
    let endedNew = 0;
    try {
      const ended = src.prepare("SELECT id FROM sessions WHERE ended_at IS NOT NULL").all().map(r => r.id);
      const known = JSON.parse(metaGet(db, "ended_sessions") || "[]");
      const fresh = ended.filter(id => !known.includes(id));
      if (fresh.length) { endedNew = fresh.length; metaSet(db, "ended_sessions", JSON.stringify(ended)); }
    } catch { /* 非 Hermes 库 */ }
    return { instance: inst.short, cursor: Number(metaGet(db, "cursor") || 0), ingested, endedNew, endedSemantic, at: now };
  } catch (e) { logErr(`ingest: ${e.message}`); return { error: e.message }; }
  finally { try { db.close(); } catch {} try { src.close(); } catch {} }
}

// 段2内部实现：返回 {projected, skipped} 或 {error}
function projectInternal() {
  if (!existsSync(EVENTS_DB)) return { projected: 0, skipped: 0, error: "events.db 不存在" };
  const lock = acquireProjectionLock();
  if (!lock.ok) return { projected: 0, skipped: 0, error: lock.error, code: lock.code };
  let db;
  try {
    db = openDb();
    const pending = db.prepare("SELECT e.* FROM events e LEFT JOIN projection p ON p.event_id=e.id WHERE p.event_id IS NULL AND e.instance NOT IN ('purge-audit','redact') AND NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge') ORDER BY e.id").all();
    if (!pending.length) return { projected: 0, skipped: 0 };
    mkdirSync(DAILY_DIR, { recursive: true });

    const byDateSession = {};
    for (const e of pending) {
      const date = localDate(e.ts);
      const key = `${date}\0${e.session}`;
      (byDateSession[key] = byDateSession[key] || { date, session: e.session, events: [] }).events.push(e);
    }

    const dailyCache = new Map();
    function dailyState(date) {
      if (dailyCache.has(date)) return dailyCache.get(date);
      const file = join(DAILY_DIR, `${date}.md`);
      let text = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!text) {
        text = `# ${date} 工作日志\n\n`;
        if (date === today()) {
          try {
            const dates = readdirSync(DAILY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f.slice(0, 10) !== date).sort();
            if (dates.length) {
              const lastDate = dates[dates.length - 1].slice(0, 10);
              const yesterday = localDate(new Date(Date.now() - 86400000));
              if (lastDate < yesterday) text += `⚠️ 漏写标记：最近日志 ${lastDate} 早于昨日 ${yesterday}，存在未落盘会话，启动时应提示用户补记\n\n`;
            }
          } catch (e) { logErr(`漏写标记检查失败: ${e.message}`); }
        }
        try { appendFileSync(file, text); }
        catch (e) { throw new Error(`daily 创建失败: ${e.message}`); }
      }
      const state = { file, text, tokens: markerTokens(text) };
      dailyCache.set(date, state);
      return state;
    }

    let projected = 0, skipped = 0;
    const insP = db.prepare("INSERT OR IGNORE INTO projection(event_id) VALUES(?)");
    for (const group of Object.values(byDateSession)) {
      const { date, session: sid, events: evs } = group;
      let state;
      try { state = dailyState(date); }
      catch (e) { logErr(e.message); return { projected, skipped, error: e.message }; }
      const present = [], fresh = [];
      for (const event of evs) {
        const mark = markerV2(event);
        if (state.tokens.has(mark) || state.tokens.has(legacyMarker(event))) present.push(event);
        else fresh.push(event);
      }
      for (const event of present) insP.run(event.id);
      skipped += present.length;
      if (!fresh.length) continue;

      const marks = fresh.map(markerV2);
      const title = String(sid).replace(/^session-/, "").split("-").slice(-2).join("-") || String(sid);
      // 通道标注(2026-08-29 溯源优化):段头显示写入通道(instance→宿主名),回答"这条由谁写入"。
      //   真源仍是 events.instance,此处仅投影展示;同组按 fresh[0] 取(同 session 同宿主)。
      const channel = channelName(fresh[0].instance, sid);
      let block = `## 会话 ${title}（${fresh[0].ts}）· 通道：${channel}\n<!-- cp-evt: ${marks.join(" ")} -->\n`;
      for (const e of fresh) {
        if (e.role === "user") {
          let text = e.content || "";
          // R1（2026-09-16 用户拍板）：宿主调用技能时会往对话塞 "Base directory for this skill: …"
          //   那**不是用户说的话**，却被落盘管道当成用户原话记入（同族先例见上方 <system-reminder 分支）。
          //   实证：events.db:5336 与 5360 均为该前缀、role=user —— 每调一次技能漏一条。
          //   仅过滤"投影层"（daily 行与由此派生的决策卡）；原始事件保留，改动不触及真源写入。
          if (/^Base directory for this skill:/.test(text.trim())) { skipped += 1; continue; }
          if (text.includes("<system-reminder")) {
            const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
            if (!m) { skipped += 1; continue; }
            text = m[1];
          }
          block += (DECISION.test(text) ? "- **⭐👤 用户（决策）**：" : "- 👤 用户：") + text + "\n";
        } else if (e.role === "tool" && WRITE_TOOLS.test(e.tool_name || "")) {
          block += `- [工具] ${e.tool_name} (ok)\n`;
        } else if (e.role === "assistant" && e.content) {
          const c = String(e.content);
          if (c.includes("[摘要]")) block += `- [摘要] ${c}\n`;
          else if (c.trim().startsWith("🛠️")) block += `- **🛠️ Agent（成果）**：${c.trim().replace(/^🛠️\s*/, "")}\n`;
          else {
            // D-05（2026-10-28）：Proma 等宿主的回复是一大段文本，成果行未必在开头。
            //   只提取“行首 🛠️ + 非空”的短行（32-300 字），最多 3 条；避免表格/代码示例误收。
            const hits = c.split(/\r?\n/).map(line => line.trim()).filter(line => /^🛠️\s+\S/.test(line) && line.length >= 32 && line.length <= 300).slice(0, 3);
            for (const h of hits) block += `- **🛠️ Agent（成果）**：${h.replace(/^🛠️\s*/, "")}\n`;
          }
        }
      }
      block += "---\n";
      try {
        appendFileSync(state.file, block + "\n");
        state.text += block + "\n";
        for (const mark of marks) state.tokens.add(mark);
        for (const e of fresh) insP.run(e.id);
        projected += fresh.length;
      } catch (e) {
        logErr(`project 追加失败（事件保留，可重试）: ${e.message}`);
        return { projected, skipped, error: `daily 追加失败: ${e.message}` };
      }
    }
    return { projected, skipped };
  } catch (e) { logErr(`project: ${e.message}`); return { error: e.message }; }
  finally { try { db?.close(); } catch {} lock.release(); }
}

// 保真提取（不 trim，K 系列教训：逐字保存）：返回原样文本或 ""（空消息忽略）
function extractText(msg) {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(c => c.type === "text" && c.text)
      .map(c => c.text).join("\n");
  }
  return "";
}

// ZCode 稳定来源输入：sourceId/session/content/ts JSONL → events → project
function zcodeInternal(sourceFile) {
  if (!sourceFile || !existsSync(sourceFile)) return { logged: 0, empty: true, error: "no source" };
  let lines;
  try { lines = readFileSync(sourceFile, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n").filter(Boolean); }
  catch (e) { return { logged: 0, error: e.message }; }
  const items = [];
  for (const line of lines) {
    let item; try { item = JSON.parse(line); } catch { continue; }
    if (!item || typeof item.sourceId !== "string" || !item.sourceId || typeof item.session !== "string" || !item.session) continue;
    if (typeof item.content !== "string" || item.content.trim() === "") continue;
    const ts = new Date(item.ts);
    if (Number.isNaN(ts.getTime())) continue;
    items.push({ sourceId: item.sourceId, session: item.session, content: item.content, ts: ts.toISOString() });
  }
  if (!items.length) return { logged: 0, empty: true };

  const db = openDb();
  let logged = 0, skipped = 0;
  try {
    const identityHealth = sourceIdentityHealth(db);
    if (!identityHealth.ok) return { logged: 0, skipped: 0, error: "来源身份完整性失败: " + JSON.stringify(identityHealth) };
    // M1 修复(2026-08-29):zcode 通道 INSERT 原缺 src_host 列(此前修复只覆盖 manual 通道:398-411),
    // 导致 config.json env.CP_HOST 设了也全空。补列+补 env 读取,与 manual 通道对齐。
    const SRC_HOST = process.env.CP_HOST || null;   // 由 zcode-flush.cjs spawnSync 显式传入(hook 进程 env 无此变量,fallback 在 flush 侧)
    const ins = db.prepare("INSERT OR IGNORE INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive, src_host, source_root, source_machine, source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    db.exec("BEGIN IMMEDIATE")   // IMMEDIATE：写锁提前获取，受 busy_timeout 管（DEFERRED 升级锁 BUSY 不等待，2026-08-29 压测实证丢写）;
    try {
      for (const item of items) {
        const info = ins.run(`zcode-msg:${item.sourceId}`, 0, item.session, "user", item.content, null, null, item.ts, SENSITIVE.test(item.content) ? 1 : 0, SRC_HOST, item.session, localSourceRoot(), item.sourceId);
        if (Number(info.changes) === 1) logged += 1;
        else skipped += 1;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      logErr(`zcode 事务回滚: ${e.message}`);
      return { logged: 0, skipped: 0, error: e.message };
    }
  } finally { try { db.close(); } catch {} }
  const pr = projectInternal();
  return {
    logged,
    skipped,
    eventCommitted: true,
    projection: { ok: !pr.error, projected: pr.projected || 0, skipped: pr.skipped || 0, ...(pr.error ? { error: pr.error } : {}) },
    empty: false,
  };
}

// manual 手动输入流：transcript JSONL → events（instance="manual" + 自增 seq）→ project
// 提取规则（与旧 log_turn R1-R4 一致）：user 全量 / tool 仅写类 / assistant 仅 [摘要]

// 通用适配器入口：标准 JSONL → events.db。身份由来源实例、来源 ID 和 revision 构成，
// 正文哈希只用于冲突检查，不参与跨来源合并。
function normalizedInternal(input) {
  if (!input || !existsSync(input)) return { logged: 0, skipped: 0, error: "no normalized input" };
  let lines;
  try { lines = readFileSync(input, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n").filter(Boolean); }
  catch (e) { return { logged: 0, skipped: 0, error: e.message }; }
  const rows = [];
  const rowByIdentity = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    let value;
    try { value = JSON.parse(lines[i]); } catch (e) { return { logged: 0, skipped: 0, error: `第 ${i + 1} 行 JSON 无效: ${e.message}` }; }
    const scalar = (field, required = true) => {
      const valueForField = value[field];
      if (valueForField == null || valueForField === "") return required ? null : null;
      if (typeof valueForField !== "string" && typeof valueForField !== "number") return null;
      const text = String(valueForField).trim();
      return text || null;
    };
    const instance = scalar("source_instance");
    const sourceId = scalar("source_id");
    const revision = Number(value.revision);
    const role = String(value.role || "").trim();
    const rawTs = value.ts;
    const ts = new Date(rawTs);
    const scope = String(value.scope || "").trim();
    if (!instance || !sourceId || !Number.isInteger(revision) || revision < 1 || !role || typeof rawTs !== "string" || !rawTs.trim() || Number.isNaN(ts.getTime())) return { logged: 0, skipped: 0, error: `第 ${i + 1} 行缺少合法 source_instance/source_id/revision/role/ts` };
    if (!/^(user|assistant|tool|system)$/.test(role)) return { logged: 0, skipped: 0, error: `第 ${i + 1} 行 role 非法` };
    if (!/^(global|workspace|agent)$/.test(scope)) return { logged: 0, skipped: 0, error: `第 ${i + 1} 行 scope 非法` };
    const sessionId = scalar("session_id");
    const sourceKind = scalar("source_kind");
    const sourceRef = scalar("source_ref");
    if (!sessionId) return { logged: 0, skipped: 0, error: `第 ${i + 1} 行缺少合法 session_id` };
    if (!sourceKind || !sourceRef) return { logged: 0, skipped: 0, error: `第 ${i + 1} 行缺少合法 source_kind/source_ref` };
    if (value.content != null && typeof value.content !== "string") return { logged: 0, skipped: 0, error: `第 ${i + 1} 行 content 必须是字符串或 null` };
    const toolName = scalar("tool_name", false);
    if (value.tool_name != null && !toolName) return { logged: 0, skipped: 0, error: `第 ${i + 1} 行 tool_name 必须是字符串或数字` };
    const toolCalls = value.tool_calls == null ? null : typeof value.tool_calls === "string" ? value.tool_calls : JSON.stringify(value.tool_calls);
    const row = { instance, sourceId, revision, session: sessionId, role, content: value.content == null ? null : value.content, toolName, toolCalls, ts: ts.toISOString(), sourceKind, sourceRef, scope };
    const identity = `${instance}\0${sourceId}\0${revision}`;
    const duplicate = rowByIdentity.get(identity);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(row)) return { logged: 0, skipped: 0, error: `第 ${i + 1} 行与同批来源身份内容冲突: ${instance}:${sourceId}:${revision}` };
      continue;
    }
    rowByIdentity.set(identity, row);
    rows.push(row);
  }
  if (!rows.length) return { logged: 0, skipped: 0, empty: true };
  const db = openDb(); let logged = 0; let skipped = 0; const conflicts = [];
  try {
    const identityHealth = sourceIdentityHealth(db);
    if (!identityHealth.ok) return { logged: 0, skipped: 0, conflicts: [], error: "来源身份完整性失败: " + JSON.stringify(identityHealth) };
    const existing = db.prepare("SELECT role, content, session, tool_name, tool_calls, ts, source_id, source_revision, source_kind, source_ref, scope FROM events WHERE instance=? AND source_id=? AND source_revision=?");
    const maxMid = db.prepare("SELECT COALESCE(MAX(mid), 0) m FROM events WHERE instance=?");
    const nextMid = new Map();
    const ins = db.prepare("INSERT INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive, src_host, source_root, source_machine, source_id, source_revision, source_kind, source_ref, scope) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const old = existing.get(row.instance, row.sourceId, row.revision);
        if (old) {
          const same = old.role === row.role && (old.content || null) === (row.content || null) && old.session === row.session && (old.tool_name || null) === row.toolName && (old.tool_calls || null) === row.toolCalls && new Date(old.ts).toISOString() === row.ts && (old.source_kind || null) === row.sourceKind && (old.source_ref || null) === row.sourceRef && (old.scope || "workspace") === row.scope;
          if (!same) conflicts.push(`${row.instance}:${row.sourceId}:${row.revision}`);
          else skipped += 1;
          continue;
        }
        if (!nextMid.has(row.instance)) nextMid.set(row.instance, Number(maxMid.get(row.instance).m || 0));
        row.mid = nextMid.get(row.instance) + 1;
        nextMid.set(row.instance, row.mid);
        ins.run(row.instance, row.mid, row.session, row.role, row.content, row.toolName, row.toolCalls, row.ts, SENSITIVE.test(row.content || "") ? 1 : 0, process.env.CP_HOST || null, row.session, localSourceRoot(), row.sourceId, row.revision, row.sourceKind, row.sourceRef, row.scope);
        logged += 1;
      }
      if (conflicts.length) throw new Error(`来源身份冲突: ${conflicts.slice(0, 5).join(", ")}`);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); logErr(`normalized 事务回滚: ${e.message}`); return { logged: 0, skipped, conflicts, error: e.message }; }
  } finally { try { db.close(); } catch {} }
  const projected = projectInternal();
  const projection = {
    ok: !projected.error,
    projected: projected.projected || 0,
    skipped: projected.skipped || 0,
    ...(projected.error ? { error: projected.error } : {}),
  };
  return { logged, skipped, conflicts, eventCommitted: true, projection, source: "normalized", at: new Date().toISOString() };
}

function manualInternal(tp, sid) {
  if (!tp || !existsSync(tp)) return { logged: 0, empty: true, error: "no transcript" };
  let lines;
  try { lines = readFileSync(tp, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n").filter(Boolean); } catch (e) { return { logged: 0, error: e.message }; }
  const items = [];
  const transcriptKey = createHash("sha256").update(resolve(tp)).digest("hex").slice(0, 12);
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const ln = lines[lineNo];
    let rec; try { rec = JSON.parse(ln); } catch { continue; }
    const msg = rec.message || {};
    const explicitId = msg.id || rec.id;
    const fallbackId = `${rec.type || "record"}:${lineNo}:${createHash("sha256").update(ln).digest("hex").slice(0, 12)}`;
    const sourceId = `${transcriptKey}:${String(explicitId || fallbackId)}`;
    if (rec.type === "user") {
      const t = extractText(msg);
      if (t !== "") items.push({ sourceId, role: "user", content: t, tool_name: null });
    } else if (rec.type === "assistant") {
      const t = extractText(msg);
      // 摄取过滤：assistant 仅 [摘要]（旧约定）与 🛠️ 成果行（2026-08-12 新约定，与投影规则同步）
      if (t && (t.includes("[摘要]") || t.trim().startsWith("🛠️"))) items.push({ sourceId, role: "assistant", content: t, tool_name: null });
    } else if (rec.type === "tool" || (msg && msg.tool_use_id)) {
      if (WRITE_TOOLS.test(msg.name || "")) items.push({ sourceId, role: "tool", content: null, tool_name: msg.name });
    }
  }
  if (!items.length) return { logged: 0, empty: true };
  const db = openDb();
  let skipped = 0;   // 内容级幂等计数（2026-08-12 T3 修复；声明在 try 外，return 需使用）
  try {
    const identityHealth = sourceIdentityHealth(db);
    if (!identityHealth.ok) return { logged: 0, skipped: 0, error: "来源身份完整性失败: " + JSON.stringify(identityHealth) };
    const now = new Date().toISOString();
    const ins = db.prepare("INSERT OR IGNORE INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive, src_host, source_root, source_machine, source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    // 幂等键是来源消息 id，不再用正文去重；同文重复发言仍是两条真实事件。
    const SRC_HOST = process.env.CP_HOST || null;   // MCP 宿主标识(2026-08-29):宿主 MCP 配置 env.CP_HOST 自动继承
    const SOURCE_ROOT = localSourceRoot();
    const dup = db.prepare("SELECT COUNT(*) c FROM events WHERE instance='manual' AND ((source_id IS NOT NULL AND source_id=?) OR (source_id IS NULL AND session=? AND role=? AND content=?))");
    db.exec("BEGIN IMMEDIATE");   // IMMEDIATE：写锁提前获取，受 busy_timeout 管（DEFERRED 升级锁 BUSY 不等待）
    try {
      // 取号必须在锁内（2026-08-29 并发压测实证：锁外读号 → 6 进程同分 1-15 → 撞 UNIQUE 被 OR IGNORE 静默吞 15 条）
      let seq = Number(metaGet(db, "manual_seq") || 0);
      for (const e of items) {
        const d = dup.get(e.sourceId, sid, e.role, e.content || "").c;
        if (d > 0) { skipped += 1; continue; }
        seq += 1;
        const info = ins.run("manual", seq, sid, e.role, e.content, e.tool_name, null, now, SENSITIVE.test(e.content || "") ? 1 : 0, SRC_HOST, sid, SOURCE_ROOT, e.sourceId);
        if (Number(info.changes) !== 1) { skipped += 1; seq -= 1; }   // 兜底：撞号如实计 skipped，不假报成功
      }
      metaSet(db, "manual_seq", seq);
      db.exec("COMMIT");
    } catch (e2) { db.exec("ROLLBACK"); logErr(`manual 事务回滚: ${e2.message}`); return { logged: 0, error: e2.message }; }
  } finally { try { db.close(); } catch {} }
  const pr = projectInternal();
  return {
    logged: items.length - skipped,
    skipped,
    eventCommitted: true,
    projection: { ok: !pr.error, projected: pr.projected || 0, skipped: pr.skipped || 0, ...(pr.error ? { error: pr.error } : {}) },
    empty: false,
  };
}

// coverage：吸收台账（ADR-001 层1，2026-08-12 实装）
// 输入 sources.json 注册表 + events.db（只读）；逐源输出 fileLines/absorbed/gap/lastTs/lastScan
// jsonl 型：源目录 *.jsonl 行数 vs 该 instance 前缀事件数对齐；session 型：无 transcript 宿主，靠 session 计数
// 幂等：零写入，可随时跑；gap>0 的源输出到 gaps 清单（尾部半行/进行中会话允许 gap≤1）
function coverageInternal() {
  const sf = join(ROOT, "sources.json");
  if (!existsSync(sf)) return { error: "sources.json 不存在（请先建注册表）", sources: [], gaps: [] };
  let reg;
  try { reg = JSON.parse(readFileSync(sf, "utf8").replace(/^\uFEFF/, "")); }
  catch (e) { return { error: `sources.json 解析失败: ${e.message}`, sources: [], gaps: [] }; }
  if (!existsSync(EVENTS_DB)) return { error: "events.db 不存在（尚未摄取）", sources: [], gaps: [] };
  const db = openDb();
  const report = []; const gaps = []; const orphans = [];
  let independence = null;   // S2-1 结果（在主 try 内计算，需提前声明避开 TDZ）
  try {
    for (const s of (Array.isArray(reg.sources) ? reg.sources : [])) {
      if (s.enabled === false) { report.push({ name: s.name, enabled: false, note: s.note || "" }); continue; }
      if (s.kind === "jsonl") {
        if (!s.dir || !existsSync(s.dir)) {
          const row = { name: s.name, kind: "jsonl", error: "源目录不存在", gap: null };
          report.push(row);
          // 2026-11-18：已启用源的目录消失必须 critical——否则 verify 的 absorption.gaps 虽有一条
          //   但 F18 只消费 critical，结果「整源停了」也报绿（假绿实证：把 dir 指向不存在路径，verify 仍全绿）
          gaps.push({ name: s.name, gap: null, critical: true, reason: `🔴 已启用源目录不存在：${s.dir}——该源从此不再吸收（换机后 dir 未改写 / 目录被删改名）` });
          continue;
        }
        let files = []; try { files = readdirSync(s.dir).filter(f => f.endsWith(".jsonl") && !isRecovered(join(s.dir, f))); } catch { }
        // 精确口径（2026-08-12 校准）：fileLines=总行数；absorbable=按适配器契约可吸行
        // （user/assistant 且有非空 text 块；thinking/tool_use/tool_result/空行不计）
        // gap = absorbable - absorbed 才是真缺口（游标未跑完/整文件未摄取会暴露）
        // P0-5 升级（2026-08-28）：注册条目声明 midCheck 时做逐 (instance,mid) 双向集合核对——
        //   missing=源有库无（漏吸）/ extra=库有源无（多吸·源文件变更遗留）/ drifted=同键 role·content 不一致（保真核验）。
        //   行号与内容口径必须与各 adapter 的 scanFile 逐字一致（proma: 非空行序号 1 基 + extractText 原样 + 前缀+文件名前 take 位）。
        const midCheck = s.midCheck && s.instancePrefix ? { take: s.midCheck.take || 8 } : null;
        const srcRows = midCheck ? new Map() : null;
        let fileLines = 0, absorbable = 0, lastScan = null, lastScanMs = -1;
        for (const f of files) {
          const p = join(s.dir, f);
          let st; try { st = statSync(p); } catch { continue; }
          if (st.mtimeMs > lastScanMs) { lastScanMs = st.mtimeMs; lastScan = { file: f, mtime: st.mtime }; }
          let lines = []; try { lines = readFileSync(p, "utf8").replace(/^\uFEFF/, "").split("\n"); } catch { continue; }
          fileLines += lines.filter(Boolean).length;
          const inst = midCheck ? s.instancePrefix + basename(f).replace(/\.jsonl$/i, "").slice(0, midCheck.take) : null;
          let lineNo = 0;
          for (const ln of lines) {
            if (!ln.trim()) continue;
            lineNo += 1;
            let rec; try { rec = JSON.parse(ln); } catch { continue; }
            const msg = rec.message || {};
            const t = extractText(msg);
            if ((rec.type === "user" || rec.type === "assistant") && t !== "") {
              absorbable += 1;
              // P1-5(2026-08-29):mid 口径=内容 hash,与 proma-adapter hashMid 规格逐字一致
              //   (sha256(role+"\n"+content) hex 前 12 位转整数);行号口径已弃(流式重写打破)。
              srcRows.set(`${inst}\0${hashMid(rec.type, t)}`, { role: rec.type, content: t, file: f, lineNo });
            }
          }
        }
        const prefix = (s.instancePrefix || s.name + "-") + "%";
        const absorbed = db.prepare("SELECT COUNT(*) c FROM events WHERE instance LIKE ?").get(prefix).c;
        const lastTs = db.prepare("SELECT MAX(ts) t FROM events WHERE instance LIKE ?").get(prefix).t;
        const gap = Math.max(0, absorbable - absorbed);
        const overAbsorbed = Math.max(0, absorbed - absorbable);
        // extra 二次分类（2026-08-28 实测定性）：库 instance 在源目录无对应文件 = 孤儿实例遗留
        // （源侧删文件、库按保真铁律保留历史，合法，单列展示不告警）；现存文件内的 extra 才是真多吸。
        let missing = [], extra = [], drifted = [], orphanEvents = 0;
        const orphanInstances = new Set();
        if (midCheck) {
          const dbRows = db.prepare("SELECT instance, mid, role, content FROM events WHERE instance LIKE ?").all(prefix);
          const dbKeys = new Set();
          const srcInstances = new Set([...srcRows.keys()].map(k => k.split("\0")[0]));
          for (const r of dbRows) {
            const key = `${r.instance}\0${r.mid}`;
            dbKeys.add(key);
            const src = srcRows.get(key);
            if (!src) {
              if (srcInstances.size && !srcInstances.has(r.instance)) { orphanEvents += 1; orphanInstances.add(r.instance); }
              else extra.push(key);
              continue;
            }
            if (src.role !== r.role || src.content !== r.content) drifted.push(key);
          }
          for (const [key, src] of srcRows) if (!dbKeys.has(key)) missing.push(key);
        }
        const row = { name: s.name, kind: "jsonl", dir: s.dir, files: files.length, fileLines, absorbable, absorbed, gap, overAbsorbed, lastTs, lastScan: lastScan ? lastScan.file : null, lastScanAt: lastScan ? lastScan.mtime : null };
        if (midCheck) {
          const sample = (list) => list.slice(0, 5).map(key => { const src = srcRows.get(key); return src ? `${src.file}:${src.lineNo}` : key; });
          row.midCheck = {
            missing: missing.length, extra: extra.length, drifted: drifted.length,
            ...(orphanEvents ? { orphanEvents, orphanInstances: [...orphanInstances].map(i => `${i}(${db.prepare("SELECT COUNT(*) c FROM events WHERE instance=?").get(i).c})`) } : {}),
            ...(missing.length ? { missingSample: sample(missing) } : {}),
            ...(extra.length ? { extraSample: sample(extra) } : {}),
            ...(drifted.length ? { driftedSample: sample(drifted) } : {}),
          };
        }
        report.push(row);
        if (gap > 0) gaps.push({ name: s.name, gap, absorbable, absorbed, reason: gap <= 1 ? "尾部半行/进行中会话（允许）" : "存在未吸收事件" });
        else if (extra.length || missing.length || drifted.length) gaps.push({ name: s.name, gap: 0, missing: missing.length, extra: extra.length, drifted: drifted.length, reason: "逐 mid 双向核对不一致（现存文件漏吸/多吸/内容漂移，明细见该源 midCheck）" });
      } else if (s.kind === "session") {
        // 双向对账（2026-08-13）：有 instancePrefix 的 session 型按自己前缀计数，
        // 无前缀的（codebuddy 等共享 manual 池）退化为 session-% 池计数（信息性展示）
        let count = 0, sessions = 0, lastTs = null;
        if (s.instancePrefix) {
          const prefix = s.instancePrefix + "%";
          count = db.prepare("SELECT COUNT(*) c FROM events WHERE instance LIKE ?").get(prefix).c;
          sessions = db.prepare("SELECT COUNT(DISTINCT session) c FROM events WHERE instance LIKE ?").get(prefix).c;
          lastTs = db.prepare("SELECT MAX(ts) t FROM events WHERE instance LIKE ?").get(prefix).t;
        } else {
          sessions = db.prepare("SELECT COUNT(DISTINCT session) c FROM events WHERE session LIKE 'session-%'").get().c;
        }
        report.push({ name: s.name, kind: "session", count, sessions, lastTs, note: s.note || "" });
      } else {
        report.push({ name: s.name, kind: s.kind, error: "未知 kind" });
      }
    }
    // 双向对账·反向（2026-08-13）：events.db 全部 instance vs 注册表前缀 → 未登记孤儿显式暴露
    const registered = [];
    for (const s of (Array.isArray(reg.sources) ? reg.sources : [])) {
      if (s.instancePrefix) registered.push({ name: s.name, prefix: s.instancePrefix });
    }
    const instances = db.prepare("SELECT instance, COUNT(*) c FROM events GROUP BY instance").all();
    for (const row of instances) {
      const hit = registered.find(r => row.instance === r.prefix || row.instance.startsWith(r.prefix));
      if (!hit) orphans.push({ instance: row.instance, count: row.c });
    }
    // 来源根独立性（S2-1）：同一 source_root 被多 instance 重复导入 → 不算独立证据
    // （必须在 db.close() 之前算，否则会掉进 finally）
    try {
      const dup = db.prepare("SELECT COUNT(*) c FROM (SELECT mid FROM events GROUP BY mid HAVING COUNT(DISTINCT instance) > 1 AND COUNT(DISTINCT source_root) = 1)").get().c;
      const total = db.prepare("SELECT COUNT(DISTINCT mid) c FROM events").get().c;
      independence = { duplicatedSameRootMids: dup, totalMids: total, judge: dup > 0 ? "存在同源重复（相同内容多宿主导入），引用时不得当作独立证据" : "无同源重复" };
    } catch (e) { independence = { error: String(e.message || e) }; }
  } finally { try { db.close(); } catch {} }
  const jsonl = report.filter(r => r.kind === "jsonl" && !r.error);
  // F18 源文件消失检测（2026-08-29 Proma 事故驱动：升级清空 agent-sessions 16 文件、887 可吸行蒸发，验收 AI 报"对齐"零报警）。
  //   absorbable 环比暴跌 >50% → 🔴 严重警告进 gaps；历史快照落 coverage-history.json（工具自留状态，非真源）。
  try {
    const histFile = join(ROOT, "coverage-history.json");
    let hist = {};
    try { hist = JSON.parse(readFileSync(histFile, "utf8")); } catch {}
    const nowTs = new Date().toISOString();
    for (const r of jsonl) {
      const prev = hist[r.name];
      if (prev && prev.absorbable > 20 && r.absorbable < prev.absorbable * 0.5) {
        const dropPct = Math.round((1 - r.absorbable / prev.absorbable) * 100);
        r.absorbableDrop = { from: prev.absorbable, to: r.absorbable, prevAt: prev.at };
        gaps.unshift({ name: r.name, gap: 0, critical: true, reason: `🔴 严重警告：源可吸行 ${prev.absorbable}→${r.absorbable}（-${dropPct}%），源文件大量消失——立即确认是预期清理还是数据事故！上次记录 ${prev.at}。真源副本在 events.db 与 delivery 抢救包，先核对再动作` });
      }
      hist[r.name] = { absorbable: r.absorbable, at: nowTs };
    }
    writeFileSync(histFile, JSON.stringify(hist, null, 2), "utf8");
  } catch (e) { logErr(`F18 检测失败（fail-open）: ${e.message}`); }
  // aligned 判定（P0-5 升级）：gap=0 且逐 mid 核对 missing/extra/drifted 全零才算对齐；
  // orphanEvents（源文件已删的历史遗留）为合法状态，显式展示但不参与对齐判定。
  const aligned = jsonl.filter(r => r.gap === 0 && (!r.midCheck || (r.midCheck.missing + r.midCheck.extra + r.midCheck.drifted) === 0)).length;
  // 来源根独立性结果（S2-1）在主 try 内计算完成（见上方 finally 前）
  return { sources: report, gaps, orphans, aligned, checked: jsonl.length, independence, sessionSources: report.filter(r => r.kind === "session").length, at: new Date().toISOString() };
}

// 票 19：来源根 = 机器名 + 引擎根路径的短哈希；同一段对话换宿主重导时仍属同一个 root。
function localSourceRoot() {
  if (process.env.CP_SOURCE_ROOT) return String(process.env.CP_SOURCE_ROOT);
  try {
    const root = process.env.CP_ROOT || join(homedir(), ".cosmic-phantom");
    const h = createHash("sha256").update(String(root).toLowerCase()).digest("hex").slice(0, 8);
    return (process.env.COMPUTERNAME || process.env.HOSTNAME || "host") + ":" + h;
  } catch { return null; }
}

// 票 19：同一会话里，来自几个不同来源根（>1 才算“多源佐证”）
function independenceInternal(session) {
  const db = openDb();
  try {
    const sql = session
      ? "SELECT source_machine r, COUNT(*) c FROM events WHERE session=? GROUP BY source_machine ORDER BY c DESC"
      : "SELECT source_machine r, COUNT(*) c FROM events GROUP BY source_machine ORDER BY c DESC";
    const rows = session ? db.prepare(sql).all(session) : db.prepare(sql).all();
    const isMachine = (v) => typeof v === "string" && v.includes(":");
    const real = rows.filter((x) => x.r && isMachine(x.r));
    const legacy = rows.filter((x) => x.r && !isMachine(x.r)).reduce((a, x) => a + x.c, 0);
    return { session: session || "(all)", roots: rows.map((x) => ({ root: x.r || "<null>", n: x.c })), distinct: real.length, legacyCount: legacy, independent: real.length > 1 };
  } finally { try { db.close(); } catch {} }
}

// 票 10：冷热分层只做体检与导出，不删真源（只增不改）。
function tiersInternal() {
  const db = openDb();
  try {
    const now = Date.now();
    const rows = db.prepare("SELECT e.ts FROM events e WHERE e.instance NOT IN ('purge-audit','redact') AND NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge')").all();
    let hot = 0, warm = 0, cold = 0;
    for (const r of rows) {
      const age = (now - Date.parse(r.ts)) / 86400000;
      if (!Number.isFinite(age)) continue;
      if (age <= 90) hot += 1; else if (age <= 365) warm += 1; else cold += 1;
    }
    return { hot90: hot, warm365: warm, cold: cold, total: rows.length, note: "分层只做统计与导出，不删行" };
  } finally { try { db.close(); } catch {} }
}

function statusInternal() {
  if (!existsSync(EVENTS_DB)) return { error: "events.db 不存在（尚未摄取）" };
  const db = openDb();
  try {
    const inst = metaGet(db, "instance_id");
    return {
      db: EVENTS_DB,
      instance: inst ? (metaGet(db, "instance_short") || inst.slice(0, 8)) : null,
      cursor: Number(metaGet(db, "cursor") || 0),
      sourceSignature: metaGet(db, "source_signature") || null,
      events: db.prepare("SELECT COUNT(*) c FROM events").get().c,
      active: db.prepare("SELECT COUNT(*) c FROM events e WHERE e.instance NOT IN ('purge-audit','redact') AND NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge')").get().c,
      purged: db.prepare("SELECT COUNT(*) c FROM event_tombstones WHERE action='purge'").get().c,
      // 2026-11-19：purge 审计行（instance=purge-audit）按设计不投影 —— 它是留痕不是记忆。
      //   原判据「events=projected」把这类行算成缺口，导致 wrap-up 永久卡在第二步。
      audit: db.prepare("SELECT COUNT(*) c FROM events WHERE instance = 'purge-audit'").get().c,
      projected: db.prepare("SELECT COUNT(*) c FROM projection p JOIN events e ON e.id=p.event_id WHERE e.instance NOT IN ('purge-audit','redact') AND NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge')").get().c,
      sensitive: db.prepare("SELECT COUNT(*) c FROM events WHERE sensitive=1").get().c,
      sourceIdentity: sourceIdentityHealth(db),
      sourceRoots: (() => {
        try {
          const rows = db.prepare("SELECT source_machine r, COUNT(*) c FROM events GROUP BY source_machine ORDER BY c DESC").all();
          const nullCount = (rows.find((x) => x.r === null) || {}).c || 0;
          const isMachine = (v) => typeof v === "string" && v.includes(":");
          const real = rows.filter((x) => isMachine(x.r));
          const legacy = rows.filter((x) => x.r && !isMachine(x.r)).reduce((a, x) => a + x.c, 0);
          return { distinct: real.length, nullCount, legacyCount: legacy, top: real.slice(0, 3) };
        } catch { return null; }
      })(),
      manualSeq: Number(metaGet(db, "manual_seq") || 0),
    };
  } finally { try { db.close(); } catch {} }
}

// 票 10：内容脱敏走墓碑（append），原行不动 —— 哈希链保留，原文在导出层不可读。
// mid 只在 instance 内唯一；未指定 instance 且存在同 mid 多实例时必须拒绝猜测。
function redactInternal(mid, reason, targetInstance) {
  if (!mid) return { ok: false, error: "用法: redact --instance <instance> --mid <mid> --reason <原因>" };
  const why = String(reason || "").trim();
  if (why.length < 4) return { ok: false, refused: true, error: "redact 必须带 --reason（至少 4 字）" };
  const db = openDb();
  try {
    const rows = targetInstance
      ? db.prepare("SELECT instance, mid, content FROM events WHERE instance=? AND mid=?").all(targetInstance, mid)
      : db.prepare("SELECT instance, mid, content FROM events WHERE mid=? AND instance NOT IN ('redact','purge-audit')").all(mid);
    if (!rows.length) return { ok: false, error: "找不到事件 " + (targetInstance ? `${targetInstance}:${mid}` : `mid=${mid}`) };
    if (rows.length > 1) return { ok: false, refused: true, error: "mid 在多个 instance 中重复，请补 --instance", candidates: rows.map(r => ({ instance: r.instance, mid: r.mid })) };
    const row = rows[0];
    const h = createHash("sha256").update(String(row.content || "")).digest("hex").slice(0, 16);
    const targetKey = `${row.instance}:${row.mid}`;
    const ts = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR IGNORE INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive, src_host, source_root, source_machine, source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("redact", "redact:" + targetKey, "audit", "event", `[REDACTED] target=${targetKey} sha256:${h} reason=${why}`, "redact", null, ts, 1, null, "audit", localSourceRoot(), targetKey);
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
    return { ok: true, instance: row.instance, mid: row.mid, hash: h, why };
  } finally { try { db.close(); } catch {} }
}

// 票 10「推送后禁止整理」：数据仓一旦推到远端，改写真源会让别的机器对不上账。
//   判据：cp-memory 有 upstream 且本地没有领先提交 = 已推送 → purge 必须显式 --allow-after-push。
function dataRepoPushed() {
  const dir = process.env.CP_DATA_DIR || join(homedir(), "cp-memory");
  try {
    if (!existsSync(join(dir, ".git"))) return { pushed: false, reason: "数据仓不在本机" };
    execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { stdio: "ignore", timeout: 15000 });
    const ahead = Number(execFileSync("git", ["-C", dir, "rev-list", "--count", "@{u}..HEAD"], { encoding: "utf8", timeout: 15000 }).trim());
    return { pushed: Number.isFinite(ahead) && ahead === 0, ahead, dir };
  } catch { return { pushed: false, reason: "无 upstream 或 git 不可用" }; }
}

function purgeInternal(before, sensitiveOnly, opts = {}) {
  if (!existsSync(EVENTS_DB)) return { purged: 0, error: "events.db 不存在" };
  const db = openDb();
  try {
    // 2026-11-19（票 10）：purge 前必须先落审计行；无理由或未确认直接拒绝。
    const reason = String(opts.reason || "").trim();
    if (!opts.confirm || reason.length < 4) {
      return { purged: 0, refused: true, error: "purge 必须带 --confirm --reason <原因>（先写审计行再追加逻辑墓碑）" };
    }
    const repo = dataRepoPushed();
    if (repo.pushed && !opts.allowAfterPush) {
      return { purged: 0, refused: true, error: "数据仓已推送到远端（ahead=0），禁止整理；确需整理请加 --allow-after-push，并同步通知其它机器", repo };
    }
    const params = [];
    const where = ["instance NOT IN ('purge-audit','redact')", "NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=events.instance AND t.mid=CAST(events.mid AS TEXT) AND t.action='purge')"];
    if (before) { where.push("ts < ?"); params.push(`${before}T00:00:00.000Z`); }
    if (sensitiveOnly) where.push("sensitive=1");
    db.exec("BEGIN IMMEDIATE");
    try {
      // 目标集合在写锁内取样，保证审计摘要与实际删除使用同一快照。
      const targets = db.prepare(`SELECT instance, mid, content FROM events WHERE ${where.join(" AND ")} ORDER BY id`).all(...params);
      const targetSummary = targets.map(r => ({ instance: r.instance, mid: String(r.mid), contentSha256: createHash("sha256").update(String(r.content || "")).digest("hex").slice(0, 16) }));
      const targetDigest = createHash("sha256").update(JSON.stringify(targetSummary)).digest("hex").slice(0, 16);
      const auditMid = "purge:" + Date.now() + ":" + targetDigest;
      const targetManifest = JSON.stringify(targetSummary);
      db.prepare("INSERT OR IGNORE INTO events(instance, mid, session, role, content, tool_name, tool_calls, ts, sensitive, src_host, source_root, source_machine, source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("purge-audit", auditMid, "audit", "event", `[purge-audit] before=${before || "-"} sensitiveOnly=${!!sensitiveOnly} count=${targets.length} targetsSha256=${targetDigest} targets=${targetManifest} reason=${reason}`, "purge", null, new Date().toISOString(), 0, null, "audit", localSourceRoot(), auditMid);
      const tombstone = db.prepare("INSERT OR IGNORE INTO event_tombstones(instance, mid, action, content_sha256, reason, audit_mid, created_at) VALUES(?,?,?,?,?,?,?)");
      const createdAt = new Date().toISOString();
      for (const target of targets) {
        tombstone.run(String(target.instance), String(target.mid), "purge", createHash("sha256").update(String(target.content || "")).digest("hex").slice(0, 16), reason, auditMid, createdAt);
      }
      // projection 是可重建派生层；撤掉目标的投影标记，防止未来误认为它仍可用，但不删 events 原行。
      db.prepare("DELETE FROM projection WHERE event_id IN (SELECT e.id FROM events e JOIN event_tombstones t ON t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge')").run();
      db.exec("COMMIT");
      logErr(`purge 执行：before=${before || "-"} sensitiveOnly=${sensitiveOnly || false} 追加 ${targets.length} 条逻辑墓碑（用户显式删除/撤回通道）`);
      return { purged: targets.length, targetDigest, audited: true, appendOnly: true };
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  } finally { try { db.close(); } catch {} }
}

// E-4（2026-10-28）：导出脱敏。本地库仍保留原文；只对导出文件打码。
//   默认脱敏 sensitive=1 的 content；--include-sensitive 显式才带原文。
const REDACT_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-****"],
  [/\bghp_[A-Za-z0-9]{20,}/g, "ghp_****"],
  [/\bAKIA[0-9A-Z]{12,}/g, "AKIA****"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE KEY REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "****"],
  [/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, "$1****"],
  [/((?:api[_-]?key|secret|password|passwd|token|cookie|authorization)\s*[:=]\s*)([^\s"',;]{4,})/gi, "$1****"],
];
function redactText(text) {
  let s = String(text ?? "");
  for (const [re, rep] of REDACT_PATTERNS) s = s.replace(re, rep);
  return s;
}
function safeExportText(text) {
  const original = String(text ?? "");
  if (!original) return original;
  const redacted = redactText(original);
  return redacted === original ? "[SENSITIVE REDACTED]" : redacted;
}

function exportInternal(outDir, includeSensitive = false) {
  if (!existsSync(EVENTS_DB)) return { error: "events.db 不存在" };
  const db = openDb();
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}   // 主库合并 wal，防未来直接拷文件缺提交
  try {
    mkdirSync(outDir, { recursive: true });
    const f = join(outDir, `events-${Date.now()}.jsonl`);
    const rows = db.prepare("SELECT e.id, e.instance, e.mid, e.session, e.role, e.content, e.tool_name, e.tool_calls, e.ts, e.sensitive, e.source_root, e.source_machine, e.source_id, e.source_revision, e.source_kind, e.source_ref, e.scope FROM events e WHERE NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge' ) ORDER BY e.id").all();
    // 票 10：墓碑按 instance:mid 定位；单独 mid 不全局唯一。
    const tombstones = new Map();
    for (const r of rows) {
      if (r.instance !== "redact") continue;
      const text = String(r.content || "");
      const target = text.match(/target=([^\s]+)/)?.[1];
      const m = /sha256:([0-9a-f]+)/.exec(text);
      if (target) tombstones.set(target, m ? m[1] : "unknown");
      else {
        const legacyMid = String(r.mid || "").replace(/^redact:/, "");
        if (legacyMid) tombstones.set(`legacy-mid:${legacyMid}`, m ? m[1] : "unknown");
      }
    }
    let redacted = 0, buried = 0;
    const outRows = rows.map(r => {
      const targetKey = `${r.instance}:${r.mid}`;
      const tombstone = tombstones.get(targetKey) || tombstones.get(`legacy-mid:${r.mid}`);
      if (!includeSensitive && tombstone) {
        buried += 1;
        return { ...r, content: "[REDACTED] sha256:" + tombstone };
      }
      if (r.sensitive && !includeSensitive) {
        redacted += 1;
        return {
          ...r,
          content: safeExportText(r.content),
          tool_calls: r.tool_calls == null ? null : safeExportText(r.tool_calls),
          tool_name: r.tool_name == null ? null : safeExportText(r.tool_name),
          source_ref: r.source_ref == null ? null : safeExportText(r.source_ref),
        };
      }
      return r;
    });
    writeFileSync(f, outRows.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const inst = metaGet(db, "instance_id");
    return { exported: outRows.length, file: f, redacted, buried, includeSensitive, instance: inst ? (metaGet(db, "instance_short") || inst.slice(0, 8)) : null, cursor: Number(metaGet(db, "cursor") || 0) };
  } finally { try { db.close(); } catch {} }
}

// ---------- E-1（2026-10-28）：证据目录 sidecar ----------
// 给 events 贴“文件路径/错误码/是否决策/CONTEXT 术语”四类标签，写 event-index.json；
// find 先查目录→返回 event_id，再用 expand 看原文。零 LLM、零依赖；目录是派生，可重建。
function loadContextTerms() {
  try {
    const ctx = readFileSync(join(ROOT, ".context", "CONTEXT.md"), "utf8");
    const terms = [];
    for (const line of ctx.split(/\r?\n/)) {
      const m = line.match(/^-\s*术语[：:]\s*(.+?)\s*$/);
      if (m && Array.from(m[1]).length >= 2) terms.push(m[1].trim());
    }
    return [...new Set(terms)];
  } catch { return []; }
}
function extractIndex(content, terms) {
  const text = String(content || "");
  const paths = [];
  for (const m of text.matchAll(/(?:[A-Za-z]:\\[^\s"'<>|，。；]+|\/(?:Users|home|tmp|var|opt|mnt)\/[^\s"'<>|，。；]+)/g)) {
    const p = m[0].replace(/[),.;]+$/, "");
    if (p.length >= 8 && p.length <= 200) paths.push(p);
  }
  const errors = [];
  for (const m of text.matchAll(/\b(?:E[A-Z0-9]{3,}|0x[0-9A-Fa-f]{6,}|HTTP\s*[45]\d{2})\b/g)) errors.push(m[0]);
  const hits = [];
  for (const t of terms) if (text.includes(t)) hits.push(t);
  return {
    paths: [...new Set(paths)].slice(0, 5),
    errors: [...new Set(errors)].slice(0, 5),
    decisions: DECISION.test(text),
    terms: [...new Set(hits)].slice(0, 5),
  };
}
function buildEventIndex() {
  const db = openDb();
  try {
    const terms = loadContextTerms();
    const rows = db.prepare("SELECT e.id, e.instance, e.mid, e.session, e.role, e.content, e.ts FROM events e WHERE e.sensitive = 0 AND NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge') ORDER BY e.id").all();
    const entries = [];
    for (const r of rows) {
      if (!r.content) continue;
      const x = extractIndex(r.content, terms);
      if (!x.paths.length && !x.errors.length && !x.decisions && !x.terms.length) continue;
      entries.push({ id: r.id, mid: r.mid, ts: r.ts, role: r.role, session: r.session, ...x });
    }
    // D-21（2026-10-28）：事件级因果边——决策事件 → 后续同会话的变更/结果事件（每条决策最多 3 条，总上限 500）。
    const causal = [];
    for (const e of entries) {
      if (!e.decisions) continue;
      const later = entries.filter(x => x.id !== e.id && x.session === e.session && x.ts >= e.ts && (x.paths.length || x.errors.length))
        .sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts < b.ts ? -1 : 1)).slice(0, 3);
      for (const t of later) causal.push({ from: e.id, to: t.id, kind: "decision->change" });
      if (causal.length >= 500) break;
    }
    const file = join(ROOT, "event-index.json");
    writeFileSync(file, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), total: rows.length, indexed: entries.length, edges: { causal, truncated: causal.length >= 500 }, entries }, null, 2) + "\n", "utf8");
    return { ok: true, file, total: rows.length, indexed: entries.length, causal: causal.length, causalTruncated: causal.length >= 500, terms: terms.length };
  } finally { try { db.close(); } catch {} }
}
function findEvents(opts) {
  const file = join(ROOT, "event-index.json");
  if (!existsSync(file)) return { error: "event-index.json 不存在，先跑 events.js index" };
  const idx = JSON.parse(readFileSync(file, "utf8"));
  let hidden = new Set();
  try {
    const db = openDb();
    hidden = new Set(db.prepare("SELECT id FROM events WHERE sensitive=1").all().map((row) => Number(row.id)));
    db.close();
  } catch (error) {
    return { error: `无法核验敏感事件标记，拒绝读取 event-index: ${error.message}` };
  }
  const entries = (idx.entries || []).filter((entry) => !hidden.has(Number(entry.id)));
  const { term, path: pathArg, error: errorArg, decision, related } = opts;
  if (related) {
    const id = Number(related);
    const base = entries.find(e => e.id === id);
    if (!base) return { error: `事件 ${id} 不在证据目录（可能无标签或属于敏感事件）` };
    const causalEdges = (idx.edges?.causal || []).filter(e => e.from === id || e.to === id).filter(e => !hidden.has(Number(e.from)) && !hidden.has(Number(e.to)));
    const ids = new Set(causalEdges.flatMap(e => [e.from, e.to]));
    const relatedEntries = entries.filter(e => e.id !== id && (ids.has(e.id) || (base.terms || []).some(t => (e.terms || []).includes(t)) || (base.paths || []).some(p => (e.paths || []).includes(p)))).slice(0, 10).map(e => ({ id: e.id, ts: e.ts, role: e.role, session: e.session, terms: e.terms, paths: e.paths, errors: e.errors, decisions: e.decisions }));
    return { id, causal: causalEdges, related: relatedEntries, hint: relatedEntries.length ? "events.js expand --evt <id> 看原文" : null };
  }
  const hits = entries.filter(e =>
    (term && (e.terms || []).some(t => t.includes(term))) ||
    (pathArg && (e.paths || []).some(p => p.includes(pathArg))) ||
    (errorArg && (e.errors || []).some(x => x.includes(errorArg))) ||
    (decision && e.decisions)
  ).slice(0, 20).map(e => ({ id: e.id, ts: e.ts, role: e.role, session: e.session, terms: e.terms, paths: e.paths, errors: e.errors, decisions: e.decisions }));
  return { count: hits.length, hits, hint: hits.length ? "events.js expand --evt <id> 看原文" : null };
}

// ---------- expand：渐进展开（只读，2026-08-31 实装）----------
// 渐进展开机制 L2/L3 落地（pro/progressive-expansion-mechanism-20260831.md §4）：
//   命中点（daily 行 cp-evt 锚点 / 会话 / 日期）→ 会话级完整上下文 → 逐字事件流。
// 三入口：--evt <cp-evt-v2锚点|legacy instance:mid> | --session <全名或唯一后缀> | --date <YYYY-MM-DD>。
// 逐字纪律：content 原样输出不 trim 不解析；只读，不碰 projection 表；预算超限停在事件边界并显式标注。
function sessionTitle(sid) {
  return String(sid).replace(/^session-/, "").split("-").slice(-2).join("-") || String(sid);
}

function expandPreview(text, max = 120) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (Buffer.byteLength(s) <= max) return s;
  let cut = 0;
  for (const ch of s) { if (Buffer.byteLength(s.slice(0, cut + 1)) > max) break; cut += 1; }
  return s.slice(0, cut) + "…";
}

function expandSessionRows(db, session, anchorEventId, budget, withToolCalls, context = 0, anchorFirst = false) {
  const allRows = db.prepare("SELECT e.id, e.instance, e.mid, e.session, e.role, e.content, e.tool_name, e.tool_calls, e.ts, e.sensitive, e.source_id, e.source_revision, e.source_kind, e.source_ref, e.scope FROM events e WHERE e.session = ? AND NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge') ORDER BY e.id").all(session);
  const anchorIndex = anchorEventId == null ? -1 : allRows.findIndex((row) => row.id === anchorEventId);
  const contextRows = anchorIndex >= 0 && context > 0
    ? allRows.slice(Math.max(0, anchorIndex - context), Math.min(allRows.length, anchorIndex + context + 1)).map((row, index) => ({ ...row, __seq: Math.max(0, anchorIndex - context) + index + 1 }))
    : allRows.map((row, index) => ({ ...row, __seq: index + 1 }));
  const rows = anchorFirst && anchorEventId != null
    ? [...contextRows.filter((row) => row.id === anchorEventId), ...contextRows.filter((row) => row.id !== anchorEventId)]
    : contextRows;
  const redactedTargets = new Set();
  for (const row of db.prepare("SELECT mid, content FROM events WHERE instance='redact'").all()) {
    const content = String(row.content || "");
    const target = content.match(/target=([^\s]+)/)?.[1];
    if (target) redactedTargets.add(target);
    else {
      const legacyMid = String(row.mid || "").replace(/^redact:/, "");
      if (legacyMid) redactedTargets.add(`legacy-mid:${legacyMid}`);
    }
  }
  const list = [];
  let bytes = 0, truncated = false, anchorSeq = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const targetKey = `${r.instance}:${r.mid}`;
    const isRedacted = redactedTargets.has(targetKey) || redactedTargets.has(`legacy-mid:${r.mid}`);
    const isSensitive = Number(r.sensitive) === 1;
    const ev = { seq: r.__seq, ts: r.ts, role: r.role, content: r.content ?? "", scope: r.scope || "workspace", source_id: r.source_id || null, source_revision: r.source_revision || 1, source_kind: r.source_kind || null, source_ref: r.source_ref || null };
    if (isRedacted) ev.redacted = true;
    if (isSensitive) ev.sensitive = true;
    if (r.role === "tool" || r.tool_name) ev.tool_name = r.tool_name || undefined;
    if (r.tool_calls) ev.tool_calls_bytes = Buffer.byteLength(String(r.tool_calls));
    if (withToolCalls && r.tool_calls) { try { ev.tool_calls = JSON.parse(r.tool_calls); } catch { ev.tool_calls = r.tool_calls; } }
    if (anchorEventId != null && r.id === anchorEventId) { ev.anchor = true; anchorSeq = ev.seq; }
    const size = Buffer.byteLength(JSON.stringify(ev));
    if (bytes + size > budget && list.length) { truncated = true; if (!anchorFirst) break; continue; }
    bytes += size; list.push(ev);
  }
  const firstUser = allRows.find(r => r.role === "user");
  return {
    session, title: sessionTitle(session), channel: channelName(allRows[0]?.instance, session),
    startedAt: allRows[0]?.ts || null, events: allRows.length, users: allRows.filter(r => r.role === "user").length,
    firstUser: firstUser ? expandPreview(firstUser.content) : null,
    anchorSeq, shown: list.length, truncated, bytes, budget, stream: list,
  };
}

function expandInternal() {
  if (!existsSync(EVENTS_DB)) return { error: "events.db 不存在" };
  const budget = Math.max(2000, Number(get("--bytes")) || 20000);
  const withToolCalls = args.includes("--tool-calls");
  const evt = get("--evt"), sessionArg = get("--session"), dateArg = get("--date");
  if (!evt && !sessionArg && !dateArg) return { error: "用法: expand --evt <cp-evt-v2锚点|instance前8位:mid> | --session <全名或唯一后缀> | --date <YYYY-MM-DD> [--bytes N] [--tool-calls]" };
  const db = openDb();
  try {
    if (evt) {
      const raw = String(evt).trim();
      const m2 = raw.match(/cp-evt-v2:([0-9a-f]{32})$/) || raw.match(/^([0-9a-f]{32})$/);
      if (m2) {
        const want = m2[1];
        const rows = db.prepare("SELECT e.id, e.instance, e.mid FROM events e WHERE NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge') ORDER BY e.id").all();
        const hit = rows.find(r => createHash("sha256").update(`${r.instance}\0${r.mid}`).digest("hex").slice(0, 32) === want);
        if (!hit) return { error: "锚点未命中任何事件（cp-evt-v2 逐事件重算哈希比对）", evt: raw };
        const full = db.prepare("SELECT session FROM events WHERE id = ?").get(hit.id);
        return { mode: "evt", anchor: `cp-evt-v2:${want}`, ...expandSessionRows(db, full.session, hit.id, budget, withToolCalls, Number(get("--context")) || 0, args.includes("--anchor-first")) };
      }
      const ml = raw.match(/^([A-Za-z0-9_-]{1,64}):(-?\d+)$/);   // legacy 投影标记 = instance 前 8 位:mid
      if (ml) {
        const hits = db.prepare("SELECT e.id, e.session FROM events e WHERE e.instance LIKE ? AND e.mid = ? AND NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge') ORDER BY e.id").all(`${ml[1]}%`, Number(ml[2]));
        if (hits.length !== 1) return { error: `legacy 锚点命中 ${hits.length} 条事件（需唯一）`, evt: raw, candidates: hits.map(h => h.session) };
        return { mode: "evt", anchor: raw, ...expandSessionRows(db, hits[0].session, hits[0].id, budget, withToolCalls, Number(get("--context")) || 0) };
      }
      return { error: "锚点格式不识别（支持 cp-evt-v2:<32hex> / <32hex> / instance前8位:mid）", evt: raw };
    }
    if (sessionArg) {
      const all = db.prepare("SELECT DISTINCT session FROM events ORDER BY session").all().map(r => r.session);
      const exact = all.filter(s => s === sessionArg);
      const like = exact.length ? exact : all.filter(s => s.includes(sessionArg));
      if (like.length === 0) return { error: "无会话命中", session: sessionArg, hint: "expand --date <YYYY-MM-DD> 可列某日全部会话" };
      if (like.length > 1) return { error: `后缀命中 ${like.length} 个会话（需唯一），请给更长片段`, candidates: like };
      return { mode: "session", ...expandSessionRows(db, like[0], null, budget, withToolCalls) };
    }
    // --date：本地日期分组（与 projectInternal 同口径 localDate），列会话清单供 --session 下钻
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) return { error: "--date 需 YYYY-MM-DD" };
    const rows = db.prepare("SELECT e.session, e.instance, e.role, e.content, e.ts FROM events e WHERE NOT EXISTS (SELECT 1 FROM event_tombstones t WHERE t.instance=e.instance AND t.mid=CAST(e.mid AS TEXT) AND t.action='purge') ORDER BY e.id").all();
    const groups = new Map();
    for (const r of rows) {
      if (localDate(r.ts) !== dateArg) continue;
      if (!groups.has(r.session)) groups.set(r.session, { session: r.session, channel: channelName(r.instance, r.session), startedAt: r.ts, events: 0, users: 0, firstUser: null });
      const g = groups.get(r.session);
      g.events += 1;
      if (r.role === "user") { g.users += 1; if (g.firstUser === null) g.firstUser = r.content || ""; }
    }
    const sessions = [...groups.values()].map(g => ({ ...g, title: sessionTitle(g.session), firstUser: g.firstUser === null ? null : expandPreview(g.firstUser) }));
    return { mode: "date", date: dateArg, sessions, hint: sessions.length ? "expand --session <session> 下钻逐字事件流" : null };
  } finally { try { db.close(); } catch {} }
}

// ---------- 入口 ----------
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const cmd = args[0];
const dbPath = get("--db");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
process.on("uncaughtException", (error) => {
  out({ error: error.message, code: error.code || "EVENTS_FAILED" });
  process.exitCode = 1;
});
switch (cmd) {
  case "ingest": {
    if (!dbPath) { out({ error: "缺 --db" }); process.exitCode = 1; break; }
    const result = ingestInternal(dbPath);
    out(result);
    if (result.error) process.exitCode = 1;
    break;
  }
  case "project": {
    const result = projectInternal();
    out(result);
    if (result.error) process.exitCode = 1;
    break;
  }
  case "zcode": {
    const result = zcodeInternal(get("--source"));
    out(result);
    if (result.error || result.projection?.ok === false) process.exitCode = 1;
    break;
  }
  case "manual": {
    const result = manualInternal(get("--transcript"), get("--session") || "anon");
    out(result);
    if (result.error || result.projection?.ok === false) process.exitCode = 1;
    break;
  }
  case "ingest-normalized": {
    const result = normalizedInternal(get("--input"));
    out(result);
    if (result.error || result.projection?.ok === false) process.exitCode = 1;
    break;
  }
  case "poll": {
    if (!dbPath) { out({ error: "缺 --db" }); process.exitCode = 1; break; }
    const r1 = ingestInternal(dbPath);
    const r2 = projectInternal();
    if (r1.error || r2.error) {
      out({ ...r1, projection: { ok: !r2.error, projected: r2.projected || 0, skipped: r2.skipped || 0, ...(r2.error ? { error: r2.error } : {}) } });
      process.exitCode = 1;
      break;
    }
    out({ source: "state.db", instance: r1.instance, cursor: r1.cursor, wrote: r1.ingested, projection: { ok: true, projected: r2.projected || 0, skipped: r2.skipped || 0 }, endedNew: r1.endedNew, endedSemantic: r1.endedSemantic, at: r1.at });
    break;
  }
  case "status": out(statusInternal()); break;
  case "source-identity": {
    const result = sourceIdentityInternal(args.includes("--repair"));
    out(result);
    if (!result.ok) process.exitCode = 1;
    break;
  }
  case "redact": {
    const result = redactInternal(get("--mid"), get("--reason"), get("--instance"));
    out(result);
    if (result.error || result.refused || result.ok === false) process.exitCode = 1;
    break;
  }
  case "tiers": out(tiersInternal()); break;
  case "independence": out(independenceInternal(get("--session"))); break;
  case "expand": out(expandInternal()); break;
  case "coverage": out(coverageInternal()); break;
  case "purge": {
    const result = purgeInternal(get("--before"), args.includes("--sensitive-only"), { confirm: args.includes("--confirm"), reason: get("--reason"), allowAfterPush: args.includes("--allow-after-push") });
    out(result);
    if (result.error || result.refused) process.exitCode = 1;
    break;
  }
  case "export": {
    const result = exportInternal(get("--out") || join(ROOT, "events-export"), process.argv.includes("--include-sensitive"));
    out(result);
    if (result.error) process.exitCode = 1;
    break;
  }
  case "index": {
    const result = buildEventIndex();
    out(result);
    if (result.error) process.exitCode = 1;
    break;
  }
  case "find": {
    const result = findEvents({ term: get("--term"), path: get("--path"), error: get("--error"), decision: args.includes("--decision"), related: get("--related") });
    out(result);
    if (result.error) process.exitCode = 1;
    break;
  }
  default: out({ usage: "poll|ingest|ingest-normalized|project|status|source-identity|independence|redact|tiers|expand|coverage|purge|export" });
}
