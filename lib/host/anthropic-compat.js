/**
 * DSH Memory — Anthropic memory-tool compatibility surface.
 *
 * Exposes the `/memories` file contract that the Anthropic `memory_20250818`
 * tool defines, so a model already trained on those verbs can drive this
 * project's bank without relearning anything:
 *
 *   view{path, view_range?}          create{path, file_text}
 *   str_replace{path, old_str, new_str?}
 *   insert{path, insert_line, insert_text}
 *   delete{path}                     rename{old_path, new_path}
 *
 * Path mapping: the virtual `/memories` root IS the project's `memories/`
 * directory, and `/memories/core.md` is the project's `core.md`. That keeps the
 * contract literal (files live directly under `/memories`, as the spec says)
 * instead of introducing a synthetic nesting level.
 *
 * Where the three first-party artifacts disagree, this picks deliberately and
 * documents the choice:
 *
 *   - `create` on an existing path → ERROR (docs + SDK `O_EXCL`), never the
 *     cookbook's silent overwrite. Silent data loss is the recurring failure
 *     across every memory implementation surveyed; a loud error is cheap.
 *   - non-unique `str_replace` → ERROR (cookbook), not "replace first" (docs).
 *     Forcing disambiguation is the safer reading of an ambiguous instruction.
 *   - `/memories` itself cannot be deleted or renamed.
 *
 * @module dsh-memory/anthropic-compat
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from './schema.js'
import { parseMemoryFile, renderMemoryFile } from './store.js'

/** The virtual root every path must live under. */
export const MEMORY_ROOT = '/memories'

/** Directory listings never descend past this depth, matching the spec. */
const MAX_LIST_DEPTH = 2

/** `view` refuses to return more lines than this in one call. */
const MAX_VIEW_LINES = 999_999

/** Resolution of one virtual path against a project's bank. */
export class MemoryPathError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MemoryPathError'
  }
}

/**
 * Turn a virtual `/memories...` path into a real filesystem path.
 *
 * Rejects escapes loudly: a path that resolves outside the bank is a bug or an
 * attack, never something to normalise away silently.
 *
 * @param project - the target project.
 * @param input - the model-supplied virtual path.
 * @returns `{ kind: 'root' | 'core' | 'file', realPath, virtualPath }`.
 */
export function resolveMemoryPath(project, input) {
  const raw = String(input ?? '').trim()
  if (!raw.startsWith(MEMORY_ROOT)) {
    throw new MemoryPathError(`path must start with "${MEMORY_ROOT}" (got ${JSON.stringify(raw)})`)
  }
  const suffix = raw.slice(MEMORY_ROOT.length).replace(/^\/+/, '')
  if (suffix === '') return { kind: 'root', realPath: project.memoriesDir, virtualPath: MEMORY_ROOT }
  if (suffix.includes('..')) throw new MemoryPathError(`path must not contain ".." (got ${JSON.stringify(raw)})`)

  if (suffix === 'core.md') return { kind: 'core', realPath: project.corePath, virtualPath: `${MEMORY_ROOT}/core.md` }

  const realPath = path.join(project.memoriesDir, suffix)
  const normalizedRoot = path.resolve(project.memoriesDir)
  const normalizedTarget = path.resolve(realPath)
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new MemoryPathError(`path escapes the memory bank: ${JSON.stringify(raw)}`)
  }
  return { kind: 'file', realPath, virtualPath: `${MEMORY_ROOT}/${suffix}` }
}

