/**
 * dsh-memory — host half.
 *
 * A Claude-style memory manager for DeepSeek Harness:
 *
 *   - project-scoped memory banks that can span several folders,
 *   - an always-in-context memory index injected into every session,
 *   - `memory` / `memory_context` tools so the model can form, revise and
 *     forget memories through conversation,
 *   - `/memory` slash commands for one-click import and export,
 *   - isolated conversations (real child sessions) that process an import or
 *     host a standalone companion chat sharing the project's memory.
 *
 * @module dsh-memory
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { memoryTools } from './tools.js'
import { memoryFileTool } from './anthropic-compat.js'
import { memoryImportTool } from './import-tool.js'
import { MemoryStore, memoryRoot } from './store.js'
import { buildBundle, exportProject, mergeCandidates, parseImport, renderDigest, stageImport } from './transfer.js'
import { processImport } from './chat.js'

/** Cordis plugin name. */
export const name = 'memory'

/**
 * Services this plugin needs. `subagents` is required because isolated
 * conversations are a core feature rather than an optional extra.
 */
export const inject = ['tools', 'commands', 'systemPrompt', 'subagents']

/** Prompt order for the memory section: tool guidance lands in the 100–199 band. */
const MEMORY_SECTION_ORDER = 120

/**
 * Per-agent memory renderers, keyed by session id.
 *
 * A prompt section's `text` provider must be synchronous, so the section serves
 * a snapshot that is refreshed out of band. Registration also has to happen
 * once per agent (a duplicate section name throws), so this table is what keeps
 * a re-entrant `agent/created` for the same session idempotent.
 */
const activeRenderers = new Map()

/**
 * Resolve one agent's project from its durable working directory.
 *
 * @param store - the memory store.
 * @param agent - the agent whose cwd decides the project.
 * @returns the agent's {@link MemoryProject}.
 */
async function projectForAgent(store, agent, options = {}) {
  if (options.personalOnly === true) return store.personal()
  const folder = agent?.session?.meta?.cwd || process.cwd()
  return store.resolve(folder)
}

/** Session id for an agent, tolerating either accessor shape. */
function agentSessionId(agent) {
  return agent?.session?.id ?? agent?.sessionId ?? undefined
}

/**
 * One registered prompt section per memory project.
 *
 * Section names must be unique within the scope they land in, and a duplicate
 * name aborts *session creation* outright rather than merely dropping the
 * memory block. Keeping one registration per project — rather than per agent —
 * is what satisfies that, and it also stops a child agent from inheriting a
 * second copy of its ancestor's memory block into the same prompt.
 *
 * Each entry owns the project's shared snapshot state, so every agent that
 * resolves to the same bank reads the same rendered block instead of rendering
 * its own copy.
 */
const projectSections = new Map()

/** The single section name owned by one project's bank. */
function memorySectionName(projectId) {
  return `memory:project:${projectId}`
}

/**
 * Ask the live prompt registry whether a section name is already taken in this
 * context's scope.
 *
 * This is a best-effort probe: the registry exposes no query API, so it reads
 * the assembled view and treats any failure as "not registered" — registering a
 * duplicate is the failure this guards against, and a false negative there is
 * strictly better than blocking memory for every assembling agent.
 *
 * @param ctx - the context that would register the section.
 * @param name - the candidate section name.
 * @returns whether the name already resolves in this scope.
 */
function isSectionRegistered(ctx, name) {
  try {
    const registry = ctx.systemPrompt
    const layers = registry?.layers ?? registry?.ctx?.systemPrompt?.layers
    const view = typeof layers?.view === 'function' ? layers.view(ctx.scope) : undefined
    if (view?.sections && typeof view.sections.has === 'function') return view.sections.has(name)
    if (Array.isArray(view?.sections)) return view.sections.some((section) => section?.name === name)
  } catch {
    /* treated as not registered */
  }
  return false
}

/** Cheap change signature: project identity plus the bank's write times. */
async function projectSignature(project) {
  const stat = async (file) => {
    try {
      const info = await fs.stat(file)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return '-'
    }
  }
  return [project.id, await stat(project.corePath), await stat(path.join(project.dir, 'index.md')), project.folders.length].join('|')
}

