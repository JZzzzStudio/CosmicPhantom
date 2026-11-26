// cp-autopilot.mjs — CP 强执行自动化扩展（v0，2026-09-28）
// 使命：把"靠自觉"的动作变成事件驱动的自动行为（无时钟、无轮询、无后台常驻——纯事件钩子）
//   message_end       → ①自动摄取（节流 2 分钟）②回复质检（reply-check 全判据）
//   before_agent_start → ③健康巡检（resume stale→自动 refresh；蒸馏到期检查）④提醒注入
// 日志：~/.cosmic-phantom/.flags/cp-autopilot.log（所有动作留痕，可复核）
import { appendFileSync, readFileSync, writeFileSync, statSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import os from 'node:os'

const ROOT = os.homedir() + '/.cosmic-phantom'
const LOG = ROOT + '/.flags/cp-autopilot.log'
const NODE = ROOT + '/tools/node/node.exe'
const SESSIONS = os.homedir() + '/.proma/agent-sessions'
const TMPREPLY = ROOT + '/.flags/cp-last-reply.txt'
const NL = String.fromCharCode(10)

const log = (m) => {
  try {
    // 日志轮转：>1MB 时归档为 .old（挑刺 R1，2026-09-28）
    try {
      const st = statSync(LOG)
      if (st.size > 1048576) { try { renameSync(LOG, LOG + '.old') } catch (e) {} }
    } catch (e) {}
    appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + m + NL)
  } catch (e) {}
}
try { log('module evaluated') } catch (e) {}

// ── 思考退化检测（2026-09-28：用户两次抓包思考流"—— —— ——"循环退化）
function degradedHits(text) {
  const hits = []
  if (!text || text.length < 150) return hits
  const runs = text.match(/(——[\s）)】\u2026]*){6,}/g)
  if (runs) hits.push('连续破折号段x' + runs.length + '（最长 ' + Math.max.apply(null, runs.map(s => (s.match(/——/g) || []).length)) + ' 连）')
  const dashCount = (text.match(/——/g) || []).length
  const density = dashCount / (text.length / 100)
  if (density > 10) hits.push('破折号密度 ' + density.toFixed(1) + '/100字')
  const rep = text.match(/(.{1,6}?) (?:\1 ?){4,}/g)
  if (rep) hits.push('短串重复x' + rep.length)
  // 破折号+星号混合链检测（2026-09-29 补）
  const mix = text.match(/(?:(?:——|\*\*)[ \t]*){4,}/g)
  if (mix) hits.push('混合链x' + mix.length)
  // 星号空格化变异（2026-09-28 二修检测）
  const totalStars = (text.match(/\*\*/g) || []).length
  const spacedStars = (text.match(/\*\*[ \t]|[ \t]\*\*/g) || []).length
  if (spacedStars >= 6 && spacedStars / Math.max(1, totalStars) > 0.7) hits.push('星号化x' + spacedStars)
  return hits
}
export { degradedHits }

// ── 源头清洗（2026-09-28 闸门2）：message_end 可返回替换消息，
//    SDK 注释确认替换版进入 agent state / session history（原文不入存储）。
//    多轮收敛版（与 thinking-sanitizer.mjs 同步，含密度规则⑤）
function sanitizeThink(t) {
  let s = String(t)
  for (let i = 0; i < 5; i++) {
    const before = s
    s = s.replace(/(——){2,}/g, '——')
    s = s.replace(/(——)(?:[ \t\n]*——){2,}/g, '$1 ')
    s = s.replace(/(.{1,6}?) (?:\1 ?){4,}/g, '$1 ')
    // ⑤ 破折号+星号混合链（退化形态）→ 折叠为单个
    s = s.replace(/(?:(?:——|\*\*)[ \t]*){4,}/g, '—— ')
    const totalStars = (s.match(/\*\*/g) || []).length
    const spacedStars = (s.match(/\*\*[ \t]|[ \t]\*\*/g) || []).length
    if (spacedStars >= 6 && spacedStars / Math.max(1, totalStars) > 0.7) {
      s = s.replace(/\*\*/g, '').replace(/ {2,}/g, ' ')
    }
    {
      const dashCount = (s.match(/——/g) || []).length
      const density = dashCount / (s.length / 100)
      // 最小长度门槛：短文本密度波动大，只对长思考生效（2026-09-29 修）
      if (s.length >= 200 && density > 10) s = s.replace(/——/g, '，')
    }
    if (s === before) break
  }
  return s
}
export { sanitizeThink }

