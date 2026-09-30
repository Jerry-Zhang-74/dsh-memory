/**
 * DSH Memory — one-click import / export.
 *
 * Export produces a self-describing bundle:
 *   exports/<timestamp>/           stamped copy of the bank
 *   exports/<timestamp>.memory.json  single-file portable bundle
 *   exports/<timestamp>.memory.md    human/LLM-readable digest
 *
 * Import understands several shapes, auto-detected:
 *   - native bundle (.memory.json, or a JSON array of memory records)
 *   - any .zip archive containing markdown/json (ZIP reader below)
 *   - markdown files with or without YAML frontmatter
 *   - JSONL / JSON arrays of {name, body, ...}
 *   - plain text (split into one memory, or one per `##` heading)
 *
 * Everything here is dependency-free: the ZIP reader uses the platform
 * `DecompressionStream`, so the plugin installs with no build step.
 *
 * @module dsh-memory/transfer
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { MEMORY_SCOPES, MEMORY_TYPES, parseMemoryFile, slugify } from './store.js'
import { parseClaudeMemory } from './claude-memory.js'

/** Signature of the single-file bundle this module writes. */
export const BUNDLE_FORMAT = 'dsh-memory-bundle'
export const BUNDLE_VERSION = 1

/** Minimum size of a ZIP end-of-central-directory record. */
const EOCD_MIN = 22
/** ZIP local file header signature. */
const SIG_LOCAL = 0x04034b50
/** ZIP central directory header signature. */
const SIG_CENTRAL = 0x02014b50
/** ZIP end-of-central-directory signature. */
const SIG_EOCD = 0x06054b50

/** Extract every entry from a ZIP archive. */
async function readZip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  // Locate the end-of-central-directory record by scanning backwards.
  let eocd = -1
  for (let i = buffer.length - EOCD_MIN; i >= 0 && i >= buffer.length - EOCD_MIN - 0xffff; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('not a ZIP archive: end-of-central-directory record not found')

  const entryCount = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder('utf-8')
  const entries = []

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || view.getUint32(cursor, true) !== SIG_CENTRAL) break
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(new Uint8Array(buffer.buffer, buffer.byteOffset + cursor + 46, nameLength))
    cursor += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue
    if (view.getUint32(localOffset, true) !== SIG_LOCAL) continue

    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = new Uint8Array(buffer.buffer, buffer.byteOffset + dataStart, compressedSize)

    let bytes
    if (method === 0) {
      bytes = raw
    } else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      bytes = new Uint8Array(await new Response(stream).arrayBuffer())
    } else {
      // Unsupported compression: skip rather than fail the whole import.
      continue
    }
    entries.push({ name, bytes })
  }
  return entries
}

/** True when the buffer starts with a ZIP local-header signature. */
function looksLikeZip(buffer) {
  return buffer.length > 4 && new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, true) === SIG_LOCAL
}

/** Normalize one loose record (from any format) into a memory candidate. */
function toCandidate(input, fallbackName) {
  if (typeof input === 'string') {
    const body = input.trim()
    if (!body) return null
    return { name: body.split('\n')[0].slice(0, 60) || fallbackName, body, description: '', type: 'project', scope: 'project', tags: [] }
  }
  if (!input || typeof input !== 'object') return null

  const body = String(
    input.body ?? input.content ?? input.text ?? input.value ?? input.fact ?? input.memory ?? input.note ?? '',
  ).trim()
  const name = String(input.name ?? input.title ?? input.key ?? input.id ?? body.split('\n')[0] ?? fallbackName).trim()
  const type = MEMORY_TYPES.includes(input.type) ? input.type : 'project'
  const scope = MEMORY_SCOPES.includes(input.scope) ? input.scope : 'project'
  const tags = Array.isArray(input.tags)
    ? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : typeof input.tags === 'string'
      ? input.tags.split(/[,;]/).map((tag) => tag.trim()).filter(Boolean)
      : []
  if (!body && !name) return null
  return {
    name: name.slice(0, 200) || fallbackName,
    body: body || name,
    description: String(input.description ?? input.summary ?? '').trim().slice(0, 400),
    type,
    scope,
    tags,
    pinned: input.pinned === true,
    created: input.created ?? input.createdAt ?? undefined,
  }
}

