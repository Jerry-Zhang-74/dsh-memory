/**
 * DSH Memory — conversational import/export.
 *
 * The point of this module: importing memory should be a *conversation*, not a
 * file dialog. A user pastes whatever they have — a claude.ai memory export
 * copied out of the settings panel, a pile of notes, a JSON dump, a whole
 * directory of markdown — and the model calls `memory_import` with the text it
 * was given. Nothing external has to know a path.
 *
 * Both shapes are accepted and auto-detected:
 *   - `content`: raw pasted text (any supported format)
 *   - `path`:    a file or directory the user referenced instead
 *
 * Writing is deliberately separated from parsing: `preview` returns the parsed
 * candidates for the model to review and re-shape before anything durable is
 * touched. That is the `remember`-then-`commit` discipline the prior art
 * converges on, reduced to one tool with a flag.
 *
 * @module dsh-memory/import-tool
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from './schema.js'
import { MEMORY_SCOPES, MEMORY_TYPES } from './store.js'
import { mergeCandidates, parseImport } from './transfer.js'

/** Extensions worth reading when the caller points at a directory. */
const READABLE = /\.(md|markdown|txt|json|jsonl|ndjson)$/i

/** Files that are scaffolding rather than memory, skipped in a directory sweep. */
const SKIP = /^(README|LICENSE|index)\.(md|markdown|txt)$/i

/**
 * Read every readable file under a directory, newest first and bounded.
 *
 * Pointing at a folder is the common case for "here is my memory export", and a
 * user should not have to name each file.
 *
 * @param dir - directory to sweep.
 * @param maxFiles - hard cap so one call cannot read an entire disk.
 * @returns `{ files, skipped }`.
 */
async function collectFromDirectory(dir, maxFiles = 400) {
  const files = []
  let skipped = 0

  const walk = async (current, depth) => {
    if (files.length >= maxFiles || depth > 4) return
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        if (READABLE.test(entry.name) && !SKIP.test(entry.name)) files.push(full)
        else skipped += 1
      }
    }
  }

  await walk(dir, 1)
  return { files, skipped }
}

/**
 * Parse either a pasted blob or a path into memory candidates.
 *
 * @param input - `{ content, path, cwd }`.
 * @returns `{ candidates, core, sources, kind, skipped }`.
 */
export async function readImportInput(input) {
  const candidates = []
  const sources = []
  let core = ''
  let kind = 'text'
  let skipped = 0

  if (typeof input.content === 'string' && input.content.trim() !== '') {
    const parsed = await parseImport(Buffer.from(input.content, 'utf8'), input.name || 'pasted.md')
    candidates.push(...parsed.candidates)
    core = parsed.core || core
    kind = parsed.kind
    sources.push('(pasted text)')
  }

  if (typeof input.path === 'string' && input.path.trim() !== '') {
    const target = path.resolve(input.cwd || process.cwd(), input.path.trim())
    const info = await fs.stat(target).catch(() => undefined)
    if (!info) throw new Error(`cannot read ${target}: no such file or directory`)

    if (info.isDirectory()) {
      const { files, skipped: skippedCount } = await collectFromDirectory(target)
      skipped += skippedCount
      if (files.length === 0) throw new Error(`no readable markdown or json files under ${target}`)
      for (const file of files) {
        const bytes = await fs.readFile(file)
        const parsed = await parseImport(bytes, path.basename(file))
        candidates.push(...parsed.candidates)
        core = parsed.core || core
        sources.push(path.relative(input.cwd || process.cwd(), file))
      }
      kind = 'directory'
    } else {
      const bytes = await fs.readFile(target)
      const parsed = await parseImport(bytes, path.basename(target))
      candidates.push(...parsed.candidates)
      core = parsed.core || core
      sources.push(path.basename(target))
      kind = parsed.kind
    }
  }

  return { candidates, core, sources, kind, skipped }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', required: true, enum: ['preview', 'commit'] },
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
    total: { type: 'integer', required: true },
    created: { type: 'integer', required: true },
    duplicates: { type: 'integer', required: true },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          type: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          body: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['new', 'duplicate', 'created'] },
        },
      },
    },
  },
}

/**
 * Build the conversational import tool.
 *
 * @param store - the memory store.
 * @param projectOf - resolves the calling agent's project.
 * @returns the tool definition.
 */