// ── 宽松 JSON 解析（输出为多行 pretty-print 时，split(NL).pop() 会挂——2026-09-28 实修）
function parseLoose(s) {
  const t = String(s || '')
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)) } catch (e) { return null } }
  return null
}
const runAsync = (args, timeout) => new Promise((resolve) => {
  execFile(NODE, args, { timeout: timeout || 120000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve({ err, stdout: String(stdout || '') }))
})

let lastIngest = 0
// R9 修复（2026-09-28）：pending 落盘——实测每轮模块重新评估，内存态跨轮必丢
const PEND = ROOT + '/.flags/cp-pending-notes.json'
const readPend = () => { try { return JSON.parse(readFileSync(PEND, 'utf8')) || [] } catch (e) { return [] } }
const writePend = (arr) => { try { writeFileSync(PEND, JSON.stringify(arr.slice(-20))) } catch (e) {} }

export default function cpAutopilot(pi) {
  log('factory called')

  // ── 事件探针：找出 Pi 真实支持的事件名（每事件仅首记一次+结构快照；为"实时拦截思考流"铺路）
  const probed = new Set()
  for (const name of ['message_update', 'message_delta', 'part_update', 'thinking_delta', 'turn_end', 'agent_end', 'session_end', 'session_start', 'tool_call', 'tool_result', 'user_prompt', 'context_update']) {
    try {
      pi.on(name, (ev) => {
        try {
          if (probed.has(name)) return
          probed.add(name)
          let shape = ''
          try { shape = JSON.stringify(ev, (k, v) => (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v)).slice(0, 600) } catch (e) {}
          log('event-probe: ' + name + ' fired | ' + shape)
        } catch (e) {}
      })
    } catch (e) {}
  }

  // ── 实时思考守卫（message_update 流式事件：增量检测退化并实时留痕 + 严重退化实时扳断）
  let lastLiveScan = 0
  let lastAbortTs = 0
  try {
    pi.on('message_update', (ev, ctx) => {
      try {
        const msg = ev && ev.message
        if (!msg || msg.role !== 'assistant') return
        const blocks = Array.isArray(msg.content) ? msg.content : []
        const think = blocks.filter(b => b && b.type === 'thinking').map(b => b.thinking || '').join('')
        if (!think || think.length < 150) return
        const now = Date.now()
        if (now - lastLiveScan < 1500) return
        lastLiveScan = now
        const hits = degradedHits(think)
        if (hits.length) {
          try {
            const LIVE = ROOT + '/.flags/thinking-degraded-live.log'
            try { if (statSync(LIVE).size > 1048576) renameSync(LIVE, LIVE + '.old') } catch (e) {}
            appendFileSync(LIVE, '[' + new Date().toISOString() + '] LIVE ' + hits.join(' ; ') + ' | len=' + think.length + NL)
          } catch (e) {}
          // 2026-09-29 启用实时扳断：严重退化 → ctx.abort() 掐断本轮生成（用户看到的直播流止损）
          // 阈值保守：连续破折号段(最长≥6) / 混合链≥2 / 密度≥15；60 秒防抖
          const severe = hits.some(h => /连续破折号段(?!x0)/.test(h) || /混合链x[2-9]/.test(h) || /密度 1[5-9]|\.密度 [2-9]/.test(h))
          if (severe && ctx && typeof ctx.abort === 'function' && (now - lastAbortTs > 60000)) {
            lastAbortTs = now
            try {
              ctx.abort()
              const LIVE = ROOT + '/.flags/thinking-degraded-live.log'
              appendFileSync(LIVE, '[' + new Date().toISOString() + '] ABORT-TRIGGERED ' + hits.join(' ; ') + NL)
            } catch (e) {}
          }
        }
      } catch (e) {}
    })
  } catch (e) {}

  // ── 每轮结束：自动摄取 + 回复质检 + 源头清洗
  pi.on('message_end', async (event) => {
    let cleanedMsg = null   // 源头清洗的替换消息（作用域必须覆盖整个 handler）
    try {
      const msg = event && event.message
      if (msg && msg.role === 'assistant') {
        const blocks = Array.isArray(msg.content) ? msg.content : []
        // ● 思考退化检测 + 源头清洗（替换版入存储，通过 handler 尾部统一返回 {message}）
        try {
          const thinkText = blocks.filter(b => b && b.type === 'thinking').map(b => b.thinking || b.text || '').join(NL)
          if (thinkText) {
            const th = degradedHits(thinkText)
            if (th.length) {
              log('thinking-degraded: ' + th.join(' ; ') + ' | len=' + thinkText.length)
              // 2026-09-28 修复：只留日志，不再写 pending/注入——避免"提醒文本即污染源"的反馈环
            }
          }
          // 源头清洗：折叠 thinking 里的退化片段（保守规则，正常文本零改动）
          let cleanedBlocks = 0
          let cutChars = 0
          const newBlocks = blocks.map(b => {
            if (b && b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 40) {
              const after = sanitizeThink(b.thinking)
              if (after !== b.thinking) {
                cleanedBlocks++
                cutChars += (b.thinking.length - after.length)
                return { ...b, thinking: after }
              }
            }
            return b
          })
          if (cleanedBlocks) {
            cleanedMsg = { ...msg, content: newBlocks }
            log('message-cleaned: blocks=' + cleanedBlocks + ' chars-=' + cutChars + ' (pre-storage source-level)')
          }
        } catch (e) { log('think-scan err: ' + String(e.message).slice(0, 80)) }
        // ① 回复质检：写临时文件 → reply-check 全判据
        const text = blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join(NL)
        if (text && text.length > 40) {
          try {
            writeFileSync(TMPREPLY, text, 'utf8')
            const r = await runAsync([ROOT + '/reply-check.js', '--file', TMPREPLY, '--root', ROOT, '--technical'], 20000)
            const j = parseLoose(r.stdout)
            if (j && !j.ok && Array.isArray(j.violations) && j.violations.length) {
              const codes = j.violations.map(v => v.code + '(' + v.detail + ')').join(', ')
              log('reply-check 命中: ' + codes)
              const pn2 = readPend(); pn2.push('reply-check 检出上轮回复：' + codes + '。请本轮修正。'); writePend(pn2)  // R3+R9: 落盘追加
            }
          } catch (e) { log('reply-check err: ' + String(e.message).slice(0, 100)) }
        }
        // ② 自动摄取（节流 2 分钟）
        const now = Date.now()
        if (now - lastIngest > 120000) {
          lastIngest = now
          const r = await runAsync(['--experimental-sqlite', ROOT + '/proma-adapter.js', '--sessions-dir', SESSIONS, '--root', ROOT], 130000)
          try {
            const j = parseLoose(r.stdout)
            if (!j) throw new Error('parse null')
            log('auto-ingest: added=' + j.added + ' projected=' + j.projected)
          } catch (e) { log('auto-ingest skip: ' + (r.err ? String(r.err.message).slice(0, 60) : 'no-json') + ' | stdout尾: ' + r.stdout.slice(-150).replace(/\n/g, ' ')) }
        }
      }
    } catch (e) { log('message_end err: ' + String(e.message).slice(0, 100)) }
    // 源头清洗返回：替换版进入 agent state / session history（SDK: "never enters agent state or session history"）
    try { if (cleanedMsg) return { message: cleanedMsg } } catch (e) {}
  })

  // ── 每轮开始：健康巡检 + 提醒注入
  pi.on('before_agent_start', (event) => {
    const notes = []
    try {
      // ① resume 健康门：stale → 自动 refresh
      try {
        // 2026-09-30 新机首验修复：check 的 stale 本来就 exit 1；execFileSync 会先抛错，旧代码永远进不了 refresh。
        // spawnSync 保留退出码与 JSON；只刷新可解释的 stale，不把 invalid/missing 或执行异常当成可自动接受的改动。
        const checked = spawnSync(NODE, [ROOT + '/resume-context.js', 'check', '--root', ROOT], { timeout: 15000, encoding: 'utf8', windowsHide: true })
        if (checked.error) throw checked.error
        const j = parseLoose(checked.stdout)
        if (!j) throw new Error('resume check 无有效 JSON: ' + String(checked.stderr || '').slice(0, 100))
        if (!j.ok && j.manifest === 'stale' && j.policy === 'valid' && !(j.missing || []).length) {
          execFileSync(NODE, [ROOT + '/resume-context.js', 'refresh', '--actor', 'cp-autopilot', '--root', ROOT], { timeout: 15000, windowsHide: true })
          const changedList = Array.isArray(j.changed) ? j.changed.join(', ') : String(j.manifest || '')
          log('auto-refresh: resume 健康门曾 ' + changedList)
          // R2: 不静默——变更文件列表进提醒，避免"自动接受改动=洗白"
          notes.push('resume 健康门曾 stale，已自动 refresh（变更：' + (changedList || '?') + '）。如有非预期变更请核查。')
        } else if (!j.ok || checked.status !== 0) {
          throw new Error('resume check 未通过: ' + JSON.stringify(j).slice(0, 200))
        }
      } catch (e) { notes.push('resume check 失败: ' + String(e.message).slice(0, 60)) }
      // ② 蒸馏到期（≥7 天）
      try {
        const m = JSON.parse(readFileSync(ROOT + '/distilled/manifest.json', 'utf8'))
        const days = (Date.now() - Date.parse(m.lastRun)) / 86400000
        if (days >= 7) { notes.push('蒸馏已 ' + Math.floor(days) + ' 天未跑（≥7 天）'); log('distill-due: ' + Math.floor(days) + 'd') }
      } catch (e) {}
      // ③ 上轮质检/退化 pending（落盘版，R9）
      const pn3 = readPend()
      if (pn3.length) { notes.push.apply(notes, pn3); writePend([]) }
      // ④ 交付物监督（C2 2026-09-29，与 F27/C1 配套）：登记的交付物（迁移包等）改动晚于最后测试 → 轻提醒。
      //   节流：watch 文件缓存 10 分钟内不重算；alerts 变化才提醒（notifiedSig 去重）；fail-open。
      try {
        const dvf = ROOT + '/.flags/delivery-verification.jsonl'
        const dwf = ROOT + '/.flags/delivery-watch.json'
        if (existsSync(dvf)) {
          let watch = null
          try { watch = JSON.parse(readFileSync(dwf, 'utf8')) } catch (e) {}
          const nowTs = Date.now()
          if (!watch || (nowTs - Date.parse(watch.checkedAt || 0)) > 600000) {
            const latest = new Map()
            for (const ln of readFileSync(dvf, 'utf8').split(NL)) {
              if (!ln.trim()) continue
              let rec = null
              try { rec = JSON.parse(ln) } catch (e) { continue }
              if (!rec || !rec.deliverable) continue
              const prev = latest.get(rec.deliverable)
              if (!prev || String(rec.testedAt || '') >= String(prev.testedAt || '')) latest.set(rec.deliverable, rec)
            }
            const snapshot = {}
            const alerts = []
            for (const [d, rec] of latest) {
              if (rec.result === 'retired') continue
              let mx = 0
              const walk = (p) => {
                let st; try { st = statSync(p) } catch (e) { return }
                if (st.mtimeMs > mx) mx = st.mtimeMs
                if (st.isDirectory()) {
                  let kids = []; try { kids = readdirSync(p) } catch (e) { return }
                  for (const k of kids) walk(p + '/' + k)
                }
              }
              walk(d)
              snapshot[d] = mx
              const testedAt = Date.parse(rec.testedAt || '')
              if (!existsSync(d)) alerts.push('不存在: ' + d)
              else if (mx && testedAt && mx > testedAt + 2000) alerts.push('有改动未复测: ' + d)
            }
            watch = { checkedAt: new Date().toISOString(), snapshot, alerts, notifiedSig: (alerts.length && watch) ? watch.notifiedSig : null }
            try { writeFileSync(dwf, JSON.stringify(watch)) } catch (e) {}
          }
          if (watch && Array.isArray(watch.alerts) && watch.alerts.length) {
            const sig = watch.alerts.join('|')
            if (watch.notifiedSig !== sig) {
              notes.push('【交付物监督】' + sig + ' —— 纪律：改→测试→才报；复测后跑 record-delivery-test.cjs 记账')
              watch.notifiedSig = sig
              try { writeFileSync(dwf, JSON.stringify(watch)) } catch (e) {}
              log('delivery-alert: ' + sig.slice(0, 160))
            }
          }
        }
      } catch (e) { log('delivery-watch err: ' + String(e.message).slice(0, 100)) }
    } catch (e) { log('before_agent_start err: ' + String(e.message).slice(0, 100)) }
    if (notes.length) {
      log('inject-notes: ' + notes.join(' | '))
      try { return { systemPrompt: event.systemPrompt + NL + NL + '【CP 自动巡检｜cp-autopilot】' + NL + notes.join(NL) } } catch (e) { return undefined }
    }
  })
}
