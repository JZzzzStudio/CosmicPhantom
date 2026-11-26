// thinking-sanitizer.mjs — 每轮请求前清洗历史中的退化样本（2026-09-28）
// 机理：Pi Agent 的 transformContext -> 扩展系统 emitContext("context" / "context_with_system")
// 作用：在 messages 发给模型之前，把 assistant 历史 thinking 里的退化片段
//       （连续破折号串 / 短串重复）折叠掉，切断"模型看到自己的退化样本→模仿→更退化"的反馈环。
// 只清 assistant 消息的 thinking 块；不碰 user 消息、不碰 text 正文。
// 日志：~/.cosmic-phantom/.flags/thinking-sanitizer.log
import { appendFileSync, statSync, renameSync } from 'node:fs'
import os from 'node:os'

const ROOT = os.homedir() + '/.cosmic-phantom'
const LOG = ROOT + '/.flags/thinking-sanitizer.log'
const NL = String.fromCharCode(10)

const log = (m) => {
  try {
    try {
      const st = statSync(LOG)
      if (st.size > 1048576) { try { renameSync(LOG, LOG + '.old') } catch (e) {} }
    } catch (e) {}
    appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + m + NL)
  } catch (e) {}
}
try { log('module evaluated') } catch (e) {}

// 清洗单个 thinking 文本（多轮收敛版，2026-09-28 终修）：
// 规则间相互暴露的残留（如星号删除后露出的破折号串）由二次循环捕获，
// 循环上限 5 次，稳定即退出。
// ① 2+ 连续"——"（无分隔连写）折叠为单个； ② 3+ 组"——"（仅空白分隔）折叠为单个；
// ③ 短串重复（1-6 字符，重复 4+ 次，空格分隔）折叠为单次；
// ④ 星号空格化变异（邻接空格占比 >70% 且 ≥6 处 → 全删星号+折叠空格）；
// ⑤ 破折号密度失控（>10/100字）→ 全部替换为逗号（保留节奏，去除密度污染）。
function sanitize(t) {
  let s = String(t)
  for (let i = 0; i < 5; i++) {
    const before = s
    s = s.replace(/(——){2,}/g, '——')
    s = s.replace(/(——)(?:[ \t\n]*——){2,}/g, '$1 ')
    s = s.replace(/(.{1,6}?) (?:\1 ?){4,}/g, '$1 ')
    // ⑤ 破折号+星号混合链（退化形态：——** ——** —— 等交错重复）→ 折叠为单个
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
export { sanitize }

export default function thinkingSanitizer(pi) {
  log('factory called')

  try {
    pi.on('context', (event) => {
      try {
        const msgs = event && event.messages
        if (!Array.isArray(msgs)) { log('context: messages not array'); return }
        let cleanedBlocks = 0
        let cleanedChars = 0
        const out = msgs.map((m) => {
          if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) return m
          let mChanged = false
          const content = m.content.map((b) => {
            if (b && b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 40) {
              const before = b.thinking
              const after = sanitize(before)
              if (after !== before) {
                mChanged = true
                cleanedBlocks++
                cleanedChars += (before.length - after.length)
                return { ...b, thinking: after }
              }
            }
            return b
          })
          return mChanged ? { ...m, content } : m
        })
        if (cleanedBlocks) {
          log('context-cleaned: blocks=' + cleanedBlocks + ' chars-=' + cleanedChars + ' msgs=' + msgs.length)
          return { messages: out }
        }
        log('context-scanned: clean, msgs=' + msgs.length)
      } catch (e) { log('context handler err: ' + String(e.message).slice(0, 100)) }
    })
    log('on(context) registered')
  } catch (e) { log('on(context) FAILED: ' + String(e.message).slice(0, 120)) }

  try {
    pi.on('context_with_system', () => {
      log('context_with_system fired (not modified)')
    })
    log('on(context_with_system) registered')
  } catch (e) { log('on(context_with_system) FAILED: ' + String(e.message).slice(0, 120)) }
}