/** `{size}\t{path}` lines for a directory tree, depth-limited and never recursing into itself. */
async function listTree(rootReal, rootVirtual, coreReal, coreVirtual) {
  const lines = []
  const walk = async (realDir, virtualDir, depth) => {
    let entries
    try {
      entries = await fs.readdir(realDir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const realChild = path.join(realDir, entry.name)
      const virtualChild = `${virtualDir}/${entry.name}`
      if (entry.isDirectory()) {
        const info = await fs.stat(realChild).catch(() => undefined)
        lines.push(`${info?.size ?? 0}\t${virtualChild}`)
        if (depth < MAX_LIST_DEPTH) await walk(realChild, virtualChild, depth + 1)
      } else if (entry.isFile()) {
        const info = await fs.stat(realChild).catch(() => undefined)
        lines.push(`${info?.size ?? 0}\t${virtualChild}`)
      }
    }
  }
  // The root itself is always present, and so is `core.md`: it lives one level
  // above the memories directory but is directly readable as `/memories/core.md`,
  // so hiding it from the listing would make `view` disagree with itself.
  const rootInfo = await fs.stat(rootReal).catch(() => undefined)
  lines.push(`${rootInfo?.size ?? 0}\t${rootVirtual}`)
  if (coreReal) {
    const coreInfo = await fs.stat(coreReal).catch(() => undefined)
    if (coreInfo) lines.push(`${coreInfo.size}\t${coreVirtual}`)
  }
  await walk(rootReal, rootVirtual, 1)
  return lines
}

/** `view`'s line-numbered file rendering: 6-wide right-aligned, tab-separated, 1-indexed. */
function renderNumbered(lines, startLine) {
  return lines.map((line, offset) => `${String(startLine + offset).padStart(6, ' ')}\t${line}`).join('\n')
}

/**
 * Apply one Anthropic memory-tool command.
 *
 * Kept as a plain function (not a tool body) so it is directly testable and so
 * the tool wrapper stays a thin adapter.
 *
 * @param project - the target project.
 * @param command - one parsed command.
 * @returns `{ content, isError }` in the tool-result vocabulary.
 */
export async function applyMemoryCommand(project, command) {
  const ok = (content) => ({ content, isError: false })
  const fail = (content) => ({ content, isError: true })

  try {
    switch (command.command) {
      case 'view': {
        const target = resolveMemoryPath(project, command.path)
        if (target.kind === 'root' || command.view_range === undefined) {
          const info = await fs.stat(target.realPath).catch(() => undefined)
          if (!info) return fail(`Error: path ${command.path} does not exist`)
          if (info.isDirectory()) {
            const listing = await listTree(target.realPath, target.virtualPath, project.corePath, `${MEMORY_ROOT}/core.md`)
            return ok(`Directory listing for ${command.path}:\n${listing.join('\n')}`)
          }
        }

        let text
        try {
          text = await fs.readFile(target.realPath, 'utf8')
        } catch {
          return fail(`Error: path ${command.path} does not exist`)
        }
        // A trailing newline terminates the last line; it does not start a new
        // one. Counting it would report a phantom empty final line and make
        // `view_range: [n, -1]` disagree with what the user sees in an editor.
        if (text.endsWith('\n')) text = text.slice(0, -1)
        const allLines = text.split('\n')
        let start = 1
        let end = allLines.length
        if (command.view_range !== undefined) {
          const range = command.view_range
          if (!Array.isArray(range) || range.length !== 2) return fail('Error: view_range must be [start, end]')
          start = Number(range[0])
          end = Number(range[1]) === -1 ? allLines.length : Number(range[1])
        }
        if (!Number.isInteger(start) || start < 1) return fail('Error: view_range start must be a positive integer')
        if (end > allLines.length) end = allLines.length
        if (start > allLines.length) return fail(`Error: view_range start ${start} is past the end of ${command.path}`)
        const slice = allLines.slice(start - 1, Math.min(end, start - 1 + MAX_VIEW_LINES))
        return ok(`Here's the content of ${command.path} with line numbers:\n${renderNumbered(slice, start)}`)
      }

      case 'create': {
        const target = resolveMemoryPath(project, command.path)
        if (target.kind !== 'file') return fail(`Error: cannot create ${command.path}`)
        await fs.mkdir(path.dirname(target.realPath), { recursive: true })
        // O_EXCL: refuse to clobber. A memory bank is durable data, so a
        // duplicate create is far more likely to be a mistake than an intent.
        try {
          await fs.writeFile(target.realPath, String(command.file_text ?? ''), { encoding: 'utf8', flag: 'wx' })
        } catch (error) {
          if (error?.code === 'EEXIST') return fail(`Error: File ${command.path} already exists`)
          throw error
        }
        await project.regenerateIndex()
        return ok(`File created successfully at: ${command.path}`)
      }

      case 'str_replace': {
        const target = resolveMemoryPath(project, command.path)
        if (target.kind !== 'file') return fail(`Error: cannot edit ${command.path}`)
        let text
        try {
          text = await fs.readFile(target.realPath, 'utf8')
        } catch {
          return fail(`Error: path ${command.path} does not exist`)
        }
        const needle = String(command.old_str ?? '')
        if (!needle) return fail('Error: old_str must not be empty')
        const occurrences = text.split(needle).length - 1
        if (occurrences === 0) return fail(`Error: old_str was not found in ${command.path}`)
        if (occurrences > 1 && command.replace_all !== true) {
          return fail(
            `Error: old_str appears ${occurrences} times in ${command.path}; it must be unique. ` +
              'Include more surrounding context, or pass replace_all: true.',
          )
        }
        const replacement = String(command.new_str ?? '')
        const next = command.replace_all === true ? text.split(needle).join(replacement) : text.replace(needle, replacement)
        await fs.writeFile(target.realPath, next, 'utf8')
        await project.regenerateIndex()
        return ok(`The memory file has been edited.`)
      }

      case 'insert': {
        const target = resolveMemoryPath(project, command.path)
        if (target.kind !== 'file') return fail(`Error: cannot edit ${command.path}`)
        let text
        try {
          text = await fs.readFile(target.realPath, 'utf8')
        } catch {
          return fail(`Error: path ${command.path} does not exist`)
        }
        const line = Number(command.insert_line)
        if (!Number.isInteger(line) || line < 0) return fail('Error: insert_line must be a non-negative integer')
        const lines = text.split('\n')
        if (line > lines.length) {
          return fail(`Error: insert_line ${line} is past the end of ${command.path} (${lines.length} lines)`)
        }
        lines.splice(line, 0, ...String(command.insert_text ?? '').split('\n'))
        await fs.writeFile(target.realPath, lines.join('\n'), 'utf8')
        await project.regenerateIndex()
        return ok(`Text inserted at line ${line} of ${command.path}.`)
      }

      case 'delete': {
        const target = resolveMemoryPath(project, command.path)
        if (target.kind === 'root') return fail(`Error: ${MEMORY_ROOT} itself cannot be deleted`)
        if (target.kind === 'core') return fail('Error: the core memory file cannot be deleted through this tool; use the `memory` tool')
        try {
          await fs.rm(target.realPath, { force: false })
        } catch {
          return fail(`Error: path ${command.path} does not exist`)
        }
        await project.regenerateIndex()
        return ok(`Successfully deleted ${command.path}`)
      }

      case 'rename': {
        const from = resolveMemoryPath(project, command.old_path)
        const to = resolveMemoryPath(project, command.new_path)
        if (from.kind === 'root') return fail(`Error: ${MEMORY_ROOT} itself cannot be renamed`)
        if (to.kind !== 'file') return fail(`Error: cannot rename onto ${command.new_path}`)
        if (from.kind === 'core') return fail('Error: the core memory file cannot be renamed through this tool')
        try {
          await fs.access(from.realPath)
        } catch {
          return fail(`Error: path ${command.old_path} does not exist`)
        }
        // rename never overwrites: the target must be free.
        try {
          await fs.access(to.realPath)
          return fail(`Error: destination ${command.new_path} already exists`)
        } catch {
          /* free, as required */
        }
        await fs.mkdir(path.dirname(to.realPath), { recursive: true })
        await fs.rename(from.realPath, to.realPath)
        await project.regenerateIndex()
        return ok(`Successfully renamed ${command.old_path} to ${command.new_path}`)
      }

      default:
        return fail(
          `Error: unknown command ${JSON.stringify(command.command)}. ` +
            'Supported: view, create, str_replace, insert, delete, rename.',
        )
    }
  } catch (error) {
    if (error instanceof MemoryPathError) return fail(`Error: ${error.message}`)
    return fail(`Error: ${error?.message ?? String(error)}`)
  }
}

/**
 * Check that a file still parses as a memory after a raw edit, and repair the
 * metadata when the edit landed in the body.
 *
 * The compatibility verbs edit raw bytes. Rather than letting a hand edit push
 * a file out of the bank's index, refresh `updated`/`modified` and re-render
 * when the shape is intact; a file whose frontmatter was destroyed is left
 * exactly as the caller wrote it (their content, their call) and simply shows
 * up in `list()` under its filename.
 *
 * @param realPath - the file that was written.
 */
export async function touchMemoryFile(realPath) {
  let text
  try {
    text = await fs.readFile(realPath, 'utf8')
  } catch {
    return
  }
  const { meta, body } = parseMemoryFile(text)
  if (!meta.name && !meta.id && !meta.description) return
  const next = renderMemoryFile({
    id: meta.id ?? path.basename(realPath, '.md'),
    name: meta.name ?? path.basename(realPath, '.md'),
    description: meta.description ?? '',
    type: meta.type,
    scope: meta.scope,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    pinned: meta.pinned === true,
    created: meta.created,
    updated: new Date().toISOString(),
    source: meta.source,
    project: meta.project,
    body,
  })
  if (next !== text) await fs.writeFile(realPath, next, 'utf8')
}

/** Tool parameter specs, shared by the tool definition and its tests. */
const PARAMETERS = {
  command: {
    type: 'string',
    required: true,
    enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
    description: 'The memory command to run.',
  },
  path: { type: 'string', description: 'view/create/str_replace/insert/delete: absolute path under /memories.' },
  view_range: {
    type: 'array',
    items: { type: 'integer' },
    description: 'view: [start, end] 1-indexed lines; end of -1 means to the end of the file.',
  },
  file_text: { type: 'string', description: 'create: the file content to write.' },
  old_str: { type: 'string', description: 'str_replace: the exact text to replace. Must appear exactly once unless replace_all.' },
  new_str: { type: 'string', description: 'str_replace: replacement text; omit to delete the matched text.' },
  replace_all: { type: 'boolean', description: 'str_replace: replace every occurrence instead of requiring uniqueness.' },
  insert_line: { type: 'integer', description: 'insert: 0-based line index to insert at; 0 prepends.' },
  insert_text: { type: 'string', description: 'insert: the text to insert.' },
  old_path: { type: 'string', description: 'rename: the existing path.' },
  new_path: { type: 'string', description: 'rename: the destination path; must not already exist.' },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', required: true },
    ok: { type: 'boolean', required: true },
    text: { type: 'string', required: true },
  },
}

