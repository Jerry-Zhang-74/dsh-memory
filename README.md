# dsh-memory

Claude-style **project memory** for DeepSeek Harness.

Memory outlives a conversation: a fact you state in one session shows up in every
later session bound to the same project folder. Memories are formed, revised and
forgotten through ordinary conversation, and can be imported or exported in bulk.

No runtime dependencies, no build step — plain ESM, install and go.

---

## What it solves

DSH sessions are isolated: a new one knows nothing you discussed before. The
built-in `memory` tool is long-term memory for the *profile* directory; this
plugin adds memory **scoped to a working directory**:

- Preferences, conventions and architecture decisions worked out in `E:\MyApp`
  appear only in sessions that touch `E:\MyApp`.
- One project can span **several folders** (a monorepo, a frontend plus a
  backend). `/memory bind` attaches another folder to the same bank.
- Memories are **markdown files on disk** — readable, editable, git-friendly.

---

## Getting started

Once installed (see *Install* below), in any session:

```text
/memory                        overview of the current project's memory
/memory list                   list everything
/memory show <id>              read one entry in full
/memory import <path>          bulk import, handed to a curator conversation
/memory import-now <path>      bulk import, merged directly
/memory export                 write the bundles to disk
/memory bind [folder]          attach another folder to the same bank
/memory projects               list every memory project on this machine
```

You can also just talk — no commands to remember:

> "remember that this project uses pnpm, not npm"
> "change that tabs memory to 2 spaces"
> "what do you remember about the build setup?"
> "forget the one about the old API"
> **"import this memory:"** (then paste)

The model calls the `memory` tool on its own.

---

## Migrating from Claude

Claude has **no memory export format** — the official path is copy and paste. So
the importer is written against the shapes real exports actually take. Four were
found in one person's export; all four are supported:

| Shape | What it looks like | How it is read |
|---|---|---|
| Modern Settings export | `=== MEMORY EXPORT ===`, `## IDENTITY`, then `[unknown] - fact` lines | one memory per section, section name becomes the type, the `[unknown]` marker is stripped |
| Older prose export | `Work context` / `Personal context` / `Top of mind` headings over paragraphs | one memory per heading |
| Screenshot transcription | `### Title (updated 2026-08-03)` plus `**Summary:**` / `**Details:**` | title cleaned, date preserved as metadata, same-named cards merged |
| Legacy bold export | `**Work context**` over a paragraph | one memory per bold heading |

Section names drive the `type`: `INSTRUCTIONS` / `PREFERENCES` / `IDENTITY` /
`Personal context` become `user`; `PROJECTS` / `CAREER` / `Academic` become
`project`; `TECHNICAL SETUP` / `Environment` become `reference`. Every imported
entry is tagged `claude-import` and `section:<name>`.

Two ways to run it:

```text
/memory import <path>          # curator conversation; best for large imports
```

or paste the content and let the model decide — it calls `memory_import`, which
previews first and writes only after you confirm.

---

## Tools the model gets

### `memory`

| action | Does |
|---|---|
| `save` | create an entry (`name` / `body` / `type` / `description` / `tags` / `scope` / `pinned`) |
| `recall` | rank memories against a query; searches **both** banks |
| `read` | fetch one entry in full by id or name |
| `update` | patch fields; changing `scope` **moves** the entry between banks |
| `edit` | replace an exact `oldText` inside a body with `newText` |
| `forget` | delete an entry permanently |
| `list` | list entries, labelled by bank, filterable by `type` / `tag` / `scope` |
| `core` | read or replace the always-in-context core note of either bank |
| `bind` / `unbind` | attach or detach a folder |
| `projects` | list every memory project on this machine |
| `stats` | size and shape of both banks |

`type` is one of `user` (durable facts about the person), `project` (this
codebase or workspace), `feedback` (corrections and preferences), `reference`
(pointers and links).

### `memory_context`

Assembles a memory block under an explicit character budget, optionally focused
by a query. Use it when the always-present index is not enough.

### `memory_files`

The Anthropic `memory_20250818` verb surface — `view`, `create`, `str_replace`,
`insert`, `delete`, `rename` — over a virtual `/memories` root. Present so a
model already trained on those verbs can drive this bank without relearning
anything.

### `memory_import`

Conversational import: pass pasted text as `content`, or a file or folder as
`path`. Previews by default, commits on confirmation. Understands every shape in
the migration table above plus JSON, JSONL, ZIP and plain text.

---

## How memory reaches a conversation

Nothing relies on the model remembering to look. Every session gets a layered
block:

- the **core note** (`core.md`) — hand-curated, always relevant;
- a **memory index** — one line per entry (name, type, summary, tags, id), capped
  at **200 lines or 25 KB**, whichever comes first;
- the **full body of pinned entries** only.

Everything else stays one `memory` call away. Whatever a bank grows to, the
always-on cost stays bounded.

Refreshing is **change-driven**, not timer-driven: a cheap signature of the bank
(mtime and size of `core.md` and `index.md`, project id, folder count) is
compared, and the block is rebuilt only when it moved. A memory saved a moment
ago is in context on the next step, and nothing re-reads the disk on every step.

### Deciding on its own

The prompt states plainly that the index is deliberately compact and that the
full text should be read before relying on its detail. The model therefore
decides:

- whether memory is needed at all (small talk usually is not);
- which bank to consult (project or personal);
- which entries to read (`recall` ranks, `read` fetches exactly one);
- where a new fact belongs (`scope`).

That is what "wired into every conversation, deciding for itself whether and how
to use memory" means here: **a folder of what exists, with the bodies on
demand**, instead of pouring history into every request.

---

## Two banks: project memory and the personal archive

They are stored and displayed separately because they answer different questions:

| | Project memory | Personal archive |
|---|---|---|
| Holds | facts about this folder: architecture, conventions, build quirks | facts about the **person**: preferences, background, ongoing commitments |
| Applies to | sessions bound to that folder | **every** session, whatever the project |
| Ownership | assigned automatically by working directory | attached to no folder at all |
| `scope` value | `project` (default) | `global` (alias `personal`) |

Guarantees:

- **No folder ever resolves into the archive**, so a project cannot accidentally
  become the person's archive.
- Changing `scope` **moves** the entry between banks rather than relabelling it —
  promoting a project fact to the archive leaves no copy behind.
- Reads need no bank: `read` and `recall` search both and label each result.
- Entries listed under a project are never mixed into the archive, or the other
  way round.

The UI shows them as two separate sections.

```text
$DSH_HOME/storages/dsh-memory/projects/
├── <projectId>/        project memory (a bound folder set)
└── _personal/          the personal archive (no folders)
```

---

## The memory page

Settings → **Memory** is a card list:

- Split into **Project memory** and **Personal archive**, each grouped by type
  (You / Topics / Areas).
- Every row reads as *name — one-line summary — age*. **Clicking a row opens the
  full text**, along with its type, tags, character count and exact timestamp.
- **Copy all** puts the whole bank on the clipboard as Markdown and shows a
  brief confirmation instead of writing a file.

---

## Conversations outside a project

Three seats exist, and the distinction that matters is that **leaving the
projects does not mean losing memory**. That is how Claude and ChatGPT behave:
account-level memory follows the person into every conversation, while a
project's own memory stays inside that project.

| Seat | Preset | Memory it carries | Tools |
|---|---|---|---|
| A project session | `standard`, `code`, `minimal`, `cordis` | project memory **+** the personal archive | the full agent |
| Outside any project, with memory | `chat` | the personal archive **only** | memory only |
| Outside any project, with nothing | `chat-empty` | none | none |

### `chat` — outside the projects, carrying personal memory

```text
~/.dsh/.agent-presets/chat/
├── preset.yml           name: 聊天
└── agent.cordis.yml     persona (complete: true) + dsh-memory (personalOnly: true)
```

`personalOnly: true` makes the personal archive the whole bank for that mount:

- a plain `save` lands in the archive instead of inventing a project from the
  process working directory;
- `read` / `recall` / `list` search the archive only, so a folder-specific note
  can never surface here;
- the injected block is the archive alone — no project heading, because there is
  no project;
- and a personal note saved here **does** appear in every project session, which
  is what makes it account-level rather than local.

There are no file, shell, search or delegation tools: the model arrives with
memory and nothing else, so it cannot pretend to see a repository it has no
access to.

### `chat-lite` — memory plus nothing project-shaped

```text
~/.dsh/.agent-presets/chat-lite/
├── preset.yml           name: 独立对话
└── agent.cordis.yml     persona (complete: true) + dsh-memory
```

Same shape, but the memory mount spans both banks. Useful when you want a
conversation that is aware of the current folder's memory without carrying the
coding toolset.

### `chat-empty` — nothing attached

```text
~/.dsh/.agent-presets/chat-empty/
├── preset.yml           name: 空白对话
└── agent.cordis.yml     persona (complete: true)
```

One row: the persona. No tools, no memory, nothing from any project. Choose it
when you want a conversation with nothing leaking in either direction.

### How the isolation works

