/**
 * Two banks: project memory vs the personal archive.
 *
 * A fact about a folder and a fact about the person are different things, and
 * mixing them is the failure this separation exists to prevent — a project list
 * showing the person's whole history, and a personal note looking like it
 * belonged to whichever folder happened to be open.
 *
 * These tests pin both the separation and the ways a caller moves between them.
 *
 *   node --test test/two-banks.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { MemoryStore, PERSONAL_PROJECT_ID } = await import('../lib/host/store.js')
const { memoryTools } = await import('../lib/host/tools.js')

/**
 * Build tools over a FRESH memory home.
 *
 * The personal archive is one bank per harness home, so a shared `DSH_HOME`
 * would let one test's personal entries leak into the next. Each case gets its
 * own home, which is also what makes "the archive holds exactly one copy"
 * meaningful.
 */
async function harness(folderName) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `dsh-memory-banks-${folderName}-`))
  process.env.DSH_HOME = home

  const folder = path.join(home, 'ws', folderName)
  await fs.mkdir(folder, { recursive: true })

  const store = new MemoryStore()
  const tools = Object.fromEntries(memoryTools(store).map((tool) => [tool.name, tool]))
  const agent = { session: { id: `session-${folderName}`, meta: { cwd: folder } }, sessionId: `session-${folderName}` }
  const exec = { agent, signal: new AbortController().signal }
  return { home, store, folder, tools, agent, exec }
}

test('the personal archive is created on demand and owns no folder', async () => {
  const { store, folder } = await harness('personal-shape')

  const personal = await store.personal()
  assert.equal(personal.id, PERSONAL_PROJECT_ID)
  assert.deepEqual(personal.folders, [], 'the archive must not be bound to any folder')

  // And no folder resolves into it, however the path is spelled.
  const resolved = await store.resolve(folder)
  assert.notEqual(resolved.id, PERSONAL_PROJECT_ID, 'a folder must never resolve to the archive')
})

test('a project save lands in the project, a personal save in the archive', async () => {
  const { store, tools, exec, folder } = await harness('routing')

  await tools.memory.execute(
    { action: 'save', name: 'Uses pnpm here', body: 'this repo uses pnpm', scope: 'project' },
    exec,
  )
  await tools.memory.execute(
    { action: 'save', name: 'Prefers concise answers', body: 'no filler, no preamble', scope: 'personal' },
    exec,
  )

  const project = await store.resolve(folder)
  const personal = await store.personal()

  assert.deepEqual((await project.list()).map((r) => r.name), ['Uses pnpm here'])
  assert.deepEqual((await personal.list()).map((r) => r.name), ['Prefers concise answers'])

  // The personal entry records itself as global, so the archive is
  // self-describing even when read on its own.
  assert.equal((await personal.list())[0].scope, 'global')
})

test('a default save goes to the project, never silently to the archive', async () => {
  const { store, tools, exec, folder } = await harness('default-scope')
  await tools.memory.execute({ action: 'save', name: 'No scope given', body: 'defaults to the project' }, exec)

  const project = await store.resolve(folder)
  const personal = await store.personal()
  assert.equal((await project.list()).length, 1)
  assert.equal((await personal.list()).length, 0, 'an unscoped save must not reach the archive')
})