/**
 * Build the Anthropic-compatible memory tool bound to one store.
 *
 * @param store - the memory store.
 * @param projectOf - resolves the calling agent's project.
 * @returns the tool definition.
 */
export function memoryFileTool(store, projectOf) {
  return defineTool({
    name: 'memory_files',
    description: [
      'Edit your memory as files under the /memories directory (Anthropic memory-tool compatible).',
      '',
      'The /memories root is this project\'s memory bank; `/memories/core.md` is the always-in-context core note.',
      'Use this for file-level control; prefer the `memory` tool for semantic save/recall/edit.',
      '',
      'Commands:',
      '- view { path, view_range? }            list a directory, or read a file (optionally a line range; -1 = EOF).',
      '- create { path, file_text }             create a new file. Fails if the path already exists.',
      '- str_replace { path, old_str, new_str? } replace exact text; old_str must be unique (or pass replace_all).',
      '- insert { path, insert_line, insert_text } insert text at a 0-based line index (0 prepends).',
      '- delete { path }                        delete a file.',
      '- rename { old_path, new_path }          move a file; never overwrites an existing destination.',
      '',
      'Always view a path before editing it, so the text you replace matches byte for byte.',
    ].join('\n'),
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const project = await projectOf(exec)
      const result = await applyMemoryCommand(project, args)
      if (!result.isError) {
        // Keep the generated index and timestamps honest after a raw edit.
        const pathArg = args.path ?? args.old_path
        if (args.command !== 'view' && pathArg) {
          const target = resolveMemoryPath(project, pathArg)
          if (target.kind !== 'root') await touchMemoryFile(target.realPath)
        }
        if (args.command === 'rename' && args.new_path) {
          const target = resolveMemoryPath(project, args.new_path)
          if (target.kind !== 'root') await touchMemoryFile(target.realPath)
        }
      }
      return { command: String(args.command), ok: !result.isError, text: result.content }
    },
    presentCall: (args) => ({ card: 'generic', title: `memory_files ${String(args.command ?? '')}`.trim(), kind: 'other', rawInput: args }),
  })
}