In every one of these, `complete: true` makes the persona the **entire** system
prompt, so the global identity and tool guidance contribute nothing. A preset's
tool registrations also land in the preset's own scope layer, and an agent joins
that layer by scope parentage — so nothing from the standard composition is
inherited.

`~/.dsh/.agent-presets` is the user's own preset directory, re-scanned on every
read, so a new or edited preset is picked up without restarting DSH.

---

## Storage layout

```text
$DSH_HOME/storages/dsh-memory/
├── projects.json                    registry: project id → bound folders
├── state/host-active.json           activation marker (see below)
├── state/agent-status.json          latest self-check result, readable remotely
├── state/supervisor-heartbeat.json  external supervisor heartbeat
└── projects/<projectId>/
    ├── project.json                 project metadata
    ├── core.md                      the always-in-context core note
    ├── index.md                     generated index, one line per entry
    ├── memories/<type>-<slug>.md     one file per memory
    ├── imports/<timestamp>/         staged imports plus an audit trail
    └── exports/<timestamp>/         written export bundles
```

One memory is YAML frontmatter plus a Markdown body:

```markdown
---
id: "project-uses-pnpm"
name: "This project uses pnpm"
description: "package manager convention"
type: "project"
scope: "project"
tags: ["tooling"]
created: "2026-09-30T00:16:00.000Z"
updated: "2026-09-30T00:16:00.000Z"
modified: "2026-09-30T00:16:00.000Z"
pinned: false
---

This repository uses pnpm; `npm install` is not allowed. The lockfile is
pnpm-lock.yaml.
```

`modified` is written alongside `updated` because that is the field name the
first-party per-memory markdown format uses, which keeps these files readable by
that tooling. The four `type` values follow the same precedent.

Writes are **atomic** (temp file plus rename) with retries and a fallback for
Windows sharing violations — without that, a background refresh reading
`core.md` while a write arrives produces `EPERM`.

---

## Import and export

### Export

```text
/memory export
```

Writes three things under `exports/<timestamp>/`:

- a **file-per-memory copy** of the whole bank (`memories/` plus `core.md`),
  portable and diffable;
- `<timestamp>.memory.json` — a single self-describing bundle with a
  `format` / `version` envelope;
- `<timestamp>.memory.md` — a digest a person or a model can read.

Export is **pure serialization with no model in the loop**, so nothing is
paraphrased and no field is dropped along the way.

### Import

```text
/memory import <path>        # curator conversation (recommended)
/memory import-now <path>    # merge directly, no conversation
```

`import` stages first and reviews second:

- the original bytes and the parse land in `imports/<timestamp>/` (`import.json`
  machine-readable, `import.md` human-readable);
- an **isolated conversation** is opened with explicit curation instructions:
  de-duplicate, merge into what exists, reject credentials and personal
  identifiers, drop chatter and stale task state, and rewrite fragments into
  self-contained facts;
- that conversation is a **real session in the sidebar**, so you can watch what
  it did and keep talking to it.

Imported content therefore never silently becomes authoritative, and a failed
import cannot damage the bank — the staging area is the audit trail.

Duplicates are detected by a `name + normalized body` fingerprint and counted.

---

## Install

The plugin mounts through DSH's bundle patch layer; no DSH source is modified.

```bash
dsh plugin --profile desktop add link:E:/DSH-Memory
```

Then restart DSH.

```json
{
  "name": "dsh-memory",
  "type": "module",
  "main": "lib/host/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: memory
      name: dsh-memory
```

**The plugin set is fixed at DSH startup.** Changes to `package.json`,
`cordis.patch.yml` or host-side code need a restart; only client bundle content
reloads without one. A user preset under `~/.dsh/.agent-presets` is the
exception — presets are re-scanned on every read.

### Uninstall

```bash
dsh plugin --profile desktop remove dsh-memory
```

Then restart. The bank stays at `$DSH_HOME/storages/dsh-memory/`.

### Checking it loaded

`apply()` writes a marker, so activation can be confirmed from outside the
process rather than guessed at:

```bash
cat ~/.dsh/storages/dsh-memory/state/host-active.json
```

```json
{ "plugin": "memory", "activatedAt": "2026-09-29T16:15:40.918Z", "pid": 40608 }
```

The loader's own view works too: `plugin_manager list_plugins` should show
`include:memory` with `fiberPhase: "active"`.

---

## Keeping it running without supervision

Host-side changes only load at startup, and a restart cannot be driven from
inside a session — force-stopping from within pops a confirmation dialog that
nobody may be there to click. So the restart mechanism lives **outside** DSH.

`tools/supervisor.mjs` is that external program. It does one narrow thing: **if
DSH is not running, it opens it.** It never closes anything, so no dialog is ever
involved. It is registered in the Startup folder and:

