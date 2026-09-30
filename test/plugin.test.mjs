/**
 * Smoke test for the dsh-memory plugin body.
 *
 * Verifies registration, the `/memory` command surface, the model-facing tools,
 * and per-agent prompt-section injection — all against a stub cordis context so
 * no harness restart is needed.
 *
 *   node --test test/plugin.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-memory-plugin-'))
process.env.DSH_HOME = HOME

const { apply, name, inject, refreshMemoryContext, memoryContextError } = await import('../lib/host/index.js')

/** A stub context recording everything the plugin registers. */
function stubContext() {
  const tools = []
  const commands = []
  const sections = []
  const listeners = []
  const isolated = []
  const ctx = {
    tools: { register: (definition) => tools.push(definition) },
    commands: { register: (definition) => commands.push(definition) },
    systemPrompt: { section: (section) => sections.push(section) },
    subagents: {
      startContinuable: async (spec) => {
        isolated.push(spec)
        return { childId: `child-${isolated.length}`, messageId: 'm1' }
      },
    },
    on: (event, handler) => listeners.push({ event, handler }),
    effect: (factory) => factory(),
  }
  return { ctx, tools, commands, sections, listeners, isolated }
}

/** A stub agent with a durable cwd and session id. */
function stubAgent(cwd) {
  return { session: { id: 'session-test', meta: { cwd } }, sessionId: 'session-test' }
}

/** Find one tool by name. */
const toolNamed = (tools, toolName) => tools.find((tool) => tool.name === toolName)

test('plugin exposes the expected cordis surface', async () => {
  assert.equal(name, 'memory')
  assert.ok(inject.includes('tools'))
  assert.ok(inject.includes('commands'))
  assert.ok(inject.includes('systemPrompt'))
  assert.ok(inject.includes('subagents'))
  assert.equal(typeof apply, 'function')

  // A `Config` export must be a Standard Schema: the Cordis loader calls
  // `Config['~standard'].validate(config)` before apply(). Exporting a plain
  // object there throws and leaves the fiber permanently `failed` — the exact
  // activation bug this guards against.
  const mod = await import('../lib/host/index.js')
  if ('Config' in mod && mod.Config !== undefined) {
    assert.equal(
      typeof mod.Config['~standard']?.validate,
      'function',
      'a Config export must implement the Standard Schema `~standard.validate` contract',
    )
  }
})

test('plugin registers all three tools and the /memory command', () => {
  const harness = stubContext()
  apply(harness.ctx, {})

  const names = harness.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['memory', 'memory_context', 'memory_files', 'memory_import'])
  assert.equal(harness.commands.length, 1)
  assert.equal(harness.commands[0].name, 'memory')

  // Tool definitions carry compiled raw JSON Schema, not the authoring spec.
  const memory = toolNamed(harness.tools, 'memory')
  assert.equal(memory.parameters.type, 'object')
  assert.deepEqual(memory.parameters.required, ['action'])
  assert.equal(memory.parameters.properties.action.type, 'string')
  assert.ok(memory.parameters.properties.action.enum.includes('save'))
  assert.equal(memory.output.schema.type, 'object')
  assert.deepEqual(memory.output.schema.required, ['ok', 'action', 'message', 'project'])
  assert.equal(typeof memory.output.render, 'function')
})

test('arguments are validated before the body runs', async () => {
  const harness = stubContext()
  apply(harness.ctx, {})
  const memory = toolNamed(harness.tools, 'memory')
  const exec = { agent: stubAgent('/tmp/x'), signal: new AbortController().signal }

  await assert.rejects(() => memory.execute({}, exec), /action is required/)
  await assert.rejects(() => memory.execute({ action: 'nonsense' }, exec), /must be one of/)
  await assert.rejects(() => memory.execute({ action: 'save', tags: 'not-an-array' }, exec), /tags must be an array/)
})

test('the memory tool round-trips save, read, recall and forget', async () => {
  const folder = path.join(HOME, 'workspace-tool')
  await fs.mkdir(folder, { recursive: true })
  const harness = stubContext()
  apply(harness.ctx, {})
  const memory = toolNamed(harness.tools, 'memory')
  const exec = { agent: stubAgent(folder), signal: new AbortController().signal }

  const saved = await memory.execute(
    { action: 'save', name: 'Uses pnpm', body: 'This project uses pnpm, never npm.', type: 'project', tags: ['tooling'] },
    exec,
  )
  assert.equal(saved.ok, true)
  assert.equal(saved.action, 'save')
  assert.equal(saved.project.label, 'workspace-tool')
  assert.ok(saved.memory.id)

  const read = await memory.execute({ action: 'read', id: saved.memory.id }, exec)
  assert.equal(read.memory.name, 'Uses pnpm')

  const recalled = await memory.execute({ action: 'recall', query: 'pnpm' }, exec)
  assert.equal(recalled.memories.length, 1)

  const listed = await memory.execute({ action: 'list' }, exec)
  assert.equal(listed.memories.length, 1)

  const stats = await memory.execute({ action: 'stats' }, exec)
  assert.equal(stats.stats.total, 1)
  assert.equal(stats.stats.byType.project, 1)

  const forgotten = await memory.execute({ action: 'forget', id: saved.memory.id }, exec)
  assert.equal(forgotten.ok, true)
  assert.equal((await memory.execute({ action: 'list' }, exec)).memories.length, 0)
})

