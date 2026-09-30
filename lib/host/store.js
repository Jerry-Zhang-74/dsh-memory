/**
 * DSH Memory — durable memory store.
 *
 * On-disk model (one project = a set of bound folders sharing one memory bank):
 *
 *   <DSH_HOME>/storages/dsh-memory/
 *     projects.json                     <- registry: project id -> bound folders
 *     projects/<projectId>/
 *       project.json                    <- project metadata (id, name, folders, created/updated)
 *       core.md                         <- the always-in-context core memory file
 *       memories/<type>-<slug>.md        <- one memory per file (YAML frontmatter + body)
 *       imports/                        <- staging area for one-click imports
 *       exports/                        <- generated export bundles
 *
 * The memory file format follows the widely used Claude/agent-memory convention:
 * a Markdown file whose frontmatter carries the metadata and whose body carries
 * the fact itself. That keeps the store hand-editable, greppable and portable.
 *
 * @module dsh-memory/store
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

/** Memory types, mirroring the `memory` entries of agent-memory tooling. */
export const MEMORY_TYPES = ['user', 'project', 'feedback', 'reference']

/**
 * Scope of a memory: this project only, or the personal archive.
 *
 * `global` is the STORED value, because it describes the fact ("applies
 * everywhere") and is what the file frontmatter records. `personal` is the
 * accepted alias a caller may use, because it names the BANK the entry lives
 * in, which is what a person thinks in. Both mean the same single bank, so
 * there is no second place for a global-ish entry to hide.
 */
export const MEMORY_SCOPES = ['project', 'global', 'personal']

/** The scope values that address the personal archive. */
export const PERSONAL_SCOPE_ALIASES = ['global', 'personal']

/**
 * Reserved project id holding the PERSONAL archive.
 *
 * Personal memories are facts about the person that apply everywhere — their
 * preferences, how they want to be addressed, what they are studying. Project
 * memories are facts about one codebase or folder. Mixing them in one list is
 * the thing this separation exists to prevent: a project's renderer would show
 * the person's whole history, and a personal note would look like it belonged
 * to whichever folder happened to be open.
 *
 * The archive therefore owns its own bank. It is a project so it reuses the
 * whole store — files, index, locking, atomic writes — but it is not reachable
 * by folder resolution, and its folder list stays empty.
 */
export const PERSONAL_PROJECT_ID = '_personal'

/** Default cap for the always-in-context memory block (characters). */
export const DEFAULT_CONTEXT_BUDGET = 8000

/**
 * Load budget for the always-in-context memory index, matching the first-party
 * Claude Code behaviour: the first 200 lines of the index file, or the first
 * 25 KB, whichever comes first. The index carries one line per memory, so a
 * large bank costs a bounded number of tokens and the model still knows what
 * exists and can pull the full body on demand.
 */
export const INDEX_MAX_LINES = 200
export const INDEX_MAX_BYTES = 25 * 1024

/** Resolve DSH home the same way the rest of the harness does. */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Root of every memory bank. */
export function memoryRoot() {
  return path.join(dshHome(), 'storages', 'dsh-memory')
}

/** Normalize a folder path for cross-platform identity comparison. */
function normalizePath(p) {
  let out = path.resolve(String(p))
  if (process.platform === 'win32') out = out.toLowerCase()
  return out.replace(/[/\\]+$/, '')
}

/** Stable short hash used to make project ids unique across different folder sets. */
function shortHash(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 10)
}