/**
 * Attach one agent to its project's memory section.
 *
 * Freshness is change-driven, not time-driven: the snapshot is rebuilt whenever
 * a cheap signature of the bank changes, and reused otherwise. That keeps
 * assembly free of repeated file reads while guaranteeing a memory saved
 * moments ago is in context on the next step — a time-based cache would
 * silently serve stale context right after a save.
 *
 * @param ctx - plugin context.
 * @param store - the memory store.
 * @param agent - the agent receiving the section.
 * @param config - resolved plugin config.
 * @returns a promise settling once the project's section is registered.
 */
function installAgentMemory(ctx, store, agent, config) {
  if (config.injectContext === false) return Promise.resolve()
  const sessionId = agentSessionId(agent)
  if (sessionId !== undefined && activeRenderers.has(sessionId)) return Promise.resolve()

  const budget = Number(config.contextBudget) > 0 ? Number(config.contextBudget) : 8000
  /**
   * Personal memory only: this mount serves a conversation that belongs to no
   * project. It still carries memory — leaving every project does not mean
   * losing what is known about the person — but there is no folder to resolve,
   * so the archive is the whole bank and it renders on its own.
   */
  const personalOnly = config.personalOnly === true
  const projectPromise = projectForAgent(store, agent, { personalOnly }).catch(() => undefined)

  /** Register (once per project) and hand back the project's shared state. */
  const stateFor = async () => {
    const project = await projectPromise
    if (!project) return undefined

    const existing = projectSections.get(project.id)
    if (existing) return existing

    const state = { project, signature: null, text: '', inFlight: null, error: null, registered: false }
    projectSections.set(project.id, state)

    /**
     * Rebuild the shared snapshot when either bank changed.
     *
     * Whisper refreshes coalesce onto the in-flight run so the synchronous
     * provider can never stack them up. A `force` refresh awaits the in-flight
     * run and then necessarily does its own pass — returning early would hand
     * back a snapshot that is by definition stale.
     */
    state.refresh = async (force = false) => {
      if (state.inFlight) {
        await state.inFlight
        if (!force) return state.text
      }
      state.inFlight = (async () => {
        try {
          // A project-less conversation carries the personal archive ONLY: it
          // has its own block, and no project bank is involved, because there is
          // no folder to key one to.
          if (personalOnly) {
            const personal = await store.personal()
            const signature = await projectSignature(personal)
            if (!force && signature === state.signature) return state.text
            state.text = await personal.renderContextBlock(budget)
            state.signature = signature
            state.error = null
            return state.text
          }

          // The personal archive is part of the signature: saving a personal
          // fact must invalidate the block just as a project fact does, or the
          // new entry would not appear until something else changed.
          const personal = await store.personal().catch(() => undefined)
          const signature = `${await projectSignature(project)}|${personal ? await projectSignature(personal) : '-'}`
          if (!force && signature === state.signature) return state.text
          state.text = await project.renderContextBlock(budget, personal)
          state.signature = await projectSignature(project)
          state.error = null
          return state.text
        } catch (error) {
          // Memory must never break a turn: keep serving the last good snapshot.
          state.error = error
          return state.text
        } finally {
          state.inFlight = null
        }
      })()
      return state.inFlight
    }

    if (!state.registered) {
      // Registration is keyed by the SECTION REGISTRY, not by this process.
      //
      // The same plugin body can be mounted more than once in one process — the
      // host composition mounts it for ordinary sessions, and an agent preset
      // ("standalone chat") mounts its own instance. Each instance has its own
      // module state, so a process-local `Set` cannot see the other's
      // registration, and the second one would abort assembly with
      // `prompt section ... is already registered`.
      //
      // The live registry is the only authority that knows what is registered
      // in a given scope, so ask it.
      state.registered = true
      if (!isSectionRegistered(ctx, memorySectionName(project.id))) {
        ctx.systemPrompt.section({
          name: memorySectionName(project.id),
          order: MEMORY_SECTION_ORDER,
          text: () => {
            void state.refresh()
            return state.text
          },
        })
      }
      await state.refresh(true)
    }
    return state
  }

  // Hand the caller a synchronous read face, then register and warm in the
  // background. Awaiting `stateFor()` here would deadlock: registration warms
  // through `refresh`, and `refresh` is reached from the read face.
  const readFace = {
    refresh: async (force) => (await stateFor())?.refresh(force),
    error: async () => (await stateFor())?.error ?? null,
  }
  if (sessionId !== undefined) activeRenderers.set(sessionId, readFace)
  ctx.effect(() => () => {
    if (sessionId !== undefined && activeRenderers.get(sessionId) === readFace) activeRenderers.delete(sessionId)
  })

  // Registration must finish before the first assembly, which the awaited
  // `agent/created` listener guarantees.
  return stateFor().then(() => undefined)
}

