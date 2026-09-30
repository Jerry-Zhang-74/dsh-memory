/**
 * A conversation outside every project still carries memory.
 *
 * The distinction this pins down is the one worth getting right:
 *
 *   - Being outside the projects does NOT mean being without memory. What is
 *     known about the person — preferences, background, habits — travels into
 *     every conversation, exactly as account-level memory does in Claude and
 *     ChatGPT.
 *   - What such a conversation does NOT carry is any single PROJECT's memory,
 *     because there is no folder to key it to.
 *
 * So there are three seats, not two:
 *
 *   project sessions      project memory + the personal archive
 *   `chat`                the personal archive only
 *   `chat-empty`          nothing at all
 *
 *   node --test test/personal-only.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { MemoryStore } = await import('../lib/host/store.js')
const { memoryTools } = await import('../lib/host/tools.js')
const { parseClaudeMemory } = await import('../lib/host/claude-memory.js')

/** A fresh memory home plus tools bound to one bank mode. */
async function harness(name, options) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `dsh-memory-po-${name}-`))
  process.env.DSH_HOME = home
  const folder = path.join(home, 'ws', name)
  await fs.mkdir(folder, { recursive: true })

  const store = new MemoryStore()
  const tools = Object.fromEntries(memoryTools(store, options).map((tool) => [tool.name, tool]))
  const agent = { session: { id: `s-${name}`, meta: { cwd: folder } }, sessionId: `s-${name}` }
  const exec = { agent, signal: new AbortController().signal }
  return { home, store, folder, tools, exec }
}

test('a project-less save goes to the archive, never inventing a project', async () => {
  const { store, tools, exec, folder } = await harness('save', { personalOnly: true })

  const saved = await tools.memory.execute(
    { action: 'save', name: 'Prefers terse answers', body: 'no preamble', type: 'user' },
    exec,
  )
  assert.equal(saved.ok, true)
  assert.match(saved.message, /personal archive/, 'a project-less save must land in the archive')
  assert.equal(saved.memory.scope, 'global')

  // The folder must NOT have acquired a project bank as a side effect.
  const personal = await store.personal()
  assert.equal((await personal.list()).length, 1)
  const registry = await store.readRegistry()
  const projects = Object.values(registry.projects)
  assert.equal(projects.length, 1, `expected only the archive, got ${projects.map((p) => p.id).join(', ')}`)
  assert.equal(projects[0].id, '_personal')

  // And resolving the folder is still possible for real project sessions, but
  // it is a different bank that this save did not touch.
  const projectBank = await store.resolve(folder)
  assert.equal((await projectBank.list()).length, 0)
})

test('an explicit project scope is ignored here rather than creating a project', async () => {
  const { store, tools, exec } = await harness('ignored', { personalOnly: true })
  const saved = await tools.memory.execute({ action: 'save', name: 'Explicit project scope', body: 'x', scope: 'project' }, exec)

  assert.match(saved.message, /personal archive/)
  assert.equal(saved.memory.scope, 'global', 'there is no project bank to honour a project scope')
  assert.equal((await store.personal()).list ? (await (await store.personal()).list()).length : 0, 1)
})

test('a project-less conversation sees the archive and no project memory', async () => {
  const { store, tools, exec, folder } = await harness('isolation', { personalOnly: true })

  // Seed a project bank directly, as another session would have.
  const projectBank = await store.resolve(folder)
  await projectBank.save({ name: 'Project-only fact', body: 'belongs to the folder' })

  const personal = await store.personal()
  await personal.save({ name: 'Personal fact', body: 'belongs to the person', scope: 'global' })

  // Listing here must show the archive alone.
  const listed = await tools.memory.execute({ action: 'list' }, exec)
  assert.deepEqual(listed.memories.map((m) => m.name), ['Personal fact'])
  assert.doesNotMatch(JSON.stringify(listed), /Project-only fact/, 'a project fact must not reach a project-less conversation')

  // Reading a project entry by name must fail rather than leak it.
  const read = await tools.memory.execute({ action: 'read', id: 'Project-only fact' }, exec)
  assert.equal(read.ok, false, 'a project entry must be unreachable here')

  // Recall searches the archive only.
  const recalled = await tools.memory.execute({ action: 'recall', query: 'folder' }, exec)
  assert.ok(!recalled.memories.some((m) => m.name === 'Project-only fact'))
})

test('the injected block for a project-less conversation is the archive alone', async () => {
  const { store } = await harness('block', { personalOnly: true })
  const personal = await store.personal()
  await personal.save({ name: 'Known about them', body: 'likes brief answers', scope: 'global' })

  const block = await personal.renderContextBlock(20000)
  assert.match(block, /Personal archive/)
  assert.match(block, /Known about them/)
  // No project heading, because there is no project.
  assert.doesNotMatch(block, /## Memory index/)
})

test('the tool description tells the model it has memory, and what not to save', async () => {
  const project = await harness('desc-project', {})
  const personal = await harness('desc-personal', { personalOnly: true })

  const projectDescription = project.tools.memory.description
  const personalDescription = personal.tools.memory.description

  // The project seat explains both banks and how to choose.
  assert.match(projectDescription, /project/)
  assert.match(projectDescription, /personal/)
  assert.match(projectDescription, /BOTH banks/)

  // The project-less seat must still promise memory. Getting this wrong is the
  // whole bug this suite exists for: "outside a project" is not "without
  // memory".
  assert.match(personalDescription, /personal archive/i)
  assert.match(personalDescription, /travels with them everywhere|outlive/i)
  // It must not offer project actions that do not exist here.
  assert.doesNotMatch(personalDescription, /- bind:/)
  assert.doesNotMatch(personalDescription, /- projects:/)

  // And it must steer codebase detail away, since a personal entry surfaces in
  // every conversation.
  assert.match(personalDescription, /folder- or codebase-specific|belongs to a project session/i)
})

test('a personal fact saved in a project-less chat reaches project sessions', async () => {
  const { store, tools, exec, folder } = await harness('shared', { personalOnly: true })
  await tools.memory.execute({ action: 'save', name: 'Works in Chinese', body: 'unless asked otherwise', type: 'user' }, exec)

  // A project session renders its own bank plus the archive, so the same fact
  // is present there — that is what "account-level memory" means.
  const projectBank = await store.resolve(folder)
  const personal = await store.personal()
  const block = await projectBank.renderContextBlock(20000, personal)
  assert.match(block, /Works in Chinese/)
  assert.match(block, /Personal archive/)
})

test('the chat preset composes the persona and a personal-only memory mount', async () => {
  const root = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', '.agent-presets', 'chat')
  const exists = await fs.access(root).then(() => true, () => false)
  if (!exists) return

  const composition = await fs.readFile(path.join(root, 'agent.cordis.yml'), 'utf8')
  const rows = composition
    .split('\n')
    .map((line) => /^-\s+id:\s*(\S+)/.exec(line)?.[1])
    .filter(Boolean)
  assert.deepEqual(rows.sort(), ['memory', 'persona'], `expected persona + memory, got ${rows.join(', ')}`)

  // The whole point: memory is present, and scoped to the archive.
  assert.match(composition, /personalOnly:\s*true/)

  // Nothing project-shaped may be composed: no files, shell, search, delegation.
  for (const forbidden of ['dsh-tool-fs', 'dsh-tool-pwsh', 'dsh-tool-bash', 'dsh-tool-web', 'dsh-tool-subagent']) {
    assert.ok(!composition.includes(forbidden), `a project-less chat must not compose ${forbidden}`)
  }
  assert.match(composition, /complete:\s*true/)
})
