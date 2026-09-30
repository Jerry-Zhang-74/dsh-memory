/**
 * DSH Memory — model-facing tools.
 *
 * `memory`          : save / recall / read / update / edit / forget / list /
 *                     core / bind / unbind / projects / stats
 * `memory_context`  : assemble a focused memory block under an explicit budget
 *
 * The tool surface deliberately mirrors the memory-tool contract models already
 * know (view / create / str_replace / delete) while fitting this project's
 * project-scoped, multi-folder model.
 *
 * @module dsh-memory/tools
 */

import { defineTool } from './schema.js'
import { MEMORY_SCOPES, MEMORY_TYPES } from './store.js'

/** Best-effort working directory of the calling agent. */
export function agentFolder(agent) {
  return agent?.session?.meta?.cwd || process.cwd()
}

/** Best-effort session id of the calling agent, recorded as a memory's source. */
function agentSessionId(agent) {
  return agent?.session?.id ?? agent?.sessionId ?? undefined
}

/** JSON schema for one memory summary. */
const summarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
    type: { type: 'string', required: true, enum: [...MEMORY_TYPES] },
    scope: { type: 'string', required: true, enum: [...MEMORY_SCOPES] },
    tags: { type: 'array', required: true, items: { type: 'string' } },
    pinned: { type: 'boolean', required: true },
    updated: { type: 'string', required: true },
    body: { type: 'string', required: true },
  },
}

/** Canonical output schema for both memory tools. */
const memoryOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    action: { type: 'string', required: true },
    message: { type: 'string', required: true },
    project: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        id: { type: 'string', required: true },
        label: { type: 'string', required: true },
        folders: { type: 'array', required: true, items: { type: 'string' } },
      },
    },
    memories: { type: 'array', items: summarySchema },
    memory: summarySchema,
    text: { type: 'string' },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          folders: { type: 'array', required: true, items: { type: 'string' } },
          updated: { type: 'string', required: true },
        },
      },
    },
    stats: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total: { type: 'integer', required: true },
        pinned: { type: 'integer', required: true },
        coreChars: { type: 'integer', required: true },
        dir: { type: 'string', required: true },
        byType: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: Object.fromEntries(MEMORY_TYPES.map((type) => [type, { type: 'integer', required: true }])),
        },
      },
    },
  },
}

/** Project identity block shared by every reply. */
function projectView(project) {
  return { id: project.id, label: project.label, folders: project.folders }
}

/** Project one stored record into the tool's summary shape. */
function summary(record) {
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? '',
    type: record.type,
    scope: record.scope,
    tags: record.tags ?? [],
    pinned: record.pinned === true,
    updated: record.updated ?? '',
    body: record.body ?? '',
  }
}

/** Render the short human-readable line the model sees for a listing. */
function renderList(action, value) {
  const where = `project "${value.project.label}"`
  if (value.memories?.length) {
    const lines = value.memories.map(
      (memory) => `- [${memory.id}] (${memory.type}${memory.pinned ? ', pinned' : ''}) ${memory.name} — ${memory.description || memory.body.split('\n')[0]}`,
    )
    return [{ type: 'text', text: `${value.message}\n\n${lines.join('\n')}` }]
  }
  if (value.memory) {
    return [
      {
        type: 'text',
        text: `${value.message}\n\n### ${value.memory.name} (${value.memory.type})\n\`id: ${value.memory.id}\`\n\n${value.memory.body}`,
      },
    ]
  }
  if (value.text) return [{ type: 'text', text: `${value.message}\n\n${value.text}` }]
  if (value.projects?.length) {
    const lines = value.projects.map((project) => `- ${project.id} — ${project.name} (${project.folders.join(', ')})`)
    return [{ type: 'text', text: `${value.message}\n\n${lines.join('\n')}` }]
  }
  return [{ type: 'text', text: `${value.message} (${where})` }]
}

/**
 * Build both memory tools bound to one store instance.
 *
 * @param store - the {@link import('./store.js').MemoryStore} to read and write.
 * @returns the tool definitions, ready for `ctx.tools.register`.
 */
