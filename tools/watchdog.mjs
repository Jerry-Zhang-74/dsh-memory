/**
 * DSH Memory — 看门狗。
 *
 * 作为一个**完全独立的进程**运行（不依赖 DSH、不作为 DSH 的子进程），因此
 * DSH 被重启时它不会跟着死掉。它做三件事：
 *
 *   1. 持续写入心跳文件，这样“它还活着吗”可以从外部回答。
 *   2. 等待 DSH 的 GUI 端口重新出现，然后核对插件是否真的重新激活
 *      （比对 host-active.json 的 pid 与心跳），把结论写进 restart-report.json。
 *   3. 可选地在 DSH 掉线超过一段时间后把它重新拉起来（--respawn）。
 *
 * 设计上只读 + 只在本进程内做判断：它从不修改 DSH 的配置，也不碰记忆库内容。
 *
 * 用法：
 *   node tools/watchdog.mjs                    # 只监控，不拉起
 *   node tools/watchdog.mjs --respawn          # 掉线超时后拉起 DSH
 *   node tools/watchdog.mjs --expect-restart   # 期望一次重启：先等端口掉，再等它回来
 *   node tools/watchdog.mjs --once             # 跑一轮就退出（给计划任务用）
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'storages', 'dsh-memory', 'state')
const HEARTBEAT = path.join(STATE_DIR, 'watchdog-heartbeat.json')
const REPORT = path.join(STATE_DIR, 'restart-report.json')
const MARKER = path.join(STATE_DIR, 'host-active.json')
const LOG = path.join(STATE_DIR, 'watchdog.log')

const PORT = 19387
const APP_EXE = 'C:\\Users\\A1391\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] ? Number(args[index + 1]) : fallback
}

const expectRestart = flag('expect-restart')
const respawn = flag('respawn')
const runOnce = flag('once')
const totalSeconds = value('timeout', expectRestart ? 240 : 0)
const pollMs = value('interval', 3000)
/** How long the port may stay down before --respawn launches the app. */
const respawnAfterMs = value('respawn-after', 25000)

/** Append one line to the watchdog log. */
async function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.appendFile(LOG, entry).catch(() => {})
  console.log(entry.trimEnd())
}

/** True when the GUI port accepts a connection. */
function portOpen(port = PORT, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (result) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** Read JSON or undefined. */
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write the heartbeat so liveness is answerable from outside. */
async function beat(state, extra = {}) {
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.writeFile(
    HEARTBEAT,
    `${JSON.stringify({ watchdogPid: process.pid, at: new Date().toISOString(), state, ...extra }, null, 2)}\n`,
  )
}

/** Write the final verdict. */
async function report(payload) {
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.writeFile(REPORT, `${JSON.stringify({ finishedAt: new Date().toISOString(), ...payload }, null, 2)}\n`)
}

/** Launch DSH detached from this process. */
function launchApp() {
  const child = spawn(APP_EXE, [], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid
}

// ---------------------------------------------------------------------------

const startedAt = new Date().toISOString()
const markerAtStart = await readJson(MARKER)
await log(`watchdog start pid=${process.pid} expect-restart=${expectRestart} respawn=${respawn} timeout=${totalSeconds}s`)

let phase = expectRestart ? 'waiting-for-port-down' : 'waiting-for-port-up'
let sawPortDown = !expectRestart
let downSince = 0
let respawned = 0
const deadline = totalSeconds > 0 ? Date.now() + totalSeconds * 1000 : Infinity

await beat(phase, { markerAtStart: markerAtStart ?? null })

while (true) {
  const up = await portOpen()

  if (phase === 'waiting-for-port-down') {
    if (!up) {
      phase = 'waiting-for-port-up'
      sawPortDown = true
      await log('port went down; waiting for it to come back')
      await beat(phase)
    }
  } else if (phase === 'waiting-for-port-up') {
    if (up) {
      phase = 'settling'
      await log('port is back; waiting for plugins to settle')
      await beat(phase)
      await new Promise((resolve) => setTimeout(resolve, 6000))
      break
    }
    if (respawn) {
      if (downSince === 0) downSince = Date.now()
      if (Date.now() - downSince > respawnAfterMs) {
        const pid = launchApp()
        respawned += 1
        downSince = 0
        await log(`DSH was down >${respawnAfterMs}ms; relaunched detached (pid ${pid})`)
      }
    }
  }

  if (runOnce && phase === 'waiting-for-port-down') break
  if (Date.now() > deadline) {
    await log(`deadline reached in phase ${phase}`)
    break
  }
  await beat(phase, { portUp: up })
  await new Promise((resolve) => setTimeout(resolve, pollMs))
}

// ---------------------------------------------------------------------------

const portUp = await portOpen()
const markerAfter = await readJson(MARKER)
const reactivated = Boolean(markerAfter && markerAtStart && markerAfter.pid !== markerAtStart.pid)

const issues = []
if (!portUp) issues.push(`GUI port ${PORT} is not accepting connections`)
if (!markerAfter) {
  issues.push('host-active.json missing: the plugin did not run apply()')
} else if (markerAtStart && markerAfter.pid === markerAtStart.pid && expectRestart) {
  issues.push(`marker pid unchanged (${markerAfter.pid}): the app did not actually restart`)
}
if (expectRestart && !sawPortDown) issues.push('the port never went down, so no restart was observed')

const verdict = issues.length === 0 ? 'ok' : !portUp ? 'app-not-responding' : 'needs-attention'

await report({
  startedAt,
  expectRestart,
  sawPortDown,
  respawned,
  portUp,
  markerAtStart: markerAtStart ?? null,
  markerAfter: markerAfter ?? null,
  reactivated,
  verdict,
  issues,
})

await beat('finished', { verdict, issues })
await log(`watchdog done verdict=${verdict}${issues.length ? ` issues=${issues.join('; ')}` : ''}`)
