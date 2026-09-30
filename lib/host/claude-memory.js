/**
 * DSH Memory — Claude memory-export parser.
 *
 * Anthropic publishes no interchange format, so real exports have to be handled
 * by their actual shapes. Four were found in the wild in one user's export, and
 * a generic markdown parser mangles every one of them:
 *
 *   1. **Modern Settings export** — `=== MEMORY EXPORT ===`, `## 1. IDENTITY`,
 *      then `[unknown] - fact` lines. Section names carry the only
 *      classification the file has; a generic parser drops it.
 *   2. **Older prose export** — `Work context` / `Personal context` / `Top of
 *      mind` headings over whole paragraphs, no bullets.
 *   3. **Screenshot transcription** — `### Title（更新于 YYYY-MM-DD）` with
 *      `**Summary:**` and `**Details:**` blocks. The date is real metadata.
 *   4. **Legacy bold export** — `**Work context**` as a paragraph heading.
 *
 * All four reduce to the same model: sections, each becoming one memory whose
 * `type` is inferred from the section name and whose tags record the origin.
 *
 * @module dsh-memory/claude-memory
 */

/**
 * Section names seen across the formats, mapped to the memory type they imply.
 *
 * Matching is lowercased and substring-based so variants like `INSTRUCTIONS`
 * and `Other instructions` land on the same inference.
 */
const SECTION_TYPES = [
  ['preference', 'user'],
  ['instruction', 'user'],
  ['identity', 'user'],
  ['profile', 'user'],
  ['personal context', 'user'],
  ['work context', 'user'],
  ['writing', 'user'],
  ['figure', 'user'],
  ['academic', 'project'],
  ['career', 'project'],
  ['project', 'project'],
  ['research', 'project'],
  ['technical', 'reference'],
  ['environment', 'reference'],
  ['setup', 'reference'],
  ['top of mind', 'project'],
  ['history', 'project'],
  ['background', 'project'],
  ['volunteer', 'project'],
  ['internship', 'project'],
]

/** Infer a memory type from a section heading. */
function typeForSection(section) {
  const lower = String(section ?? '').toLowerCase()
  for (const [needle, type] of SECTION_TYPES) {
    if (lower.includes(needle)) return type
  }
  return 'project'
}

/** True when the text looks like a Claude memory export in any of the four shapes. */
export function looksLikeClaudeMemory(text) {
  const sample = String(text ?? '').slice(0, 6000)
  if (/===\s*MEMORY EXPORT\s*===/i.test(sample)) return true
  if (/^\s*\*\*\s*(work context|personal context|top of mind)\s*\*\*/im.test(sample)) return true
  if (/^\s*(work context|personal context|top of mind|brief history)\s*$/im.test(sample)) return true
  if (/\*\*\s*Summary:\s*\*\*/i.test(sample) && /\*\*\s*Details:\s*\*\*/i.test(sample)) return true
  return false
}