/** Parse a markdown file into one or more candidates (frontmatter, or `##` sections). */
function parseMarkdown(text, fileName) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  const { meta, body } = parseMemoryFile(normalized)
  const baseName = fileName.replace(/\.(md|markdown|txt)$/i, '')

  if (meta.name || meta.description || meta.id) {
    const candidate = toCandidate(
      {
        name: meta.name ?? baseName,
        body: body.trim(),
        description: meta.description,
        type: meta.type,
        scope: meta.scope,
        tags: meta.tags,
        pinned: meta.pinned,
        created: meta.created,
      },
      baseName,
    )
    return candidate ? [candidate] : []
  }

  // No frontmatter: a document with `##` sections becomes one memory each; a
  // heading-less document becomes a single memory named after the file.
  const sections = normalized.split(/\n(?=##\s)/)
  if (sections.length > 1) {
    const candidates = []
    for (const section of sections) {
      const match = /^##\s+(.+)$/m.exec(section)
      if (!match) continue
      const candidate = toCandidate({ name: match[1].trim(), body: section.replace(/^##\s+.+\n?/, '').trim(), type: meta.type }, match[1].trim())
      if (candidate) candidates.push(candidate)
    }
    if (candidates.length > 0) return candidates
  }

  // A pure "# Title" document is one memory with its title as the name.
  const title = /^#\s+(.+)$/m.exec(normalized)
  const candidate = toCandidate(
    { name: title ? title[1].trim() : baseName, body: normalized.replace(/^#\s+.+\n?/, '').trim() || normalized.trim() },
    baseName,
  )
  return candidate ? [candidate] : []
}

/** Parse JSONL text into candidates. */
function parseJsonl(text, fallbackName) {
  const candidates = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//')) continue
    try {
      const candidate = toCandidate(JSON.parse(trimmed), fallbackName)
      if (candidate) candidates.push(candidate)
    } catch {
      /* skip a malformed line rather than failing the import */
    }
  }
  return candidates
}

/** Parse a JSON document into candidates, understanding the native bundle. */
function parseJson(text, fallbackName) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (data && typeof data === 'object' && data.format === BUNDLE_FORMAT) {
    return { candidates: (data.memories ?? []).map((entry) => toCandidate(entry, fallbackName)).filter(Boolean), core: data.core ?? '' }
  }
  if (Array.isArray(data)) {
    return { candidates: data.map((entry) => toCandidate(entry, fallbackName)).filter(Boolean), core: '' }
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.memories)) {
      return { candidates: data.memories.map((entry) => toCandidate(entry, fallbackName)).filter(Boolean), core: data.core ?? '' }
    }
    const single = toCandidate(data, fallbackName)
    return { candidates: single ? [single] : [], core: '' }
  }
  return { candidates: [], core: '' }
}

/**
 * Parse an arbitrary import payload into memory candidates.
 *
 * @param bytes - raw file bytes.
 * @param fileName - the originating filename, used to pick a parser and name entries.
 * @returns candidates plus an optional core-memory file body and a per-format note.
 */
export function parseImport(bytes, fileName) {
  const name = String(fileName ?? 'import')
  const lower = name.toLowerCase()

  if (looksLikeZip(bytes) || lower.endsWith('.zip')) {
    return readZip(bytes).then((entries) => {
      const candidates = []
      let core = ''
      for (const entry of entries) {
        const text = new TextDecoder('utf-8').decode(entry.bytes)
        const base = path.basename(entry.name)
        if (/core\.md$/i.test(entry.name)) {
          core = text
          continue
        }
        if (!/\.(md|markdown|txt|json|jsonl|ndjson)$/i.test(entry.name)) continue
        if (/\.jsonl?$|\.ndjson$/i.test(entry.name)) {
          const parsed = parseJson(text, base)
          if (parsed && parsed.candidates.length > 0) candidates.push(...parsed.candidates)
          else candidates.push(...parseJsonl(text, base))
        } else {
          candidates.push(...parseMarkdown(text, base))
        }
      }
      return { candidates, core, kind: 'zip' }
    })
  }

  const text = new TextDecoder('utf-8').decode(bytes)
  const trimmed = text.trim()

  // A Claude memory export gets its own parser before any generic path: the
  // four shapes it ships in all carry a section structure that the generic
  // markdown reader flattens away, and the section IS the classification.
  const claude = parseClaudeMemory(text)
  if (claude.length > 0) return { candidates: claude, core: '', kind: 'claude-memory' }

  if (lower.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed, name.replace(/\.[^.]+$/, ''))
    if (parsed && parsed.candidates.length > 0) return { ...parsed, kind: 'json' }
  }
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) {
    return { candidates: parseJsonl(trimmed, name.replace(/\.[^.]+$/, '')), core: '', kind: 'jsonl' }
  }
  return { candidates: parseMarkdown(text, name), core: '', kind: 'markdown' }
}

/** Render a bundle object for one project. */
export async function buildBundle(project) {
  const memories = await project.list()
  const core = await project.readCore()
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    project: { id: project.id, name: project.label, folders: project.folders },
    core,
    memories: memories.map((record) => ({
      id: record.id,
      name: record.name,
      description: record.description,
      type: record.type,
      scope: record.scope,
      tags: record.tags,
      pinned: record.pinned,
      created: record.created,
      updated: record.updated,
      body: record.body,
    })),
  }
}

