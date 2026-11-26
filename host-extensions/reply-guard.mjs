// reply-guard.mjs — 顶层探针版 v3（2026-09-28，零反斜杠写法）
// 顶层代码在"模块被 import"时立即执行 → module.log（用于区分"没被加载"vs"加载失败"）
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'

const FLAGS = os.homedir() + '/.cosmic-phantom/.flags/'
const POLICY = os.homedir() + '/.cosmic-phantom/reply-policy.json'
const MODLOG = FLAGS + 'reply-guard.module.log'
const BOOT = FLAGS + 'reply-guard.boot.log'
const HITS = FLAGS + 'reply-guard.hits.log'
const PEND = FLAGS + 'reply-guard.pending.json'
const NL = String.fromCharCode(10)

try { appendFileSync(MODLOG, '[' + new Date().toISOString() + '] module evaluated' + NL) } catch (e) {}

// 2026-11-18：禁用词改读真源 reply-policy.json，不再硬编码 5 个词——否则门禁改了扩展不知道（检测面与门禁漂移）。
// 读不到/格式不对才回退内置，fail-open（不因配置问题让扩展挂掉）。
const FALLBACK_FORBIDDEN = ['你说得对', '有道理', '确实', '没错', '言之有理']
function loadForbidden() {
  try {
    const p = JSON.parse(readFileSync(POLICY, 'utf8'))
    if (Array.isArray(p.forbidden) && p.forbidden.length) return p.forbidden.filter(function (x) { return typeof x === 'string' && x })
  } catch (e) {}
  return FALLBACK_FORBIDDEN
}

export default function replyGuard(pi) {
  try { appendFileSync(BOOT, '[' + new Date().toISOString() + '] factory called' + NL) } catch (e) {}

  // R9 修复（2026-09-28）：pending 落盘（每轮模块重新评估，内存态必丢）
  const readPend = () => { try { return JSON.parse(readFileSync(PEND, 'utf8')) || [] } catch (e) { return [] } }
  const writePend = (arr) => { try { writeFileSync(PEND, JSON.stringify(arr.slice(-20))) } catch (e) {} }
  pi.on('message_end', (event) => {
    try {
      const msg = event && event.message
      if (!msg || msg.role !== 'assistant') return
      const blocks = Array.isArray(msg.content) ? msg.content : []
      const text = blocks.filter(function (b) { return b && b.type === 'text' }).map(function (b) { return b.text || '' }).join(NL)
      if (!text) return
      const FORBIDDEN = loadForbidden()
      const hit = FORBIDDEN.find(function (w) { return text.includes(w) })
      if (!hit) return
      const pn = readPend(); pn.push('reply-guard 检出上一轮回复含禁用词「' + hit + '」。请本轮修正措辞。'); writePend(pn)
      appendFileSync(HITS, '[' + new Date().toISOString() + '] hit=' + hit + NL)
    } catch (e) {}
  })

  pi.on('before_agent_start', (event) => {
    const pn = readPend()
    if (!pn.length) return
    const note = pn.join(NL)
    writePend([])
    try { return { systemPrompt: event.systemPrompt + NL + NL + '【自动质检提醒｜reply-guard】' + note } } catch (e) { return undefined }
  })
}