/** Parse a `（更新于 2026-08-03）` / `(updated Aug 3)` suffix into an ISO date. */
function parseUpdated(text) {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`
  const monthDay = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(text)
  if (monthDay) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const index = months.indexOf(monthDay[1].toLowerCase().slice(0, 3))
    const year = new Date().getUTCFullYear()
    return `${year}-${String(index + 1).padStart(2, '0')}-${String(Number(monthDay[2])).padStart(2, '0')}T00:00:00.000Z`
  }
  return undefined
}

/** Strip a leading `[unknown] - ` / `[2026-01-01] - ` provenance marker. */
function stripMarker(line) {
  return line.replace(/^\s*\[[^\]]*\]\s*[-–—]\s*/, '').trim()
}

/** One candidate record. */
function candidate({ name, body, section, type, created, tags }) {
  return {
    name: name.trim().slice(0, 200),
    body: body.trim(),
    description: body.replace(/\s+/g, ' ').trim().slice(0, 200),
    type: type ?? typeForSection(section),
    scope: 'project',
    tags: ['claude-import', ...(section ? [`section:${section.toLowerCase().replace(/\s+/g, '-')}`] : []), ...(tags ?? [])],
    created,
  }
}

/**
 * Format 1: `=== MEMORY EXPORT ===` with `## N. SECTION` headings.
 *
 * Each section becomes one memory: the section name is the title and carries
 * the type, the `- ` lines become the body. Provenance markers (`[unknown]`)
 * are stripped rather than stored, because they carry no information.
 */
function parseModernExport(text) {
  const body = text.replace(/^[\s\S]*?===\s*MEMORY EXPORT\s*===/i, '')
  const lines = body.split('\n')
  const sections = []
  let current = null

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    const heading = /^#{1,3}\s*(?:\d+\.\s*)?(.+?)\s*$/.exec(line)
    if (heading) {
      if (current) sections.push(current)
      current = { name: heading[1].trim(), items: [] }
      continue
    }
    if (current === null) continue
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (bullet) {
      const item = stripMarker(bullet[1])
      if (item) current.items.push(item)
      continue
    }
    const plain = stripMarker(line)
    if (plain && !/^-+$/.test(plain)) current.items.push(plain)
  }
  if (current) sections.push(current)

  return sections
    .filter((section) => section.items.length > 0)
    .map((section) =>
      candidate({
        name: section.name,
        // Keep bullets: these entries are long and lists are how they read.
        body: section.items.map((item) => `- ${item}`).join('\n'),
        section: section.name,
      }),
    )
}

/** Known paragraph headings of the older prose export, longest first so `Brief history` wins over `History`. */
const PROSE_HEADINGS = [
  'brief history',
  'work context',
  'personal context',
  'top of mind',
  'other instructions',
  'recent months',
  'earlier context',
  'long-term background',
]

/**
 * Format 2 and 4: a heading line (bare or `**bold**`) over running prose.
 *
 * Recognised headings are read as section starts and everything until the next
 * heading is that section's body. Unrecognised bare lines are treated as
 * continuation text, so prose is never truncated mid-thought.
 */
function parseProseExport(text) {
  const lines = text.split('\n')
  const sections = []
  let current = null

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (line === '') continue

    const bare = line.replace(/^\*\*(.+?)\*\*:?\s*$/, '$1').replace(/^#+\s*/, '').trim()
    const isHeading =
      /^\*\*.+\*\*:?$/.test(line) || PROSE_HEADINGS.includes(bare.toLowerCase())
    if (isHeading && bare.length > 0 && bare.length < 60) {
      if (current) sections.push(current)
      current = { name: bare, paragraphs: [] }
      continue
    }
    if (current === null) current = { name: 'Memory', paragraphs: [] }
    current.paragraphs.push(line)
  }
  if (current) sections.push(current)

  return sections
    .filter((section) => section.paragraphs.length > 0)
    .map((section) => {
      // Preserve the Italic sub-headings (`*Recent months*`) as list labels.
      const body = section.paragraphs
        .map((line) => (/^\*[^*]+\*$/.test(line) ? `\n**${line.replace(/^\*|\*$/g, '')}**` : line))
        .join('\n\n')
      return candidate({ name: section.name, body, section: section.name })
    })
}

/**
 * Split a transcribed card title into a clean name and any parenthetical
 * annotation.
 *
 * Real titles carry more than a date: `Guqiang Defense（项目：果酱；更新于
 * 2026-09-20）` and `Promoter Review（项目：启动子综述；更新于 2026-09-29 ← 最后
 * 更新的卡片）`. Keeping that in the name makes two cards for the same topic
 * look like different memories, so the annotation moves into the body — where a
 * re-import does not duplicate anything — and the name keeps only the title.
 *
 * @param line - the raw heading text.
 * @returns `{ name, note }`.
 */
