/**
 * Client bundle contract.
 *
 * The client half is served as a *classic script*, not an ES module, so it
 * cannot be `import`ed — it is executed here against a minimal fake of the
 * browser globals the boot protocol installs, and then its exported Cordis
 * plugin is exercised. This catches the silent-failure traps that otherwise
 * only show up as a surface that never appears:
 *
 *   - the script must register exactly one factory under the package name
 *   - `exports.apply` and `exports.inject` must both exist
 *   - a client half is only discovered when `exports['./package.json']` and
 *     `exports['./client']` exist AND `dsh.client.platform === 'web'`
 *
 *   node --test test/client-bundle.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A minimal React stand-in: enough for createElement/useState/useEffect/useRef. */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  }
}

/** Execute the bundle the way the page does. */
async function loadBundle() {
  const source = await fs.readFile(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  const registrations = []
  const tags = []

  const document = {
    querySelector: () => null,
    createElement: () => {
      const tag = { dataset: {}, textContent: '' }
      tags.push(tag)
      return tag
    },
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }

  // The bundle is a classic script: `window` and `document` are globals it
  // references directly, so `new Function` gives it exactly that shape.
  const run = new Function('window', 'document', 'require', source)
  run(window, document, (specifier) => {
    if (specifier === 'react') return fakeReact()
    throw new Error(`unexpected require: ${specifier}`)
  })

  assert.equal(registrations.length, 1, 'the bundle must register exactly one factory')
  const exports = registrations[0].factory((specifier) => {
    if (specifier === 'react') return fakeReact()
    throw new Error(`unexpected require: ${specifier}`)
  })
  return { registration: registrations[0], exports, tags }
}

/** A context recording every slot injection and registering the contributed entry. */
function stubContext({ snapshot, execute } = {}) {
  const injected = []
  const registered = []
  const locales = []
  const ctx = {
    effect: (factory) => factory(),
    locale: { register: (ns, dictionaries) => locales.push({ ns, dictionaries }), bind: () => (key) => key },
    slots: {
      inject: (name, contribute) => injected.push({ name, contribute }),
      register: (options, component) => registered.push({ options, component }),
    },
    sessions: {
      list: {
        getSnapshot:
          snapshot ??
          (() => ({ ids: ['session-a'], current: 'session-a', byId: {}, phase: 'ready' })),
      },
    },
    remote: { commands: { execute: execute ?? (async () => ({ ok: true, value: { result: { kind: 'success', text: 'ok' } } })) } },
  }
  return { ctx, injected, registered, locales }
}

test('the bundle registers one factory under the package name', async () => {
  const { registration } = await loadBundle()
  assert.equal(registration.id, 'dsh-memory')
  assert.equal(typeof registration.factory, 'function')
})

test('the bundle exports a Cordis plugin with apply and inject', async () => {
  const { exports } = await loadBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject), 'inject must be an array')
  for (const service of ['slots', 'sessions', 'remote', 'remote.commands', 'locale']) {
    assert.ok(exports.inject.includes(service), `inject must declare ${service}`)
  }
})

test('apply registers exactly the settings page, and nothing in the sidebar', async () => {
  const { exports, tags } = await loadBundle()
  const { ctx, injected, registered, locales } = stubContext()

  exports.apply(ctx)

  // The stylesheet is inserted exactly once, tagged for idempotency.
  assert.equal(tags.length, 1, 'one stylesheet insertion')
  assert.equal(tags[0].dataset.plugin, 'dsh-memory')
  assert.match(tags[0].textContent, /\.dshmem-row/, 'the row style must be present')
  assert.match(tags[0].textContent, /\.dshmem-body/, 'the expanded-body style must be present')
  // The retired sidebar trigger must not leave dead CSS behind.
  assert.doesNotMatch(tags[0].textContent, /dshmem-trigger/)
  // Every class the component tree sets must have a rule, or the surface
  // renders unstyled in a way no assertion would otherwise notice.
  for (const used of ['dshmem-btn', 'dshmem-sect', 'dshmem-row', 'dshmem-line', 'dshmem-body', 'dshmem-meta',
    'dshmem-tag', 'dshmem-page', 'dshmem-grow', 'dshmem-toast', 'dshmem-diag', 'dshmem-empty']) {
    assert.match(tags[0].textContent, new RegExp(`\\.${used}\\{`), `${used} is set by the component but has no rule`)
  }

  assert.equal(locales.length, 1)
  assert.equal(locales[0].ns, 'memory')
  // Both dictionaries must cover the same keys, or one language shows raw keys.
  assert.deepEqual(
    Object.keys(locales[0].dictionaries.en).sort(),
    Object.keys(locales[0].dictionaries.zh).sort(),
    'dictionaries must cover the same keys',
  )

  // Memory is configuration, not a primary action: it registers into Settings
  // only. A permanent seat in the sidebar foot is for things used constantly,
  // and taking one there was an explicit complaint.
  const names = injected.map((entry) => entry.name)
  assert.deepEqual(names, ['settings.section'], 'memory must not claim a sidebar seat')

  for (const entry of injected) entry.contribute()
  assert.equal(registered.length, 1)

  const { options, component } = registered[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'memory')
  assert.equal(options.locale, 'memory')
  assert.equal(typeof options.order, 'number')
  assert.equal(typeof options.label, 'function', 'a settings section supplies a nav label')
  assert.equal(typeof component, 'function', 'a slot component must be a render function')
  assert.equal(options.inject().ctx, ctx, 'the injected face must hand over the context')
})

