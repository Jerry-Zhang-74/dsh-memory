/**
 * Atomic-write robustness.
 *
 * Both failure modes here were observed for real, not invented:
 *   - EPERM when a Windows reader holds the destination open during rename
 *   - ENOENT when the staged temp file vanished between write and rename
 *
 * `atomicWriteHooks.beforePublish` makes each deterministic instead of racy.
 *
 *   node --test test/atomic-write.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-memory-atomic-'))
process.env.DSH_HOME = HOME

const { MemoryStore, atomicWriteHooks } = await import('../lib/host/store.js')

/** A fresh project per test. */
async function project(name) {
  const folder = path.join(HOME, 'ws', name)
  await fs.mkdir(folder, { recursive: true })
  return new MemoryStore().resolve(folder)
}

test.afterEach(() => {
  atomicWriteHooks.beforePublish = null
})

test('baseline: writes land and leave no temp files behind', async () => {
  const p = await project('baseline')
  await p.save({ name: 'Plain', body: 'ordinary write' })
  await p.writeCore('core text')

  assert.equal((await p.list())[0].name, 'Plain')
  assert.equal((await p.readCore()).trim(), 'core text')

  const leftovers = (await fs.readdir(p.memoriesDir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('a staged temp file deleted before publish still lands the write', async () => {
  const p = await project('temp-vanishes')

  // Simulate a scanner/temp-cleaner removing the staged file. This is the
  // ENOENT-on-rename-source case that broke a real run.
  atomicWriteHooks.beforePublish = async (temp) => {
    await fs.rm(temp, { force: true })
  }

  const record = await p.save({ name: 'Survivor', body: 'must reach the disk' })
  assert.ok(record.id)

  atomicWriteHooks.beforePublish = null
  const listed = await p.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'Survivor')
  assert.equal(listed[0].body.trim(), 'must reach the disk')
})

test('a destination held open for reading still receives the write', async () => {
  const p = await project('reader-holds')
  await p.writeCore('first version')

  // Hold the destination open for reading, which is exactly what the background
  // memory-section refresh does while a write arrives on Windows.
  const handle = await fs.open(p.corePath, 'r')
  try {
    await p.writeCore('second version')
  } finally {
    await handle.close()
  }

  assert.equal((await p.readCore()).trim(), 'second version')
})

test('repeated failures fall back to an in-place write rather than losing data', async () => {
  const p = await project('give-up')

  let interventions = 0
  atomicWriteHooks.beforePublish = async (temp) => {
    interventions += 1
    await fs.rm(temp, { force: true })
  }

  await p.writeCore('eventually written')

  atomicWriteHooks.beforePublish = null
  assert.ok(interventions >= 1, 'the hook must actually have interfered')
  assert.equal((await p.readCore()).trim(), 'eventually written')
})

test('concurrent saves and renders do not corrupt the bank', async () => {
  const p = await project('concurrent')

  let stop = false
  const reader = (async () => {
    while (!stop) {
      await p.readCore()
      await p.renderContextBlock(8000)
    }
  })()

  for (let i = 0; i < 25; i += 1) {
    await p.save({ name: `Fact ${i}`, body: `body ${i}` })
    await p.writeCore(`core revision ${i}`)
  }
  stop = true
  await reader

  assert.equal((await p.list()).length, 25)
  assert.equal((await p.readCore()).trim(), 'core revision 24')
  const leftovers = (await fs.readdir(p.dir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'no temp files may be left behind')
})
