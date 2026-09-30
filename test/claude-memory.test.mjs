/**
 * Claude memory-export parsing.
 *
 * The fixtures are the four real shapes found in one user's export; a generic
 * markdown parser loses the section structure on every one of them, and the
 * section is the only classification the file carries.
 *
 * When `CLAUDE_EXPORT_DIR` is set, the same assertions additionally run against
 * the real files, so the parser is exercised on data nobody shaped for it:
 *
 *   CLAUDE_EXPORT_DIR=E:\Claude-Data-Rescue\04-memory node --test test/claude-memory.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

const { looksLikeClaudeMemory, parseClaudeMemory } = await import('../lib/host/claude-memory.js')
const { parseImport } = await import('../lib/host/transfer.js')

const MODERN = `=== MEMORY EXPORT ===

## 1. INSTRUCTIONS
[unknown] - Respond in Chinese unless explicitly requested otherwise.
[unknown] - Writing should be facts-based — no fabrication or speculation.

## 2. IDENTITY
[unknown] - Undergraduate student at East China University of Science and Technology.
[unknown] - Based in Shanghai (Fengxian campus area).

## 5. PREFERENCES
[unknown] - Prefers high information density — no filler language.

## TECHNICAL SETUP (reference)
[unknown] - Windows 10 Home with WSL2/Ubuntu 24.04.
`

const PROSE = `Work context
张泽岳 is an undergraduate student at ECUST, advised by Liu Yajing.

Personal context
Zeyue is based in Shanghai. His interests extend into neural circuit mechanisms.

Top of mind
Zeyue is in the final stretch of a heavy exam period.

Brief history

*Recent months*

大创 project: the Bxb1 landing pad platform uses an attP–mCherry–attP structure.

*Earlier context*

Molecular biology literature and technology: engaged with terpene biosynthesis.
`

const LEGACY = `**Work context**

No explicit information about chuanyu's professional role has been shared.

**Personal context**

Chuanyu communicates in a casual, reflective style.

**Top of mind**

Chuanyu recently requested an HTML review document on Anelloviridae.
`

const TRANSCRIBED = `# Claude 云端 Memory 全量转录

> 来源：memory-screenshots/

---

## 一、偏好类（Preferences）

### Preferences（更新于 2026-09-28）
**Summary:** How Zeyue wants answers formatted
**Details:**
- 课程思考题要求"简答题形式"作答
- 不要 markdown 符号

### Writing And Output Preferences（更新于 2026-08-03）
**Summary:** Zeyue's documented preferences for written outputs
**Details:**
- Factual accuracy required
- Citations follow GB/T 7714-2015

---

## 二、身份与学业（Profile / Academic）

### Profile（更新于 2026-08-16）
**Summary:** Identity facts
**Details:**
- name: Zeyue Zhang (张泽岳)
- city: Shanghai
`

test('each Claude export shape is recognised', () => {
  for (const [label, text] of [['modern', MODERN], ['prose', PROSE], ['legacy', LEGACY], ['transcribed', TRANSCRIBED]]) {
    assert.equal(looksLikeClaudeMemory(text), true, `${label} must be recognised`)
  }
  assert.equal(looksLikeClaudeMemory('just some ordinary notes about a project'), false)
  assert.equal(looksLikeClaudeMemory('# Heading\n\n- a bullet\n'), false)
})

test('modern export: one memory per section, markers stripped, types inferred', () => {
  const memories = parseClaudeMemory(MODERN)
  const names = memories.map((memory) => memory.name)
  assert.deepEqual(names, ['INSTRUCTIONS', 'IDENTITY', 'PREFERENCES', 'TECHNICAL SETUP (reference)'])

  const identity = memories.find((memory) => memory.name === 'IDENTITY')
  assert.equal(identity.type, 'user')
  // The `[unknown] - ` provenance marker carries no information.
  assert.doesNotMatch(identity.body, /\[unknown\]/)
  assert.match(identity.body, /^- Undergraduate student at East China/m)
  assert.ok(identity.tags.includes('claude-import'))
  assert.ok(identity.tags.includes('section:identity'))

  // Section names drive the type, not a blanket default.
  assert.equal(memories.find((memory) => memory.name === 'PREFERENCES').type, 'user')
  assert.equal(memories.find((memory) => memory.name.startsWith('TECHNICAL')).type, 'reference')
})

test('prose export: headings become sections, paragraphs survive intact', () => {
  const memories = parseClaudeMemory(PROSE)
  const names = memories.map((memory) => memory.name)
  assert.ok(names.includes('Work context'))
  assert.ok(names.includes('Personal context'))
  assert.ok(names.includes('Top of mind'))
  // `Brief history` swallows its italic sub-headings rather than being split
  // into fragments.
  assert.ok(names.includes('Brief history'))

  const personal = memories.find((memory) => memory.name === 'Personal context')
  assert.match(personal.body, /based in Shanghai/)
  assert.doesNotMatch(personal.body, /Work context/, 'a section must not absorb the next heading')

  const brief = memories.find((memory) => memory.name === 'Brief history')
  assert.match(brief.body, /\*\*Recent months\*\*/, 'italic sub-headings are kept as labels')
  assert.match(brief.body, /\*\*Earlier context\*\*/)
})