test('the settings page renders without throwing, with and without a context', async () => {
  const { exports } = await loadBundle()
  const { ctx, injected, registered } = stubContext()
  exports.apply(ctx)
  for (const entry of injected) entry.contribute()

  const t = (key) => key
  for (const { options, component } of registered) {
    const tree = component({ t, ctx, ...options.inject() })
    assert.ok(tree, `${options.name} must render something`)
  }

  // A missing context must not throw at mount: a client surface that throws
  // takes the page it is mounted into with it.
  assert.ok(registered[0].component({ t }), 'rendering without a context must not throw')
})

test('session resolution prefers the reactive hook, then props, then a snapshot', async () => {
  const { exports } = await loadBundle()

  // The shell hands every root-slot occupant a `useSessions` selector hook. It
  // must win, because a one-off snapshot read can precede the session list
  // being ready — which is precisely how the panel ended up reporting
  // "no session" while a session was in fact open.
  const reactive = exports.useCurrentSession({ useSessions: (select) => select({ current: 'from-hook' }) }, {})
  assert.equal(reactive, 'from-hook')

  // A hook that yields nothing falls through to the snapshot instead of
  // returning undefined outright.
  const fallbackHook = exports.useCurrentSession(
    { useSessions: () => undefined },
    stubContext().ctx,
  )
  assert.equal(fallbackHook, 'session-a', 'an empty hook result must fall back to the snapshot')

  // A throwing selector must not take the surface down.
  const throwing = exports.useCurrentSession(
    {
      useSessions: () => {
        throw new Error('selector exploded')
      },
    },
    stubContext().ctx,
  )
  assert.equal(throwing, 'session-a')

  // With no hook at all, props and snapshots still work.
  assert.equal(exports.useCurrentSession({ sessionId: 'prop-id' }, {}), 'prop-id')
  assert.equal(exports.useCurrentSession({}, stubContext().ctx), 'session-a')
  assert.equal(exports.useCurrentSession({}, {}), undefined)
})

test('session resolution prefers the prop, then current, then the first id', async () => {
  const { exports } = await loadBundle()

  // 1. an explicit prop wins
  assert.equal(
    exports.resolveSession({}, { sessionId: 'from-prop' }).sessionId,
    'from-prop',
  )

  // 2. a `session` object prop is also accepted
  assert.equal(
    exports.resolveSession({}, { session: { sessionId: 'session-prop' } }).sessionId,
    'session-prop',
  )

  // 3. a ready list resolves through `current`
  const ready = stubContext()
  assert.equal(exports.resolveSession(ready.ctx).sessionId, 'session-a')
  assert.equal(exports.resolveSession(ready.ctx).how, 'current')

  // 3. no current selection falls back to the first known id
  const noCurrent = stubContext({ snapshot: () => ({ ids: ['session-b'], current: undefined }) })
  const fallback = exports.resolveSession(noCurrent.ctx)
  assert.equal(fallback.sessionId, 'session-b')
  assert.equal(fallback.how, 'first-id')

  // 4. nothing available reports a diagnostic instead of throwing
  const empty = stubContext({ snapshot: () => ({ ids: [], current: undefined }) })
  const none = exports.resolveSession(empty.ctx)
  assert.equal(none.sessionId, undefined)
  assert.equal(none.how, 'none')
  assert.ok(none.diagnostic.length > 0, 'diagnostics must explain what was read')

  // 5. a missing sessions service is reported, not thrown
  const broken = exports.resolveSession({})
  assert.equal(broken.sessionId, undefined)
  assert.match(broken.diagnostic.join('\n'), /ctx\.sessions\.list/)

  // 6. a throwing store is contained
  const throwing = stubContext({
    snapshot: () => {
      throw new Error('store exploded')
    },
  })
  const contained = exports.resolveSession(throwing.ctx)
  assert.equal(contained.sessionId, undefined)
  assert.match(contained.diagnostic.join('\n'), /store exploded/)
})

test('commands are addressed to the resolved session and unwrapped', async () => {
  const { exports } = await loadBundle()
  const calls = []
  const { ctx } = stubContext({
    execute: async (sessionId, line, images) => {
      calls.push({ sessionId, line, images })
      return { ok: true, value: { result: { kind: 'success', text: `ran ${line}` } } }
    },
  })

  // Reach the shared action body through the exported component tree.
  const settings = exports.MemorySettingsSection({ t: (key) => key, ctx })
  assert.ok(settings)
  assert.equal(calls.length, 0, 'rendering alone must not fire a command')
})

