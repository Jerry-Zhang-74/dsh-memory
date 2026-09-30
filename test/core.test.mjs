/**
 * Self-test for the dsh-memory host core.
 *
 * Runs the store, transfer and zip paths against a throwaway DSH_HOME so the
 * live profile is never touched. Run with:
 *   node --test test/core.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-memory-test-'))
process.env.DSH_HOME = HOME

const { MemoryStore, memoryRoot, parseMemoryFile } = await import('../lib/host/store.js')
const { parseImport, mergeCandidates, stageImport, exportProject, buildBundle } = await import('../lib/host/transfer.js')

/** Create a throwaway project rooted at a temp folder. */
async function makeProject(name) {
  const folder = path.join(HOME, 'projects-src', name)
  await fs.mkdir(folder, { recursive: true })
  const store = new MemoryStore()
  return { store, folder, project: await store.resolve(folder) }
}

test('store: save, list, read, search, update, edit, forget', async () => {
  const { project } = await makeProject('alpha')

  const saved = await project.save({
    name: 'Prefers tabs over spaces',
    body: 'The user always indents with tabs in this repository.',
    description: 'indentation preference',
    type: 'feedback',
    tags: ['style', 'formatting'],
  })
  assert.equal(saved.type, 'feedback')
  assert.deepEqual(saved.tags, ['style', 'formatting'])

  const listed = await project.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'Prefers tabs over spaces')
  assert.equal(listed[0].updated, listed[0].modified ?? listed[0].updated)

  const found = await project.search('indentation tabs')
  assert.equal(found.length, 1)
  assert.ok(found[0].score > 0)

  const byName = await project.get('Prefers tabs over spaces')
  assert.equal(byName.id, saved.id)

  const updated = await project.update(saved.id, { description: 'tabs, never spaces' })
  assert.equal(updated.description, 'tabs, never spaces')

  const edited = await project.editBody(saved.id, 'always indents with tabs', 'indents with tabs')
  assert.equal(edited.ok, true)
  assert.match(edited.record.body, /indents with tabs/)

  const missing = await project.editBody(saved.id, 'not-present-text', 'x')
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'text-not-found')

  const forgotten = await project.forget(saved.id)
  assert.equal(forgotten.name, 'Prefers tabs over spaces')
  assert.equal((await project.list()).length, 0)
})

test('store: frontmatter round-trips through the parser', async () => {
  const { project } = await makeProject('roundtrip')
  await project.save({
    name: 'Quoted "title" with: colon',
    body: 'line one\nline two',
    description: 'a summary',
    tags: ['a', 'b'],
    pinned: true,
    type: 'user',
  })
  const [record] = await project.list()
  const raw = await fs.readFile(record.file, 'utf8')
  const { meta, body } = parseMemoryFile(raw)
  assert.equal(meta.name, 'Quoted "title" with: colon')
  assert.equal(meta.pinned, true)
  assert.deepEqual(meta.tags, ['a', 'b'])
  assert.equal(body.trim(), 'line one\nline two')
  assert.ok(meta.modified, 'modified timestamp is written for first-party compatibility')
})

test('store: shared bank across two bound folders', async () => {
  const { store, project } = await makeProject('multi-a')
  await project.save({ name: 'Shared fact', body: 'visible from both folders' })

  const second = path.join(HOME, 'projects-src', 'multi-b')
  await fs.mkdir(second, { recursive: true })
  const { project: bound } = await store.bindFolder(second, project.id)
  assert.equal(bound.id, project.id)
  assert.equal(bound.folders.length, 2)

  const resolvedFromSecond = await store.resolve(second)
  assert.equal(resolvedFromSecond.id, project.id)
  assert.equal((await resolvedFromSecond.list()).length, 1)
})

