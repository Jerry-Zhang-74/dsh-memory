/**
 * The Anthropic memory-tool compatibility surface.
 *
 * These tests pin the deliberate choices where Anthropic's own three artifacts
 * disagree (create-on-existing, non-unique str_replace) so a future edit cannot
 * silently switch to the data-losing reading.
 *
 *   node --test test/anthropic-compat.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-memory-compat-'))
process.env.DSH_HOME = HOME

const { MemoryStore } = await import('../lib/host/store.js')
const { applyMemoryCommand, resolveMemoryPath, MEMORY_ROOT } = await import('../lib/host/anthropic-compat.js')

/** A fresh project in its own folder. */
async function project(name) {
  const folder = path.join(HOME, 'ws', name)
  await fs.mkdir(folder, { recursive: true })
  return new MemoryStore().resolve(folder)
}

test('path resolution: root, core, files, and escapes', async () => {
  const p = await project('paths')
  assert.equal(resolveMemoryPath(p, '/memories').kind, 'root')
  assert.equal(resolveMemoryPath(p, '/memories/core.md').kind, 'core')
  assert.equal(resolveMemoryPath(p, '/memories/notes.md').kind, 'file')
  assert.equal(resolveMemoryPath(p, '/memories/a/b.md').realPath, path.join(p.memoriesDir, 'a', 'b.md'))

  // A path outside the contract is rejected, never silently normalised.
  for (const bad of ['/etc/passwd', 'memories/x.md', '/memories/../secrets.md', '/memories/a/../../x.md']) {
    assert.throws(() => resolveMemoryPath(p, bad), /must start with|must not contain|escapes/, `should reject ${bad}`)
  }
})

test('create: writes a file, and refuses to clobber an existing one', async () => {
  const p = await project('create')
  const created = await applyMemoryCommand(p, { command: 'create', path: '/memories/first.md', file_text: 'hello\n' })
  assert.equal(created.isError, false)
  assert.match(created.content, /File created successfully/)
  assert.equal(await fs.readFile(path.join(p.memoriesDir, 'first.md'), 'utf8'), 'hello\n')

  // The docs + SDK use O_EXCL semantics; the cookbook silently overwrites.
  // We refuse, because silent overwrite of durable memory is data loss.
  const again = await applyMemoryCommand(p, { command: 'create', path: '/memories/first.md', file_text: 'DIFFERENT' })
  assert.equal(again.isError, true)
  assert.match(again.content, /already exists/)
  assert.equal(await fs.readFile(path.join(p.memoriesDir, 'first.md'), 'utf8'), 'hello\n', 'content must be untouched')

  // The root is not creatable.
  const rootCreate = await applyMemoryCommand(p, { command: 'create', path: '/memories', file_text: 'x' })
  assert.equal(rootCreate.isError, true)
})

test('view: directory listing at the root and line-numbered file reads', async () => {
  const p = await project('view')
  await applyMemoryCommand(p, { command: 'create', path: '/memories/a.md', file_text: 'alpha\nbravo\ncharlie\n' })

  const listing = await applyMemoryCommand(p, { command: 'view', path: '/memories' })
  assert.equal(listing.isError, false)
  assert.match(listing.content, /Directory listing for \/memories:/)
  assert.match(listing.content, /\/memories\/core\.md/)
  assert.match(listing.content, /\/memories\/a\.md/)
  // `{size}\t{path}` rows, per the spec's listing format.
  assert.match(listing.content, /^\d+\t\/memories\/a\.md$/m)

  const full = await applyMemoryCommand(p, { command: 'view', path: '/memories/a.md' })
  // 6-wide right-aligned 1-indexed numbers, tab separated. The file's trailing
  // newline terminates line 3; it must not be reported as a phantom line 4.
  assert.equal(full.content, "Here's the content of /memories/a.md with line numbers:\n     1\talpha\n     2\tbravo\n     3\tcharlie")

  const ranged = await applyMemoryCommand(p, { command: 'view', path: '/memories/a.md', view_range: [2, -1] })
  assert.match(ranged.content, /     2\tbravo/)
  assert.match(ranged.content, /     3\tcharlie/)
  assert.doesNotMatch(ranged.content, /alpha/)

  const missing = await applyMemoryCommand(p, { command: 'view', path: '/memories/nope.md' })
  assert.equal(missing.isError, true)
  assert.match(missing.content, /does not exist/)
})