test('the two banks render as separate sections, never one merged list', async () => {
  const { exports } = await loadBundle()

  const digest = {
    project: { id: 'p', label: 'promoter_atlas', folders: [] },
    core: '',
    memories: [
      { id: 'a', name: 'Folder fact', description: '', type: 'project', tags: [], pinned: false, updated: '2026-09-01T00:00:00Z', chars: 10, body: 'x', scope: 'project' },
      { id: 'b', name: 'Person fact', description: '', type: 'user', tags: [], pinned: false, updated: '2026-09-02T00:00:00Z', chars: 10, body: 'y', scope: 'global' },
      { id: 'c', name: 'Another folder fact', description: '', type: 'reference', tags: [], pinned: false, updated: '2026-09-03T00:00:00Z', chars: 10, body: 'z', scope: 'project' },
    ],
  }

  const sections = exports.splitBanks(digest)
  assert.deepEqual(sections.map((section) => section.key), ['project', 'personal'], 'project first, then the archive')

  const project = sections.find((section) => section.key === 'project')
  const personal = sections.find((section) => section.key === 'personal')
  assert.equal(project.count, 2)
  assert.equal(personal.count, 1)

  // The whole point: a personal entry must not appear under the project.
  const projectNames = project.groups.flatMap((group) => group.memories.map((memory) => memory.name))
  assert.deepEqual(projectNames.sort(), ['Another folder fact', 'Folder fact'])
  assert.ok(!projectNames.includes('Person fact'), 'a personal entry must not sit in the project section')

  const personalNames = personal.groups.flatMap((group) => group.memories.map((memory) => memory.name))
  assert.deepEqual(personalNames, ['Person fact'])

  // An empty bank contributes no section rather than an empty heading.
  const onlyProject = exports.splitBanks({ ...digest, memories: digest.memories.filter((m) => m.scope !== 'global') })
  assert.deepEqual(onlyProject.map((section) => section.key), ['project'])
  const onlyPersonal = exports.splitBanks({ ...digest, memories: digest.memories.filter((m) => m.scope === 'global') })
  assert.deepEqual(onlyPersonal.map((section) => section.key), ['personal'])
  assert.deepEqual(exports.splitBanks({ memories: [] }), [])
})

test('every memory renders as a clickable row that expands to its full text', async () => {
  const { exports } = await loadBundle()
  const t = (key) => key

  const memory = {
    id: 'm1',
    name: 'A remembered thing',
    description: 'one line summary',
    type: 'project',
    tags: ['alpha', 'beta'],
    pinned: true,
    updated: '2026-09-01T00:00:00Z',
    chars: 42,
    body: 'the full body text\nwith a second line',
    scope: 'project',
  }

  // Collapsed: a real button carrying the scannable line, and no body.
  const collapsed = exports.renderRow(memory, t, Date.parse('2026-09-02T00:00:00Z'), undefined, () => {})
  assert.equal(collapsed.type, 'button', 'the row must be a real button, not a div')
  assert.equal(collapsed.props['aria-expanded'], false, 'collapsed state must be announced')
  assert.equal(typeof collapsed.props.onClick, 'function')
  const collapsedText = JSON.stringify(collapsed)
  assert.match(collapsedText, /A remembered thing/)
  assert.doesNotMatch(collapsedText, /second line/, 'the body must stay hidden while collapsed')

  // Expanded: same row, now carrying the body and its metadata.
  const expanded = exports.renderRow(memory, t, Date.parse('2026-09-02T00:00:00Z'), 'm1', () => {})
  assert.equal(expanded.props['aria-expanded'], true)
  const expandedText = JSON.stringify(expanded)
  assert.match(expandedText, /second line/, 'expanding must reveal the full body')
  assert.match(expandedText, /alpha/)
  assert.match(expandedText, /pinned/, 'a pinned entry is marked')

  // Clicking toggles: expanded -> closed, closed -> opened.
  let next
  exports.renderRow(memory, t, Date.now(), 'm1', (value) => {
    next = value
  }).props.onClick()
  assert.equal(next, undefined, 'clicking an expanded row collapses it')
  exports.renderRow(memory, t, Date.now(), undefined, (value) => {
    next = value
  }).props.onClick()
  assert.equal(next, 'm1', 'clicking a collapsed row opens it')

  // An entry with no body says so rather than rendering an empty box.
  const empty = exports.renderRow({ ...memory, body: '' }, t, Date.now(), 'm1', () => {})
  assert.match(JSON.stringify(empty), /noBody/)
})

test('package.json declares the three things client discovery requires', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))

  // 1. the client bundle is found through exports['./client']
  assert.equal(pkg.exports['./client'], './lib/client.js')
  // 2. WITHOUT './package.json' in exports the scan silently reports
  //    "not a client package" and no bundle is ever served.
  assert.equal(pkg.exports['./package.json'], './package.json')
  // 3. platform must be the literal 'web'
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh?.client?.inject))

  await fs.access(path.join(ROOT, pkg.exports['./client']))
})
