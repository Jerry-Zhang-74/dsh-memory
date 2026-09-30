/**
 * dsh-memory — client half.
 *
 * Two surfaces, both built around the same idea: show the memory, do not
 * describe the machinery.
 *
 *   1. `settings.section`  — the memory list as cards grouped by type, with
 *      one-click copy-to-clipboard export. This is the primary entry.
 *   2. `sidebar.footer.action` — the same surface in a quick overlay.
 *
 * Design notes that are load-bearing:
 *
 *   - Cards, not logs. A user wants to see *what is remembered*; a monospace
 *     dump of command output is a developer artifact. Each card carries a title,
 *     one line of description, tag chips and a relative timestamp, grouped under
 *     the same headings the reference UI uses (You / Topics / Areas).
 *   - Clipboard, not a file. "Export" almost always means "give me the text so I
 *     can paste it somewhere", so export copies and raises a toast. Writing files
 *     is still available from `/memory export` in the conversation.
 *   - Data arrives through `/memory digest`, a delimited JSON block inside the
 *     ordinary command result. One implementation serves both the transcript and
 *     these cards; there is no second API to keep in sync.
 *   - A surface that throws takes the page with it, so every host interaction is
 *     wrapped and every failure renders as text.
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Locale namespace. */
    const NS = 'memory'
    const zh = {
      nav: '记忆',
      title: '记忆',
      subtitle: '这些是它记住的关于你的事，跨越对话保留。想改哪条，直接在这里说就行。',
      open: '打开记忆',
      close: '关闭',
      empty: '还没有记住任何东西。在对话里告诉它一件事，它就会记下来。',
      emptyHint: '例如：「记住这个项目用 pnpm」或「我偏好简洁的回答」。',
      groupYou: '关于你',
      groupTopics: '主题',
      groupAreas: '领域',
      groupOther: '其他',
      sectProject: '项目记忆',
      sectPersonal: '个人归档',
      noBody: '（这条没有正文）',
      pinned: '常驻',
      copy: '一键复制',
      copied: '已复制到剪贴板',
      copyFailed: '复制失败，请手动选择文本',
      refresh: '刷新',
      pending: '读取中…',
      failed: '读取失败',
      retry: '重试',
      chars: '字',
      hint: '增删改都在对话里说一句就行；这个页面只是让你一眼看清记住了什么。',
    }
    const en = {
      nav: 'Memory',
      title: 'Memory',
      subtitle: 'What it remembers about you, kept across conversations. To change something, just say so in the conversation.',
      open: 'Open memory',
      close: 'Close',
      empty: 'Nothing remembered yet. Tell it something in a conversation and it will keep it.',
      emptyHint: 'For example: "remember this project uses pnpm" or "I prefer concise answers".',
      groupYou: 'You',
      groupTopics: 'Topics',
      groupAreas: 'Areas',
      groupOther: 'Other',
      sectProject: 'Project memory',
      sectPersonal: 'Personal archive',
      noBody: '(this entry has no body)',
      pinned: 'Always on',
      copy: 'Copy all',
      copied: 'Copied to clipboard',
      copyFailed: 'Copy failed — select the text manually',
      refresh: 'Refresh',
      pending: 'Loading…',
      failed: 'Could not load',
      retry: 'Retry',
      chars: 'chars',
      hint: 'To add, change or remove anything, just say it in the conversation. This page is only for seeing what is kept.',
    }

    /** How each memory type is grouped and labelled, mirroring the reference UI. */
    const GROUPS = [
      { key: 'you', types: ['user', 'feedback'], label: 'groupYou' },
      { key: 'topics', types: ['project'], label: 'groupTopics' },
      { key: 'areas', types: ['reference'], label: 'groupAreas' },
    ]

    const CSS = `
      .dshmem-btn{font:inherit;font-size:12px;padding:5px 11px;border-radius:999px;cursor:pointer;white-space:nowrap;
        color:var(--dsw-alias-label-secondary,#555);background:transparent;
        border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14))}
      .dshmem-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
      .dshmem-btn:disabled{opacity:.45;cursor:default}
      .dshmem-btn-primary{background:var(--dsw-alias-brand-primary,#4c6ef5);border-color:transparent;color:#fff}
      .dshmem-btn-primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-brand-primary,#4c6ef5)}
      .dshmem-page{display:flex;flex-direction:column;gap:14px;padding:2px}
      .dshmem-grow{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px}
      .dshmem-sub{font-size:12.5px;line-height:1.65;margin:0;color:var(--dsw-alias-label-secondary,rgba(0,0,0,.6))}
      .dshmem-sect{margin-top:20px}
      .dshmem-sectName{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111);
        padding:0 0 2px;display:flex;align-items:baseline;gap:8px}
      .dshmem-sectCount{font-size:11.5px;font-weight:400;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}
      .dshmem-group{margin-top:12px}
      .dshmem-groupName{font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
        color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.5));padding:6px 0 2px}
      /* One memory = one clickable row. The whole row is the button so the hit
         target matches what looks pressable. */
      .dshmem-row{display:block;width:100%;text-align:left;font:inherit;cursor:pointer;
        padding:11px 6px;margin:0;background:transparent;border:none;
        border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));
        border-radius:0;transition:background .12s ease}
      .dshmem-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.045))}
      .dshmem-row:first-of-type{border-top:none}
      .dshmem-line{display:flex;align-items:baseline;gap:14px}
      .dshmem-name{flex:0 0 34%;font-size:13px;font-weight:500;line-height:1.5;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dshmem-desc{flex:1;min-width:0;font-size:12.5px;line-height:1.55;
        color:var(--dsw-alias-label-secondary,rgba(0,0,0,.62));
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dshmem-when{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.42));white-space:nowrap}
      /* Expanded body reuses the conversation's own reading rhythm. */
      .dshmem-body{white-space:pre-wrap;word-break:break-word;margin:10px 0 2px 0;padding:10px 12px;
        font-size:12.5px;line-height:1.7;border-radius:10px;
        background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));
        border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
      .dshmem-meta{font-size:11px;margin-top:8px;display:flex;gap:10px;flex-wrap:wrap;
        color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}
      .dshmem-tag{font-size:10px;padding:1px 6px;border-radius:999px;
        background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
      .dshmem-pin{display:inline-block;margin-left:6px;font-size:10px;padding:1px 6px;border-radius:999px;
        vertical-align:1px;color:var(--dsw-alias-brand-primary,#4c6ef5);
        background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c6ef5) 12%,transparent)}
      .dshmem-empty{padding:34px 4px;text-align:center}
      .dshmem-emptyTitle{font-size:13.5px;margin:0 0 6px}
      .dshmem-toast{position:fixed;left:50%;bottom:38px;transform:translateX(-50%);z-index:70;
        font-size:12.5px;padding:9px 16px;border-radius:999px;pointer-events:none;
        color:#fff;background:rgba(24,24,28,.92);box-shadow:0 8px 26px rgba(0,0,0,.3);
        animation:dshmem-toast-in .16s ease-out}
      @keyframes dshmem-toast-in{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
      .dshmem-err{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#d33)}
      .dshmem-hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}
      .dshmem-diag{font-size:10px;line-height:1.5;font-family:ui-monospace,Consolas,monospace;
        color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45));white-space:pre-wrap}
    `

    /** Tag id keeps stylesheet injection idempotent across reloads. */
    const CSS_TAG = 'dsh-memory/memory-panel.css'

    /** Insert the stylesheet once. Runs inside the factory, i.e. at materialization. */
    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-memory'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Format an ISO timestamp as a short relative age. */
    function relativeTime(iso, now = Date.now()) {
      if (!iso) return ''
      const then = Date.parse(iso)
      if (Number.isNaN(then)) return ''
      const seconds = Math.max(0, Math.round((now - then) / 1000))
      if (seconds < 60) return 'just now'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours}h`
      const days = Math.round(hours / 24)
      if (days < 30) return `${days}d`
      const months = Math.round(days / 30)
      if (months < 12) return `${months}mo`
      return `${Math.round(months / 12)}y`
    }

    /** Parse the digest payload out of a command result, or return undefined. */
    function parseDigest(text) {
      if (typeof text !== 'string') return undefined
      const open = text.indexOf('<<<dsh-memory:digest>>>')
      if (open === -1) return undefined
      const close = text.indexOf('<<<end-dsh-memory:digest>>>', open)
      if (close === -1) return undefined
      const json = text.slice(open + '<<<dsh-memory:digest>>>'.length, close).trim()
      try {
        return JSON.parse(json)
      } catch {
        return undefined
      }
    }

    /**
     * Resolve the session a command should run against.
     *
     * Several shapes are tried because a failure here leaves the surface unusable,
     * and the available props differ between a settings page and the sidebar foot.
     *
     * @returns `{ sessionId, how, diagnostic }`.
     */
    function resolveSession(ctx, props) {
      const diagnostic = []
      const explicit = props?.sessionId
      if (typeof explicit === 'string' && explicit !== '') return { sessionId: explicit, how: 'prop', diagnostic }
      const fromSession = props?.session?.sessionId
      if (typeof fromSession === 'string' && fromSession !== '') {
        return { sessionId: fromSession, how: 'session-prop', diagnostic }
      }

      const store = ctx?.sessions?.list
      if (!store || typeof store.getSnapshot !== 'function') {
        diagnostic.push(`ctx.sessions.list: ${store === undefined ? 'undefined' : typeof store}`)
        return { sessionId: undefined, how: 'none', diagnostic }
      }

      let snapshot
      try {
        snapshot = store.getSnapshot()
      } catch (error) {
        diagnostic.push(`getSnapshot threw: ${error?.message ?? error}`)
        return { sessionId: undefined, how: 'none', diagnostic }
      }

      diagnostic.push(`keys: ${snapshot && typeof snapshot === 'object' ? Object.keys(snapshot).join(',') : typeof snapshot}`)
      diagnostic.push(`current: ${String(snapshot?.current)}`)
      diagnostic.push(`ids: ${Array.isArray(snapshot?.ids) ? snapshot.ids.length : typeof snapshot?.ids}`)

      if (typeof snapshot?.current === 'string' && snapshot.current !== '') {
        return { sessionId: snapshot.current, how: 'current', diagnostic }
      }
      const first = Array.isArray(snapshot?.ids) ? snapshot.ids[0] : undefined
      if (typeof first === 'string' && first !== '') return { sessionId: first, how: 'first-id', diagnostic }
      return { sessionId: undefined, how: 'none', diagnostic }
    }

    /**
     * Read the current session reactively.
     *
     * The shell hands every root-slot occupant a `useSessions` selector hook
     * (declared in the slot's `standardProps`). Using it is the difference
     * between a panel that can address a command and one that reports "no
     * session" because it read a snapshot before the session list was ready —
     * which is exactly the bug this exists to prevent.
     *
     * Falls back to a one-off snapshot read when the hook is absent, so the
     * component still works where the slot is composed differently.
     *
     * @returns the current session id, or undefined.
     */
    function useCurrentSession(props, ctx) {
      const useSessions = props?.useSessions
      if (typeof useSessions === 'function') {
        try {
          const current = useSessions((state) => state?.current)
          if (typeof current === 'string' && current !== '') return current
        } catch {
          /* a selector that throws must not take the surface down */
        }
      }
      return resolveSession(ctx, props).sessionId
    }

    /**
     * Run one `/memory` command and unwrap both envelope layers.
     *
     * @returns `{ kind, text, diagnostic }`.
     */
    async function runCommand(ctx, line, props) {
      const resolved = resolveSession(ctx, props)
      if (resolved.sessionId === undefined) {
        return { kind: 'no-session', text: '', diagnostic: resolved.diagnostic }
      }
      const envelope = await ctx.remote.commands.execute(resolved.sessionId, line, [])
      if (!envelope || envelope.ok !== true) {
        return { kind: 'error', text: envelope?.error?.message ?? 'command transport failed', diagnostic: resolved.diagnostic }
      }
      if (envelope.value === undefined) {
        return { kind: 'error', text: `unknown or malformed command: ${line}`, diagnostic: resolved.diagnostic }
      }
      const result = envelope.value.result ?? { kind: 'success', text: '' }
      return { kind: result.kind, text: result.text, diagnostic: resolved.diagnostic }
    }

    /**
     * Copy text to the clipboard, with a fallback for contexts where the async
     * clipboard API is unavailable or denied (it needs a secure context and can
     * be blocked inside an iframe).
     *
     * @returns whether the copy succeeded.
     */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through to the legacy path */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    /** A transient toast that removes itself. */
    function useToast() {
      const [message, setMessage] = React.useState('')
      const timerRef = React.useRef(undefined)
      const show = React.useCallback((text) => {
        setMessage(text)
        if (timerRef.current !== undefined) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setMessage(''), 1900)
      }, [])
      React.useEffect(
        () => () => {
          if (timerRef.current !== undefined) clearTimeout(timerRef.current)
        },
        [],
      )
      const node = message
        ? React.createElement('div', { className: 'dshmem-toast', role: 'status' }, message)
        : null
      return { show, node }
    }

    /**
     * Group memories into the type headings the reference UI uses, newest first
     * inside each.
     *
     * @param memories - entries to group.
     * @returns one group per non-empty type heading.
     */
    function groupMemories(memories) {
      const output = []
      const used = new Set()
      for (const group of GROUPS) {
        const members = memories.filter((memory) => group.types.includes(memory.type))
        if (members.length === 0) continue
        for (const member of members) used.add(member.id)
        output.push({
          key: group.key,
          label: group.label,
          memories: [...members].sort((a, b) => String(b.updated).localeCompare(String(a.updated))),
        })
      }
      const rest = memories.filter((memory) => !used.has(memory.id))
      if (rest.length > 0) output.push({ key: 'other', label: 'groupOther', memories: rest })
      return output
    }

    /**
     * Split entries into the two banks, then group each by type.
     *
     * Project memory and the personal archive are shown as separate sections
     * because they mean different things — one is about the folder, the other
     * about the person — and a single merged list is exactly the confusion this
     * separation exists to remove. Personal entries carry `scope: 'global'`.
     *
     * @param digest - the payload from `/memory digest`.
     * @returns `[{ key, label, count, groups }]`, project first.
     */
    function splitBanks(digest) {
      const memories = digest?.memories ?? []
      const project = memories.filter((memory) => memory.scope !== 'global')
      const personal = memories.filter((memory) => memory.scope === 'global')
      const sections = []
      if (project.length > 0) {
        sections.push({ key: 'project', label: 'sectProject', hint: digest?.project?.label ?? '', count: project.length, groups: groupMemories(project) })
      }
      if (personal.length > 0) {
        sections.push({ key: 'personal', label: 'sectPersonal', hint: '', count: personal.length, groups: groupMemories(personal) })
      }
      return sections
    }

    /** Shared load/copy state for both surfaces. */
    function useMemoryState(props) {
      const { ctx, t, sessionId } = props
      const [state, setState] = React.useState({ phase: 'loading', digest: undefined, error: '', diagnostic: [] })
      const [copying, setCopying] = React.useState(false)
      const toast = useToast()
      const propsRef = React.useRef(props)
      propsRef.current = props

      const load = React.useCallback(async () => {
        setState((previous) => ({ ...previous, phase: previous.digest ? 'ready' : 'loading', error: '' }))
        try {
          const result = await runCommand(ctx, '/memory digest', propsRef.current)
          if (result.kind === 'no-session') {
            setState({ phase: 'error', digest: undefined, error: t('failed'), diagnostic: result.diagnostic })
            return
          }
          if (result.kind === 'error') {
            setState({ phase: 'error', digest: undefined, error: result.text ?? t('failed'), diagnostic: result.diagnostic })
            return
          }
          const digest = parseDigest(result.text)
          if (!digest) {
            setState({ phase: 'error', digest: undefined, error: t('failed'), diagnostic: result.diagnostic })
            return
          }
          setState({ phase: 'ready', digest, error: '', diagnostic: result.diagnostic })
        } catch (failure) {
          setState({ phase: 'error', digest: undefined, error: failure?.message ?? String(failure), diagnostic: [] })
        }
      }, [ctx, t, sessionId])

      const copyAll = React.useCallback(async () => {
        setCopying(true)
        try {
          // Ask the host for the same text `/memory export` writes to disk, so
          // the clipboard and the file bundle can never drift apart.
          const result = await runCommand(ctx, '/memory export-text', propsRef.current)
          if (result.kind !== 'success' || !result.text) {
            toast.show(t('copyFailed'))
            return
          }
          toast.show((await copyText(result.text)) ? t('copied') : t('copyFailed'))
        } catch {
          toast.show(t('copyFailed'))
        } finally {
          setCopying(false)
        }
      }, [ctx, t, toast, sessionId])

      React.useEffect(() => {
        void load()
      }, [load])

      return { state, load, copyAll, copying, toast }
    }

    /**
     * One memory as a clickable row that expands into its full text.
     *
     * The collapsed line is the scannable shape (name, one-line description,
     * age); clicking opens the actual note. Rows are real `<button>`s so the
     * keyboard and screen reader get the behaviour for free.
     *
     * @param memory - the entry to render.
     * @param t - locale lookup.
     * @param now - render clock for the relative age.
     * @param openId - currently expanded id, if any.
     * @param setOpenId - expands or collapses an id.
     */
    function renderRow(memory, t, now, openId, setOpenId) {
      const expanded = openId === memory.id
      const tags = Array.isArray(memory.tags) ? memory.tags : []
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dshmem-row',
          key: memory.id,
          'aria-expanded': expanded,
          onClick: () => setOpenId(expanded ? undefined : memory.id),
        },
        React.createElement(
          'div',
          { className: 'dshmem-line' },
          React.createElement(
            'div',
            { className: 'dshmem-name' },
            memory.name,
            memory.pinned ? React.createElement('span', { className: 'dshmem-pin' }, t('pinned')) : null,
          ),
          React.createElement(
            'div',
            { className: 'dshmem-desc' },
            memory.description || (memory.body ?? '').replace(/\s+/g, ' ').slice(0, 180),
          ),
          React.createElement('div', { className: 'dshmem-when' }, relativeTime(memory.updated, now)),
        ),
        expanded
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement('div', { className: 'dshmem-body' }, (memory.body ?? '').trim() || t('noBody')),
              React.createElement(
                'div',
                { className: 'dshmem-meta' },
                React.createElement('span', null, memory.type),
                tags.map((tag) => React.createElement('span', { className: 'dshmem-tag', key: tag }, tag)),
                React.createElement('span', null, `${memory.chars ?? 0} ${t('chars')}`),
                memory.updated ? React.createElement('span', null, new Date(memory.updated).toLocaleString()) : null,
              ),
            )
          : null,
      )
    }

    /** The card list: the heart of the surface. */
    function MemoryList(props) {
      const { state, load, copyAll, copying, toast, t } = props
      const digest = state.digest
      const sections = digest ? splitBanks(digest) : []
      const total = digest?.memories?.length ?? 0
      const now = Date.now()
      // Which entry is expanded. One at a time keeps the list scannable and
      // makes the toggle unambiguous with no per-row bookkeeping.
      const [openId, setOpenId] = React.useState(undefined)

      const buttons = React.createElement(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 } },
        React.createElement('button', { type: 'button', className: 'dshmem-btn', onClick: () => void load() }, t('refresh')),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dshmem-btn dshmem-btn-primary',
            disabled: copying || state.phase !== 'ready' || total === 0,
            onClick: () => void copyAll(),
          },
          t('copy'),
        ),
      )

      if (state.phase === 'loading' && !digest) {
        return React.createElement(
          'div',
          null,
          React.createElement('p', { className: 'dshmem-sub' }, t('pending')),
        )
      }

      if (state.phase === 'error' && !digest) {
        return React.createElement(
          'div',
          { className: 'dshmem-grow' },
          React.createElement('div', { className: 'dshmem-err' }, `${t('failed')}: ${state.error}`),
          React.createElement('div', { className: 'dshmem-row', style: { borderTop: 'none', marginTop: 10 } }, buttons),
          state.diagnostic?.length
            ? React.createElement(
                'details',
                { style: { marginTop: 10 } },
                React.createElement('summary', { className: 'dshmem-hint' }, 'diagnostics'),
                React.createElement('div', { className: 'dshmem-diag' }, state.diagnostic.join('\n')),
              )
            : null,
        )
      }

      if (sections.length === 0) {
        return React.createElement(
          'div',
          null,
          React.createElement(
            'div',
            { className: 'dshmem-empty' },
            React.createElement('p', { className: 'dshmem-emptyTitle' }, t('empty')),
            React.createElement('p', { className: 'dshmem-hint' }, t('emptyHint')),
          ),
          React.createElement('div', { className: 'dshmem-row', style: { borderTop: 'none', cursor: 'default' } }, buttons),
        )
      }

      return React.createElement(
        'div',
        null,
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 } },
          React.createElement(
            'span',
            { className: 'dshmem-hint', style: { flex: 1 } },
            `${digest.memories.length} · ${digest.project?.label ?? ''}`,
          ),
          buttons,
        ),
        ...sections.map((section) =>
          React.createElement(
            'div',
            { className: 'dshmem-sect', key: section.key },
            React.createElement(
              'div',
              { className: 'dshmem-sectName' },
              t(section.label),
              React.createElement('span', { className: 'dshmem-sectCount' }, `${section.count}${section.hint ? ` · ${section.hint}` : ''}`),
            ),
            ...section.groups.map((group) =>
              React.createElement(
                'div',
                { className: 'dshmem-group', key: `${section.key}:${group.key}` },
                React.createElement('div', { className: 'dshmem-groupName' }, t(group.label)),
                ...group.memories.map((memory) => renderRow(memory, t, now, openId, setOpenId)),
              ),
            ),
          ),
        ),
        React.createElement('div', { className: 'dshmem-hint', style: { marginTop: 16 } }, t('hint')),
        toast.node,
      )
    }

    /** The settings page: the same list in a full content column. */
    function MemorySettingsSection(props) {
      const t = props.t ?? ((key) => key)
      const sessionId = useCurrentSession(props, props.ctx)
      const state = useMemoryState({ ...props, t, sessionId })
      return React.createElement(
        'div',
        { className: 'dshmem-page' },
        React.createElement('p', { className: 'dshmem-sub' }, t('subtitle')),
        React.createElement(MemoryList, { ...state, t }),
      )
    }

    /** Hard dependencies: slots, the sessions list, and the Remote gateway. */
    const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']

    /**
     * Client plugin body.
     *
     * Registers exactly one surface: the settings page. Memory is configuration,
     * not a primary action, so it belongs beside General / Models / Plugins
     * rather than occupying a permanent seat in the sidebar foot — that space is
     * for things the user does constantly.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ensureCss()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memory: dictionaries')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'memory',
            order: 30,
            label: () => ctx.locale.bind(NS)('nav'),
            locale: NS,
            inject: () => ({ ctx }),
          },
          MemorySettingsSection,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.MemoryList = MemoryList
    exports.MemorySettingsSection = MemorySettingsSection
    exports.parseDigest = parseDigest
    exports.relativeTime = relativeTime
    exports.groupMemories = groupMemories
    exports.splitBanks = splitBanks
    exports.renderRow = renderRow
    exports.resolveSession = resolveSession
    exports.useCurrentSession = useCurrentSession
    return module.exports
  },
})