export function memoryImportTool(store, projectOf) {
  return defineTool({
    name: 'memory_import',
    description: [
      'Bring existing memory into this project from conversation.',
      '',
      'This is the right tool when a user pastes memory content, says "remember all this", or points at an',
      'export they have. Pass the text they gave you as `content`, or `path` for a file or a whole folder.',
      'Supported shapes are auto-detected: native bundles, JSON/JSONL arrays of records, markdown with or',
      'without frontmatter, plain text, a claude.ai-style memory export copied as prose, and ZIP archives.',
      '',
      'Two-step by design, so imported content never silently becomes authoritative:',
      '  1. Call with `preview: true` (the default) and SHOW the user what was understood, in their language.',
      '  2. After they confirm — or immediately, if they clearly asked you to just do it — call again with',
      '     `preview: false` to write the entries.',
      '',
      'Duplicates (same name and body) are skipped automatically. Never import credentials, API keys, tokens,',
      'or personal identifiers: drop those candidates and say so.',
      '',
      'For a large or messy import, prefer `/memory import <path>` in the conversation, which hands the work to',
      'an isolated curator conversation instead of consuming this context.',
    ].join('\n'),
    parameters: {
      content: {
        type: 'string',
        description: 'The memory text to import, as pasted. Preferred over `path` when the content is already in the conversation.',
      },
      path: {
        type: 'string',
        description: 'A file or directory to read instead of `content`. Directories are swept for markdown and json.',
      },
      preview: {
        type: 'boolean',
        description: 'true (default) reports what would be imported without writing. false commits the entries.',
      },
      type: { type: 'string', enum: [...MEMORY_TYPES], description: 'Override the type for every imported entry.' },
      scope: { type: 'string', enum: [...MEMORY_SCOPES], description: 'Override the scope for every imported entry.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Extra tags applied to every imported entry.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const lines = [value.message, '']
        for (const candidate of value.candidates ?? []) {
          const marker = candidate.status === 'duplicate' ? '↺' : candidate.status === 'created' ? '✓' : '·'
          const tags = candidate.tags?.length ? ` #${candidate.tags.join(' #')}` : ''
          const preview = candidate.body.replace(/\s+/g, ' ').slice(0, 160)
          lines.push(`${marker} **${candidate.name}** (${candidate.type}${tags}) — ${preview}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const project = await projectOf(exec)
      const mode = args.preview === false ? 'commit' : 'preview'

      const parsed = await readImportInput({
        content: args.content,
        path: args.path,
        cwd: exec.agent?.session?.meta?.cwd,
      })

      if (parsed.candidates.length === 0) {
        return {
          mode,
          ok: false,
          message: 'Nothing importable was found. Pass the memory text as `content`, or a path to a file or folder.',
          total: 0,
          created: 0,
          duplicates: 0,
          candidates: [],
        }
      }

      // Apply per-import overrides uniformly, so the caller can say
      // "everything in here is about me" without editing each entry.
      const candidates = parsed.candidates.map((candidate) => ({
        ...candidate,
        ...(args.type ? { type: args.type } : {}),
        ...(args.scope ? { scope: args.scope } : {}),
        tags: Array.from(new Set([...(candidate.tags ?? []), ...(args.tags ?? [])])),
      }))

      const result = await mergeCandidates(project, candidates, {
        dryRun: mode === 'preview',
        source: parsed.sources.length === 1 ? `import:${parsed.sources[0]}` : `import:${parsed.sources.length} sources`,
        core: parsed.core,
      })

      const createdNames = new Set(result.created.map((entry) => entry.name))
      const duplicateNames = new Set(result.skipped.map((entry) => entry.name))

      const report = candidates.slice(0, 60).map((candidate) => ({
        name: candidate.name,
        type: candidate.type,
        tags: candidate.tags ?? [],
        body: candidate.body,
        status: duplicateNames.has(candidate.name) ? 'duplicate' : createdNames.has(candidate.name) ? 'created' : 'new',
      }))

      const sourceLabel = parsed.sources.length > 2 ? `${parsed.sources.length} files` : parsed.sources.join(', ')
      const message =
        mode === 'preview'
          ? `Read ${parsed.candidates.length} candidate ${parsed.candidates.length === 1 ? 'memory' : 'memories'} from ${sourceLabel} (${parsed.kind}). ${result.skipped.length} already exist. Nothing has been written yet — review these, then commit.`
          : `Imported ${result.created.length} of ${parsed.total} candidates from ${sourceLabel}; ${result.skipped.length} were duplicates.`

      return {
        mode,
        ok: true,
        message,
        total: parsed.candidates.length,
        created: result.created.length,
        duplicates: result.skipped.length,
        candidates: report,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.path ? 'Import memory from a path' : 'Import pasted memory',
      kind: 'other',
      rawInput: args.path ?? args.content?.slice(0, 200),
    }),
  })
}