/**
 * Defaults for every tunable.
 *
 * Deliberately NOT exported as `Config`: the Cordis loader treats a plugin's
 * `Config` export as a Standard Schema and calls `Config['~standard'].validate()`
 * on it, so a plain object there throws a TypeError at activation and the fiber
 * ends up permanently `failed`. Most shipped plugins export no `Config` at all;
 * an entry may still pass `config:` in its patch, which is merged over these.
 */
const DEFAULTS = {
  /** Master switch for injecting remembered context into sessions. */
  injectContext: true,
  /** Character ceiling for the injected memory block. */
  contextBudget: 8000,
  /** Subagent provider used for isolated conversations. */
  isolatedProvider: 'spawn',
  /** Tool names hidden in isolated conversations (nested delegation is pointless there). */
  isolatedToolFilter: ['subagent', 'subagent_fork', 'workflow'],
  /**
   * Personal memory only: a conversation that belongs to no project.
   *
   * This is what separates "outside every project" from "without memory". A
   * conversation that sits outside the projects still carries the person's own
   * archive — preferences, background, standing commitments — exactly as the
   * account-level memory does in Claude and ChatGPT. What it does NOT carry is
   * any single project's memory, because there is no folder to key it to.
   *
   * A preset that mounts this plugin with `personalOnly: true` gets that
   * behaviour, and its scope defaults to the archive so a plain `save` lands
   * where it belongs rather than inventing a project from the process cwd.
   */
  personalOnly: false,
}

/** Merge caller config over the defaults, ignoring unknown keys. */
function resolveOptions(config) {
  const input = config && typeof config === 'object' ? config : {}
  return {
    injectContext: input.injectContext !== false,
    contextBudget: Number(input.contextBudget) > 0 ? Number(input.contextBudget) : DEFAULTS.contextBudget,
    isolatedProvider: typeof input.isolatedProvider === 'string' && input.isolatedProvider ? input.isolatedProvider : DEFAULTS.isolatedProvider,
    isolatedToolFilter: Array.isArray(input.isolatedToolFilter) ? input.isolatedToolFilter : DEFAULTS.isolatedToolFilter,
    personalOnly: input.personalOnly === true,
  }
}

/**
 * Delimiters for the machine-readable payload the `/memory digest` subcommand
 * returns.
 *
 * The command channel is text-only (`CommandResult` carries `text`), and adding
 * a bespoke Remote service for the browser surfaces would mean a second API to
 * keep in sync with the command. A delimited JSON block inside the text keeps a
 * single implementation: the panel renders cards from it, and a human reading
 * the transcript still sees something sane.
 */
export const MEMORY_DIGEST_OPEN = '<<<dsh-memory:digest>>>'
export const MEMORY_DIGEST_CLOSE = '<<<end-dsh-memory:digest>>>'

/**
 * Re-render one session's injected memory snapshot and return it.
 *
 * The prompt section itself must be synchronous, so it serves a snapshot that
 * refreshes out of band. This exposes the refresh for tests and for any caller
 * that needs the very latest text before assembling a prompt.
 *
 * @param sessionId - the session whose snapshot to rebuild.
 * @returns the fresh block, or undefined when no section is installed.
 */
export async function refreshMemoryContext(sessionId) {
  const renderer = activeRenderers.get(sessionId)
  if (!renderer) return undefined
  return renderer.refresh(true)
}

/**
 * The last render failure for one session, if any.
 *
 * @param sessionId - the session to inspect.
 * @returns the error, or null when the last render succeeded (or none ran).
 */
export async function memoryContextError(sessionId) {
  const renderer = activeRenderers.get(sessionId)
  if (!renderer) return null
  return (await renderer.error()) ?? null
}

/** Format a project line for command output. */
function describeProject(project) {
  const folders = (project.folders ?? []).map((folder) => `  - ${folder}`).join('\n')
  return `**${project.label}** (\`${project.id}\`)\n${folders || '  (no bound folders)'}`
}

/**
 * Plugin body.
 *
 * @param ctx - host plugin context.
 * @param config - optional per-entry config, merged over {@link DEFAULTS}.
 */