/** A filesystem-safe slug for names and memory filenames. */
export function slugify(input, fallback = 'memory') {
  const slug = String(input ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug || fallback
}

/** Format one Date as an ISO-8601 UTC string. */
function nowIso() {
  return new Date().toISOString()
}

/**
 * Serialize YAML frontmatter scalars defensively: everything is emitted as a
 * JSON value, which is a strict subset of YAML 1.2 and therefore round-trips
 * without an extra dependency.
 */
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

/** Render frontmatter + body for one memory record. */
export function renderMemoryFile(record) {
  const lines = ['---']
  lines.push(`id: ${yamlScalar(record.id)}`)
  lines.push(`name: ${yamlScalar(record.name)}`)
  lines.push(`description: ${yamlScalar(record.description)}`)
  lines.push(`type: ${yamlScalar(record.type)}`)
  // The file records the descriptive value, never the bank alias: `personal`
  // names where an entry lives, `global` describes what it means, and only the
  // latter belongs in durable frontmatter.
  lines.push(`scope: ${yamlScalar(record.scope === 'personal' ? 'global' : record.scope)}`)
  lines.push(`tags: ${JSON.stringify(record.tags ?? [])}`)
  lines.push(`created: ${yamlScalar(record.created)}`)
  lines.push(`updated: ${yamlScalar(record.updated)}`)
  // `modified` is written as well as `updated`: it is the field name the
  // first-party per-memory markdown format uses, so these files stay readable
  // by that tooling (and by anything written against it).
  lines.push(`modified: ${yamlScalar(record.updated)}`)
  lines.push(`pinned: ${record.pinned ? 'true' : 'false'}`)
  if (record.source) lines.push(`source: ${yamlScalar(record.source)}`)
  if (record.project) lines.push(`project: ${yamlScalar(record.project)}`)
  lines.push('---', '')
  lines.push(String(record.body ?? '').replace(/\r\n/g, '\n').trimEnd(), '')
  return lines.join('\n')
}

/** Read `key: value` frontmatter into a plain object (tolerant of hand edits). */
export function parseMemoryFile(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  const meta = {}
  let body = normalized
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---', 3)
    if (end !== -1) {
      const head = normalized.slice(4, end)
      body = normalized.slice(end + 4).replace(/^\n/, '')
      for (const rawLine of head.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const sep = line.indexOf(':')
        if (sep === -1) continue
        const key = line.slice(0, sep).trim()
        let value = line.slice(sep + 1).trim()
        if (value.startsWith('"') || value.startsWith('[')) {
          try {
            value = JSON.parse(value)
          } catch {
            /* keep the raw string when a hand edit is not valid JSON */
          }
        } else if (value === 'true' || value === 'false') {
          value = value === 'true'
        } else if (value === 'null') {
          value = null
        }
        meta[key] = value
      }
    }
  }
  return { meta, body }
}

/** Build the searchable text of one record, lowercased once per query. */
function haystack(record) {
  return [record.name, record.description, (record.tags ?? []).join(' '), record.body]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

/** Split a query into lowercase terms, dropping noise. */
function terms(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter((term) => term.length > 1)
}

/**
 * Score one record against a query. Name/description/tag hits outrank body hits,
 * and a pinned memory gets a small constant lift so intent survives ranking.
 */
function scoreRecord(record, queryTerms) {
  if (queryTerms.length === 0) return record.pinned ? 1 : 0
  const name = String(record.name ?? '').toLowerCase()
  const description = String(record.description ?? '').toLowerCase()
  const tags = (record.tags ?? []).join(' ').toLowerCase()
  const body = String(record.body ?? '').toLowerCase()
  let score = 0
  for (const term of queryTerms) {
    if (name.includes(term)) score += 10
    if (tags.includes(term)) score += 6
    if (description.includes(term)) score += 4
    const bodyHits = body.split(term).length - 1
    if (bodyHits > 0) score += Math.min(bodyHits, 5)
  }
  if (record.pinned) score += 1
  return score
}

/** One lock chain per project so concurrent tool calls cannot interleave writes. */
const writeChains = new Map()

/** Run `task` after every previously queued task for `key`. */
function withLock(key, task) {
  const previous = writeChains.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  writeChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** True when an error is a transient Windows sharing violation. */
function isSharingViolation(error) {
  return (
    error &&
    (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY') &&
    process.platform === 'win32'
  )
}

/** Short pause without pulling in a timer dependency chain. */
function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Test-only seam: runs between writing the temporary file and publishing it.
 *
 * The interesting failure modes of an atomic write are races with something
 * outside this process (an antivirus scanner or a temp cleaner removing the
 * staged file). Those cannot be provoked reliably from a test, so the seam lets
 * a test delete or lock the staged file deterministically and assert that the
 * write still lands.
 */
export const atomicWriteHooks = { beforePublish: null }

/**
 * Write a file atomically so a crash can never leave a half-written memory.
 *
 * Two failure modes are handled, and both occur in ordinary operation rather
 * than only under synthetic load:
 *
 * 1. **Windows sharing violation.** `rename` cannot replace a destination that
 *    another handle holds open for reading. The memory section regenerates in
 *    the background while the model may be writing a memory, and a concurrent
 *    reader of `core.md` is enough to produce EPERM.
 * 2. **The staged file disappearing.** Something outside this process (a
 *    scanner, a cleaner) can remove `<file>.<pid>.<ts>.tmp` between the write
 *    and the rename, which surfaces as ENOENT on the *source* of the rename.
 *
 * For both, the whole sequence is retried from a fresh temp file, and the write
 * finally falls back to writing the destination in place. Landing the content is
 * what matters: a memory that reports success must actually be on disk.
 */
async function writeFileAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })

  /** Errors that mean "try again from scratch" rather than "give up". */
  const retryable = (error) => {
    if (isSharingViolation(error)) return true
    // ENOENT naming our own staged file means the rename source vanished.
    return error?.code === 'ENOENT' && typeof error.path === 'string' && error.path.endsWith('.tmp')
  }

  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const temp = `${file}.${process.pid}.${Date.now()}-${attempt}.tmp`
    try {
      await fs.writeFile(temp, content, 'utf8')
      if (atomicWriteHooks.beforePublish) await atomicWriteHooks.beforePublish(temp, file)
      await fs.rename(temp, file)
      return
    } catch (error) {
      lastError = error
      await fs.rm(temp, { force: true }).catch(() => {})
      if (!retryable(error)) break
      await pause(10 * (attempt + 1))
    }
  }

  // Last resort: write in place. Not atomic, but durable, and strictly better
  // than failing a write the caller was told would succeed.
  if (retryable(lastError) || lastError?.code === 'EEXIST' || lastError?.code === 'ENOTEMPTY') {
    try {
      await fs.writeFile(file, content, 'utf8')
      return
    } catch {
      /* fall through to the original error, which is the useful one */
    }
  }
  throw lastError
}

