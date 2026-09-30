/**
 * dsh-chat — standalone side conversations.
 *
 * A conversation of its own, not a feature of anything else. This plugin knows
 * nothing about memory: it opens a real, continuable child session that shares
 * the current working folder (so it sees the same files), and lets the user keep
 * talking to it from the sidebar afterwards.
 *
 * Because the child shares the folder, any *other* plugin that keys off the
 * working directory (project memory, for one) applies to it automatically. That
 * is the whole integration story — no coupling, no special cases.
 *
 * Deliberately NOT a proxy for the parent: `/chat` opens fresh, so the side
 * conversation has zero inherited history and cannot pollute the main thread.
 *
 * @module dsh-chat
 */

/** Cordis plugin name. */
export const name = 'chat'

/** Isolated conversations ride the harness's continuable-subagent capability. */
export const inject = ['commands', 'subagents']

/** Provider used to establish the child session. */
const DEFAULT_PROVIDER = 'spawn'

/**
 * Tools hidden inside a side conversation.
 *
 * Nested delegation from a side conversation is almost always a mistake: the
 * user opened one thread to keep the main one clean, and a side conversation
 * spawning its own subagents defeats that. Subagent control tools are denied so
 * the child cannot re-delegate.
 */
const DEFAULT_TOOL_FILTER = { deny: ['subagent', 'subagent_fork', 'workflow'] }

/** Compose a plain-text user message content block. */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/** Join path segments with whichever separator the base uses. */
function joinPath(base, name) {
  if (typeof base !== 'string' || base === '') return name
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[/\\]+$/, '')}${separator}${name}`
}

/**
 * The standing brief handed to a side conversation.
 *
 * @param options - `{ folder, instruction, label }`.
 * @returns the prompt text.
 */
function sideConversationPrompt(options) {
  const lines = [
    '# Side conversation',
    '',
    'You are a separate conversation, opened beside the user\'s main thread so that thread stays focused.',
    'Nothing from the main thread is carried over, and nothing you say here enters it.',
    '',
  ]

  if (options.folder) {
    lines.push(
      '## Where you are',
      '',
      `Your working directory is \`${options.folder}\`, the same one the user is working in, so the same files are in reach.`,
      '',
    )
  }

  lines.push(
    '## How to behave',
    '',
    '- Be direct. The user opened this thread to get something done, not to be managed.',
    '- Use the tools you have; do not ask permission for ordinary reads.',
    '- Ask only when a genuine ambiguity would change what you build.',
    '- When you finish, say what you did and where the result is, in a few lines.',
    '',
  )

  if (options.label) {
    lines.push('## What this thread is for', '', options.label, '')
  }

  if (options.instruction) {
    lines.push('## The user\'s opening request', '', options.instruction, '')
  }

  return lines.join('\n')
}

/**
 * Plugin body.
 *
 * @param ctx - host context carrying `commands` and `subagents`.
 */
export function apply(ctx) {
  ctx.commands.register({
    name: 'chat',
    description: 'Open a standalone side conversation (shares this folder, keeps its own thread)',
    input: { hint: '<what you want to do>' },
    handler: async ({ agent, rawInput, signal }) => {
      const instruction = String(rawInput ?? '').trim()
      if (!instruction) {
        return {
          kind: 'error',
          text: [
            'usage: /chat <what you want to do>',
            '',
            'Opens a side conversation that runs in the current folder with its own thread.',
            'It appears in the sidebar and can be continued like any other session.',
          ].join('\n'),
        }
      }

      const folder = agent?.session?.meta?.cwd
      if (!agent) {
        return {
          kind: 'error',
          text: 'A side conversation needs a session to open from. Open or create a session first, then retry.',
        }
      }

      const label = instruction.length > 60 ? `${instruction.slice(0, 57)}...` : instruction

      try {
        const started = await ctx.subagents.startContinuable({
          provider: DEFAULT_PROVIDER,
          label: `chat: ${label}`,
          request: {
            prompt: textBlock(sideConversationPrompt({ folder, instruction, label })),
            parent: agent,
            toolFilter: DEFAULT_TOOL_FILTER,
          },
          signal: signal ?? new AbortController().signal,
        })

        return {
          kind: 'success',
          text: [
            `Opened a side conversation: session \`${started.childId}\`.`,
            '',
            folder ? `It runs in \`${folder}\` and sees the same files.` : 'It shares your working folder.',
            'Find it in the sidebar and keep talking to it there, or ignore it and stay here.',
          ].join('\n'),
        }
      } catch (error) {
        return {
          kind: 'error',
          text: [
            `Could not open a side conversation: ${error?.message ?? String(error)}`,
            '',
            'This feature needs an active session and the subagent capability. If it keeps failing,',
            'check that `@deepseek-ai/dsh-subagent-spawn-in-process` is active in this profile.',
          ].join('\n'),
        }
      }
    },
  })
}

export { sideConversationPrompt, DEFAULT_PROVIDER, DEFAULT_TOOL_FILTER, joinPath }