test('memory_context honours the budget and reports its shape', async () => {
  const folder = path.join(HOME, 'workspace-ctx')
  await fs.mkdir(folder, { recursive: true })
  const harness = stubContext()
  apply(harness.ctx, {})
  const memory = toolNamed(harness.tools, 'memory')
  const contextTool = toolNamed(harness.tools, 'memory_context')
  const exec = { agent: stubAgent(folder), signal: new AbortController().signal }

  for (let i = 0; i < 3; i += 1) {
    await memory.execute({ action: 'save', name: `Fact ${i}`, body: `body number ${i}` }, exec)
  }
  const block = await contextTool.execute({ budget: 100000 }, exec)
  assert.equal(block.ok, true)
  assert.equal(block.count, 3)
  assert.match(block.text, /Fact 2/)

  const focused = await contextTool.execute({ query: 'Fact 1', budget: 100000 }, exec)
  assert.ok(focused.count >= 1)
})

test('the /memory command reports status, list, export and bind', async () => {
  const folder = path.join(HOME, 'workspace-cmd')
  await fs.mkdir(folder, { recursive: true })
  const harness = stubContext()
  apply(harness.ctx, {})
  const command = harness.commands[0]
  const agent = stubAgent(folder)

  const status = await command.handler({ agent, rawInput: '', signal: undefined })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /Memory project:/)
  assert.match(status.text, /memories: 0/)

  const memory = toolNamed(harness.tools, 'memory')
  await memory.execute({ action: 'save', name: 'Command fact', body: 'created via tool' }, { agent, signal: undefined })

  const list = await command.handler({ agent, rawInput: ' list', signal: undefined })
  assert.match(list.text, /Command fact/)

  const show = await command.handler({ agent, rawInput: ' show Command fact', signal: undefined })
  assert.match(show.text, /created via tool/)

  const exported = await command.handler({ agent, rawInput: ' export', signal: undefined })
  assert.equal(exported.kind, 'success')
  assert.match(exported.text, /Exported \*\*1\*\* memories/)

  const projects = await command.handler({ agent, rawInput: ' projects', signal: undefined })
  assert.match(projects.text, /workspace-cmd/)

  const unknown = await command.handler({ agent, rawInput: ' frobnicate', signal: undefined })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /unknown subcommand/)
})

test('/memory bind attaches a second folder to the same bank', async () => {
  const first = path.join(HOME, 'bind-a')
  const second = path.join(HOME, 'bind-b')
  await fs.mkdir(first, { recursive: true })
  await fs.mkdir(second, { recursive: true })
  const harness = stubContext()
  apply(harness.ctx, {})
  const command = harness.commands[0]
  const agent = stubAgent(first)

  await toolNamed(harness.tools, 'memory').execute({ action: 'save', name: 'Shared', body: 'spans folders' }, { agent, signal: undefined })

  const bound = await command.handler({ agent, rawInput: ` bind ${second}`, signal: undefined })
  assert.equal(bound.kind, 'success')

  // A session in the second folder now sees the same bank.
  const otherAgent = stubAgent(second)
  const list = await toolNamed(harness.tools, 'memory').execute({ action: 'list' }, { agent: otherAgent, signal: undefined })
  assert.equal(list.memories.length, 1)
  assert.equal(list.memories[0].name, 'Shared')
})

test('/memory no longer opens side conversations: that is its own plugin', async () => {
  const folder = path.join(HOME, 'chat-moved-out')
  await fs.mkdir(folder, { recursive: true })
  const harness = stubContext()
  apply(harness.ctx, {})
  const command = harness.commands[0]
  const agent = stubAgent(folder)

  // The subcommand is gone, so nothing in the memory plugin can open a chat.
  const result = await command.handler({ agent, rawInput: ' chat do something', signal: undefined })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /unknown subcommand/)
  assert.equal(harness.isolated.length, 0, 'the memory plugin must not open conversations for this')
})