/** True when the path exists. */
async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/** Read JSON, returning `fallback` for a missing or corrupt file. */
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * One project's memory bank. Instances are cheap; callers create one per
 * operation through {@link MemoryStore.project}.
 */
export class MemoryProject {
  constructor(store, id, meta) {
    this.store = store
    this.id = id
    this.meta = meta
  }

  /** Directory holding this project's bank. */
  get dir() {
    return path.join(memoryRoot(), 'projects', this.id)
  }

  get memoriesDir() {
    return path.join(this.dir, 'memories')
  }

  get importsDir() {
    return path.join(this.dir, 'imports')
  }

  get exportsDir() {
    return path.join(this.dir, 'exports')
  }

  get corePath() {
    return path.join(this.dir, 'core.md')
  }

  get metaPath() {
    return path.join(this.dir, 'project.json')
  }

  /** Folders bound to this project (the first is the primary folder). */
  get folders() {
    return this.meta.folders ?? []
  }

  get label() {
    return this.meta.name || path.basename(this.folders[0] ?? '') || this.id
  }

  /** Create the directory skeleton if it is missing. */
  async ensure() {
    await fs.mkdir(this.memoriesDir, { recursive: true })
    await fs.mkdir(this.importsDir, { recursive: true })
    await fs.mkdir(this.exportsDir, { recursive: true })
    if (!(await exists(this.corePath))) {
      const header = [
        `# ${this.label} — core memory`,
        '',
        'Hand-written or agent-curated facts that must always be in context.',
        'Keep this file short: it is injected into every session bound to this project.',
        '',
      ].join('\n')
      await writeFileAtomic(this.corePath, header)
    }
  }

  /** Persist project metadata. */
  async saveMeta() {
    this.meta.updated = nowIso()
    await writeFileAtomic(this.metaPath, `${JSON.stringify(this.meta, null, 2)}\n`)
  }

  /** Read every memory file in the bank, newest-updated first. */
  async list() {
    await this.ensure()
    const names = await fs.readdir(this.memoriesDir).catch(() => [])
    const records = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const file = path.join(this.memoriesDir, name)
      let text
      try {
        text = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      const { meta, body } = parseMemoryFile(text)
      records.push({
        id: meta.id || name.replace(/\.md$/, ''),
        name: meta.name || name.replace(/\.md$/, ''),
        description: meta.description || '',
        type: MEMORY_TYPES.includes(meta.type) ? meta.type : 'project',
        scope: MEMORY_SCOPES.includes(meta.scope) ? meta.scope : 'project',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        pinned: meta.pinned === true,
        source: meta.source ?? null,
        project: meta.project ?? this.id,
        created: meta.created ?? null,
        updated: meta.updated ?? meta.modified ?? null,
        body: body.trimEnd(),
        file,
        fileName: name,
      })
    }
    records.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
    return records
  }

