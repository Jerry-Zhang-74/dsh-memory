/**
 * Prompt-section registration against the REAL SystemPrompt service.
 *
 * This is the regression test for the bug that made every new session fail:
 *
 *   gateway/internal: failed to create session: Error: prompt section
 *   "memory:project" is already registered
 *
 * The memory block was registered under a fixed section name, so the second
 * agent to be created collided with the first and the whole session creation
 * aborted. The earlier plugin test used a stub `systemPrompt` that simply
 * pushed sections into an array, which cannot detect a duplicate — the stub was
 * the reason this shipped.
 *
 * So this suite mounts the real service and creates several agents, exactly as
 * the harness does.
 *
 *   node --test test/prompt-section.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-memory-section-'))
process.env.DSH_HOME = HOME

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

const { Context } = await load('cordis')
const { SystemPrompt } = await load('dsh-system-prompt')
const { ToolRuntime } = await load('dsh-tools')
const { CommandRuntime } = await load('dsh-commands')
const { SubagentRuntime } = await load('dsh-subagent')

const plugin = await import('../lib/host/index.js')

/**
 * Build a context carrying the real services plus whatever `agent/created`
 * listeners the plugin registered.
 *
 * @returns `{ ctx, listeners, systemPrompt, createAgent }`.
 */
function harness() {
  const ctx = new Context()
  const systemPrompt = new SystemPrompt(ctx, {})
  new ToolRuntime(ctx, {})
  new CommandRuntime(ctx)
  new SubagentRuntime(ctx, {})

  const listeners = []
  const originalOn = ctx.on.bind(ctx)
  ctx.on = (event, handler) => {
    listeners.push({ event, handler })
    return originalOn(event, handler)
  }

  plugin.apply(ctx, {})

  const created = listeners.filter((entry) => entry.event === 'agent/created')

  /**
   * Create one agent the way the harness announces it: a child scope for the
   * agent, then the event.
   *
   * @param sessionId - durable session identity.
   * @param cwd - the agent's working directory.
   */
  const createAgent = async (sessionId, cwd) => {
    const agentCtx = ctx.extend({ name: `agent:${sessionId}` })
    const agent = { ctx: agentCtx, session: { id: sessionId, meta: { cwd } }, sessionId }
    for (const listener of created) await listener.handler({ agent })
    return agent
  }

  return { ctx, listeners, systemPrompt, createAgent, created }
}

test('the plugin registers the agent/created listener', () => {
  const h = harness()
  assert.equal(h.created.length, 1, 'exactly one agent/created listener')
})

test('creating several agents must not throw a duplicate-section error', async () => {
  const h = harness()
  const folder = path.join(HOME, 'ws', 'many-agents')
  await fs.mkdir(folder, { recursive: true })

  // The real failure: the first agent registered a fixed section name and every
  // later agent collided with it, aborting session creation.
  const first = await h.createAgent('session-one', folder)
  assert.ok(first)

  for (const id of ['session-two', 'session-three', 'session-four']) {
    await h.createAgent(id, folder)
  }

  // Assembly must still succeed for every scope involved.
  const assembly = await h.systemPrompt.assemble({})
  assert.ok(Array.isArray(assembly.sections))
})

