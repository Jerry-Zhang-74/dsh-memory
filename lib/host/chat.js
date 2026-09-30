/**
 * DSH Memory — the import curator conversation.
 *
 * Handing a large or messy import to a fresh conversation is what keeps the
 * user's own thread clean: the curator reads the staged payload, de-duplicates
 * against what is already stored, rejects anything unsafe, and reports what it
 * did — all without spending the main conversation's context.
 *
 * The conversation is a real child session, so the user can open it in the
 * sidebar and watch or continue it.
 *
 * Standalone side conversations are a different feature and live in their own
 * plugin (`dsh-chat`); nothing here depends on them.
 *
 * @module dsh-memory/chat
 */

/** Compose a plain-text user message content block. */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * The standing instruction handed to an import-processing conversation.
 *
 * Kept factual and bounded: the child is told exactly which files it owns, what
 * "good memory" means, and that it must report rather than converse.
 */
function importPrompt(project, stage, extraInstruction) {
  const lines = [
    '# Task: process an imported memory export into this project\'s memory bank',
    '',
    `You are working in an isolated conversation. The memory project is **${project.label}** (\`${project.id}\`).`,
    `Its bound folders are: ${(project.folders ?? []).map((folder) => `\`${folder}\``).join(', ') || '(none)'}.`,
    '',
    '## Staged import',
    '',
    `- staging directory: \`${stage.dir}\``,
    `- machine-readable candidates: \`${path_join(stage.dir, 'import.json')}\``,
    `- readable digest: \`${path_join(stage.dir, 'import.md')}\``,
    `- original file: \`${stage.raw}\``,
    `- detected format: ${stage.manifest.kind}`,
    `- candidate entries: ${stage.manifest.candidateCount}`,
    '',
    '## What to do',
    '',
    '1. Read `import.json` (and `import.md` when the JSON is ambiguous).',
    `2. Read the existing bank before writing: call \`memory\` with \`{"action":"list"}\`, and \`{"action":"core"}\` for the core file.`,
    '3. For each candidate decide: **keep**, **merge into an existing memory**, **skip as duplicate/noise**, or **reject as unsafe**.',
    '   - Never store credentials, API keys, tokens, passwords or personal identifiers. Reject them and say so.',
    '   - Drop conversational filler, stale task state, and anything not useful in a future session.',
    '   - Rewrite terse fragments into self-contained facts: a memory must make sense with no surrounding chat.',
    '   - Prefer merging into an existing memory over creating a near-duplicate.',
    '4. Write the survivors with the `memory` tool (`action: "save"`), choosing a real `type`',
    '   (`user` for durable facts about the person, `project` for this codebase/workspace,',
    '   `feedback` for corrections and preferences, `reference` for pointers and links),',
    '   useful `tags`, and `pinned: true` only for facts that must always be in context.',
    '   Use `action: "update"` or `action: "edit"` when refining something that already exists.',
    '5. If the import carried a core-memory file worth adopting, fold its durable content in with `action: "core"`.',
    '6. Do not modify any file in the staging directory — it is the audit trail.',
    '',
    '## Report',
    '',
    'Finish with a short Markdown report: counts of kept / merged / skipped / rejected,',
    'the names of the memories you created or changed, and anything you deliberately dropped and why.',
    'Do not ask questions — make reasonable decisions and state them.',
  ]
  if (extraInstruction) lines.push('', '## Additional instruction from the user', '', extraInstruction)
  return lines.join('\n')
}

/** Local join so this module has no import cycle with path handling elsewhere. */
function path_join(base, name) {
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[/\\]+$/, '')}${separator}${name}`
}

/**
 * Open one isolated continuable conversation under `parent`.
 *
 * @param ctx - host context carrying `subagents`.
 * @param parent - the agent opening the conversation.
 * @param options - label, prompt text, and optional tool narrowing.
 * @returns the child session id and its accepted message id.
 */
export async function openConversation(ctx, parent, options) {
  if (!ctx.subagents) throw new Error('isolated conversations need the subagent capability')
  return ctx.subagents.startContinuable({
    provider: options.provider ?? 'spawn',
    label: options.label,
    request: {
      prompt: textBlock(options.prompt),
      parent,
      ...(options.toolFilter ? { toolFilter: options.toolFilter } : {}),
    },
    signal: options.signal ?? new AbortController().signal,
  })
}

/**
 * Hand a staged import to an isolated conversation for processing.
 *
 * @param ctx - host context.
 * @param parent - the agent whose session opened the import.
 * @param project - destination memory project.
 * @param stage - result of `stageImport`.
 * @param options - extra instruction and cancellation.
 * @returns the child conversation id.
 */
export async function processImport(ctx, parent, project, stage, options = {}) {
  const started = await openConversation(ctx, parent, {
    label: `memory import: ${stage.manifest.source}`,
    prompt: importPrompt(project, stage, options.instruction),
    signal: options.signal,
    provider: options.provider,
    toolFilter: options.toolFilter,
  })
  return started
}
