// sts-guard.mjs — Stop That Shit × CP 守护（Proma 适配版）
// 来源：外部 STS 工具的 Pi 适配层副本；源目录由发布环境提供。
//
// 与 STS 本体的差异（仅两处，均在本文件内）：
//   1. 不依赖 @earendil-works/pi-coding-agent（原版入口用它算 getAgentDir()）；
//   2. dataDir 指向 CP：~/.cosmic-phantom/.flags/sts-state/（可用 STS_STATE_DIR 覆盖）。
//
// 行为：用户说"只看不改 / 只审查 / $stop-that-shit review"等 → 契约武装；
//   guard 级别下违规写操作被硬拦截（工具调用直接 block，附 reason）。
// 哲学：fail-open——本扩展任何内部错误都不阻塞会话（与 STS 本体一致）。
// 回退：删除本文件 + sts-src/ 目录即可（一键回退）。
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const ROOT_CP = path.join(os.homedir(), '.cosmic-phantom')
const DATA_DIR = process.env.STS_STATE_DIR || path.join(ROOT_CP, '.flags', 'sts-state')
const LOG = path.join(ROOT_CP, '.flags', 'sts-guard.log')

function log(message) {
  try {
    // 日志轮转：>1MB 时归档为 .old（与 cp-autopilot 同规）
    try {
      const st = fs.statSync(LOG)
      if (st.size > 1048576) { try { fs.renameSync(LOG, LOG + '.old') } catch (e) {} }
    } catch (e) {}
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + message + '\n')
  } catch (e) {}
}

const require = createRequire(import.meta.url)

let registerPiExtension = null
try {
  ({ registerPiExtension } = require('./sts-src/src/adapters/pi-extension.cjs'))
  log('module evaluated; registerPiExtension loaded; dataDir=' + DATA_DIR)
} catch (e) {
  log('LOAD FAILED (fail-open, guard inactive): ' + (e && e.message))
}

export default function stsGuard(pi) {
  if (typeof registerPiExtension !== 'function') {
    log('factory called but registerPiExtension unavailable; skip')
    return
  }
  try {
    registerPiExtension(pi, { dataDir: DATA_DIR })
    log('registered; events bound')
  } catch (e) {
    log('REGISTER FAILED (fail-open): ' + (e && e.message))
  }
}
