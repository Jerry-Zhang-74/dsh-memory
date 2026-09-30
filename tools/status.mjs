/**
 * dsh-memory — agent status writer.
 *
 * The point: make "what is the agent doing right now?" answerable from outside
 * the process, at any moment, over a remote connection. The watchdog already
 * proves the *app* is alive; this proves the *work* is alive.
 *
 * Run it whenever the agent wants to record a heartbeat, and read the JSON it
 * produces from anywhere:
 *
 *   node tools/status.mjs --summary "checkpoint passed" --tests 54/54
 *   Get-Content ~/.dsh/storages/dsh-memory/state/agent-status.json
 *
 * It merges rather than overwrites, so a caller that only knows one field does
 * not erase the rest.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'storages', 'dsh-memory', 'state')
const STATUS = path.join(STATE_DIR, 'agent-status.json')
const HEARTBEAT = path.join(STATE_DIR, 'watchdog-heartbeat.json')
const MARKER = path.join(STATE_DIR, 'host-active.json')
const PORT = 19387

/** Read a JSON file, or undefined. */
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

/** Collect `--flag value` pairs. */
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
const now = new Date().toISOString()

// Facts this script can establish by itself, so a caller only supplies what it
// uniquely knows (the summary and any pending items).
const [portUp, marker, heartbeat, previous] = await Promise.all([
  portOpen(),
  readJson(MARKER),
  readJson(HEARTBEAT),
  readJson(STATUS),
])

const status = {
  ...(previous ?? {}),
  at: now,
  agentAlive: true,
  appResponding: portUp,
  hostPid: marker?.pid ?? previous?.hostPid ?? null,
  pluginActivatedAt: marker?.activatedAt ?? previous?.pluginActivatedAt ?? null,
  watchdog:
    heartbeat === undefined
      ? { seen: false }
      : { seen: true, lastAt: heartbeat.at, state: heartbeat.state, verdict: heartbeat.verdict },
}

if (args.summary) status.summary = String(args.summary)
if (args.tests) {
  const [passed, total] = String(args.tests).split('/')
  status.tests = { passed: Number(passed), total: Number(total), at: now }
}
if (args.pending) {
  status.pending = String(args.pending)
    .split('|')
    .map((entry) => entry.trim())
    .filter(Boolean)
}
if (args.plugins) {
  status.plugins = String(args.plugins)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

await fs.mkdir(STATE_DIR, { recursive: true })
await fs.writeFile(STATUS, `${JSON.stringify(status, null, 2)}\n`)

if (args.quiet !== true) console.log(JSON.stringify(status, null, 2))