- polls every 8 seconds;
- waits 15 seconds after the app disappears before relaunching;
- caps relaunches at 5 per run, so a crash loop stops instead of spinning;
- writes `state/supervisor-heartbeat.json` so its own liveness is checkable.

A scheduled task (`DSH-Memory-Watchdog`) runs the same idea on a 5-minute cadence
as a second line of defence.

Together these mean: close DSH normally whenever you like, and it comes back on
its own with the new code loaded.

---

## Development notes

Real failures, already fixed in the code, kept here because each one is easy to
reintroduce.

### A `Config` export must be a Standard Schema

The Cordis loader validates a plugin's `Config` before calling `apply()`:

```js
const result = runtime.Config['~standard'].validate(config)
```

A plain object throws `TypeError: Cannot read properties of undefined (reading
'validate')`, the fiber becomes permanently `failed`, and the only report is a
vague `failed to import`. 150 of DSH's 194 bundled plugins export no `Config` at
all — it is optional. Configure through `config:` in the patch and merge defaults
in your own `apply()`.

### A prompt section name must be unique per scope

A duplicate name aborts **session creation** with `prompt section "..." is
already registered`, not merely dropping the block. A fixed section name
therefore breaks the second agent that ever exists. Registration here is keyed by
project id, and the live registry is consulted before registering, because the
same plugin body can be mounted more than once in one process (the host
composition plus a preset) and each instance has its own module state.

### Do not import `@deepseek-ai/*` from a linked plugin

A plugin mounted through `link:` resolves to its real path, and Node then cannot
find DSH's own packages from there (`ERR_MODULE_NOT_FOUND`). This plugin has zero
runtime dependencies: tool definitions are compiled from the authoring spec by
`lib/host/schema.js`.

### Windows atomic writes hit sharing violations

`fs.rename` cannot replace a destination another handle holds open for reading,
which happens in ordinary operation: a background refresh reading `core.md` while
a write arrives. Retries plus a copy fallback, with a concurrency stress test.

### A time-based prompt cache serves stale context

A short TTL meant a memory saved mid-turn could be missing from the very next
step. Freshness is change-driven instead.

### Test against the real service, not a stub

The duplicate-section bug shipped because the test used a fake `systemPrompt`
that pushed into an array and could not detect a duplicate. `prompt-section.test.mjs`
mounts the real service and creates several agents.

---

## Layout

```text
lib/host/
├── index.js             plugin body: tools, commands, per-session prompt section
├── store.js             the bank: project resolution, atomic writes, index, ranking
├── tools.js             the `memory` and `memory_context` tools
├── transfer.js          import/export formats, ZIP reader, staging, merging
├── claude-memory.js     the four Claude export shapes
├── anthropic-compat.js  the /memories verb surface
├── import-tool.js       conversational import
├── chat.js              the import curator conversation
└── schema.js            local tool schema compiler (replaces a dependency)

chat-plugin/             dsh-chat: standalone side conversations (`/chat`)

tools/
├── supervisor.mjs       external program: opens DSH when it is not running
├── watchdog.mjs         scheduled-task fallback, same policy
├── restart-driver.mjs   detached relaunch helper
├── verify-after-restart.mjs  post-restart evidence
└── status.mjs           writes the remotely readable status panel

test/                    nine suites, 73 cases
docs/                    DSH plugin architecture reference
research/                prior-art survey plus downloaded sources (not published)
```

Run everything:

```bash
node --test test/*.test.mjs
CLAUDE_EXPORT_DIR=/path/to/claude/export node --test test/claude-memory.test.mjs
node test/activate.mjs          # activation against the real cordis runtime
```

---

## Prior art

Findings from the prior-art survey:

- **Anthropic publishes no JSON interchange format.** The memory tool is plain
  text files under `/memories`; claude.ai import is pasted prose processed by a
  model; Claude Code has no memory import or export at all. A durable
  interchange format is therefore unclaimed ground — the bundle here is new
  rather than a copy.
- **The file layout does follow first-party precedent**: Claude Code's
  auto-memory uses an index file (one line per memory, loaded in full) plus one
  markdown file per memory, with a `type` in `user|feedback|project|reference`
  and a `modified` timestamp, under a 200-line / 25 KB budget. That layout is
  adopted here instead of invented.
- **The recurring failure across prior art is silent data loss** — importers that
  keep 7 of 20 fields, exporters that truncate at 10,000 records, exports that
  omit whole record classes. So export here is pure serialization with no model
  involved, and staging keeps the original bytes.

---

## License

MIT — see [LICENSE](LICENSE).