function splitTitleAnnotation(line) {
  const match = /[（(]([^（()）]*(?:更新于|updated)[^（()）]*)[）)]/i.exec(line)
  if (!match) return { name: line.trim(), note: '' }
  const name = line.replace(match[0], '').trim()
  return { name, note: match[1].trim() }
}

/**
 * Merge candidates that share a name.
 *
 * A screenshot transcription can run one card across two images, which shows up
 * as the same title twice with a `（第二张卡片）`-style annotation — the real
 * export this handles does exactly that for one card. Two entries with the same
 * name are one memory, so their bodies are joined rather than producing a
 * duplicate that a re-import would then skip.
 *
 * @param candidates - parsed candidates in source order.
 * @returns candidates with same-named entries merged.
 */
function mergeByName(candidates) {
  const merged = []
  const byName = new Map()
  for (const entry of candidates) {
    const key = entry.name.toLowerCase()
    const existing = byName.get(key)
    if (!existing) {
      byName.set(key, entry)
      merged.push(entry)
      continue
    }
    existing.body = `${existing.body}\n\n---\n\n${entry.body}`.trim()
    existing.description = existing.description || entry.description
    // Keep the earliest recorded date: it is when the card was first written.
    if (entry.created && (!existing.created || entry.created < existing.created)) existing.created = entry.created
    for (const tag of entry.tags ?? []) {
      if (!existing.tags.includes(tag)) existing.tags.push(tag)
    }
  }
  return merged
}

/**
 * Format 3: screenshot transcription — `### Title（更新于 date）` with
 * `**Summary:**` / `**Details:**`.
 */
function parseTranscribed(text) {
  const memories = []
  const blocks = text.split(/\n(?=#{2,4}\s)/)

  for (const block of blocks) {
    const heading = /^#{2,4}\s*(.+?)\s*$/m.exec(block)
    if (!heading) continue
    const titleLine = heading[1]
    const { name, note } = splitTitleAnnotation(titleLine)
    if (!name || /^claude|^来源|^说明|^转录时间/.test(name)) continue

    const summary = /\*\*\s*Summary:\s*\*\*\s*(.+?)(?:\n|$)/i.exec(block)
    const details = /\*\*\s*Details:\s*\*\*\s*([\s\S]*)$/i.exec(block)
    const detailBody = details ? details[1].trim() : ''
    if (!detailBody && !summary) continue

    const created = parseUpdated(titleLine)
    memories.push(
      candidate({
        name,
        // The annotation is provenance, so it belongs with the content.
        body: [note ? `_${note}_` : '', detailBody || summary[1].trim()].filter(Boolean).join('\n\n'),
        section: name,
        type: name.toLowerCase().includes('preference') ? 'user' : undefined,
        created,
        tags: created ? [`updated:${created.slice(0, 10)}`] : [],
      }),
    )
  }
  return mergeByName(memories)
}

/** Count how many signals each known format shows. */
function detectFormat(text) {
  const sample = String(text ?? '')
  if (/===\s*MEMORY EXPORT\s*===/i.test(sample)) return 'modern'
  if (/\*\*\s*Summary:\s*\*\*/i.test(sample) && /\*\*\s*Details:\s*\*\*/i.test(sample)) return 'transcribed'
  if (/^\s*(?:\*\*)?(work context|personal context|top of mind|brief history)(?:\*\*)?\s*$/im.test(sample)) return 'prose'
  return undefined
}

/**
 * Parse a Claude memory export in whichever shape it takes.
 *
 * @param text - the export text.
 * @returns memory candidates, or an empty array when the text is not one.
 */
export function parseClaudeMemory(text) {
  if (!looksLikeClaudeMemory(text)) return []
  const format = detectFormat(text)
  switch (format) {
    case 'modern':
      return parseModernExport(text)
    case 'transcribed':
      return parseTranscribed(text)
    case 'prose':
      return parseProseExport(text)
    default:
      return []
  }
}

export { parseModernExport, parseProseExport, parseTranscribed, typeForSection }