test('str_replace: exact match, unique-match enforced, replace_all opt-in', async () => {
  const p = await project('replace')
  await applyMemoryCommand(p, { command: 'create', path: '/memories/r.md', file_text: 'one two one\n' })

  const ambiguous = await applyMemoryCommand(p, { command: 'str_replace', path: '/memories/r.md', old_str: 'one', new_str: 'X' })
  assert.equal(ambiguous.isError, true, 'non-unique old_str must be refused')
  assert.match(ambiguous.content, /appears 2 times/)

  const all = await applyMemoryCommand(p, { command: 'str_replace', path: '/memories/r.md', old_str: 'one', new_str: 'X', replace_all: true })
  assert.equal(all.isError, false)
  assert.equal(await fs.readFile(path.join(p.memoriesDir, 'r.md'), 'utf8'), 'X two X\n')

  const missing = await applyMemoryCommand(p, { command: 'str_replace', path: '/memories/r.md', old_str: 'zzz', new_str: 'y' })
  assert.equal(missing.isError, true)
  assert.match(missing.content, /was not found/)

  const empty = await applyMemoryCommand(p, { command: 'str_replace', path: '/memories/r.md', old_str: '', new_str: 'y' })
  assert.equal(empty.isError, true)

  // Omitting new_str deletes the matched text.
  await applyMemoryCommand(p, { command: 'str_replace', path: '/memories/r.md', old_str: ' two' })
  assert.equal(await fs.readFile(path.join(p.memoriesDir, 'r.md'), 'utf8'), 'X X\n')
})

test('insert: 0 prepends, in-range inserts land, past-the-end is refused', async () => {
  const p = await project('insert')
  await applyMemoryCommand(p, { command: 'create', path: '/memories/i.md', file_text: 'B\nC\n' })

  await applyMemoryCommand(p, { command: 'insert', path: '/memories/i.md', insert_line: 0, insert_text: 'A' })
  assert.equal(await fs.readFile(path.join(p.memoriesDir, 'i.md'), 'utf8'), 'A\nB\nC\n')

  await applyMemoryCommand(p, { command: 'insert', path: '/memories/i.md', insert_line: 3, insert_text: 'D' })
  assert.equal(await fs.readFile(path.join(p.memoriesDir, 'i.md'), 'utf8'), 'A\nB\nC\nD\n')

  const tooFar = await applyMemoryCommand(p, { command: 'insert', path: '/memories/i.md', insert_line: 99, insert_text: 'X' })
  assert.equal(tooFar.isError, true)
  assert.match(tooFar.content, /past the end/)

  const negative = await applyMemoryCommand(p, { command: 'insert', path: '/memories/i.md', insert_line: -1, insert_text: 'X' })
  assert.equal(negative.isError, true)
})

test('delete: removes a file but never the root', async () => {
  const p = await project('delete')
  await applyMemoryCommand(p, { command: 'create', path: '/memories/d.md', file_text: 'x' })

  const root = await applyMemoryCommand(p, { command: 'delete', path: '/memories' })
  assert.equal(root.isError, true)
  assert.match(root.content, /cannot be deleted/)

  const gone = await applyMemoryCommand(p, { command: 'delete', path: '/memories/d.md' })
  assert.equal(gone.isError, false)
  assert.match(gone.content, /Successfully deleted/)
  await assert.rejects(() => fs.access(path.join(p.memoriesDir, 'd.md')))

  const again = await applyMemoryCommand(p, { command: 'delete', path: '/memories/d.md' })
  assert.equal(again.isError, true)
})

test('rename: moves a file, never overwrites the destination, refuses the root', async () => {
  const p = await project('rename')
  await applyMemoryCommand(p, { command: 'create', path: '/memories/old.md', file_text: 'content' })
  await applyMemoryCommand(p, { command: 'create', path: '/memories/taken.md', file_text: 'occupied' })

  const root = await applyMemoryCommand(p, { command: 'rename', old_path: '/memories', new_path: '/memories/x' })
  assert.equal(root.isError, true)

  const clash = await applyMemoryCommand(p, { command: 'rename', old_path: '/memories/old.md', new_path: '/memories/taken.md' })
  assert.equal(clash.isError, true)
  assert.match(clash.content, /already exists/)
  assert.equal(await fs.readFile(path.join(p.memoriesDir, 'taken.md'), 'utf8'), 'occupied', 'destination must be untouched')

  const ok = await applyMemoryCommand(p, { command: 'rename', old_path: '/memories/old.md', new_path: '/memories/sub/new.md' })
  assert.equal(ok.isError, false)
  assert.equal(await fs.readFile(path.join(p.memoriesDir, 'sub', 'new.md'), 'utf8'), 'content')

  const missing = await applyMemoryCommand(p, { command: 'rename', old_path: '/memories/ghost.md', new_path: '/memories/g.md' })
  assert.equal(missing.isError, true)
})

test('unknown commands fail loudly rather than silently succeeding', async () => {
  const p = await project('unknown')
  const result = await applyMemoryCommand(p, { command: 'frobnicate', path: '/memories/x' })
  assert.equal(result.isError, true)
  assert.match(result.content, /unknown command/)
})

test('the verb surface drives the same bank the semantic tool reads', async () => {
  const p = await project('interop')
  await applyMemoryCommand(p, {
    command: 'create',
    path: '/memories/from-verbs.md',
    file_text: '---\nname: "Written by verbs"\ntype: "project"\ntags: ["compat"]\n---\n\nBody written through the file contract.\n',
  })

  // The semantic side must see it.
  const listed = await p.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'Written by verbs')
  assert.deepEqual(listed[0].tags, ['compat'])

  // And the index must have been regenerated for it.
  const index = await fs.readFile(path.join(p.dir, 'index.md'), 'utf8')
  assert.match(index, /Written by verbs/)
})
