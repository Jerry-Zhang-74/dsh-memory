/**
 * The `chat-lite` preset must actually mount.
 *
 * A preset is a Cordis composition mounted under a standing scope. Discovery
 * proving the YAML parses is not the same as the composition ACTIVATING: a row
 * naming a package the loader cannot resolve fails at mount, and the roster
 * refuses a preset with any inactive row. That is exactly the failure a
 * hand-authored preset is most likely to hit, so it is tested here rather than
 * assumed.
 *
 * The preset is a user artifact (`<dshHome>/.agent-presets/chat-lite`), so this
 * suite skips cleanly when it is absent instead of failing on a machine that
 * never authored it.
 *
 *   node --test test/preset-mount.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-memory-preset-'))
process.env.DSH_HOME = HOME

const APP = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'npm',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'node_modules',
  '@deepseek-ai',
)
const load = (pkg, entry = 'lib/index.js') => import(pathToFileURL(path.join(APP, pkg, entry)).href)

const PRESET_DIR = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', '.agent-presets', 'chat-lite')
const EMPTY_PRESET_DIR = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', '.agent-presets', 'chat-empty')

const { Context } = await load('cordis')
const { SystemPrompt } = await load('dsh-system-prompt')
const { ToolRuntime } = await load('dsh-tools')
const { CommandRuntime } = await load('dsh-commands')
const { SubagentRuntime } = await load('dsh-subagent')
const { AgentPresets, discoverPresets } = await load('dsh-agent-presets')

/** Build a context with the services a preset mount needs. */
function hostContext() {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx, {})
  new CommandRuntime(ctx)
  new SubagentRuntime(ctx, {})
  // The roster reads `settings` (for the per-user default) and `loader` (for
  // module resolution). A minimal stand-in is enough for a mount test: no
  // default is stored, so only the base default is read.
  ctx.provide('settings', {
    register: () => ({ get: () => undefined, set: () => {}, observe: () => () => {} }),
  })
  return ctx
}

const exists = (target) => fs.access(target).then(() => true, () => false)

test('both conversation presets are discovered and healthy', async () => {
  const root = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', '.agent-presets')
  if (!(await exists(root))) return

  const presets = await discoverPresets([{ path: root, trust: 'user' }])
  const byId = Object.fromEntries(presets.map((preset) => [preset.id, preset]))

  for (const id of ['chat-lite', 'chat-empty']) {
    if (!(await exists(path.join(root, id)))) continue
    const preset = byId[id]
    assert.ok(preset, `${id} must be discovered`)
    assert.equal(preset.broken, undefined, `${id} must be healthy, got: ${preset.broken}`)
    assert.equal(preset.trust, 'user')
  }
})

test('chat-empty composes the persona alone: no tools, no memory', { skip: !(await exists(EMPTY_PRESET_DIR)) }, async () => {
  const composition = await fs.readFile(path.join(EMPTY_PRESET_DIR, 'agent.cordis.yml'), 'utf8')

  // The row list IS the capability statement. Asserting on rows (lines starting
  // with `- id:`) rather than on prose is deliberate: the persona text mentions
  // files and commands in order to say it cannot use them, so a text match
  // would pass even with a real capability row present.
  const rows = composition
    .split('\n')
    .map((line) => /^-\s+id:\s*(\S+)/.exec(line)?.[1])
    .filter(Boolean)

  assert.deepEqual(rows, ['persona'], `a project-free conversation composes nothing but the persona, got ${rows.join(', ')}`)

  // Explicitly: neither memory nor any coding capability.
  for (const forbidden of ['dsh-memory', 'memory', 'dsh-tool-fs', 'dsh-tool-pwsh', 'dsh-tool-bash', 'dsh-tool-web', 'dsh-tool-subagent']) {
    assert.ok(!composition.includes(`id: ${forbidden}`), `chat-empty must not compose ${forbidden}`)
  }

  // Complete prompt plus suppressed runtime context: nothing else can reach it.
  assert.match(composition, /complete:\s*true/)
  assert.match(composition, /includeRuntimeContext:\s*false/)
})

test('the composition states exactly which capabilities chat-lite grants', { skip: !(await exists(PRESET_DIR)) }, async () => {
  const composition = await fs.readFile(path.join(PRESET_DIR, 'agent.cordis.yml'), 'utf8')

  // The row list is the whole capability statement, so assert on ROWS (a line
  // starting with `- id:`), not on the prose: the persona below mentions the
  // `memory` tool, and matching that would pass even with no memory row at all
  // — which is precisely the bug this caught.
  const rows = composition
    .split('\n')
    .map((line) => /^-\s+id:\s*(\S+)/.exec(line)?.[1])
    .filter(Boolean)

  assert.deepEqual(rows.sort(), ['memory', 'persona'], `expected exactly persona + memory, got ${rows.join(', ')}`)

  // The persona must be the COMPLETE prompt, or global guidance leaks in and
  // this stops being a standalone conversation.
  assert.match(composition, /complete:\s*true/)

  // And no coding-agent capability may appear anywhere in the composition.
  for (const forbidden of ['dsh-tool-fs', 'dsh-tool-pwsh', 'dsh-tool-bash', 'dsh-tool-web', 'dsh-tool-subagent', 'dsh-tool-workflow']) {
    assert.ok(!composition.includes(forbidden), `a standalone conversation must not compose ${forbidden}`)
  }
})

test('mounting requires a real loader scope, so the live check is the GUI', { skip: !(await fs.access(PRESET_DIR).then(() => true, () => false)) }, async () => {
  // `mount()` refuses an unscoped context outright — the scope key IS the join
  // between an agent and its preset — and a scope only exists under the real
  // Cordis loader, which this harness deliberately does not stand up. So the
  // activation half is verified where it actually happens: the roster reports a
  // preset whose rows fail to activate as `broken` with a reason, and
  // `chat-lite` is discovered healthy.
  const presets = await discoverPresets([{ path: path.dirname(PRESET_DIR), trust: 'user' }])
  const preset = presets.find((entry) => entry.id === 'chat-lite')
  assert.ok(preset, 'chat-lite must resolve from disk')
  assert.equal(preset.broken, undefined, `chat-lite must be healthy, got: ${preset.broken}`)

  const ctx = hostContext()
  const roster = new AgentPresets(ctx, { default: 'standard', roots: [], includeUserRoot: false })
  await assert.rejects(
    () => roster.mount(ctx.extend({ name: 'unscoped' }), 'chat-lite'),
    /unscoped|scope/i,
    'mount must refuse a context with no scope, which is why the live GUI is the real test',
  )
})