/** Render the bundle as a single human/LLM-readable markdown digest. */
export function renderDigest(bundle) {
  const lines = [
    `# Memory export — ${bundle.project.name}`,
    '',
    `- exported: ${bundle.exportedAt}`,
    `- project id: \`${bundle.project.id}\``,
    `- folders: ${(bundle.project.folders ?? []).join(', ') || '(none)'}`,
    `- memories: ${bundle.memories.length}`,
    '',
  ]
  if (bundle.core?.trim()) lines.push('## Core memory', '', bundle.core.trim(), '')
  for (const memory of bundle.memories) {
    lines.push(`## ${memory.name}`, '')
    lines.push(`- id: \`${memory.id}\``)
    lines.push(`- type: ${memory.type}${memory.pinned ? ' (pinned)' : ''}`)
    if (memory.tags?.length) lines.push(`- tags: ${memory.tags.join(', ')}`)
    if (memory.description) lines.push(`- summary: ${memory.description}`)
    if (memory.updated) lines.push(`- updated: ${memory.updated}`)
    lines.push('', memory.body.trim(), '')
  }
  return lines.join('\n')
}

/**
 * Write one export bundle for a project.
 *
 * @param project - the project whose bank to export.
 * @param options - `{ format: 'both' | 'json' | 'md' }`.
 * @returns written file paths and the bundle itself.
 */
export async function exportProject(project, options = {}) {
  const format = options.format ?? 'both'
  const bundle = await buildBundle(project)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(project.exportsDir, stamp)
  await fs.mkdir(dir, { recursive: true })

  const written = []

  // Stamped copy of the whole bank: portable as a plain directory.
  const bankDir = path.join(dir, 'memories')
  await fs.mkdir(bankDir, { recursive: true })
  for (const record of await project.list()) {
    const target = path.join(bankDir, record.fileName)
    await fs.writeFile(target, await fs.readFile(record.file, 'utf8'), 'utf8')
    written.push(target)
  }
  const coreOut = path.join(dir, 'core.md')
  await fs.writeFile(coreOut, bundle.core, 'utf8')
  written.push(coreOut)

  if (format === 'both' || format === 'json') {
    const jsonOut = path.join(project.exportsDir, `${stamp}.memory.json`)
    await fs.writeFile(jsonOut, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
    written.push(jsonOut)
  }
  if (format === 'both' || format === 'md') {
    const mdOut = path.join(project.exportsDir, `${stamp}.memory.md`)
    await fs.writeFile(mdOut, `${renderDigest(bundle)}\n`, 'utf8')
    written.push(mdOut)
  }

  return { bundle, dir, files: written, jsonOut: written.find((file) => file.endsWith('.memory.json')), mdOut: written.find((file) => file.endsWith('.memory.md')) }
}

/**
 * Stage imported bytes into the project's `imports/` folder.
 *
 * Staging (rather than merging straight into the bank) is what lets the same
 * payload be reviewed in an isolated conversation before it becomes memory.
 *
 * @param project - destination project.
 * @param fileName - original filename.
 * @param bytes - raw payload.
 * @returns the staging directory, written files, and the parse result.
 */
export async function stageImport(project, fileName, bytes) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(project.importsDir, stamp)
  await fs.mkdir(dir, { recursive: true })
  const safeName = slugify(path.basename(fileName).replace(/\.[^.]+$/, ''), 'import') + path.extname(fileName || '') 
  const raw = path.join(dir, safeName || 'import.txt')
  await fs.writeFile(raw, bytes)

  const parsed = await parseImport(bytes, fileName)
  const manifest = {
    stagedAt: new Date().toISOString(),
    source: fileName,
    kind: parsed.kind,
    candidateCount: parsed.candidates.length,
    candidates: parsed.candidates,
    core: parsed.core ?? '',
  }
  await fs.writeFile(path.join(dir, 'import.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fs.writeFile(path.join(dir, 'import.md'), `${renderDigest({
    exportedAt: manifest.stagedAt,
    project: { id: project.id, name: project.label, folders: project.folders },
    core: manifest.core,
    memories: parsed.candidates.map((candidate, index) => ({ ...candidate, id: `candidate-${index + 1}` })),
  })}\n`, 'utf8')

  return { dir, raw, manifest, candidates: parsed.candidates }
}

/**
 * Merge parsed candidates straight into a project's bank.
 *
 * @param project - destination project.
 * @param candidates - candidates from {@link parseImport}.
 * @param options - `{ source, dryRun, core }`.
 * @returns counts plus the ids of created and skipped memories.
 */
export async function mergeCandidates(project, candidates, options = {}) {
  const existing = await project.list()
  const fingerprint = (candidate) => `${candidate.name.toLowerCase()}::${candidate.body.replace(/\s+/g, ' ').trim().toLowerCase()}`
  const seen = new Set(existing.map((record) => fingerprint({ name: record.name, body: record.body })))

  const created = []
  const skipped = []
  for (const candidate of candidates) {
    const key = fingerprint(candidate)
    if (seen.has(key)) {
      skipped.push({ name: candidate.name, reason: 'duplicate' })
      continue
    }
    if (options.dryRun) {
      created.push({ name: candidate.name, id: '(dry-run)' })
      seen.add(key)
      continue
    }
    const record = await project.save({ ...candidate, source: options.source })
    created.push({ name: record.name, id: record.id })
    seen.add(key)
  }

  if (!options.dryRun && options.core) {
    const current = await project.readCore()
    if (!current.trim() || current.trim().split('\n').length <= 5) await project.writeCore(options.core)
  }

  return { created, skipped, total: candidates.length }
}
