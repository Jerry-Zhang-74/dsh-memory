/**
 * DSH Memory — 外源守护进程（常驻监督者）。
 *
 * 为什么需要它：宿主插件代码只在 DSH **启动时**加载。而「重启」不能从会话内部
 * 完成 —— 从内部强制结束进程会弹出确认框，用户不一定在场，于是卡住。
 *
 * 所以重启的责任放在这个**完全独立于 DSH 的进程**上。它的工作方式很窄，只做
 * 一件事：**当 DSH 没在运行时把它打开**。它从不关闭任何东西，因此全程不需要
 * 任何交互。
 *
 * 用法：
 *   node tools/supervisor.mjs                  # 常驻，每 8 秒检查一次
 *   node tools/supervisor.mjs --interval 5000
 *   node tools/supervisor.mjs --once           # 只检查一轮（给计划任务用）
 *   node tools/supervisor.mjs --grace 20       # 掉线多少秒后才拉起（默认 15）
 *   node tools/supervisor.mjs --max-launches 5 # 本次运行最多拉起几次（防止崩溃循环）
 *
 * 安全约束：
 *   - 永不终止进程，永不修改 DSH 配置。
 *   - 拉起后有一段冷静期，避免同一次掉线被重复拉起。
 *   - 拉起次数有上限；达到上限就停下并写明原因，不做无限尝试。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync, spawn } from 'node:child_process'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'storages', 'dsh-memory', 'state')
const HEARTBEAT = path.join(STATE_DIR, 'supervisor-heartbeat.json')
const LOG = path.join(STATE_DIR, 'supervisor.log')
const MARKER = path.join(STATE_DIR, 'host-active.json')

const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const APP_EXE = process.env.DSH_APP_EXE ||
  path.join(LOCAL_APPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
const PORT = 19387
const APP_IMAGE = 'DeepSeek Harness.exe'

/** Parse `--flag` / `--key value` arguments. */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const intervalMs = Number(args.interval ?? 8000)
const graceMs = Number(args.grace ?? 15) * 1000
const maxLaunches = Number(args['max-launches'] ?? 5)
const runOnce = args.once === true

/** Append a timestamped line to the supervisor log. */
async function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.appendFile(LOG, entry).catch(() => {})
  if (args.quiet !== true) console.log(entry.trimEnd())
}

/** True when the GUI port accepts a connection. */
function portOpen(port = PORT, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Count live DSH shell processes.
 *
 * `tasklist` is used rather than a PowerShell query because this runs on a tight
 * loop and must stay cheap.
 */
function appProcessCount() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${APP_IMAGE}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return (out.match(new RegExp(APP_IMAGE.replace('.', '\\.'), 'gi')) ?? []).length
  } catch {
    return -1
  }
}

/** Read JSON, or undefined. */
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write the heartbeat so an outside reader can see the supervisor is alive. */
async function beat(state, extra = {}) {
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.writeFile(
    HEARTBEAT,
    `${JSON.stringify({ supervisorPid: process.pid, at: new Date().toISOString(), state, ...extra }, null, 2)}\n`,
  )
}

/** Launch DSH fully detached from this process. */
function launchApp() {
  const child = spawn(APP_EXE, [], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid
}

/** Pause without a busy loop. */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------

await log(`supervisor start pid=${process.pid} interval=${intervalMs}ms grace=${graceMs}ms maxLaunches=${maxLaunches}`)

let launches = 0
let downSince = 0
let healthySince = Date.now()
const startedMarker = await readJson(MARKER)

while (true) {
  const processes = appProcessCount()
  const port = await portOpen()
  const marker = await readJson(MARKER)

  // "Down" means no shell process at all. A running app with a slow port is not
  // something this supervisor should act on — it only ever opens a closed app.
  const down = processes === 0 && !port

  if (!down) {
    if (downSince !== 0) await log(`DSH is back (processes=${processes} port=${port})`)
    downSince = 0
    healthySince = Date.now()
    await beat('watching', {
      processes,
      portOpen: port,
      launches,
      hostPid: marker?.pid ?? null,
      pluginActivatedAt: marker?.activatedAt ?? null,
    })
  } else {
    if (downSince === 0) {
      downSince = Date.now()
      await log('DSH is not running; starting the grace clock')
    }

    const downFor = Date.now() - downSince
    const markerChanged = marker && startedMarker && marker.pid !== startedMarker.pid

    if (downFor >= graceMs) {
      if (launches >= maxLaunches) {
        await beat('stopped', { reason: 'launch limit reached', launches })
        await log(`launch limit ${maxLaunches} reached; stopping instead of looping`)
        break
      }
      const pid = launchApp()
      launches += 1
      downSince = 0
      // A freshly launched app needs time to bind the port; without this pause
      // the next tick would see "down" again and launch a second copy.
      await log(`DSH had been down for ${Math.round(downFor / 1000)}s; launched detached (pid ${pid})`)
      await beat('launched', { spawnedPid: pid, launches })
      await settle(Math.max(intervalMs * 3, 15000))
      continue
    }

    await beat('grace', { downForMs: downFor, launches, markerChanged: Boolean(markerChanged) })
  }

  if (runOnce) {
    await log(`single pass complete (down=${down}, processes=${processes}, port=${port})`)
    break
  }

  await settle(intervalMs)
}

await beat('finished', { launches })
await log(`supervisor exit pid=${process.pid} launches=${launches}`)