export function memoryTools(store, options = {}) {
  /**
   * A conversation that belongs to no project carries only the personal
   * archive. It still HAS memory — leaving every project does not mean losing
   * what is known about the person — but there is no folder to key a project
   * bank to, so no project bank is involved at all.
   */
  const personalOnly = options.personalOnly === true

  /** Resolve the calling agent's project, or throw a model-readable failure. */
  const projectFor = async (exec) => {
    if (!exec.agent) throw new Error('memory requires an owning agent session')
    if (personalOnly) return store.personal()
    return store.resolve(agentFolder(exec.agent))
  }

  /**
   * Pick the bank a call addresses.
   *
   * Two banks exist and the model chooses between them per call, because only
   * the model can tell a fact about THIS folder from a fact about the person:
   *
   *   - `project`  — the folder the session is working in.
   *   - `personal` — the person's own archive, which travels with every
   *                  project and is therefore never mixed into a project list.
   *
   * The choice is by `scope`, defaulting to the project, so an ordinary save
   * never silently lands in the archive. In a project-less conversation every
   * bank IS the archive, so the default lands there too.
   */
  const bankFor = async (exec, scope) => {
    if (personalOnly) return store.personal()
    if (scope === 'global' || scope === 'personal') return store.personal()
    return projectFor(exec)
  }

  const memoryTool = defineTool({
    name: 'memory',
    description: personalOnly
      ? [
          'Read and write the personal archive. This conversation belongs to no project, so there is no',
          'project memory here — only what is known about the person, which travels with them everywhere.',
          '',
          'Save preferences, background, habits, standing commitments, and anything else that holds',
          'regardless of which folder they are working in. Do NOT save folder- or codebase-specific detail:',
          'it belongs to a project session, and writing it here would surface it in every conversation.',
          '',
          'Facts saved here outlive the conversation. Do NOT save transient task state, secrets, or',
          'credentials, or anything the user asks you to forget.',
          '',
          'Actions:',
          '- save: create an entry (name, body, optional type/description/tags/pinned).',
          '- recall: rank archive entries against a query.',
          '- read: fetch one entry in full by id or name.',
          '- update: patch fields of one entry.',
          '- edit: replace an exact `oldText` inside one body with `newText` (precise edits).',
          '- forget: delete an entry permanently.',
          '- list: list archive entries.',
          '- core: read or replace the archive\'s always-in-context core note.',
          '- stats: size and shape of the archive.',
          '',
          'Prefer `edit`/`update` for refinements — revise an existing entry instead of storing a near-duplicate.',
        ].join('\n')
      : [
          'Read and write your durable memory. Two separate banks exist, and choosing the right one matters:',
          '',
          '- **project** (default) — facts about the folder this session works in: architecture, conventions,',
          '  build quirks, project-specific decisions. Appears in sessions bound to that folder.',
          '- **personal** — facts about the person that hold everywhere: how they want answers, their',
          '  preferences, their background, their ongoing commitments. Appears in every session.',
          '',
          'Save with the right `scope`; passing `personal` for a project detail pollutes the archive, and',
          'passing `project` for a general preference hides it from every other folder.',
          '',
          'Facts saved here outlive the conversation. Do NOT save transient task state, secrets, credentials,',
          'or anything the user asks you to forget.',
          '',
          'Actions:',
          '- save: create a memory (name, body, optional type/description/tags/scope/pinned).',
          '- recall: rank memories against a query. Searches BOTH banks unless `scope` narrows it.',
          '- read: fetch one memory in full by id or name.',
          '- update: patch fields of one memory (name/description/body/type/scope/tags/pinned).',
          '- edit: replace an exact `oldText` inside one memory body with `newText` (precise edits).',
          '- forget: delete one memory permanently.',
          '- list: list memories. Both banks unless `scope` narrows it.',
          '- core: read or replace the always-in-context core note of the chosen bank.',
          '- bind: attach a folder to this project so the two folders share one memory bank.',
          '- unbind: detach a bound folder.',
          '- projects: list every memory project on this machine.',
          '- stats: size and shape of both banks.',
          '',
          'Prefer `save` for new facts and `edit`/`update` for refinements — revise an existing memory',
      'instead of storing a near-duplicate.',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['save', 'recall', 'read', 'update', 'edit', 'forget', 'list', 'core', 'bind', 'unbind', 'projects', 'stats'],
        description: 'The memory operation to perform.',
      },
      name: { type: 'string', description: 'save/update: short declarative title.' },
      body: { type: 'string', description: 'save/update: the memory content, in Markdown.' },
      description: { type: 'string', description: 'save/update: one-line summary used for recall ranking.' },
      type: { type: 'string', enum: [...MEMORY_TYPES], description: 'save/update: user | project | feedback | reference.' },
      scope: {
        type: 'string',
        enum: [...MEMORY_SCOPES],
        description: personalOnly
          ? 'Ignored here: a project-less conversation has only the personal archive.'
          : 'save/update: project (default) or global (the personal archive, applies everywhere).',
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'save/update: searchable tags.' },
      pinned: { type: 'boolean', description: 'save/update: pin so the memory is always injected into context.' },
      id: { type: 'string', description: 'read/update/edit/forget: memory id, filename, or name.' },
      query: { type: 'string', description: 'recall: natural-language query. list: optional filter.' },
      oldText: { type: 'string', description: 'edit: exact existing text to replace.' },
      newText: { type: 'string', description: 'edit: replacement text (empty string deletes it).' },
      coreText: { type: 'string', description: 'core: replacement contents of the core memory file.' },
      folder: { type: 'string', description: 'bind/unbind: absolute folder path. Defaults to the current working directory.' },
      projectId: { type: 'string', description: 'bind/unbind: target project id. Defaults to the current project.' },
      limit: { type: 'integer', description: 'recall/list: maximum entries to return (default 10 for recall, all for list).' },
    },
    output: {
      schema: memoryOutputSchema,
      render: renderList,
    },
    async execute(args, exec) {
      const project = await projectFor(exec)
      const action = String(args.action)
      const base = { ok: true, action, project: projectView(project), message: '' }

      // Reads that span both banks by default: a question about what is
      // remembered should not require knowing which bank holds the answer.
      //
      // In a project-less conversation the archive IS the only bank, so the
      // spanning path must not read it twice — the project bank there resolves
      // to the same archive, which would return every entry doubled.
      const searchBanks = async (query, options) => {
        if (personalOnly) {
          const bank = await store.personal()
          const found = await bank.search(query, options)
          return found.map((record) => ({ record, bank }))
        }
        if (options.scope === 'project' || options.scope === 'personal') {
          const bank = await bankFor(exec, options.scope)
          const found = await bank.search(query, options)
          return found.map((record) => ({ record, bank }))
        }
        const personal = await store.personal()
        const [fromProject, fromPersonal] = await Promise.all([
          project.search(query, options),
          personal.search(query, options),
        ])
        // A guard, not just an optimisation: if the two banks are ever the same
        // object, merging both would duplicate every hit.
        if (personal.id === project.id) return fromPersonal.map((record) => ({ record, bank: personal }))
        return [
          ...fromProject.map((record) => ({ record, bank: project })),
          ...fromPersonal.map((record) => ({ record, bank: personal })),
        ]
          .sort((a, b) => (b.record.score ?? 0) - (a.record.score ?? 0))
          .slice(0, Math.max(1, Number(options.limit) || 10))
      }

      switch (action) {
        case 'save': {
          // `scope` chooses the bank: a global fact belongs to the person, not
          // to whichever folder happens to be open. In a project-less
          // conversation the only bank IS the archive, so every save is global.
          const bank = await bankFor(exec, args.scope)
          // `project` here IS the archive in a project-less mount, so the label
          // must come from the mount mode rather than from an id comparison.
          const where = personalOnly ? 'the personal archive' : bank.id === project.id ? 'this project' : 'the personal archive'
          const record = await bank.save({
            name: args.name,
            body: args.body,
            description: args.description,
            type: args.type,
            scope: personalOnly || args.scope === 'global' || args.scope === 'personal' ? 'global' : args.scope,
            tags: args.tags,
            pinned: args.pinned,
            source: agentSessionId(exec.agent) ? `session:${agentSessionId(exec.agent)}` : undefined,
          })
          return { ...base, message: `Saved memory "${record.name}" to ${where}.`, memory: summary(record) }
        }
        case 'recall': {
          const hits = await searchBanks(args.query, {
            limit: args.limit ?? 10,
            type: args.type,
            scope: undefined,
          })
          const tagged = hits.map(({ record, bank }) => ({
            ...summary(record),
            scope: bank.id === project.id ? 'project' : 'global',
          }))
          return {
            ...base,
            message: tagged.length
              ? `Recalled ${tagged.length} memory ${tagged.length === 1 ? 'entry' : 'entries'} for "${args.query ?? ''}".`
              : `No memory matched "${args.query ?? ''}".`,
            memories: tagged,
          }
        }
        case 'read': {
          const ref = args.id ?? args.name ?? args.query
          // Search both banks, so a read never needs the caller to know which
          // one holds the entry.
          const record = (await project.get(ref)) ?? (await (await store.personal()).get(ref))
          if (!record) return { ...base, ok: false, message: `No memory found for "${ref ?? ''}".` }
          const fromPersonal = store.isPersonal(record.project)
          return {
            ...base,
            message: `Memory "${record.name}" (${fromPersonal ? 'personal archive' : 'this project'}).`,
            memory: { ...summary(record), scope: fromPersonal ? 'global' : 'project' },
          }
        }
        case 'update': {
          const ref = args.id ?? args.name ?? args.query
          // A scope change MOVES the entry between banks rather than relabelling
          // it, so the two lists stay honest about what they hold.
          const movingTo = args.scope === 'global' || args.scope === 'personal' ? 'personal' : args.scope === 'project' ? 'project' : undefined
          const current = (await project.get(ref)) ?? (await (await store.personal()).get(ref))
          if (!current) return { ...base, ok: false, message: `No memory found to update for "${ref ?? ''}".` }

          const currentIsPersonal = store.isPersonal(current.project)
          if (movingTo && movingTo !== (currentIsPersonal ? 'personal' : 'project')) {
            const target = await bankFor(exec, movingTo === 'personal' ? 'personal' : 'project')
            const moved = await target.save({ ...current, scope: movingTo === 'personal' ? 'global' : 'project', name: current.name })
            await (await bankFor(exec, currentIsPersonal ? 'personal' : 'project')).forget(current.id)
            return { ...base, message: `Moved "${moved.name}" to ${movingTo === 'personal' ? 'the personal archive' : 'this project'}.`, memory: summary(moved) }
          }

          const home = await bankFor(exec, currentIsPersonal ? 'personal' : 'project')
          const record = await home.update(current.id, args)
          if (!record) return { ...base, ok: false, message: `No memory found to update for "${ref ?? ''}".` }
          return { ...base, message: `Updated memory "${record.name}".`, memory: summary(record) }
        }
        case 'edit': {
          const ref = args.id ?? args.name ?? args.query
          const current = (await project.get(ref)) ?? (await (await store.personal()).get(ref))
          if (!current) return { ...base, ok: false, message: `No memory found for "${ref ?? ''}".` }
          const home = await bankFor(exec, store.isPersonal(current.project) ? 'personal' : 'project')
          const result = await home.editBody(current.id, args.oldText, args.newText ?? '')
          if (!result.ok) {
            const detail =
              result.reason === 'not-found'
                ? 'no such memory'
                : result.reason === 'text-not-found'
                  ? 'oldText does not appear verbatim in that memory'
                  : 'oldText must be non-empty'
            return { ...base, ok: false, message: `Edit failed: ${detail}.` }
          }
          return { ...base, message: `Edited memory "${result.record.name}".`, memory: summary(result.record) }
        }
        case 'forget': {
          const ref = args.id ?? args.name ?? args.query
          const current = (await project.get(ref)) ?? (await (await store.personal()).get(ref))
          if (!current) return { ...base, ok: false, message: `No memory found to forget for "${ref ?? ''}".` }
          const home = await bankFor(exec, store.isPersonal(current.project) ? 'personal' : 'project')
          const record = await home.forget(current.id)
          if (!record) return { ...base, ok: false, message: `No memory found to forget for "${ref ?? ''}".` }
          return { ...base, message: `Forgot memory "${record.name}".` }
        }
        case 'list': {
          const applyFilters = (records) => {
            let out = records
            if (args.type) out = out.filter((record) => record.type === args.type)
            if (args.tag) {
              const tag = String(args.tag).toLowerCase()
              out = out.filter((record) => (record.tags ?? []).some((value) => String(value).toLowerCase() === tag))
            }
            return out
          }

          // A project-less conversation has one bank. Listing "both" there would
          // read the same archive twice and return every entry doubled, so the
          // spanning path is skipped outright rather than deduplicated after the
          // fact.
          if (personalOnly) {
            const inArchive = applyFilters(await project.list())
            const limited = args.limit ? inArchive.slice(0, Math.max(1, Number(args.limit))) : inArchive
            return {
              ...base,
              message: limited.length
                ? `${limited.length} ${limited.length === 1 ? 'entry' : 'entries'} in the personal archive.`
                : 'The personal archive is empty.',
              memories: limited.map((record) => ({ ...summary(record), scope: 'global' })),
            }
          }

          const personal = await store.personal()
          // An absent scope means BOTH banks: asking "what do you remember"
          // must not silently omit the archive, which is the whole reason the
          // archive is labelled rather than merged.
          const personalWanted = args.scope !== 'project'
          const projectWanted = args.scope !== 'personal' && args.scope !== 'global'
          const inProject = projectWanted ? applyFilters(await project.list()) : []
          const inPersonal = personalWanted ? applyFilters(await personal.list()) : []
          const records = [
            ...inProject.map((record) => ({ ...summary(record), scope: 'project' })),
            ...inPersonal.map((record) => ({ ...summary(record), scope: 'global' })),
          ]
          const limited = args.limit ? records.slice(0, Math.max(1, Number(args.limit))) : records
          return {
            ...base,
            message: limited.length
              ? `${limited.length} ${limited.length === 1 ? 'memory' : 'memories'} — ${inProject.length} in "${project.label}", ${inPersonal.length} in the personal archive.`
              : `No memories yet in "${project.label}" or the personal archive.`,
            memories: limited,
          }
        }
        case 'core': {
          const bank = await bankFor(exec, args.scope)
          if (args.coreText === undefined) {
            const text = await bank.readCore()
            return { ...base, message: `Core note of ${bank.id === project.id ? 'this project' : 'the personal archive'}.`, text }
          }
          await bank.writeCore(args.coreText)
          return { ...base, message: 'Core note replaced.', text: String(args.coreText) }
        }
        case 'bind': {
          const folder = args.folder || agentFolder(exec.agent)
          const { project: bound, created } = await store.bindFolder(folder, args.projectId ?? project.id)
          return {
            ...base,
            project: projectView(bound),
            message: created
              ? `Created project "${bound.label}" bound to ${folder}.`
              : `Bound ${folder} to project "${bound.label}".`,
          }
        }
        case 'unbind': {
          const folder = args.folder || agentFolder(exec.agent)
          const updated = await store.unbindFolder(folder, args.projectId ?? project.id)
          return { ...base, project: projectView(updated), message: `Unbound ${folder} from project "${updated.label}".` }
        }
        case 'projects': {
          const projects = await store.projects()
          return {
            ...base,
            message: `${projects.length} memory ${projects.length === 1 ? 'project' : 'projects'}.`,
            projects: projects.map((entry) => ({
              id: entry.id,
              name: entry.name ?? '',
              folders: entry.folders ?? [],
              updated: entry.updated ?? '',
            })),
          }
        }
        case 'stats':
        default: {
          const stats = await project.stats()
          return {
            ...base,
            action: 'stats',
            message: `Project "${stats.label}": ${stats.total} memories (${stats.pinned} pinned), core ${stats.coreChars} chars.`,
            stats: {
              total: stats.total,
              pinned: stats.pinned,
              coreChars: stats.coreChars,
              dir: stats.dir,
              byType: stats.byType,
            },
          }
        }
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `memory ${String(args.action ?? '')}`.trim(), kind: 'other', rawInput: args }),
  })

  const contextTool = defineTool({
    name: 'memory_context',
    description: [
      'Assemble a memory block for the current project under an explicit character budget, optionally focused by a query.',
      'Use this when you need more remembered context than the always-injected memory block provides.',
      'Returns Markdown ready to reason over.',
    ].join('\n'),
    parameters: {
      query: { type: 'string', description: 'Optional focus; matched memories rank first.' },
      budget: { type: 'integer', description: 'Maximum characters of memory to return (default 8000).' },
      includeCore: { type: 'boolean', description: 'Include the core memory file (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          text: { type: 'string', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.message}\n\n${value.text}` }],
    },
    async execute(args, exec) {
      const project = await projectFor(exec)
      const budget = Math.max(200, Math.min(Number(args.budget) || 8000, 60000))
      const records = args.query ? await project.search(args.query, { limit: 50 }) : await project.list()
      const core = args.includeCore === false ? '' : (await project.readCore()).trim()

      const parts = []
      let used = 0
      if (core) {
        const block = `## Core memory\n\n${core}`
        parts.push(block)
        used += block.length
      }
      let included = 0
      for (const record of records) {
        const block = `## ${record.name}\n_type: ${record.type}${record.tags?.length ? ` [${record.tags.join(', ')}]` : ''}_\n\n${record.body.trim()}`
        if (used + block.length > budget) break
        parts.push(block)
        used += block.length
        included += 1
      }
      const text = parts.join('\n\n---\n\n') || '_No stored memory yet._'
      return {
        ok: true,
        message: `Memory context for project "${project.label}": ${included} of ${records.length} memories, ${used} chars.`,
        text,
        count: included,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'memory context', kind: 'other' }),
  })

  return [memoryTool, contextTool]
}