test('/memory import stages the file and hands it to an isolated conversation', async () => {
  const folder = path.join(HOME, 'workspace-import')
  await fs.mkdir(folder, { recursive: true })
  const harness = stubContext()
  apply(harness.ctx, {})
  const command = harness.commands[0]
  const agent = stubAgent(folder)

  const source = path.join(folder, 'incoming.md')
  await fs.writeFile(source, '## Imported fact one\n\nvalue one\n\n## Imported fact two\n\nvalue two\n', 'utf8')

  const result = await command.handler({ agent, rawInput: ` import ${source}`, signal: undefined })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Staged \*\*2\*\* candidate memories/)
  assert.match(result.text, /isolated conversation is now processing it: session `child-1`/)

  // The import must be staged, not merged: an isolated conversation reviews it first.
  assert.equal(harness.isolated.length, 1)
  const prompt = harness.isolated[0].request.prompt[0].text
  assert.match(prompt, /process an imported memory export/)
  assert.match(prompt, /import\.json/)
  assert.match(prompt, /Never store credentials/)

  const bank = await toolNamed(harness.tools, 'memory').execute({ action: 'list' }, { agent, signal: undefined })
  assert.equal(bank.memories.length, 0, 'staging must not write into the bank')

  const missing = await command.handler({ agent, rawInput: ' import /nope/missing.md', signal: undefined })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /cannot read/)
})

test('/memory import-now merges directly when the user wants no conversation', async () => {
  const folder = path.join(HOME, 'workspace-import-now')
  await fs.mkdir(folder, { recursive: true })
  const harness = stubContext()
  apply(harness.ctx, {})
  const command = harness.commands[0]
  const agent = stubAgent(folder)

  const source = path.join(folder, 'direct.json')
  await fs.writeFile(source, JSON.stringify([{ name: 'Direct A', body: 'alpha' }, { name: 'Direct B', body: 'beta' }]), 'utf8')

  const result = await command.handler({ agent, rawInput: ` import-now ${source}`, signal: undefined })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Imported 2 of 2 candidates directly/)
  assert.equal(harness.isolated.length, 0)

  const bank = await toolNamed(harness.tools, 'memory').execute({ action: 'list' }, { agent, signal: undefined })
  assert.equal(bank.memories.length, 2)
})

test('agent/created installs a scoped memory section that renders live content', async () => {
  const folder = path.join(HOME, 'workspace-section')
  await fs.mkdir(folder, { recursive: true })
  const harness = stubContext()
  apply(harness.ctx, {})

  const createdListeners = harness.listeners.filter((entry) => entry.event === 'agent/created')
  assert.equal(createdListeners.length, 1)

  const agent = stubAgent(folder)
  await createdListeners[0].handler({ agent })

  assert.equal(harness.sections.length, 1)
  // The name is per PROJECT, not a constant: a fixed name collided as soon as a
  // second agent existed, and a duplicate aborts session creation outright.
  assert.match(harness.sections[0].name, /^memory:project:/)
  assert.equal(harness.sections[0].order, 120)

  // Re-firing creation for the same session must not double-register the
  // section (a duplicate section name throws inside the real registry).
  await createdListeners[0].handler({ agent })
  assert.equal(harness.sections.length, 1)

  // The provider is synchronous, so it serves a snapshot; refreshing rebuilds
  // it from the bank and proves a saved memory lands in context.
  await toolNamed(harness.tools, 'memory').execute(
    { action: 'save', name: 'Context fact', body: 'always visible' },
    { agent, signal: undefined },
  )
  const fresh = await refreshMemoryContext('session-test')
  assert.equal(await memoryContextError('session-test'), null)
  assert.match(fresh, /Memory: workspace-section/)
  assert.match(fresh, /Context fact/)
  assert.match(harness.sections[0].text(), /Context fact/)

  // A second refresh with no bank change must be a cheap no-op that still
  // returns the same content.
  assert.match(await refreshMemoryContext('session-test'), /Context fact/)

  // A changed bank must be picked up on the next refresh.
  await toolNamed(harness.tools, 'memory').execute(
    { action: 'save', name: 'Second fact', body: 'also visible' },
    { agent, signal: undefined },
  )
  assert.match(await refreshMemoryContext('session-test'), /Second fact/)
})

test('injectContext:false disables the prompt section', async () => {
  const harness = stubContext()
  apply(harness.ctx, { injectContext: false })
  const agent = stubAgent(path.join(HOME, 'workspace-off'))
  for (const listener of harness.listeners.filter((entry) => entry.event === 'agent/created')) {
    await listener.handler({ agent })
  }
  assert.equal(harness.sections.length, 0)
})
