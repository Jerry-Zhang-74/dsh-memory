/**
 * Activation harness: run the plugin body against the REAL cordis runtime and
 * the REAL DSH service classes, so an activation failure surfaces as the exact
 * thrown error instead of the loader's summary "failed to import".
 *
 * Usage: node test/activate.mjs
 */

import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

const APP = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'npm',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'node_modules',
  '@deepseek-ai',
)

const load = (pkg) => import(pathToFileURL(path.join(APP, pkg, 'lib', 'index.js')).href)

const { Context, resolveConfig } = await load('cordis')
const { ToolRuntime } = await load('dsh-tools')
const { SystemPrompt } = await load('dsh-system-prompt')
const { CommandRuntime } = await load('dsh-commands')
const { SubagentRuntime } = await load('dsh-subagent')

// Keep the harness off the live profile's banks.
process.env.DSH_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-memory-activate-'))

const plugin = await import(pathToFileURL(path.join(process.cwd(), 'lib', 'host', 'index.js')).href)
console.log('imported exports:', Object.keys(plugin).join(', '))
console.log('declared inject:', JSON.stringify(plugin.inject))

// The loader validates a plugin's `Config` export as a Standard Schema before
// calling apply(). A plain object there throws and leaves the fiber `failed`,
// so this gate runs first: it is the exact check that broke activation once.
try {
  console.log('resolveConfig ->', JSON.stringify(resolveConfig(plugin, {})))
} catch (error) {
  console.log('!! resolveConfig THREW (the loader would leave this fiber failed):', error?.message ?? error)
  process.exit(1)
}

const ctx = new Context()

// Each service is a Cordis `Service`: constructing it publishes itself under its
// own key, so nothing here calls `ctx.provide` for them.
for (const [label, create] of [
  ['systemPrompt', () => new SystemPrompt(ctx, {})],
  ['tools', () => new ToolRuntime(ctx, {})],
  ['commands', () => new CommandRuntime(ctx)],
  ['subagents', () => new SubagentRuntime(ctx, {})],
]) {
  try {
    create()
    console.log(`  mounted ${label}`)
  } catch (error) {
    console.log(`!! could not mount ${label}:`, error?.message ?? error)
    process.exit(1)
  }
}

console.log('--- invoking apply(ctx, {}) ---')
try {
  plugin.apply(ctx, {})
  console.log('apply() returned cleanly')
} catch (error) {
  console.log('!! apply() THREW:')
  console.log(error?.stack ?? String(error))
  process.exitCode = 1
}

await new Promise((resolve) => setTimeout(resolve, 250))

// Report what actually reached the registries.
try {
  const names = ctx.tools.schemas().map((schema) => schema.name)
  console.log('registered tools:', JSON.stringify(names))
} catch (error) {
  console.log('!! could not list tools:', error.message)
}
try {
  const commands = ctx.commands.list({ session: { id: 'harness' } }).map((command) => command.name)
  console.log('registered commands:', JSON.stringify(commands))
} catch (error) {
  console.log('!! could not list commands:', error.message)
}
try {
  const assembly = await ctx.systemPrompt.assemble({})
  console.log('global prompt sections:', JSON.stringify(assembly.sections.map((section) => section.name)))
} catch (error) {
  console.log('!! could not assemble prompt:', error.message)
}

const marker = path.join(process.env.DSH_HOME, 'storages', 'dsh-memory', 'state', 'host-active.json')
console.log('marker written:', await fs.access(marker).then(() => true, () => false))

// Exercise one tool end-to-end through the real registry.
try {
  const folder = path.join(process.env.DSH_HOME, 'workspace')
  await fs.mkdir(folder, { recursive: true })
  const agent = { session: { id: 'harness-session', meta: { cwd: folder } } }
  const result = await ctx.tools.execute({
    callId: 'call-1',
    name: 'memory',
    arguments: { action: 'save', name: 'Harness fact', body: 'written by the activation harness' },
    agent,
    signal: new AbortController().signal,
  })
  console.log('memory tool result isError:', result.isError)
  console.log('memory tool content:', JSON.stringify(result.content))
} catch (error) {
  console.log('!! tool execution failed:', error?.message ?? error)
}

process.exit(process.exitCode ?? 0)