test('list and recall span both banks and label each entry', async () => {
  const { tools, exec } = await harness('spanning')
  await tools.memory.execute({ action: 'save', name: 'Project thing', body: 'about this folder' }, exec)
  await tools.memory.execute({ action: 'save', name: 'Personal thing', body: 'about the person', scope: 'personal' }, exec)

  const listed = await tools.memory.execute({ action: 'list' }, exec)
  const byName = Object.fromEntries(listed.memories.map((memory) => [memory.name, memory]))
  assert.equal(byName['Project thing'].scope, 'project')
  assert.equal(byName['Personal thing'].scope, 'global', 'a personal entry is labelled when listed from a project')
  assert.match(listed.message, /personal archive/)

  // Narrowing works in both directions.
  const onlyProject = await tools.memory.execute({ action: 'list', scope: 'project' }, exec)
  assert.deepEqual(onlyProject.memories.map((m) => m.name), ['Project thing'])
  const onlyPersonal = await tools.memory.execute({ action: 'list', scope: 'personal' }, exec)
  assert.deepEqual(onlyPersonal.memories.map((m) => m.name), ['Personal thing'])

  // Recall finds the personal entry without being told where to look.
  const recalled = await tools.memory.execute({ action: 'recall', query: 'person' }, exec)
  assert.ok(recalled.memories.some((memory) => memory.name === 'Personal thing'))
})

test('read finds an entry in either bank without being told which', async () => {
  const { tools, exec } = await harness('read-anywhere')
  await tools.memory.execute({ action: 'save', name: 'Personal only', body: 'in the archive', scope: 'personal' }, exec)

  const read = await tools.memory.execute({ action: 'read', id: 'Personal only' }, exec)
  assert.equal(read.ok, true)
  assert.match(read.message, /personal archive/)
  assert.equal(read.memory.scope, 'global')
})

test('changing scope MOVES an entry between banks instead of relabelling it', async () => {
  const { store, tools, exec, folder } = await harness('moving')
  const project = await store.resolve(folder)
  const personal = await store.personal()

  await tools.memory.execute({ action: 'save', name: 'Started in project', body: 'body' }, exec)
  assert.equal((await project.list()).length, 1)

  // Promote it: it turns out to be a general fact.
  const moved = await tools.memory.execute({ action: 'update', id: 'Started in project', scope: 'personal' }, exec)
  assert.equal(moved.ok, true)
  assert.match(moved.message, /personal archive/)

  assert.equal((await project.list()).length, 0, 'the project must not keep a stale copy')
  assert.equal((await personal.list()).length, 1, 'the archive must hold exactly one copy')
  assert.equal((await personal.list())[0].name, 'Started in project')
})

test('the core note is per bank, so the archive has its own', async () => {
  const { tools, exec } = await harness('core-notes')

  await tools.memory.execute({ action: 'core', coreText: 'project core' }, exec)
  await tools.memory.execute({ action: 'core', scope: 'personal', coreText: 'personal core' }, exec)

  const projectCore = await tools.memory.execute({ action: 'core' }, exec)
  const personalCore = await tools.memory.execute({ action: 'core', scope: 'personal' }, exec)
  assert.equal(projectCore.text.trim(), 'project core')
  assert.equal(personalCore.text.trim(), 'personal core')
})

test('the injected block separates the two, and personal entries are not project entries', async () => {
  const { store, tools, exec, folder } = await harness('block')
  await tools.memory.execute({ action: 'save', name: 'Folder fact', body: 'belongs to the folder' }, exec)
  await tools.memory.execute({ action: 'save', name: 'Person fact', body: 'belongs to the person', scope: 'personal' }, exec)

  const project = await store.resolve(folder)
  const personal = await store.personal()
  const block = await project.renderContextBlock(20000, personal)

  assert.match(block, /## Memory index/)
  assert.match(block, /## Personal archive/)
  assert.match(block, /Folder fact/)
  assert.match(block, /Person fact/)

  // The headings must be separate, and the project index must not swallow the
  // personal entry: that is the "don't mix them" requirement made checkable.
  const projectIndex = block.slice(block.indexOf('## Memory index'), block.indexOf('## Personal archive'))
  assert.match(projectIndex, /Folder fact/)
  assert.doesNotMatch(projectIndex, /Person fact/, 'a personal entry must not appear in the project index')

  // Rendering the archive on its own must not invent a project section.
  const personalOnly = await personal.renderContextBlock(20000)
  assert.match(personalOnly, /Personal archive/)
  assert.doesNotMatch(personalOnly, /## Memory index/)
})