test('store: index is bounded and regenerated', async () => {
  const { project } = await makeProject('indexed')
  for (let i = 0; i < 5; i += 1) {
    await project.save({ name: `Fact ${i}`, body: `body ${i}`, pinned: i === 0 })
  }
  const index = await fs.readFile(path.join(project.dir, 'index.md'), 'utf8')
  assert.match(index, /Fact 4/)
  assert.match(index, /## Core memory|## Memories/)

  const block = await project.renderContextBlock(100000)
  assert.match(block, /Memory index \(5 entries\)/)
  assert.match(block, /Pinned: Fact 0/)
  assert.match(block, /body 0/)
  // Only the pinned body is inlined; the rest stay behind the index.
  assert.doesNotMatch(block, /body 4/)
})

test('transfer: json bundle round-trips into a fresh project', async () => {
  const source = await makeProject('export-src')
  await source.project.save({ name: 'Exported fact', body: 'durable knowledge', tags: ['x'], type: 'reference' })
  await source.project.writeCore('core knowledge here')

  const bundle = await buildBundle(source.project)
  assert.equal(bundle.memories.length, 1)
  assert.equal(bundle.core.trim(), 'core knowledge here')

  const bytes = Buffer.from(JSON.stringify(bundle))
  const parsed = await parseImport(bytes, 'bundle.memory.json')
  assert.equal(parsed.kind, 'json')
  assert.equal(parsed.candidates.length, 1)
  assert.equal(parsed.candidates[0].name, 'Exported fact')
  assert.equal(parsed.candidates[0].type, 'reference')

  const target = await makeProject('import-dst')
  const result = await mergeCandidates(target.project, parsed.candidates, { source: 'test', core: parsed.core })
  assert.equal(result.created.length, 1)
  assert.equal((await target.project.list()).length, 1)
  assert.match(await target.project.readCore(), /core knowledge here/)
})

test('transfer: duplicate candidates are skipped', async () => {
  const { project } = await makeProject('dedupe')
  const candidates = [{ name: 'Same', body: 'identical body' }]
  const first = await mergeCandidates(project, candidates)
  assert.equal(first.created.length, 1)
  const second = await mergeCandidates(project, candidates)
  assert.equal(second.created.length, 0)
  assert.equal(second.skipped[0].reason, 'duplicate')
})

test('transfer: markdown with frontmatter and with ## sections', async () => {
  const withFrontmatter = Buffer.from('---\nname: From frontmatter\ntype: user\ntags: ["a"]\n---\n\nbody text\n')
  const parsedFront = await parseImport(withFrontmatter, 'note.md')
  assert.equal(parsedFront.candidates.length, 1)
  assert.equal(parsedFront.candidates[0].name, 'From frontmatter')
  assert.equal(parsedFront.candidates[0].type, 'user')

  const withSections = Buffer.from('# Doc\n\n## First fact\n\nalpha\n\n## Second fact\n\nbeta\n')
  const parsedSections = await parseImport(withSections, 'doc.md')
  assert.equal(parsedSections.candidates.length, 2)
  assert.deepEqual(
    parsedSections.candidates.map((candidate) => candidate.name),
    ['First fact', 'Second fact'],
  )
})

test('transfer: jsonl and plain text', async () => {
  const jsonl = Buffer.from('{"name":"one","body":"a"}\n{"name":"two","body":"b"}\n')
  const parsed = await parseImport(jsonl, 'memories.jsonl')
  assert.equal(parsed.candidates.length, 2)

  const text = await parseImport(Buffer.from('just a single loose fact'), 'loose.txt')
  assert.equal(text.candidates.length, 1)
  assert.equal(text.candidates[0].body, 'just a single loose fact')
})

test('transfer: zip archives are read through DecompressionStream', async () => {
  // Build a deflated single-entry zip by hand: no dependency provides one.
  const content = new TextEncoder().encode('{"name":"zipped","body":"from a zip"}')
  const deflated = new Uint8Array(
    await new Response(new Blob([content]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
  )
  const fileName = new TextEncoder().encode('memories.json')

  const crcTable = (() => {
    const table = new Uint32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let c = i
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
    return table
  })()
  let crc = 0xffffffff
  for (const byte of content) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  crc = (crc ^ 0xffffffff) >>> 0

  const local = new DataView(new ArrayBuffer(30))
  local.setUint32(0, 0x04034b50, true)
  local.setUint16(4, 20, true)
  local.setUint16(8, 8, true)
  local.setUint32(14, crc, true)
  local.setUint32(18, deflated.length, true)
  local.setUint32(22, content.length, true)
  local.setUint16(26, fileName.length, true)

  const central = new DataView(new ArrayBuffer(46))
  central.setUint32(0, 0x02014b50, true)
  central.setUint16(4, 20, true)
  central.setUint16(6, 20, true)
  central.setUint16(10, 8, true)
  central.setUint32(16, crc, true)
  central.setUint32(20, deflated.length, true)
  central.setUint32(24, content.length, true)
  central.setUint16(28, fileName.length, true)
  central.setUint32(42, 0, true)

  const centralSize = 46 + fileName.length
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, 1, true)
  eocd.setUint16(10, 1, true)
  eocd.setUint32(12, centralSize, true)
  eocd.setUint32(16, 30 + fileName.length + deflated.length, true)

  const zip = Buffer.concat([
    Buffer.from(local.buffer),
    Buffer.from(fileName),
    Buffer.from(deflated),
    Buffer.from(central.buffer),
    Buffer.from(fileName),
    Buffer.from(eocd.buffer),
  ])

  const parsed = await parseImport(zip, 'archive.zip')
  assert.equal(parsed.kind, 'zip')
  assert.equal(parsed.candidates.length, 1)
  assert.equal(parsed.candidates[0].name, 'zipped')
  assert.equal(parsed.candidates[0].body, 'from a zip')
})

test('transfer: staging writes candidates, raw bytes and an audit digest', async () => {
  const { project } = await makeProject('staged')
  const stage = await stageImport(project, 'notes.md', Buffer.from('## Fact A\n\nvalue a\n'))
  assert.equal(stage.candidates.length, 1)
  assert.equal(stage.manifest.candidateCount, 1)
  for (const file of ['import.json', 'import.md']) {
    await fs.access(path.join(stage.dir, file))
  }
  await fs.access(stage.raw)
})

test('transfer: export writes a bank copy plus json and md bundles', async () => {
  const { project } = await makeProject('exported')
  await project.save({ name: 'A fact', body: 'body a' })
  await project.save({ name: 'B fact', body: 'body b' })

  const { files, bundle, jsonOut, mdOut } = await exportProject(project)
  assert.equal(bundle.memories.length, 2)
  assert.ok(jsonOut && jsonOut.endsWith('.memory.json'))
  assert.ok(mdOut && mdOut.endsWith('.memory.md'))
  for (const file of files) await fs.access(file)

  const digest = await fs.readFile(mdOut, 'utf8')
  assert.match(digest, /## A fact/)
  assert.match(digest, /body b/)
})

test('transfer: memory root lives under the DSH home storage area', async () => {
  assert.equal(memoryRoot(), path.join(HOME, 'storages', 'dsh-memory'))
})
