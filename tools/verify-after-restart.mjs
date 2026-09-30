/**
 * Post-restart verifier.
 *
 * Written to be launched DETACHED immediately before a DSH restart. It survives
 * the restart (it is its own process, spawned without a console window), waits
 * for the app to come back, then writes an evidence report to
 * `$DSH_HOME/storages/dsh-memory/state/restart-report.json`.
 *
 * The point is to be able to answer "did the restart actually load the new
 * plugin?" from outside the app, without a human watching and without touching
 * the running process.
 *
 * Usage: node tools/verify-after-restart.mjs [timeoutSeconds]
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'storages', 'dsh-memory', 'state')
const REPORT = path.join(STATE_DIR, 'restart-report.json')
const MARKER = path.join(STATE_DIR, 'host-active.json')
const PORT = 19387
const timeoutSeconds = Number(process.argv[2] ?? 180)

/** True when the GUI port accepts a connection. */
function portOpen(port, timeoutMs = 1500) {
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

/** Read JSON, or undefined. */
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Poll until the port is up again, or give up. */
async function waitForPort(deadline) {
  while (Date.now() < deadline) {
    if (await portOpen(PORT)) return true
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return false
}

const startedAt = new Date().toISOString()
const before = await readJson(MARKER)

const deadline = Date.now() + timeoutSeconds * 1000
const cameUp = await waitForPort(deadline)

// Give the host a moment to finish activating plugins after the port opens.
await new Promise((resolve) => setTimeout(resolve, 6000))
const after = await readJson(MARKER)

const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  port: PORT,
  appResponding: cameUp,
  markerBefore: before ?? null,
  markerAfter: after ?? null,
  /** The marker was rewritten by a NEW process: proof apply() ran again. */
  reactivated: Boolean(after && before && after.pid !== before.pid),
  firstActivation: Boolean(after && before === undefined),
  verdict: 'unknown',
  issues: [],
}

if (!cameUp) {
  report.verdict = 'app-not-responding'
  report.issues.push(`port ${PORT} never accepted a connection within ${timeoutSeconds}s`)
} else if (!after) {
  report.verdict = 'plugin-not-activated'
  report.issues.push('host-active.json is missing: apply() did not run, check `plugin_manager list_plugins` for include:memory fiberPhase')
} else if (before && after.pid === before.pid) {
  report.verdict = 'no-restart-observed'
  report.issues.push(`marker pid is still ${before.pid}: the app did not restart, so the new code may not be loaded`)
} else {
  report.verdict = 'ok'
}

await fs.mkdir(STATE_DIR, { recursive: true })
await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