export function apply(ctx, config) {
  const resolved = resolveOptions(config)
  const store = new MemoryStore()

  // Record that this plugin body actually ran. Plugin activation is otherwise
  // only observable inside the app, and "did my edit load?" is the single most
  // common question while developing a plugin — a marker file answers it from
  // outside the process.
  void fs
    .mkdir(path.join(memoryRoot(), 'state'), { recursive: true })
    .then(() => fs.writeFile(path.join(memoryRoot(), 'state', 'host-active.json'), `${JSON.stringify({ plugin: name, activatedAt: new Date().toISOString(), pid: process.pid }, null, 2)}\n`))
    .catch(() => {})

  // ---- model-facing tools -------------------------------------------------
  for (const tool of memoryTools(store, { personalOnly: resolved.personalOnly })) ctx.tools.register(tool)
  // The Anthropic memory-tool verb surface, for models already trained on it.
  ctx.tools.register(memoryFileTool(store, async (exec) => projectForAgent(store, exec.agent, resolved)))
  // Conversational import: the user pastes memory, the model brings it in.
  ctx.tools.register(memoryImportTool(store, async (exec) => projectForAgent(store, exec.agent, resolved)))

  // ---- always-in-context memory, per session ------------------------------
  // `agent/created` is a serial event dispatched during setup and before first
  // prompt assembly, so a section registered here is present for turn one.
  // Awaiting it is what guarantees that ordering.
  ctx.on('agent/created', async ({ agent }) => {
    if (!agent) return
    await installAgentMemory(ctx, store, agent, resolved)
  })

  // ---- human commands -----------------------------------------------------
  ctx.commands.register({
    name: 'memory',
    description: 'Show, import, export and bind project memory',
    input: { hint: '[list|show <id>|import <path>|export|bind [path]|projects|digest]' },
    handler: async ({ agent, rawInput, signal }) => {
      try {
        const project = await projectForAgent(store, agent)
        const input = String(rawInput ?? '').trim()
        const [verb, ...rest] = input.split(/\s+/).filter(Boolean)
        const argument = rest.join(' ').trim()

        switch ((verb ?? 'status').toLowerCase()) {
          case 'digest': {
            // Machine-readable payload for the browser surfaces, which render
            // cards rather than prose. Delimited so it survives the text-only
            // CommandResult channel with no second API surface to keep in sync.
            //
            // BOTH banks are included, each entry carrying the `scope` that says
            // which one it came from: the panel shows them as separate sections,
            // and it can only do that if the payload distinguishes them.
            const personal = await store.personal()
            const toView = (record, scope) => ({
              id: record.id,
              name: record.name,
              description: record.description ?? '',
              type: record.type,
              tags: record.tags ?? [],
              pinned: record.pinned === true,
              updated: record.updated ?? '',
              chars: (record.body ?? '').length,
              body: record.body ?? '',
              scope,
            })
            const payload = {
              project: { id: project.id, label: project.label, folders: project.folders },
              core: (await project.readCore()).trim(),
              personalCore: (await personal.readCore()).trim(),
              personalLabel: personal.label,
              memories: [
                ...(await project.list()).map((record) => toView(record, 'project')),
                ...(await personal.list()).map((record) => toView(record, 'global')),
              ],
            }
            return {
              kind: 'success',
              text: `${MEMORY_DIGEST_OPEN}\n${JSON.stringify(payload)}\n${MEMORY_DIGEST_CLOSE}`,
            }
          }

          case 'status':
          case '': {
            const stats = await project.stats()
            return {
              kind: 'success',
              text: [
                `Memory project: ${describeProject(project)}`,
                '',
                `- memories: ${stats.total} (${stats.pinned} pinned)`,
                `- core note: ${stats.coreChars} chars`,
                `- by type: ${Object.entries(stats.byType).map(([type, count]) => `${type} ${count}`).join(', ')}`,
                `- store: ${stats.dir}`,
                '',
                'Commands: `/memory list`, `/memory import <path>`, `/memory export`, `/memory bind [path]`, `/memory chat <request>`',
              ].join('\n'),
            }
          }

          case 'list': {
            const records = await project.list()
            if (records.length === 0) return { kind: 'success', text: `No memories yet in ${describeProject(project)}` }
            const lines = records.map(
              (record) => `- \`${record.id}\` **${record.name}** (${record.type}${record.pinned ? ', pinned' : ''}) — ${record.description || record.body.split('\n')[0]}`,
            )
            return { kind: 'success', text: `${records.length} memories in ${describeProject(project)}\n\n${lines.join('\n')}` }
          }

          case 'show': {
            if (!argument) return { kind: 'error', text: 'usage: /memory show <id|name>' }
            const record = await project.get(argument)
            if (!record) return { kind: 'error', text: `no memory matches "${argument}"` }
            return {
              kind: 'success',
              text: [`### ${record.name}`, `- id: \`${record.id}\``, `- type: ${record.type}`, `- updated: ${record.updated ?? 'unknown'}`, '', record.body].join('\n'),
            }
          }

          case 'import': {
            if (!argument) return { kind: 'error', text: 'usage: /memory import <path to file>' }
            const target = path.resolve(agent?.session?.meta?.cwd || process.cwd(), argument)
            let bytes
            try {
              bytes = await fs.readFile(target)
            } catch (error) {
              return { kind: 'error', text: `cannot read ${target}: ${error.message}` }
            }
            const stage = await stageImport(project, path.basename(target), bytes)
            const started = await processImport(ctx, agent, project, stage, {
              signal,
              provider: resolved.isolatedProvider,
              toolFilter: resolved.isolatedToolFilter,
            })
            return {
              kind: 'success',
              text: [
                `Staged **${stage.candidates.length}** candidate ${stage.candidates.length === 1 ? 'memory' : 'memories'} from \`${path.basename(target)}\` (${stage.manifest.kind}).`,
                '',
                `Staging: \`${stage.dir}\``,
                `An isolated conversation is now processing it: session \`${started.childId}\``,
                '',
                'Open that session in the sidebar to watch it work, or keep going here — it will fold the entries into this project.',
              ].join('\n'),
            }
          }

          case 'import-now': {
            if (!argument) return { kind: 'error', text: 'usage: /memory import-now <path to file>' }
            const target = path.resolve(agent?.session?.meta?.cwd || process.cwd(), argument)
            let bytes
            try {
              bytes = await fs.readFile(target)
            } catch (error) {
              return { kind: 'error', text: `cannot read ${target}: ${error.message}` }
            }
            const parsed = await parseImport(bytes, path.basename(target))
            const result = await mergeCandidates(project, parsed.candidates, { source: `import:${path.basename(target)}`, core: parsed.core })
            return {
              kind: 'success',
              text: [
                `Imported ${result.created.length} of ${result.total} candidates directly (no isolated conversation).`,
                result.skipped.length ? `Skipped ${result.skipped.length} duplicates.` : '',
                '',
                result.created.slice(0, 40).map((entry) => `- ${entry.name}`).join('\n'),
              ]
                .filter(Boolean)
                .join('\n'),
            }
          }

          case 'export-text': {
            // The clipboard path: produce the readable digest as text and let the
            // caller put it wherever it wants. No file is written, because the
            // common case is "give me my memory so I can paste it somewhere".
            const bundle = await buildBundle(project)
            return { kind: 'success', text: renderDigest(bundle) }
          }

          case 'export': {
            const { files, dir, bundle } = await exportProject(project, { format: 'both' })
            return {
              kind: 'success',
              text: [
                `Exported **${bundle.memories.length}** memories from ${describeProject(project)}.`,
                '',
                `Directory: \`${dir}\``,
                ...files.map((file) => `- \`${file}\``),
              ].join('\n'),
            }
          }

          case 'bind': {
            const folder = argument ? path.resolve(agent?.session?.meta?.cwd || process.cwd(), argument) : agent?.session?.meta?.cwd || process.cwd()
            const { project: bound, created } = await store.bindFolder(folder, project.id)
            return {
              kind: 'success',
              text: created
                ? `Created a new memory project for \`${folder}\`.`
                : `Bound \`${folder}\` to memory project ${describeProject(bound)}`,
            }
          }

          case 'projects': {
            const projects = await store.projects()
            return {
              kind: 'success',
              text: `${projects.length} memory projects:\n\n${projects
                .map((entry) => `- **${entry.name}** (\`${entry.id}\`)\n${(entry.folders ?? []).map((folder) => `  - ${folder}`).join('\n')}`)
                .join('\n')}`,
            }
          }

          default:
            return {
              kind: 'error',
              text: `unknown subcommand "${verb}". Try: list, show, import, import-now, export, bind, projects`,
            }
        }
      } catch (error) {
        return { kind: 'error', text: `memory command failed: ${error?.message ?? String(error)}` }
      }
    },
  })
}