  /** Read one memory by id, slug or filename. */
  async get(ref) {
    const wanted = String(ref ?? '').trim()
    if (!wanted) return undefined
    const wantedSlug = slugify(wanted, '')
    const records = await this.list()
    return records.find(
      (record) =>
        record.id === wanted ||
        record.fileName === wanted ||
        record.fileName === `${wanted}.md` ||
        (wantedSlug && slugify(record.name, '') === wantedSlug),
    )
  }

  /** Allocate a filename that does not collide inside this bank. */
  async allocateFileName(type, name) {
    const base = `${slugify(type, 'memory')}-${slugify(name, 'memory')}`
    await this.ensure()
    const taken = new Set(await fs.readdir(this.memoriesDir).catch(() => []))
    let candidate = `${base}.md`
    let counter = 2
    while (taken.has(candidate)) {
      candidate = `${base}-${counter}.md`
      counter += 1
    }
    return candidate
  }

  /** Create a memory. Returns the stored record. */
  async save(input) {
    const body = String(input.body ?? '').trim()
    if (!body && !input.description) throw new Error('memory requires a body or a description')
    return withLock(this.id, async () => {
      await this.ensure()
      const name = String(input.name || body.split('\n')[0].slice(0, 60)).trim()
      const type = MEMORY_TYPES.includes(input.type) ? input.type : 'project'
      const scope = MEMORY_SCOPES.includes(input.scope) ? input.scope : 'project'
      const fileName = await this.allocateFileName(type, name)
      const timestamp = nowIso()
      const record = {
        id: fileName.replace(/\.md$/, ''),
        name,
        description: String(input.description ?? '').trim().slice(0, 400),
        type,
        scope,
        tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
        pinned: input.pinned === true,
        source: input.source ? String(input.source) : null,
        project: this.id,
        created: timestamp,
        updated: timestamp,
        body,
      }
      await writeFileAtomic(path.join(this.memoriesDir, fileName), renderMemoryFile(record))
      await this.regenerateIndex()
      return { ...record, fileName, file: path.join(this.memoriesDir, fileName) }
    })
  }

  /** Patch one memory in place, preserving unspecified fields. */
  async update(ref, patch) {
    return withLock(this.id, async () => {
      const existing = await this.get(ref)
      if (!existing) return undefined
      const next = {
        ...existing,
        name: patch.name !== undefined ? String(patch.name).trim() || existing.name : existing.name,
        description: patch.description !== undefined ? String(patch.description).trim() : existing.description,
        type: MEMORY_TYPES.includes(patch.type) ? patch.type : existing.type,
        scope: MEMORY_SCOPES.includes(patch.scope) ? patch.scope : existing.scope,
        tags: Array.isArray(patch.tags) ? patch.tags.map((tag) => String(tag).trim()).filter(Boolean) : existing.tags,
        pinned: patch.pinned !== undefined ? patch.pinned === true : existing.pinned,
        body: patch.body !== undefined ? String(patch.body) : existing.body,
        updated: nowIso(),
      }
      await writeFileAtomic(path.join(this.memoriesDir, existing.fileName), renderMemoryFile(next))
      await this.regenerateIndex()
      return { ...next, fileName: existing.fileName, file: existing.file }
    })
  }

  /** Replace the exact text `oldText` inside one memory's body. */
  async editBody(ref, oldText, newText, replaceAll = false) {
    return withLock(this.id, async () => {
      const existing = await this.get(ref)
      if (!existing) return { ok: false, reason: 'not-found' }
      const needle = String(oldText ?? '')
      if (!needle) return { ok: false, reason: 'empty-old-text' }
      if (!existing.body.includes(needle)) return { ok: false, reason: 'text-not-found', record: existing }
      const body = replaceAll ? existing.body.split(needle).join(String(newText ?? '')) : existing.body.replace(needle, String(newText ?? ''))
      const next = { ...existing, body, updated: nowIso() }
      await writeFileAtomic(path.join(this.memoriesDir, existing.fileName), renderMemoryFile(next))
      await this.regenerateIndex()
      return { ok: true, record: { ...next, fileName: existing.fileName, file: existing.file } }
    })
  }

  /** Delete one memory. */
  async forget(ref) {
    return withLock(this.id, async () => {
      const existing = await this.get(ref)
      if (!existing) return undefined
      await fs.rm(existing.file, { force: true })
      await this.regenerateIndex()
      return existing
    })
  }