test('legacy bold export: bold paragraph headings are sections', () => {
  const memories = parseClaudeMemory(LEGACY)
  const names = memories.map((memory) => memory.name)
  assert.deepEqual(names, ['Work context', 'Personal context', 'Top of mind'])
  assert.match(memories[0].body, /professional role/)
})

test('transcribed export: the update date is preserved as metadata', () => {
  const memories = parseClaudeMemory(TRANSCRIBED)
  const names = memories.map((memory) => memory.name)
  assert.ok(names.includes('Preferences'), `got ${names.join(', ')}`)
  assert.ok(names.includes('Writing And Output Preferences'))
  assert.ok(names.includes('Profile'))
  // The transcription's own front matter is not a memory.
  assert.ok(!names.some((name) => /转录|来源/.test(name)))

  const preferences = memories.find((memory) => memory.name === 'Preferences')
  assert.equal(preferences.created, '2026-09-28T00:00:00.000Z')
  assert.ok(preferences.tags.includes('updated:2026-09-28'))
  // The parenthetical date must not survive into the title.
  assert.doesNotMatch(preferences.name, /更新于/)
  assert.match(preferences.body, /简答题形式/)

  assert.equal(memories.find((memory) => memory.name === 'Profile').created, '2026-08-16T00:00:00.000Z')
})

test('the generic import path routes Claude exports to the dedicated parser', async () => {
  const parsed = await parseImport(Buffer.from(MODERN, 'utf8'), 'claude_memory_260717.txt')
  assert.equal(parsed.kind, 'claude-memory')
  assert.equal(parsed.candidates.length, 4)

  // And ordinary markdown is untouched by the new branch.
  const plain = await parseImport(Buffer.from('# Notes\n\n## One\n\nalpha\n', 'utf8'), 'notes.md')
  assert.equal(plain.kind, 'markdown')
})

// ---------------------------------------------------------------------------
// Real files, when the export directory is available.
// ---------------------------------------------------------------------------

const EXPORT_DIR = process.env.CLAUDE_EXPORT_DIR

test('real export files parse into classified memories', { skip: !EXPORT_DIR }, async () => {
  const files = [
    'claude_memory_260717.txt',
    'claude_memory_260630.txt',
    'claude-legacy-memory.md',
    'MEMORY-transcribed.md',
  ]

  for (const file of files) {
    const text = await fs.readFile(path.join(EXPORT_DIR, file), 'utf8')
    const parsed = await parseImport(Buffer.from(text, 'utf8'), file)

    assert.ok(parsed.candidates.length > 0, `${file} must yield memories`)
    assert.ok(
      parsed.candidates.length < 60,
      `${file} must yield sections, not one memory per line (got ${parsed.candidates.length})`,
    )

    for (const memory of parsed.candidates) {
      assert.ok(memory.name && memory.name.length < 160, `${file}: name must be a heading, got "${memory.name}"`)
      assert.ok(memory.body.trim().length > 0, `${file}: body must not be empty`)
      assert.ok(['user', 'project', 'feedback', 'reference'].includes(memory.type), `${file}: type must be valid`)
    }

    const names = parsed.candidates.map((memory) => memory.name)
    console.log(`    ${file}: ${parsed.candidates.length} memories [${parsed.kind}] :: ${names.join(' | ')}`)
  }
})

test('real modern export classifies its sections rather than defaulting', { skip: !EXPORT_DIR }, async () => {
  const text = await fs.readFile(path.join(EXPORT_DIR, 'claude_memory_260717.txt'), 'utf8')
  const memories = parseClaudeMemory(text)
  const byName = Object.fromEntries(memories.map((memory) => [memory.name, memory]))

  assert.equal(byName.IDENTITY?.type, 'user')
  assert.equal(byName.PREFERENCES?.type, 'user')
  assert.equal(byName.INSTRUCTIONS?.type, 'user')
  assert.ok(byName.CAREER || byName.PROJECTS, 'career or projects section must survive')
  // Provenance markers are noise and must be gone.
  for (const memory of memories) assert.doesNotMatch(memory.body, /^\[unknown\]/m)
})

test('real transcribed export: titles are clean and annotations are preserved as provenance', { skip: !EXPORT_DIR }, async () => {
  const text = await fs.readFile(path.join(EXPORT_DIR, 'MEMORY-transcribed.md'), 'utf8')
  const memories = parseClaudeMemory(text)
  const names = memories.map((memory) => memory.name)

  // No name may carry a parenthetical annotation, or the same topic reads as two
  // different memories and a re-import duplicates it.
  for (const name of names) {
    assert.doesNotMatch(name, /更新于|项目：|updated/i, `name must be a bare title, got "${name}"`)
  }

  // Duplicate section titles in the source must not become two memories.
  const seen = new Set()
  for (const name of names) {
    assert.ok(!seen.has(name), `duplicate memory name "${name}"`)
    seen.add(name)
  }

  // The annotation itself is still available, as body provenance.
  const annotated = memories.find((memory) => /项目：/.test(memory.body))
  assert.ok(annotated, 'a project annotation must survive into the body')

  // Dates become real metadata.
  const dated = memories.filter((memory) => memory.created)
  assert.ok(dated.length >= 5, `expected several dated cards, got ${dated.length}`)
})