test('agents sharing a folder share one section, and never duplicate it', async () => {
  const h = harness()
  const folder = path.join(HOME, 'ws', 'names')
  await fs.mkdir(folder, { recursive: true })

  const perAgent = []
  for (const id of ['alpha', 'beta', 'gamma']) {
    const agent = await h.createAgent(id, folder)
    const assembly = await h.systemPrompt.assemble({ scope: agent.ctx.scope })
    const names = assembly.sections.map((section) => section.name)
    perAgent.push(names)

    // One section per bank, never one per agent: a child scope inherits its
    // ancestors', so a per-agent registration would put N copies of the memory
    // block into one prompt and burn context for nothing.
    const memorySections = names.filter((name) => name.startsWith('memory:project'))
    assert.equal(
      memorySections.length,
      1,
      `agent ${id} must see exactly one memory section, saw ${memorySections.join(', ')}`,
    )
  }

  // Same folder, same bank, same section — by design.
  const all = new Set(perAgent.flat().filter((name) => name.startsWith('memory:project')))
  assert.equal(all.size, 1, `expected a single shared section, got ${[...all].join(', ')}`)

  // The name is derived from the project id, so two banks can never collide.
  // (Whether the harness *filters* sections per scope is out of this plugin's
  // hands; what it controls is that one bank contributes exactly one name.)
  const [sharedName] = [...all]
  assert.match(sharedName, /^memory:project:[a-z0-9-]+$/i, `unexpected section name form: ${sharedName}`)

  const otherFolder = path.join(HOME, 'ws', 'other')
  await fs.mkdir(otherFolder, { recursive: true })
  const other = await h.createAgent('session-other', otherFolder)
  const otherNames = (await h.systemPrompt.assemble({ scope: other.ctx.scope }))
    .sections.map((section) => section.name)
    .filter((name) => name.startsWith('memory:project'))

  // A second bank registers its own name rather than reusing the first, and
  // must not add a second copy of the same one.
  assert.ok(otherNames.length >= 1, 'a distinct bank must register a section')
  const distinct = new Set(otherNames)
  assert.equal(distinct.size, otherNames.length, 'a bank must never register the same name twice')
  assert.ok(
    otherNames.some((name) => name !== sharedName),
    `a distinct bank must own a distinct name; saw only ${[...distinct].join(', ')}`,
  )
})

test('a re-announced agent is ignored rather than double-registering', async () => {
  const h = harness()
  const folder = path.join(HOME, 'ws', 'reannounce')
  await fs.mkdir(folder, { recursive: true })

  const agent = await h.createAgent('session-repeat', folder)
  // The same session announced twice must not add a second section.
  await h.created[0].handler({ agent })

  const assembly = await h.systemPrompt.assemble({ scope: agent.ctx.scope })
  const memorySections = assembly.sections.filter((section) => section.name.startsWith('memory:project'))
  assert.equal(memorySections.length, 1, 'idempotent per session')
})

test('the injected memory block reaches the assembled prompt', async () => {
  const h = harness()
  const folder = path.join(HOME, 'ws', 'content')
  await fs.mkdir(folder, { recursive: true })
  const agent = await h.createAgent('session-content', folder)

  // Save through the registered tool so the bank is populated the same way the
  // model would populate it.
  const tool = h.ctx.tools.get('memory')
  assert.ok(tool, 'the memory tool must be registered')
  await tool.execute(
    { action: 'save', name: 'Injected fact', body: 'this must reach the prompt' },
    { agent, signal: new AbortController().signal },
  )

  // Let the section's out-of-band refresh pick the change up.
  await plugin.refreshMemoryContext('session-content')
  const assembly = await h.systemPrompt.assemble({ scope: agent.ctx.scope })
  const section = assembly.sections.find((entry) => entry.name.startsWith('memory:project'))
  assert.ok(section, 'the memory section must be assembled')
  assert.match(section.text, /Injected fact/, 'freshly saved memory must be in the section text')
})

test('injectContext:false registers no section at all', async () => {
  const ctx = new Context()
  const systemPrompt = new SystemPrompt(ctx, {})
  // Mount the same services the real composition provides, or `apply` fails for
  // reasons unrelated to what this test is about.
  new ToolRuntime(ctx, {})
  new CommandRuntime(ctx)
  new SubagentRuntime(ctx, {})
  const listeners = []
  const originalOn = ctx.on.bind(ctx)
  ctx.on = (event, handler) => {
    listeners.push({ event, handler })
    return originalOn(event, handler)
  }
  plugin.apply(ctx, { injectContext: false })

  const folder = path.join(HOME, 'ws', 'off')
  await fs.mkdir(folder, { recursive: true })
  const agentCtx = ctx.extend({ name: 'agent:off' })
  for (const entry of listeners.filter((l) => l.event === 'agent/created')) {
    await entry.handler({ agent: { ctx: agentCtx, session: { id: 'off', meta: { cwd: folder } }, sessionId: 'off' } })
  }

  const assembly = await systemPrompt.assemble({ scope: agentCtx.scope })
  assert.equal(assembly.sections.filter((section) => section.name.startsWith('memory:project')).length, 0)
})