  /** Rank memories for a natural-language query. */
  async search(query, options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 10, 100))
    const queryTerms = terms(query)
    let records = await this.list()
    if (options.type) records = records.filter((record) => record.type === options.type)
    if (options.scope) records = records.filter((record) => record.scope === options.scope)
    if (options.tag) {
      const tag = String(options.tag).toLowerCase()
      records = records.filter((record) => (record.tags ?? []).some((value) => String(value).toLowerCase() === tag))
    }
    const scored = records
      .map((record) => ({ record, score: scoreRecord(record, queryTerms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || String(b.record.updated ?? '').localeCompare(String(a.record.updated ?? '')))
    return scored.slice(0, limit).map((entry) => ({ ...entry.record, score: entry.score }))
  }

  /** Read the always-in-context core memory file. */
  async readCore() {
    await this.ensure()
    try {
      return await fs.readFile(this.corePath, 'utf8')
    } catch {
      return ''
    }
  }

  /** Replace the core memory file. */
  async writeCore(text) {
    return withLock(this.id, async () => {
      await this.ensure()
      await writeFileAtomic(this.corePath, String(text ?? ''))
      await this.regenerateIndex()
      return this.corePath
    })
  }

  /**
   * One index line per memory — the bounded, always-cheap part of context.
   *
   * This is the generated `index.md` shape (and the in-memory equivalent): a
   * single line per memory so the model knows what exists without paying for
   * every body. Truncated to {@link INDEX_MAX_LINES} lines / {@link INDEX_MAX_BYTES}
   * bytes, whichever comes first.
   */
  async indexLines() {
    const records = await this.list()
    const lines = []
    let bytes = 0
    let omitted = 0
    for (const record of records) {
      const tags = record.tags?.length ? ` #${record.tags.join(' #')}` : ''
      const summary = (record.description || record.body.split('\n')[0] || '').trim().slice(0, 160)
      const line = `- \`${record.id}\` **${record.name}** (${record.type}${record.pinned ? ', pinned' : ''}) — ${summary}${tags}`
      const size = Buffer.byteLength(`${line}\n`, 'utf8')
      if (lines.length >= INDEX_MAX_LINES || bytes + size > INDEX_MAX_BYTES) {
        omitted += 1
        continue
      }
      lines.push(line)
      bytes += size
    }
    return { lines, omitted, total: records.length }
  }

  /**
   * Regenerate the on-disk `index.md` next to the memory files, so the bank is
   * readable (and diffable) without the harness.
   *
   * Lock-free on purpose: callers already hold the project lock when they
   * refresh the index, and the lock is not reentrant.
   */
  async regenerateIndex() {
    await this.ensure()
    const { lines, omitted, total } = await this.indexLines()
    const core = (await this.readCore()).trim()
    const parts = [`# Memory index — ${this.label}`, '', `${total} memories.`, '']
    if (core) parts.push('## Core memory', '', core, '')
    parts.push('## Memories', '', ...(lines.length ? lines : ['_No memories stored yet._']))
    if (omitted > 0) parts.push('', `_${omitted} further memories omitted from this index._`)
    parts.push('')
    const target = path.join(this.dir, 'index.md')
    await writeFileAtomic(target, parts.join('\n'))
    return target
  }

  /** Regenerate `index.md` under the project lock. */
  async writeIndex() {
    return withLock(this.id, () => this.regenerateIndex())
  }

  /**
   * Render the always-in-context memory block for a session.
   *
   * Layered deliberately so cost stays bounded no matter how large the bank
   * grows:
   *   1. the core note (hand-curated, always relevant),
   *   2. an index line per memory (name, type, summary, tags, id),
   *   3. the full body of every `pinned` memory only.
   *
   * Everything else stays one `memory` call away, which is the same trade the
   * first-party memory index makes: bounded always-on context plus on-demand
   * bodies.
   */
  async renderContextBlock(budget = DEFAULT_CONTEXT_BUDGET, personal) {
    const core = (await this.readCore()).trim()
    const { lines, omitted, total } = await this.indexLines()
    const records = await this.list()
    const pinned = records.filter((record) => record.pinned)
    const isPersonalBank = this.id === PERSONAL_PROJECT_ID

    const parts = [
      [
        `# Memory: ${this.label}`,
        '',
        'Durable facts carried over from earlier sessions. Treat them as established context.',
        'Use the `memory` tool to save, recall, read, update or forget entries; `memory_context` pulls more.',
        'The index below is deliberately compact — read any entry in full before relying on its detail.',
        this.folders.length ? `Bound folders:\n${this.folders.map((folder) => `- ${folder}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ]
    let used = parts[0].length
    const push = (text) => {
      if (used + text.length > budget) return false
      parts.push(text)
      used += text.length
      return true
    }

    if (core) push(`## Core memory\n\n${core}`)

    if (total > 0) {
      const heading = isPersonalBank ? '## Personal archive' : '## Memory index'
      const header = `${heading} (${total} ${total === 1 ? 'entry' : 'entries'})`
      const body = lines.join('\n')
      const tail = omitted > 0 ? `\n_${omitted} further entries are omitted from this index._` : ''
      push(`${header}\n\n${body}${tail}\n\n_Read any entry in full with \`memory\` \`{"action":"read","id":"<id>"}\`._`)
    }

    for (const record of pinned) {
      push(`## Pinned: ${record.name}\n\n${record.body.trim()}`)
    }

    // Personal memories apply to every project, so they ride along with the
    // project's own block — always under their own heading, never merged into
    // the project index.
    if (personal && !isPersonalBank) {
      const section = await personal.renderPersonalIndex(Math.max(500, budget - used))
      if (section) push(section)
    }

    return parts.join('\n\n').trim()
  }

  /**
   * The personal archive's index, rendered for a session's memory block.
   *
   * Personal memories are shown to every session, so they are always labelled
   * as such: an entry that applies everywhere must not read as if it belonged
   * to whichever folder happens to be open.
   *
   * @param budget - character ceiling for this section.
   * @returns the rendered section, or '' when the archive is empty.
   */
  async renderPersonalIndex(budget = 3000) {
    const { lines, omitted, total } = await this.indexLines()
    if (total === 0) return ''
    const core = (await this.readCore()).trim()
    const parts = [`## Personal archive (${total} ${total === 1 ? 'entry' : 'entries'})`]
    if (core) parts.push(core)
    parts.push(lines.join('\n'))
    if (omitted > 0) parts.push(`_${omitted} further personal entries are omitted._`)
    parts.push('_Applies to every project. Read one with `memory` `{"action":"read","id":"<id>","scope":"global"}`._')
    const text = parts.join('\n\n')
    return text.length > budget ? `${text.slice(0, budget)}\n…` : text
  }

  /** Summarize the bank for listings and UI. */
  async stats() {
    const records = await this.list()
    const byType = {}
    for (const type of MEMORY_TYPES) byType[type] = 0
    for (const record of records) byType[record.type] = (byType[record.type] ?? 0) + 1
    const core = await this.readCore()
    return {
      projectId: this.id,
      label: this.label,
      folders: this.folders,
      dir: this.dir,
      total: records.length,
      pinned: records.filter((record) => record.pinned).length,
      byType,
      coreChars: core.length,
      updated: records[0]?.updated ?? null,
    }
  }
}

/**
 * The memory store: resolves the project a folder belongs to and hands out
 * {@link MemoryProject} handles.
 */
export class MemoryStore {
  constructor() {
    this.registryPath = path.join(memoryRoot(), 'projects.json')
  }

  async readRegistry() {
    const data = await readJson(this.registryPath, { version: 1, projects: {} })
    if (!data || typeof data !== 'object' || typeof data.projects !== 'object' || data.projects === null) {
      return { version: 1, projects: {} }
    }
    return data
  }

  async writeRegistry(registry) {
    await writeFileAtomic(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`)
  }

  /** Every registered project, most recently updated first. */
  async projects() {
    const registry = await this.readRegistry()
    return Object.values(registry.projects).sort((a, b) =>
      String(b.updated ?? '').localeCompare(String(a.updated ?? '')),
    )
  }

  /**
   * Resolve the project bound to `folder`, creating one on first use.
   *
   * A folder that was explicitly bound to an existing project always resolves
   * to that project, which is what makes a project span several directories.
   *
   * The personal archive is skipped outright: it holds no folders by
   * construction, and a folder must never resolve into the person's archive.
   */
  async resolve(folder) {
    const wanted = normalizePath(folder || process.cwd())
    const registry = await this.readRegistry()
    for (const project of Object.values(registry.projects)) {
      if (project.id === PERSONAL_PROJECT_ID) continue
      const match = (project.folders ?? []).some((bound) => normalizePath(bound) === wanted)
      if (match) {
        project.updated = nowIso()
        await this.writeRegistry(registry)
        return this.project(project.id, project)
      }
    }
    return this.create({ name: path.basename(wanted) || 'project', folders: [folder || process.cwd()] })
  }

  /** Fetch a project by id. */
  async get(id) {
    const registry = await this.readRegistry()
    const project = registry.projects[id]
    if (!project) return undefined
    return this.project(id, project)
  }

  /** Wrap a project id + metadata in a handle. */
  project(id, meta) {
    return new MemoryProject(this, id, meta)
  }

  /**
   * The personal archive, created on first use.
   *
   * Deliberately not reachable through {@link MemoryStore.resolve}: no folder
   * resolves to it, so a project can never accidentally become the person's
   * archive. It is a project only so it reuses the same storage.
   *
   * @returns the personal {@link MemoryProject}.
   */
  async personal() {
    const registry = await this.readRegistry()
    let entry = registry.projects[PERSONAL_PROJECT_ID]
    if (!entry) {
      const timestamp = nowIso()
      entry = { id: PERSONAL_PROJECT_ID, name: '个人归档', folders: [], created: timestamp, updated: timestamp }
      registry.projects[PERSONAL_PROJECT_ID] = entry
      await this.writeRegistry(registry)
    }
    const handle = this.project(PERSONAL_PROJECT_ID, entry)
    await handle.ensure()
    return handle
  }

  /** Whether a project id is the reserved personal archive. */
  isPersonal(projectId) {
    return projectId === PERSONAL_PROJECT_ID
  }

  /** Create a new project for one or more folders. */
  async create(input) {
    const folders = (input.folders ?? []).map((folder) => path.resolve(folder))
    const registry = await this.readRegistry()
    const key = folders.map(normalizePath).sort().join('|') || shortHash(String(Date.now()))
    let id = `${slugify(input.name || path.basename(folders[0] ?? '') || 'project', 'project')}-${shortHash(key)}`
    let suffix = 2
    while (registry.projects[id]) {
      id = `${slugify(input.name || 'project', 'project')}-${shortHash(key)}-${suffix}`
      suffix += 1
    }
    const timestamp = nowIso()
    const project = {
      id,
      name: String(input.name ?? '').trim() || path.basename(folders[0] ?? '') || 'project',
      folders,
      created: timestamp,
      updated: timestamp,
    }
    registry.projects[id] = project
    await this.writeRegistry(registry)
    const handle = this.project(id, project)
    await handle.ensure()
    await handle.saveMeta()
    return handle
  }

  /** Bind one more folder to an existing project. */
  async bindFolder(folder, projectId) {
    const target = path.resolve(folder)
    const registry = await this.readRegistry()

    if (!projectId) {
      // No explicit project: adopt the project of the closest bound ancestor
      // folder, otherwise mint a new project for this folder.
      const wanted = normalizePath(target)
      for (const project of Object.values(registry.projects)) {
        const related = (project.folders ?? []).some((bound) => {
          const norm = normalizePath(bound)
          return wanted === norm || wanted.startsWith(`${norm}${path.sep}`) || norm.startsWith(`${wanted}${path.sep}`)
        })
        if (related) return { project: await this.bindFolder(target, project.id), created: false }
      }
      return { project: await this.create({ name: path.basename(target), folders: [target] }), created: true }
    }

    const project = registry.projects[projectId]
    if (!project) throw new Error(`unknown project "${projectId}"`)
    project.folders = Array.from(new Set([...(project.folders ?? []), target]))
    project.updated = nowIso()
    await this.writeRegistry(registry)
    const handle = this.project(projectId, project)
    await handle.ensure()
    await handle.saveMeta()
    return { project: handle, created: false }
  }

  /** Remove a folder binding (the memory bank itself is untouched). */
  async unbindFolder(folder, projectId) {
    const registry = await this.readRegistry()
    const project = registry.projects[projectId]
    if (!project) throw new Error(`unknown project "${projectId}"`)
    const wanted = normalizePath(folder)
    project.folders = (project.folders ?? []).filter((bound) => normalizePath(bound) !== wanted)
    project.updated = nowIso()
    await this.writeRegistry(registry)
    const handle = this.project(projectId, project)
    await handle.saveMeta()
    return handle
  }
}
