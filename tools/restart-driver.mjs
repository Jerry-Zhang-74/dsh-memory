/**
 * DSH Memory — restart driver that finishes the job the caller cannot.
 *
 * Stopping DSH kills the shell that issued the stop, so a restart cannot be
 * written as "stop, then start" in one command: the second half never runs.
 * This script solves that by being a SEPARATE process, spawned before the stop.
 * It survives, waits for the app to disappear, launches it again, and then
 * proves the outcome instead of assuming it.
 *
 * Ordering: this script is launched first, then the caller stops DSH. The
 * launch is what makes the restart reliable — the caller's own execution ending
 * is an expected part of the sequence, not a failure.
 *
 * Usage: node tools/restart-driver.mjs [timeoutSeconds]
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync, spawn } from 'node:child_process'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'storages', 'dsh-memory', 'state')
const LOG = path.join(STATE_DIR, 'restart-driver.log')
const REPORT = path.join(STATE_DIR, 'restart-report.json')
const MARKER = path.join(STATE_DIR, 'host-active.json')

const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const APP_EXE = process.env.DSH_APP_EXE ||
  path.join(LOCAL_APPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
const PORT = 19387
const timeoutSeconds = Number(process.argv[2] ?? 180)

/** Append a timestamped line to the driver log. */
async function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.appendFile(LOG, entry).catch(() => {})
}

/** Read JSON, or undefined. */
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
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

/** Count live DSH shell processes. */
function appProcessCount() {
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH', '/FO', 'CSV'],
      { encoding: 'utf8', windowsHide: true },
    )
    return (out.match(/DeepSeek Harness\.exe/gi) ?? []).length
  } catch {
    return -1
  }
}

/** Launch DSH fully detached from this process. */
function launchApp() {
  const child = spawn(APP_EXE, [], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid
}

const startedAt = new Date().toISOString()
const markerBefore = await readJson(MARKER)
await log(`driver start pid=${process.pid} timeout=${timeoutSeconds}s markerPid=${markerBefore?.pid ?? 'none'}`)

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = Date.now() + timeoutSeconds * 1000

// Phase 1: wait for the app to be gone (the caller stops it after we start).
let sawExit = false
while (Date.now() < deadline) {
  const count = appProcessCount()
  const up = await portOpen()
  if (count === 0 && !up) {
    sawExit = true
    await log('app is gone; port is free')
    break
  }
  await settle(1000)
}

if (!sawExit) {
  await log('app never exited within the window; launching anyway')
}

// Phase 2: relaunch. A short pause lets Windows release the single-instance
// lock so the new process is the real one, not handed off to a dying shell.
await settle(2500)
const launchedPid = launchApp()
await log(`relaunched detached (spawned pid ${launchedPid})`)

// Phase 3: wait for the GUI, then for the plugin to re-activate.
let portUp = false
while (Date.now() < deadline) {
  if (await portOpen()) {
    portUp = true
    await log('port is up')
    break
  }
  await settle(1500)
}

let markerAfter
if (portUp) {
  // The host needs a moment past the port opening to finish activating plugins.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await settle(2000)
    markerAfter = await readJson(MARKER)
    if (markerAfter && markerAfter.pid !== markerBefore?.pid) break
  }
}

const reactivated = Boolean(markerAfter && markerAfter.pid !== markerBefore?.pid)
const issues = []
if (!portUp) issues.push(`GUI port ${PORT} never came back within ${timeoutSeconds}s`)
if (portUp && !markerAfter) issues.push('host-active.json missing after restart: the plugin did not run apply()')
if (portUp && markerAfter && !reactivated) {
  issues.push(`marker pid unchanged (${markerAfter.pid}): the new process did not activate the plugin`)
}

await fs.mkdir(STATE_DIR, { recursive: true })
await fs.writeFile(
  REPORT,
  `${JSON.stringify(
    {
      startedAt,
      finishedAt: new Date().toISOString(),
      via: 'restart-driver',
      sawExit,
      portUp,
      markerBefore: markerBefore ?? null,
      markerAfter: markerAfter ?? null,
      reactivated,
      verdict: issues.length === 0 ? 'ok' : 'needs-attention',
      issues,
    },
    null,
    2,
  )}\n`,
)

await log(`driver done verdict=${issues.length === 0 ? 'ok' : 'needs-attention'}${issues.length ? ` :: ${issues.join('; ')}` : ''}`)
