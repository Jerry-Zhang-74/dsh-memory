# DSH (DeepSeek Harness) Plugin/Extension Architecture — Verified Reference

**Research method:** read-only. No existing file was modified. This one document is the only file created.

## Source-of-truth correction (read this first)

The task named this checkout:

```
C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\
```

**That path does not exist as a directory.** `app.asar` is a packed Electron archive *file*; the
`dsh\` folder under it is not browsable. `app.asar.unpacked\dsh\` exists but contains only
`node_modules` with native binaries (`node-pty`, `sharp`, `sherpa-onnx`, `libreoffice-kit`, …) —
no plugin source, no `.d.ts`.

The readable implementation used for this document is the **globally installed npm package** that
the desktop app and every profile actually link against:

```
C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\           ← the dsh CLI (apps/cli)
C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\   ← 196 packages
```

Proof that this is the live tree: every `~/.dsh/profiles/node_modules/@deepseek-ai/*` symlink resolves there, e.g.

```
dsh-tools -> C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools
```

| Fact | Value |
|---|---|
| `@deepseek-ai/dsh` CLI version | `0.1.1-rc.2` |
| `@deepseek-ai/cordis` version | `4.0.2` |
| Desktop app version | `0.2.0-rc.2` (runtime.json) |
| DSH home | `C:\Users\<user>\.dsh` |
| Bundled runtime | node `24.21.0`, pnpm `11.7.0`, python `3.12.14` |

Throughout, `PKGS` = `C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`.

Every package ships `lib/*.js` (compiled ESM) + `lib/types/*.d.ts` + a substantial `README.md`. **The
READMEs are the real plugin-authoring documentation.**

---

## 1. Plugin-authoring documentation and skills

### 1a. The plugin-development skill (the primary authoring guide)

**File read:** `PKGS\dsh\config\agent-presets\cordis\skills\cordis-plugin-development\SKILL.md` (20,923 bytes)

This is a first-class skill that ships inside the `cordis` agent preset. Frontmatter:

```markdown
---
name: cordis-plugin-development
description: Create, modify, debug, or extend dynamic Cordis Plugins, including Host Services and Events, Client Slot and theme UI, Package-private Client-to-Host calls, dynamic Tools, version updates, approval failures, and runtime diagnostics. Use this Skill to route a user request to the correct platform and Inspect Provider, then define, run, repair, or roll back the Plugin.
---
```

Its platform-selection table (verbatim):

```markdown
| Requirement | Preferred platform | Inspect first |
| --- | --- | --- |
| Files, commands, processes, or networking | Host | `fs`, `bash`, `subprocess`, `pty`, and `web` in `Service.listService` |
| Agents, durable Session data, or Host lifecycle | Host | The relevant Service and `Event.listEvents` |
| Register a dynamic Tool callable in the next model step | Host | `harness` in `Builtin.listBuiltins`, plus `Tool.listTools` |
| Page theme, layout, or current page state | Client | `Theme.listTokens` and Client `Service.listService` |
| Conversation Snapshot or session/workspace lists | Client | The target Slot's standard props and owner props |
| Settings pages, sidebars, input areas, overlays, or Tool cards | Client | `Slots.listSubTree` |
| Fetch on Host and display on Client | Both | Host Service + `harness.handle`; Client Slot + `host.call` |
```

Its settings-page guidance (verbatim):

```markdown
A full settings UI should usually register its own section through `settings.section` to obtain a complete content area. `settings.general.item` is only appropriate for one compact, general-purpose preference.
```

⚠️ **Scope caveat:** this SKILL.md (and `PKG\dsh-tool-cordis\lib\types\prompt.d.ts`, which embeds
`CORDIS_SYSTEM_PROMPT`) documents **dynamic** Cordis plugins — code the model defines at runtime into
a `node:vm` realm via `cordis_define` / `cordis_run`. Dynamic plugins do **not** use `inject` arrays
the same way, cannot use `import`/JSX, and are process-local. The *static* plugin contract (a package
on disk loaded by the Cordis Loader) is documented in §2/§3. The **capability navigation** in this
skill transfers; the code-execution rules do not.

### 1b. The composition skill

**File read:** `PKGS\dsh\config\agent-presets\cordis\skills\editing-cordis-compositions\SKILL.md` (14,414 bytes) — exists; covers editing `cordis.yml`/`cordis.patch.yml` trees.

### 1c. Per-package READMEs (the real API docs)

**Files read (selection):** `PKGS\dsh-tools\README.md` (33,757 B), `PKGS\dsh-commands\README.md`,
`PKGS\dsh-system-prompt\README.md`, `PKGS\dsh-client-modules\README.md`, `PKGS\dsh-client-hmr\README.md`,
`PKGS\dsh-fs\README.md`, `PKGS\dsh-client-ui-deliverables\README.md`, `PKGS\dsh-agent-tool-presentation\README.md`.

There is no `docs/` directory in the installed packages (the source repo's `docs/` and `.agents/notes/`
are not published); the READMEs are the substitute and they are detailed.

> **So what this means for a plugin author:** start from
> `PKGS\dsh\config\agent-presets\cordis\skills\cordis-plugin-development\SKILL.md` for capability
> navigation, then read the README of every service you touch. Do not treat the dynamic-plugin
> prompt as the static plugin contract.

---

## 2. The plugin object contract (`name`, `Config`, `apply`, `inject`, `reusable`, `dsh.client`)

### 2a. Cordis `Plugin` — the exported object shape

**File read:** `PKGS\cordis\lib\types\registry.d.ts` (lines 47–93)

```ts
/** Supported plugin entrypoint shapes. */
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>;
/** Types associated with plugin entrypoints and runtime records. */
export declare namespace Plugin {
    /** Shared metadata understood by the plugin registry and related tooling. */
    interface Base<T = any> {
        /** Display name used for fiber diagnostics and logger names. */
        name?: string;
        /** Standard-schema validator applied to config before the plugin starts. */
        Config?: StandardSchemaV1<any, T>;
        /** Services the plugin requires; it only loads while all are available. */
        inject?: Inject;
        /** Service name(s) the plugin provides (read by `Service` and by loaders). */
        provide?: string | string[];
        /** Service names whose intercept config the plugin declares it consumes. */
        intercept?: Dict<boolean>;
    }
    interface Transform<S, T> {
        /** Marks the transform object as a schema/config transform. */
        schema?: true;
        /** Convert user-facing config to runtime config. */
        Config: (config: S) => T;
    }
    /** Function plugin called with `(ctx, config)`. */
    interface Function<T = any> extends Base<T> {
        (ctx: Context, config: T): any;
    }
    /** Class plugin constructed with `(ctx, config)`. */
    interface Constructor<T = any> extends Base<T> {
        new (ctx: Context, config: T): any;
    }
    /** Object plugin with an `apply(ctx, config)` method. */
    interface Object<T = any> extends Base<T> {
        apply(ctx: Context, config: T): any;
    }
```

And the injection declaration (lines 13–15):

```ts
export type Inject<M = Dict> = (keyof M)[] | {
    [K in M]: M[K];
};
```

(actual: `{ [K in keyof M]?: M[K]; }`)

`Config` is a **Standard Schema** validator (`@standard-schema/spec`), and the shipped idiom is
`@deepseek-ai/schemastery` imported as `z`.

**Real Config usage — file read:** `PKGS\dsh-fs-local\lib\index.js` (lines 674–678)

```js
var LocalFileSystem = class extends FileSystem {
	static Config = z.object({
		cwd: z.string().default(process.cwd()),
		diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES)
	});
```

with `import z from "@deepseek-ai/schemastery";` at line 4.

**Real exported plugin body — file read:** `PKGS\dsh-client-ui-theme\lib\index.js` (lines 70–79)

```js
function apply(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema);
	});
	ctx.on("webserver/index-inject", (table) => {
		table.push(bootThemeInjection(readPreference(ctx)));
	});
}
//#endregion
export { DEFAULT_PREFERENCE, THEME_PREFERENCES, THEME_PREFERENCE_FIELD, THEME_SETTINGS_NAMESPACE, apply };
```

Note: **`name` is optional** and this package omits it; only `apply` is exported. It reaches
optional services with `ctx.inject([...], cb)`, which is a scoped child plugin — the "optional
dependency" idiom that avoids declaring `inject` and entering `waiting`.

**Real minimal client-side host half — file read:** `PKGS\dsh-client-ui-goal\lib\index.js` (whole file, 11 lines)

```js
/**
* Goal surface plugin, node half. Pure UI plugin: the empty apply exists so
* the plugin appears in the host cordis.yml / Loader; the browser half
* ships via exports["./client"], discovered through the package.json
* dsh.client declaration.
*/
/** Host plugin body — no host-side behavior for this surface plugin. */
function apply() {}
//#endregion
export { apply };
```

### 2b. `reusable` — DOES NOT EXIST

```
grep 'reusable' over PKGS\cordis\**  → No matches found
grep -i 'reusable' over all *.d.ts   → only unrelated prose in dsh-client-runtime / dsh-file-reference / etc.
```

`reusable` is **not** part of Cordis 4.0.2's plugin metadata. Do not emit it. If you saw it in a
newer Cordis or a DSH design note, it is not in this runtime. The available metadata is exactly
`name`, `Config`, `inject`, `provide`, `intercept`.

### 2c. `dsh.client` — the client-half declaration

**File read:** `PKGS\dsh-client-modules\lib\index.js` (lines 119–146)

```js
/** Narrow an unknown parsed JSON value to the `dsh.client` declaration, throwing on malformed fields. */
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
	return {
		platform: decl.platform,
		...inject !== void 0 ? { inject } : {},
		...external !== void 0 ? { external } : {},
		...decl.immediately !== void 0 ? { immediately: decl.immediately } : {}
	};
}
/** Resolve `exports["./client"]` to a relative path, accepting the string and one-level conditional forms. */
function clientExportOf(pkgName, exportsField) {
	if (typeof exportsField !== "object" || exportsField === null) return void 0;
	const client = exportsField["./client"];
	if (client === void 0) return void 0;
	if (typeof client === "string") return client;
	if (typeof client === "object" && client !== null) {
		const fallback = client.default;
		if (typeof fallback === "string") return fallback;
	}
	throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
}
```

**Real declaration — file read:** `PKGS\dsh-client-ui-goal\package.json`

```json
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation"
      ],
      "platform": "web"
    }
  },
```

`dsh.client` fields: `platform` (required string, must be `"web"` to qualify), `inject?` (string[]),
`external?` (string[]), `immediately?` (boolean). `PKGS\dsh-client-ui-theme\package.json` shows
`"immediately": true`.

> **So what this means for a plugin author:** a plugin package can be dual-face. The Host half is the
> package's `"main"`/`exports["."]` module (a normal Cordis plugin object with `apply`); the Client
> half is a **separate built bundle** declared by `exports["./client"]` plus `dsh.client.platform`.
> `reusable` is not a thing in this version.

---

## 3. The `dsh` CLI: how plugins get loaded, and how to add a local one

### 3a. Entry modes

**File read:** `PKGS\dsh\README.md` (lines 9–16)

```markdown
| Command | Purpose |
|---|---|
| `dsh --profile <name>` | Boot the named profile under `$DSH_HOME/profiles/<name>`. |
| `dsh --profile headless "job"` | Run one fresh persisted session, print the final answer, and exit. |
| `dsh web` | Alias of `--profile web`. |
| `dsh plugin --profile <name> <pnpm args>` | Manage a profile's plugins by forwarding to pnpm in the profile directory. |
```

### 3b. The Loader entry contract (the "entry id" question)

**File read:** `PKGS\cordis-plugin-loader\README.md` (lines 25–46)

```markdown
| Field | Description |
| --- | --- |
| `id` | Stable id for resolving, updating, and removing the entry. |
| `name` | Module specifier imported by the loader. |
| `config` | Config passed to the plugin. |
| `group` | Marks the entry as a group whose `config` is a child entry list. |
| `disabled` | Stops the entry and prevents it from starting. |
| `inject` | Adds required services or intercept config for this entry. |
```

**File read:** `PKGS\cordis-plugin-include\README.md` (lines 25–32) — the YAML form:

```yaml
- id: timer
  name: '@cordisjs/plugin-timer'
- id: app
  name: ./plugins/app
  config:
    message: hello
```

> **`id`** is the patch address used by `cordis.patch.yml` overrides. **`name`** is the module
> specifier Node imports *and* the identity the client module system keys on (see §8). They are
> different keys with different jobs.

### 3c. Profile layout and composition order

**File read:** `PKGS\dsh\README.md` (lines 32–43)

```markdown
A profile directory holds a `package.json` (out-of-tree plugin dependencies plus the profile manifest `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml` (the user's own patch layer).

The tree composes over an empty root:
- each bundle's patch in `dsh.profile.bundles` order
- then the profile's `cordis.patch.yml`, then the home-level `$DSH_HOME/cordis.patch.yml`
- then `--patch` overlays

Bundles named in `dsh.profile.bundles` resolve from the dsh installation first (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`), then from the profile's own `node_modules`, where pnpm installs out-of-tree plugins.
```

**File read:** `PKGS\dsh-app-boot\lib\types\profile.d.ts` (lines 30–56)
```ts
/** The bundle half of the `dsh` manifest section: what a bundle package exports. */
export interface DshBundleManifest {
    /** The patch layer this bundle exports, relative to its package root. */
    patch: string;
}
/** The profile half of the `dsh` manifest section: what a profile directory composes. */
export interface DshProfileManifest {
    /** Ordered bundle layer list (package names). */
    bundles?: string[];
}
/**
 * The profile-launcher slice of the `dsh`-owned package.json section. A
 * manifest may declare both roles; other consumers own additional keys.
 */
export interface DshManifestSection {
    /** Bundle metadata consumed by the profile launcher. */
    bundle?: DshBundleManifest;
    /** Profile metadata consumed by the profile launcher. */
    profile?: DshProfileManifest;
}
```

**Real files on this machine — read:** `C:\Users\<user>\.dsh\profiles\desktop\package.json`

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-whale-widget": "link:C:/Users/<user>/.dsh/plugins/DeepSeek-Balance-Whale-Widget-main",
    "dsh-mobile": "0.4.7",
    "whale-desktop-bridge": "link:C:/Users/<user>/.dsh/plugins/whale-desktop-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-whale-widget",
        "whale-desktop-bridge",
        "dsh-mobile",
        "@deepseek-ai/dsh-experimental-auto-review"
      ]
    }
  }
}
```

`C:\Users\<user>\.dsh\profiles\desktop\cordis.yml` is the empty root:

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

**The executed patch-layer precedence — file read:** `PKGS\dsh\lib\profile-boot-DG5t9aNs.js`

```js
/** The full patch stack of one composed profile, in application order. */
function allPatches(composed) {
	return [
		...composed.bundlePatches,
		...composed.profile.patches,
		...composed.homePatches,
		...composed.overlays
	];
}
```

Order: every bundle's patch in `dsh.profile.bundles` order → the profile's own `cordis.patch.yml`
→ the home-level `$DSH_HOME/cordis.patch.yml` → `--patch` overlays. A plugin's row therefore mounts
*before* the user's layer, and the user layer can override or disable it.

The same file regenerates the profile root on every boot:

```js
	const profile = loadProfile(NAME, name, INSTALL_ANCHOR, void 0, { userLayer });
	writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG);
```

⚠️ **Never target `cordis.yml`** — the launcher overwrites it. Only `cordis.patch.yml` is durable.

**Patch-file shape is mechanically enforced — file read:** `PKGS\dsh-app-boot\lib\index.js`

```js
	if (!Array.isArray(parsed)) throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`);
	parsed.forEach((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${binName}: ${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`);
	});
```

So `cordis.patch.yml` must be a top-level YAML **array** whose every element is a **mapping** — which
is why a comments-only file throws while `[]` is the valid "empty/disabled" value, and why a plugin's
patch must contain at least one real entry (the `- insert:` block).

### 3d. The bundle patch file

**Real, complete, working example — read:** `C:\Users\<user>\.dsh\plugins\whale-desktop-bridge\cordis.patch.yml`

```yaml
# whale-desktop-bridge bundle patch layer.
# Mounts the bridge bundle into the cordis tree so its apply() runs.
- insert:
    - id: whale-desktop-bridge
      name: whale-desktop-bridge
```

matching `whale-desktop-bridge\package.json`:

```json
{
  "name": "whale-desktop-bridge",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

Note the three-way name agreement: package `name` = loader entry `name` = patch `id` (not strictly
required for `id`, but this is the convention).

`PKGS\dsh-base\cordis.patch.yml` (the first layer of every profile) shows the full idiom, including
`!!js` config expressions:

```yaml
- insert:
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'

    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      config:
        root: ['.']

    - id: llm
      name: '@deepseek-ai/dsh-llm'

    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
```

### 3e. Adding a locally-developed plugin to the running harness

**File read:** `PKGS\dsh\lib\plugin-9h8shc4d.js`

```js
/**
 * `dsh plugin --profile <name> <args...>` — profile plugin management as a
 * thin pnpm forwarder: initialize the profile on first use, run
 * `pnpm <args...>` in the profile directory, then reconcile the
 * `dsh.profile.bundles` layer list against the installed state (a dependency
 * resolving to a package that declares `dsh.bundle` joins the layer stack; a
 * dependency without one is left as a plain dependency).
 */
```

and the warning it emits for a non-bundle dependency:

```js
} else if (!isBundle && !beforeDeps.has(packageName)) process.stderr.write(`${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)
```

**The exact procedure:**

1. Create `<plugin-dir>\package.json` with `name`, `type: "module"`, `main: "lib/index.js"`, and
   `dsh.bundle.patch: "./cordis.patch.yml"` (if you want it to be a bundle layer).
2. Create `<plugin-dir>\cordis.patch.yml` containing `- insert: [{ id: <id>, name: <packageName> }]`.
3. Install and activate:
   ```
   dsh plugin --profile web add link:C:/absolute/path/to/<plugin-dir>
   ```
   This forwards to pnpm in `$DSH_HOME/profiles/web`, then appends `<packageName>` to
   `dsh.profile.bundles` because the manifest declares `dsh.bundle`.
   *Absolute paths are required* — pnpm runs with cwd = the profile directory, so a bare `.` or
   relative path would resolve inside the profile.
4. **Restart the profile.** The tree is composed at boot. Individual plugins can hot-reload their
   *code* (HMR), but the **set** of Loader entries is fixed per boot — and the client-module scan
   caches a negative "not a client package" verdict per package name that "never expires".
5. Verify composition without booting:
   ```
   dsh --profile web --dump-config
   dsh --profile web --dump-default-config
   ```

Alternative manual route (what the tooling does): add the dependency to the profile
`package.json`, then add the package name to `dsh.profile.bundles` by hand, or insert the row
directly in the profile's own `cordis.patch.yml`.

### 3f. Build scripts and `pnpm run dev:web`

**File read:** `PKGS\dsh-client-ui-theme\package.json`

```json
  "scripts": {
    "bundle": "tsdown",
    "watch": "tsdown --watch"
  }
```

**File read:** `PKGS\dsh-client-hmr\README.md` (line 5 and 7)

```markdown
Hot reload for script-loaded client plugins. The web bundle mounts the row unconditionally; without a rebuild watcher (`pnpm run dev:web`) rewriting client bundles, the poll observes no changes and the chain stays idle.
```

```markdown
The node half detects rebuilds with one interval that stat-polls each graph bundle from a synchronous baseline, immediately re-hashes after adding a row, retains missing rows as dirty, and broadcasts only real rev changes; any tsdown watch process producing the bundle therefore triggers HMR with no builder→host channel.
```

**File read:** `PKGS\dsh-web-app\cordis.patch.yml` (lines 146–151)

```yaml
    # The client-plugin reload chain, always mounted: it is idle until a
    # rebuild watcher (pnpm run dev:web) actually rewrites client bundles. It
    # is a row rather than a child of web-runtime because its node half is a
    # client-side package, which a host-side bundle cannot import.
    - id: client-hmr
      name: '@deepseek-ai/dsh-client-hmr'
```

> **So what this means for a plugin author:** `pnpm run dev:web` is a **monorepo-level script of the
> DSH source repository**, not of the installed product. It runs the per-package `tsdown --watch`
> that rebuilds client bundles. For a **local out-of-tree plugin** there is no such script — you run
> your own `tsdown --watch` (or any bundler producing the `__ModuleLoader__` format from §8), and
> `dsh-client-hmr` picks up the changed file by content hash: bundle *content* changes hot-reload,
> plugin *set* changes require a restart.

---

## 4. The Tool contract — `ctx.tools.register(...)`

**File read:** `PKGS\dsh-tools\lib\types\index.d.ts` (lines 96–172) — `ToolDefinition` in full

```ts
/** Tool-owned canonical output contract used after the body returns a JSON value. */
export interface ToolOutputDefinition {
    /** Raw supported JSON Schema enforced against every successful canonical value. */
    readonly schema: JsonSchemaNode;
    /** Pure projection from validated arguments and value to Native/model content. */
    render(args: unknown, value: JsonValue): ContentBlock[];
    /** Pure replayable presentation projection, computed only for top-level calls. */
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
/** A registered tool: its schema plus the execution function. */
export interface ToolDefinition extends ToolSchema {
    /** Mandatory canonical output declaration. */
    readonly output: ToolOutputDefinition;
    /**
     * Run one accepted call and return only its canonical lossless-JSON value.
     * @param args - losslessly snapshotted, frozen model arguments.
     * @param exec - execution identity, cancellation signal, and context deferral.
     * @returns the canonical value declared by `output.schema`.
     */
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
```

(JSDoc bodies elided above for length; every declaration is verbatim. `finalizeContent`,
`timeoutMs`, `isConcurrencySafe`, `presentCall`, `presentResult` are all optional.)

`ToolSchema` is imported from `dsh-llm` — **file read:** `PKGS\dsh-llm\lib\types\types.d.ts` (lines 318–330)

```ts
/**
 * JSON-schema description of a tool, as sent to the model.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
export interface ToolSchema {
    name: string;
    description: string;
    /** JSON Schema object for the arguments. */
    parameters: Record<string, unknown>;
}
```

**Content blocks — file read:** `PKGS\dsh-llm\lib\types\types.d.ts` (lines 38–89)

```ts
/** Plain text visible to the end user. */
export interface TextBlock {
    type: 'text';
    text: string;
}
/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
    type: 'reasoning';
    text: string;
}
export interface ImageBlock {
    type: 'image';
    /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
    attachment: ImageAttachmentRef;
}
/** A tool invocation requested by the model. */
export interface ToolCallBlock {
    type: 'tool-call';
    id: CallId;
    name: string;
    arguments: string;
}
/** The result of a tool invocation, sent back to the model. */
export interface ToolResultBlock {
    type: 'tool-result';
    toolCallId: CallId;
    content: ContentBlock[];
    isError?: boolean;
}
export interface ContentBlockMap {
    'text': TextBlock;
    'reasoning': ReasoningBlock;
    'image': ImageBlock;
    'tool-call': ToolCallBlock;
    'tool-result': ToolResultBlock;
}
export type ContentBlockType = keyof ContentBlockMap;
export type ContentBlock = ContentBlockMap[ContentBlockType];
```

### 4a. The register method and scoping/restriction

**File read:** `PKGS\dsh-tools\lib\types\index.d.ts` (lines 493–622, declarations verbatim)

```ts
export declare class ToolRuntime extends Service {
    static inject: string[];
    static Config: z<Config>;
    /**
     * Register globally or in the calling agent scope. Scoped tools shadow
     * globals; duplicates within one layer and the reserved `run_code` name fail.
     * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
     * @returns the exact disposer that unregisters the tool.
     */
    register(definition: ToolDefinition): () => void;
    /**
     * Restrict global tools for the calling agent scope. ...
     * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
     * @returns the exact disposer that lifts this restriction.
     */
    restrict(filter: ToolRestriction): () => void;
    /**
     * Register a monotonic guard after the extensible `tools/pre-execute`
     * waterfall. A plain-context guard applies globally; one registered through
     * `agent.ctx` applies only to that agent. ...
     * @param guard - synchronous check; a returned string denies the execution.
     * @returns the exact disposer that unregisters the guard.
     */
    guard(guard: ToolGuard): () => void;
    get(name: string, scope?: ScopeKey): ToolDefinition | undefined;
    schemas(scope?: ScopeKey): ToolSchema[];
    executionMode(exec: ToolExecutionInput): ToolExecutionMode;
}
```

```ts
/**
 * Per-scope filter over global tools. Restrictions intersect and do not affect
 * scoped registrations or the reserved Code Mode transport.
 */
export interface ToolRestriction {
    /** Global tool names that stay visible; everything else is removed. */
    readonly allow?: readonly string[];
    /** Global tool names removed from visibility. */
    readonly deny?: readonly string[];
}
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged.
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
```

**Yes — tools can be scoped and disabled.** Registering from a child of `agent.ctx` scopes the tool
to that agent (shadowing a global of the same name); `restrict({deny:[...]})` masks global tools for
a scope; both return the exact Cordis effect disposer.

### 4b. The execution context handed to `execute`

**File read:** `PKGS\dsh-tools\lib\types\index.d.ts` (lines 196–300, declarations verbatim)

```ts
export interface ToolExecutionInput {
    readonly callId: CallId;
    readonly rootCallId?: CallId;
    readonly name: string;
    /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
    readonly arguments: unknown;
    /** The agent on whose behalf the call runs (set by the agent loop). */
    readonly agent?: Agent;
    readonly parent?: ToolExecutionToken;
    /** Required caller-owned cancellation for this invocation. */
    readonly signal: AbortSignal;
}
export interface ToolExecution extends ToolExecutionInput {
    readonly rootCallId: CallId;
    readonly token: ToolExecutionToken;
}
export interface ToolRunContext extends ToolExecution {
    /**
     * Defer one context — typically a nested-dispatch context ferried by a
     * composite tool, or a fresh plugin-sourced instruction — until this tool's
     * final result reaches the agent loop. ...
     */
    deferContext(context: UserMessage): void;
    /**
     * Mark a successful final result as terminal for the current agent turn.
     */
    concludeTurn(): void;
}
```

### 4c. `defineTool` — the typed authoring helper

**File read:** `PKGS\dsh-tools\lib\types\schema.d.ts` (lines 177–239)

```ts
/** Options for {@link defineTool}. */
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    /** Tool name (must be unique). */
    readonly name: string;
    /** Human-readable description sent to the model. */
    readonly description: string;
    /** Per-property parameter schema compiled to an implicit open object root. */
    readonly parameters: S;
    /** Canonical output schema plus pure Native and presentation projections. */
    readonly output: {
        /** Schema enforced against every successful body or policy-replaced value. */
        readonly schema: O;
        /** Pure Native/model rendering of one validated canonical value. */
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        /** Pure replayable presentation metadata for direct top-level calls. */
        presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue;
    };
    readonly timeoutMs?: number;
    isConcurrencySafe?(args: InferArgs<S>): boolean;
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    presentCall?(args: InferArgs<S>): ToolCallView | undefined;
    presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined;
}
/**
 * Define a first-party tool with inferred arguments and strict execution
 * validation. ...
 */
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
```

**The parameter-schema DSL — file read:** `PKGS\dsh-tools\lib\types\schema.d.ts` (lines 19–88)

```ts
/** String value schema with type-correct literal constraints. */
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'string';
    enum?: readonly string[];
    const?: string;
}
export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'number';
    enum?: readonly number[];
    const?: number;
}
export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'boolean';
    ...
}
export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'array';
    items?: ValueSchemaSpec;
}
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'object';
    properties?: ParameterSchemaSpec;
    additionalProperties: boolean;
}
/** Author-only unconstrained lossless JSON node. */
export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'json';
}
/** Exact-one union schema; at least two branches are required. */
export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
    oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]];
}
export type ValueSchemaSpec = StringValueSchemaSpec | NumberValueSchemaSpec | IntegerValueSchemaSpec | BooleanValueSchemaSpec | NullValueSchemaSpec | ArrayValueSchemaSpec | ObjectValueSchemaSpec | JsonValueSchemaSpec | OneOfValueSchemaSpec;
/** One implicit parameter-root property, optionally required. */
export type ParameterPropertySpec = ValueSchemaSpec & {
    required?: true;
};
/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
export type ParameterSchemaSpec = {
    [key: string]: ParameterPropertySpec;
    [key: symbol]: never;
};
```

### 4d. A complete, real registration

**File read:** `PKGS\dsh-tool-goal\lib\index.js` (lines 251–295)

```js
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	ctx.systemPrompt.section({
		name: "tool:goal",
		order: 114,
		text: guidance(resolved.blockedAfterConsecutiveRounds)
	});
	ctx.tools.register(defineTool({
		name: "get_goal",
		description: GET_DESCRIPTION,
		parameters: {},
		output: GOAL_OUTPUT,
		execute(_args, exec) {
			const execution = goalToolExecution(ctx, exec);
			return Promise.resolve(goalValue(ctx.goals.get(execution.agent)));
		},
		presentCall: () => present("Read current goal", "read")
	}));
	ctx.tools.register(defineTool({
		name: "create_goal",
		description: CREATE_DESCRIPTION,
		parameters: {
			objective: {
				type: "string",
				required: true,
				description: "The concrete completion objective inferred from the direct human request."
			},
			max_goal_rounds: {
				type: "number",
				description: "Optional positive safe-integer limit for automatic continuation rounds."
			}
		},
		output: GOAL_OUTPUT,
		execute(args, exec) {
			const execution = goalToolExecution(ctx, exec);
			requireDirectHuman(ctx, execution);
			const goal = ctx.goals.create(execution.agent, {
				objective: args.objective,
				...args.max_goal_rounds === void 0 ? {} : { maxGoalRounds: args.max_goal_rounds }
			});
			return Promise.resolve(goalValue(goal));
		},
		presentCall: (args) => present("Create goal", "other", args.objective)
	}));
```

Note the **separation of concerns**: `execute` returns a *canonical JSON value* (here `goalValue(...)`);
`output.schema` validates it; `output.render` projects it to model-facing `ContentBlock[]`;
`presentCall`/`presentResult` are pure, replayable UI intents.

### 4e. Errors

**File read:** `PKGS\dsh-tools\lib\types\index.d.ts` (lines 356–411)

```ts
export interface ToolErrorInfo { ... }
export interface ToolFailure { ... }
export declare class ToolNotFoundError extends HarnessError { ... }
export declare class ToolOutputError extends HarnessError { ... }
export interface ToolExecutionSuccess { ... }
export interface ToolExecutionFailure { ... }
export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure;
```

A tool surfaces an error by **throwing** from `execute`; the registry normalizes it into a failure
result. `ToolOutputError` is thrown for you when the returned value violates `output.schema`.

> **So what this means for a plugin author:** use `defineTool({name, description, parameters, output,
> execute})`. `parameters` is DSH's own property-map DSL (not raw JSON Schema), `required: true` is
> a per-property annotation, and `output` is **mandatory** — you must declare the canonical value
> shape and how to render it. Throwing from `execute` is how you fail a call.

---

## 5. The Host command contract — `ctx.commands.register(...)`

### 5a. `CommandDefinition` and friends

**File read:** `PKGS\dsh-commands\lib\types\index.d.ts` (lines 15–50, 69–100)

```ts
/** Invocation passed to one registered command handler. */
export interface CommandInvocation {
    /** Pairing id already written to this invocation's `command/run` event. */
    readonly commandId: CommandId;
    /** Exact agent whose UI received the command. */
    readonly agent: Agent;
    /** Exact text following the registered command name, including separator whitespace. */
    readonly rawInput: string;
    /**
     * Durably admitted image blocks accompanying this invocation, in submission
     * order; empty unless the definition declares `input.images`. ...
     */
    readonly attachments: readonly ImageBlock[];
    /** Cancellation signal owned by the dispatching UI request. */
    readonly signal: AbortSignal;
}
/** Plugin-owned command registration. */
export interface CommandDefinition {
    /** Lowercase command name without the leading slash. */
    readonly name: string;
    /** Human-readable summary used in discovery UI. */
    readonly description: string;
    /** Optional free-form input hint advertised to capable clients. */
    readonly input?: CommandInputDescriptor;
    /**
     * Whether `command/run` records `rawInput`. Defaults to true. ...
     */
    readonly recordInput?: boolean;
    /** Execute against the receiving agent without sending the command to the model. */
    readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}
/** Syntactically valid slash command before registry resolution. */
export interface ParsedCommand {
    /** Lowercase command name without the leading slash. */
    readonly name: string;
    /** Exact text following the command name. */
    readonly rawInput: string;
}
export declare function parseCommand(line: string): ParsedCommand | undefined;
export declare class CommandRuntime extends TypertRemoteService {
    register(definition: CommandDefinition): () => void;
    list(agent: Agent): readonly CommandDescriptor[];
    find(agent: Agent, name: string): CommandDefinition | undefined;
    execute(agent: Agent, line: string, images: readonly EncodedImageAttachment[], signal: AbortSignal): Promise<CommandExecution | undefined>;
}
```

### 5b. `CommandResult` / `CommandExecution` — the returned shape

**File read:** `PKGS\dsh-commands\lib\types\types.d.ts` (lines 10–53)

```ts
/** Immutable metadata for a command's optional unstructured input. */
export interface CommandInputDescriptor {
    /** Placeholder shown before the user supplies free-form input. */
    readonly hint: string;
    /**
     * Whether composer image attachments may accompany an invocation. Absent or
     * false = the executor rejects an invocation carrying images ...
     */
    readonly images?: boolean;
}
/** Expected command outcome rendered directly by the dispatching UI. */
export type CommandResult = {
    readonly kind: 'success';
    readonly text?: string;
    /** Earlier authoritative domain event that owns a richer presentation. */
    readonly sourceEventSeq?: number;
} | {
    readonly kind: 'error';
    readonly text: string;
};
/**
 * One settled command execution: the handler's normalized result plus the
 * lifecycle pairing id minted for its `command/run`/`command/done` records, ...
 */
export interface CommandExecution {
    /** Pairing id carried by this execution's lifecycle events. */
    readonly commandId: CommandId;
    /** The handler's normalized outcome. */
    readonly result: CommandResult;
}
/** Handler-free immutable command view returned to UI adapters. */
export interface CommandDescriptor {
    /** Lowercase command name without the leading slash. */
    readonly name: string;
    /** Human-readable summary used in discovery UI. */
    readonly description: string;
    /** Optional free-form input hint advertised to capable clients. */
    readonly input?: CommandInputDescriptor;
}
```

### 5c. ⚠️ `registerFileReceiptResolver` — DOES NOT EXIST

```
grep 'registerFileReceiptResolver|FileReceipt' over every *.d.ts in PKGS  → No matches found
grep 'receipt'                              over every *.d.ts in PKGS  → only RpcReceipt, SubagentPromptReceipt,
                                                                        SubagentInterruptReceipt, DynamicCordisUndefineReceipt
```

There is **no file-receipt API and no way for a command to return bytes to the browser.**
`CommandResult` carries `text` and an optional `sourceEventSeq` — nothing else. This is the single
biggest correction to the task's premises.

### 5d. How a slash command appears in the GUI

**File read:** `PKGS\dsh-client-ui-commands\README.md` (lines 5–9)

```markdown
Client command API (`ctx.commandUi`): the session-keyed command-directory cache, the `/` command source with `matchSpace`/`matchEnter` decision hooks, three-kind dispatch (`execute` / `popupSelect` / `leadingInput`), and popupSelect registration for business packages.
```

```markdown
`CommandDirectory` (`src/client/directory.ts`) is the one wire-derived cache, keyed by session. Ordinary sessions fetch through `command.list({sessionId})`, ...
```

and (line 23):

```markdown
a matched command's handler mutates host domain state that other packages project into the next request ... while the command line itself, the detached result, and every menu/notice rendering stay client-side and never enter the session log.
```

**Therefore: registering a command on the Host makes it appear in the GUI's `/` menu automatically.**
The client (`dsh-client-ui-commands`, mounted by the `dsh-web-app` bundle) calls `command.list` and
renders the menu. You write **zero** client code for a slash command. Command discovery, fuzzy
matching, and dispatch are all owned by that package. Results are rendered by the adapter directly
and *never enter model history*.

### 5e. How files actually reach the browser

Since commands cannot return files, three verified mechanisms exist:

**(i) Host HTTP route served to the browser** — the fully worked local-plugin example,
`C:\Users\<user>\.dsh\plugins\DeepSeek-Balance-Whale-Widget-main\lib\index.js` (lines 1853–1889, 2000–2014):

```js
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-whale/image.png',
      handler: (req, res) => {
        try {
          const bytes = loadImage()
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('whale image unavailable: ' + String((err && err.message) || err))
        }
      },
    }))
```

```js
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(WIDGET_JS)
      },
    }))

    disposers.push(ctx.webServer.tapIndex((html) => {
      if (html.indexOf('/dsh-whale/widget.js') !== -1) return html
      const tag = '<script defer src="/dsh-whale/widget.js"></script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    }))
```

The service is `ctx.webServer`; the route contract is documented in **`PKGS\dsh-host-webserver\README.md`** (line 5):

```markdown
`register(route)` adds a named `exact`/`prefix` HTTP route; `registerUpgrade(route)` adds an upgrade route for an exact pathname. A duplicate path within either table throws ... both methods return a disposer that removes the registration.
```

**(ii) The `present` tool + deliverables projection.** The model declares finished files; the client
renders file chips and opens them through the Host opener — **not** a browser download.
**File read:** `PKGS\dsh-client-ui-deliverables\README.md` (lines 5–9):

```markdown
`deliverablesDefinition` folds each Turn's successful mutation calls into engine-published `DeliverablesTurnData`; `producedForClosing` reads that data with the closing Assistant seq. The vocabulary is the mutation tools' own follow-along `locations`, never the closing prose ...
```

```markdown
Each chip opens through the owner-supplied `openFile` — the same Host opener the tool rows use, with the chat view resolving relative paths against the session cwd.
```

**(iii) Client bundle assets.** A `dsh.client` bundle is itself served from `/plugins/<pkg>/client.js` (§8).

> **So what this means for a plugin author:** a slash command can only return text. To hand the user
> a file, either (a) register an `exact` route on `ctx.webServer` and link it, or (b) register a
> client half that calls `ctx.remote`/`host.call` and renders a link. There is no `CommandResult`
> file field and no `registerFileReceiptResolver`.

---

## 6. Isolated child conversations from a plugin

Full detail was researched in depth; the essentials:

### 6a. `ctx.agents` — create/resume

**File read:** `PKGS\dsh-agent\lib\types\index.d.ts` (lines 58–118, 119–140, 279–296)

```ts
export interface CreateAgentOptions {
    /** The live agent/session identity. */
    readonly sessionId: SessionId;
    readonly meta?: {
        readonly cwd?: string;
        readonly parentSession?: SessionId;
        readonly seedLength?: number;
        readonly origin?: 'subagent';
        readonly delegationDepth?: number;
        readonly agentPreset?: string;
    };
    readonly seed?: readonly SessionEvent[];
    /** Per-agent options (model, …). */
    readonly agentOptions?: AgentOptions;
    readonly signal?: AbortSignal;
    readonly setup?: AgentSetup;
}
export interface ResumeAgentOptions {
    /** The persisted session id to load and use as the live agent/session identity. */
    readonly resumeSessionId: SessionId;
    readonly agentOptions?: AgentOptions;
    readonly signal?: AbortSignal;
    readonly setup?: AgentSetup;
}
```

```ts
    create(options: CreateAgentOptions): Promise<AgentHandle>;
    resume(options: ResumeAgentOptions): Promise<AgentHandle>;
```

```ts
export interface AgentHandle {
    agent: Agent;
    dispose(): Promise<void>;
}
export type AgentSetup = (agentCtx: Context) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void;
```

**Important:** `sessionId` is required, there is **no `prompt`/`message` field** — `create` returns an
**idle** agent you must drive yourself.

**Driving it — file read:** `PKGS\dsh-headless\lib\index.js` (lines 63–99)

```js
	const { agent } = await agents.create({
		sessionId: SessionId(`session-${randomUUID()}`),
		meta: { cwd: process.cwd() },
		agentOptions: {
			provider: selection.provider,
			model: selection.model
		},
		setup: (agentCtx) => {
			installModelSelection(agentCtx, {
				current: selection,
				assembled: void 0
			});
		}
	});
	await agent.whenIdle();
	const firstSeq = agent.session.seq;
	agent.followup(createUserMessage({
		content: [{
			type: "text",
			text: task
		}],
		source: { kind: "user" }
	}));
	await agent.whenIdle();
	await sessions.flush(agent.session);
	const outcome = summarize(agent.session.events, firstSeq);
	io.stdout.write(outcome.text + "\n");
```

### 6b. `ctx.subagents` — start / startContinuable / followup

**File read:** `PKGS\dsh-subagent\lib\types\types.d.ts` (lines 84–140)

```ts
export interface SubagentStartRequest {
    /** Optional short display label persisted with a session-backed child. */
    readonly label?: string;
    /** Content delivered as the child's user message. */
    readonly prompt: ContentBlock[];
    /**
     * The spawning agent. In-process providers derive workspace, lineage, and
     * delegation depth from its durable session state. ...
     */
    readonly parent: Agent;
    readonly signal: AbortSignal;
    readonly agentOptions?: AgentOptions;
    readonly outputSchema?: ObjectJsonSchema;
    readonly maxDepth?: number;
    readonly toolFilter?: ToolRestriction;
    readonly persona?: string;
}
```

```ts
export interface SubagentResult {
    /**
     * The child's final assistant output is the content of its last non-empty
     * assistant message. ...
     */
    readonly output: ContentBlock[];
    readonly structured?: unknown;
    readonly diagnostic?: string;
    /** Why the run ended. A non-`completed` reason means `output` may be partial. */
    readonly stopReason: SubagentStopReason;
}
export interface SubagentRun {
    readonly id: SessionId;
    readonly localAgent: Agent | undefined;
    readonly result: Promise<SubagentResult>;
    dispose(): Promise<void>;
}
```

**File read:** `PKGS\dsh-subagent\lib\types\index.d.ts` (lines 111–136, 260–270)

```ts
    startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
    followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
    start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
```

**File read:** `PKGS\dsh-subagent\lib\types\continuation.d.ts` (lines 79–124)

```ts
export interface ContinuableStartSpec {
    readonly provider: string;
    readonly label: string;
    readonly childId?: SessionId;
    readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>;
    readonly signal: AbortSignal;
}
export interface ContinuableStart {
    readonly childId: SessionId;
    readonly messageId: MessageId;
}
```

⚠️ **`SubagentHandle` does not exist** (0 grep matches). ⚠️ **There is no `prompt(...)` method** —
`prompt` is only a required request *field*; the follow-up method is `followup(...)`.

### 6c. The canonical await pattern

**File read:** `PKGS\dsh-tool-subagent\lib\index.js` (lines 78–99) — the exact
await-result-then-dispose shape:

```js
async function settleForegroundRun(run) {
	const [execution] = await Promise.allSettled([run.result.then((result) => {
		const error = stopReasonError(result);
		if (error !== void 0) throw new Error(withDiagnosticAndPartialText(error, result));
		return {
			kind: "foreground",
			runId: run.id,
			output: result.output
		};
	})]);
	const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
	...
}
```

and the join of text blocks (lines 39–42):

```js
function outputValueText(values) {
	return values.filter((value) => typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "text" && typeof value.text === "string").map((value) => value.text).join("");
}
```

### 6d. Recommendation for "process imported content in a fresh isolated conversation, return a summary"

**Use `ctx.subagents.start(providerName, request)` with the in-process `spawn` provider; await
`run.result`; read `result.output`; then `await run.dispose()`.**

Evidence for the isolation claim — `PKGS\dsh-subagent-spawn-in-process\lib\index.js`:

```
spawn runs each child as a fresh child Agent on the same cordis context
(its own session, own system prompt, zero parent context);  inheritsParentContext = false
```

whereas the `fork` provider sets `inheritsParentContext = true` and seeds the parent's completed-turn
prefix (`PKGS\dsh-subagent-fork-in-process\lib\index.js`). **Use `spawn`, not `fork`, for a truly
fresh context window.**

Required request fields: `prompt` (`ContentBlock[]`), `parent` (`Agent`), `signal` (`AbortSignal`).
Optional: `label`, `agentOptions` (different provider/model), `outputSchema` (validated structured
result), `maxDepth`, `toolFilter` (tool restriction in the child), `persona` (child-scoped
`deployment:persona` shadowing).

**If your plugin has no calling Agent**, bypass the seam entirely with the §6a sequence
(`ctx.agents.create` → `followup` → `whenIdle` → read the child's events). `SubagentStartRequest.parent`
is required and in-process providers derive workspace/lineage/depth from its durable session state.

⚠️ **Do NOT use `startContinuable` for this**: it returns only `{childId, messageId}`, requires session
persistence, and delivers the child's closing message later as an inbox notice. The vendor README
(`PKGS\dsh-tool-subagent\README.md` line 80) states verbatim:

```markdown
The settlement notice states how that child ended and carries any final assistant message, but it is not this call's return value and cannot be awaited here.
```

> **So what this means for a plugin author:** for "summarize this imported content in a fresh
> conversation", `ctx.subagents.start('spawn', {prompt, parent, signal})` → `await run.result` →
> join `result.output` text blocks → `await run.dispose()`. Reach for `ctx.agents.create` only when
> you have no calling agent to pass as `parent`.

---

## 7. System-prompt / context injection

### 7a. `PromptSection` / `PromptContext`

**File read:** `PKGS\dsh-system-prompt\lib\types\index.d.ts` (lines 36–109)

```ts
/** Merge-extensible context for one prompt assembly. */
export interface AssembleContext {
    /**
     * Scope whose providers and waterfall listeners participate. When absent,
     * only global providers and subject-less listeners participate.
     */
    scope?: ScopeKey;
    /** Explicit control signal for the turn that requested this assembly, when any. */
    signal?: AbortSignal;
}
/** One contributed section of the system prompt (registry input). */
export interface PromptSection {
    /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
    readonly name: string;
    /**
     * Sections are concatenated in ascending order. Convention: `-100` is the
     * harness identity, `0` the deployment persona, tool guidance uses 100–199;
     * other negative orders also render before the persona.
     */
    readonly order: number;
    /**
     * Static text or a provider evaluated at each assembly with that assembly's
     * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
     * interpolated later, by {@link renderPrompt}.
     */
    readonly text: string | ((context: AssembleContext) => string);
    /**
     * Treat this contribution as the complete system prompt. ...
     */
    readonly complete?: boolean;
}
/** Dynamic model context materialized as a durable user-role snapshot. */
export interface PromptContext {
    /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
    readonly name: string;
    /** Contexts are joined in ascending order. */
    readonly order: number;
    /** Static text or a provider evaluated for each assembly. Empty text contributes nothing. */
    readonly text: string | ((context: AssembleContext) => string);
}
/** Tool schemas visible in one assembly and their pre-restriction name set. */
export interface ToolProviderResult {
    /** The schemas this provider contributes to THIS assembly. */
    readonly schemas: readonly ToolSchema[];
    /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
    readonly knownNames?: readonly string[];
}
```

### 7b. The four registration methods

**File read:** `PKGS\dsh-system-prompt\lib\types\index.d.ts` (lines 173–229)

```ts
/** Registry service for the prompt inputs assembled before each model step. */
export declare class SystemPrompt extends Service {
    static Config: z<Config>;
    section(section: PromptSection): () => void;
    context(context: PromptContext): () => void;
    suppressRuntimeContext(): () => void;
    tools(provider: (context: AssembleContext) => ToolProviderResult): () => void;
    /**
     * @param name - the `[a-z][a-z0-9_]*` reference name.
     * @param provider - evaluated for each assembly.
     * @returns the exact Cordis effect disposer.
     */
    variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void;
    assemble(context?: AssembleContext): Promise<PromptAssembly>;
}
```

### 7c. Standing instructions — which one to use

**File read:** `PKGS\dsh-system-prompt\README.md` (lines 20–25)

```markdown
- `ctx.systemPrompt.section(section: PromptSection): () => void` Contribute a section. The layer is the calling context's scope: `agent.ctx` contributes to that agent alone, shadowing a same-named global section there. A `complete: true` section becomes the exact complete prompt after the assembly waterfall; more than one effective complete section rejects assembly. Duplicate names within one layer and non-finite orders throw. Disposed with the calling fiber.
- `ctx.systemPrompt.context(context: PromptContext): () => void` Contribute ordered dynamic context for the calling scope. Providers are evaluated for each eligible assembly and become a sourced runtime-context snapshot in model history under the shipped loop.
- `ctx.systemPrompt.tools(provider: (context: AssembleContext) => ToolProviderResult): () => void` Contribute tool schemas, evaluated at each assembly with that assembly's context.
- `ctx.systemPrompt.variable(name: string, provider: (context) => string | undefined): () => void` Contribute a prompt variable, referenced from section text as `{{name}}`. Scoped variables shadow a same-named global for that agent. Duplicate-in-layer or unreferenceable names throw; `undefined` means "no value for this assembly". Disposed with the calling fiber.
```

**For "here is what you remember about the user" injected into every model step, use `section` with a
provider function** (re-evaluated each assembly, so the text can change as memory changes):

```js
ctx.systemPrompt.section({
  name: 'plugin:memory',            // must be unique within this layer
  order: 50,                        // after persona (0) and harness identity (-100)
  text: () => renderMemoryBlock()   // re-evaluated every assembly
})
```

`ctx.systemPrompt.context(...)` is the alternative that materializes as a durable **user-role
snapshot** in model history rather than as system text — use it when the content is per-turn state
rather than standing instruction.

**Order bands (verbatim, README line 34):**

```markdown
Order bands: `-100` is the harness identity, `0` the deployment persona, tool guidance uses `100–199`.
```

**Variable interpolation is STRICT (README line 36):**

```markdown
`renderPrompt(assembly)` — interpolates `{{variable}}` references in each section, drops empty sections, joins with blank lines. STRICT: an unknown reference (`Object.hasOwn` lookup — prototype names like `{{constructor}}` are unknown), a registered-but-valueless reference, a malformed complete `{{…}}` group, or a `{{` that opens no complete group while a `}}` still follows (`{{{model}}}`) throws — fail loud beats shipping a malformed prompt.
```

> **So what this means for a plugin author:** one `ctx.systemPrompt.section({name, order, text})` call
> injects standing instructions into every model step. Use a *function* for `text` so the content is
> re-evaluated per assembly. Avoid `{{...}}` in your text unless you registered the variable.
> The shipped loop registers `{{model}}` and `{{cwd}}`.

---

## 8. Client-side: `dsh.client`, Slots, bundles, theme tokens

### 8a. How the client half is discovered, built into the boot graph, and served

**File read:** `PKGS\dsh-client-modules\lib\index.js` (lines 377–404, 420–437)

```js
	resolveMeta(pkgName) {
		const cached = this.pkgMeta.get(pkgName);
		if (cached !== void 0) return cached;
		let pkgPath;
		try {
			pkgPath = this.resolvePkgJson(pkgName);
		} catch {
			this.pkgMeta.set(pkgName, null);
			return null;
		}
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const dsh = pkg.dsh;
		const decl = parseDshClient(pkgName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
		if (decl === void 0 || decl.platform !== "web") {
			this.pkgMeta.set(pkgName, null);
			return null;
		}
		const clientRel = clientExportOf(pkgName, pkg.exports);
		if (clientRel === void 0) throw new Error(`client-modules: ${pkgName} declares dsh.client but exports no "./client" bundle`);
		const meta = {
			clientPath: join(dirname(pkgPath), clientRel),
			...decl.inject !== void 0 ? { inject: decl.inject } : {},
			external: decl.external ?? [],
			immediately: decl.immediately === true
		};
		this.pkgMeta.set(pkgName, meta);
		return meta;
	}
```

```js
	/** Reconcile one entry name against the live loader entries. @returns whether the table changed. */
	processOne(entryName) {
		let qualifies = false;
		for (const entry of this.ctx.loader.entries()) if (entry.options.name === entryName && entry.fiber !== void 0 && !entry.disabled) {
			qualifies = true;
			break;
		}
		if (!qualifies) return this.table.delete(entryName);
		if (this.table.has(entryName)) return false;
		const meta = this.resolveMeta(entryName);
		if (meta === null) return false;
		const rev = this.initialBundleRevision(entryName, meta.clientPath);
		this.table.set(entryName, {
			entry: graphRow(entryName, rev, meta),
			meta
		});
		return true;
	}
```

and the URL shape (lines 151–161):

```js
/** Graph row for one bundle rev (url carries the rev as its cache-busting query). */
function graphRow(id, rev, fields) {
	return {
		id,
		url: `/plugins/${id}/client.js?rev=${rev}`,
		rev,
		...fields.inject !== void 0 ? { inject: fields.inject } : {},
		...fields.immediately ? { immediately: true } : {},
		...fields.external.length > 0 ? { external: fields.external } : {}
	};
}
```

**File read:** `PKGS\dsh-client-modules\README.md` (line 13)

```markdown
The Node half scans enabled Loader entries for web `dsh.client` packages, resolves each `exports["./client"]`, hashes the built bundle into the boot graph, carries package-specific `dsh.client.external` requests, orders dynamic providers before consumers, and serves each bundle with its source map under `/plugins`.
```

⚠️ **The silent-failure trap.** Line 276 of the same file:

```js
		this.resolvePkgJson = (spec) => require.resolve(`${spec}/package.json`);
```

Because Node's `exports` gate applies to `require.resolve('pkg/package.json')` and the `catch` above
**swallows the error**, a plugin whose `exports` map omits `"./package.json"` is **silently treated as
"not a client package"** — no error, no bundle, nothing in the boot graph. Every in-box client
package ships `"./package.json": "./package.json"`.

Also: the client half is discovered by scanning **Loader entries**, so the entry `name` must be a
resolvable **package name**. An entry named `./my-client.mjs` will never get a client bundle.

### 8b. The client bundle format — NOT a plain ES module

**File read:** `PKGS\dsh-client-ui-goal\lib\client.js` (lines 1–6 and 440–447)

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-goal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
```

```js
		exports.GoalBar = GoalBar;
		exports.GoalDock = GoalDock;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
```

**File read:** `PKGS\dsh-client-modules\lib\client.js` (lines 8–31)

```js
		/**
		* Client module system: the browser peer of Node's internal ESM loader, built
		* as a lazy CJS table. The vendored cordis Loader consumes this object
		* through its `internal` contract (the only call site is `EntryTree.import` →
		* `internal.import`), which keeps entry governance (fiber lifecycle, inject
		* waiting, update/refresh) entirely on the vendored side while this package
		* owns code arrival.
		*
		* Lazy CJS model: executing a plugin bundle only REGISTERS its
		* factory (`window.__ModuleLoader__.load({id, factory})`); every module body
		* side effect — including CSS injection — lives inside the factory closure
		* and runs at materialization, not at script execution. ...
		*
		* Resolution branch order (import): seed word → shell instance; memoized
		* record → exports; graph row → register its dependency factories and own
		* factory; registered factory → materialize; anything else → throw (loud —
		* the runtime mirror of the build-time bundle purity gate).
		*/
```

`id` **must** equal the package name of the graph row executing it — otherwise the loader throws
`bundle ${url} loaded without registering "${id}"`.

**Answers:**
- The client bundle is **not** a plain ES module — it is a **classic script** (same-origin
  `<script async src="/plugins/<pkg>/client.js?rev=…">`), not ESM, not an import map.
- It **must export a Cordis plugin**: the materialized `module.exports` is adopted as the Loader
  entry's module, so `exports.apply` and `exports.inject` are the required face. Verified across all
  44 shipped client bundles: `exports.inject = inject;` appears in **44/44**; `exports.name = name;`
  in only **2** (`dsh-client-hmr`, `dsh-cordis-client-runner`); `exports.default =` in **0**; and
  **no client half declares `Config`** — client config is not a thing (state arrives via services,
  `SettingsScope`, or projection).
- Available imports: `require()` resolves **seed words** then materialized/registered dynamic
  packages. The complete set actually used by shipped bundles is
  `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-runtime/client`, plus dynamic packages by name (or `<pkg>/client`).
  Anything else throws:
  ```js
  throw new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`);
  ```
  ⚠️ **`@deepseek-ai/dsh-client-ui-slots` and `@deepseek-ai/dsh-client-ui-primitives` are NOT
  installed packages** — they are Vite-bundled into the web shell and exposed as seed words, so they
  are requireable at runtime but have no readable `.d.ts` in this tree.
  ⚠️ Value imports of `@deepseek-ai/dsh-client-runtime` from a bundle must use the **`/client`
  subpath** — the bare package name is not in the loader externals table and inlines a second module
  instance (`PKGS\dsh-client-runtime\README.md`).
- `dsh.client.inject` is **informational graph metadata only**; the real Cordis service injection is
  the `inject` array the bundle itself exports. `dsh.client.external` is accepted by the parser but
  is used by **zero** in-box packages.

CSS is injected by the bundle itself (`document.createElement("style")` with `data-plugin` /
`data-plugin-css`), inside the factory — see `dsh-client-ui-goal\lib\client.js` lines 12–19; the
loader claims untagged styles for the materializing plugin so HMR can remove them.

### 8c. Slots — registration and inspection

⚠️ **`listSubTree` is NOT a method of the Slots service.** It is the **Client Inspect provider**
method id `Slots.listSubTree` (provider `Slots`, platform `client`), implemented in
`PKGS\dsh-cordis-client-runner\lib\client.js`, delegating to `ctx.get("slots").snapshot(root)`.
It is the *inspection* path used by the dynamic-plugin workflow — not an authoring API.

**The service-level read API — file read:** `PKGS\dsh-client-runtime\lib\types\client\slots.d.ts` (lines 46–178, declarations verbatim)

```ts
export declare class SlotRegistry extends Service {
    readonly register: SlotCore['register'];
    /**
     * Install an effect for each declaration lifetime of a slot. The callback
     * runs synchronously when the declaration already exists; otherwise it runs
     * inside the declaring `register()` call after the declaration is committed.
     * ...
     * @param key - declared SlotMap key to depend on.
     * @param callback - creates one disposer or an iterable of disposers.
     * @returns idempotent disposer for the wait and active effect.
     */
    inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void;
    install(renderer: SlotRenderer): void;
    installLocale(face: LocaleFace): void;
    renderSlot<K extends keyof SlotMap & string>(key: K, owner: OwnerOf<K>): ReturnType<SlotRenderer['renderRoot']>;
    pruneStoreScope(sessionId: string): void;
    entries(key: keyof SlotMap & string): readonly StoredEntry[];
    entriesOfSlot(key: keyof SlotMap & string): readonly StoredEntry[];
    snapshot(root?: string): LiveSlotNode[];
    onEntryError(fn: (key: string, entry: StoredEntry, error: unknown, info: { abdicated: boolean; }) => void): () => void;
    spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined;
    subscribe(key: keyof SlotMap & string, fn: () => void): () => void;
    getVersion(key: keyof SlotMap & string): number;
}
```

**There is no `ctx.slots.contribute`.** The API is `inject(slotKey, () => register(options, Component))`.

**The contribution shape — verified from the embedded slot catalog in**
`PKGS\dsh-cordis-client-runner\lib\client.js` (lines 1897, 1905–1933, 1953):

```ts
export type SlotComponent<P> = (props: P) => ReactNode;
export interface SlotEntryDef {
    kind: SlotKind;
    scope: SlotScope;
    owner?: object;
    keyProps?: Record<string, object>;
    hookContext?: unknown;
    inject?: object;
}
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain';
export type SlotScope = 'root' | 'session-maybe' | 'session';
export interface StoredEntry {
    component: unknown;
    options: {
        key?: string;
        id?: string;
        order?: number;
        label?: SlotLabel;
        priority?: number;
    };
    select?: ((owner: never) => unknown) | undefined;
    inject?: ((...args: never[]) => Record<string, unknown>) | undefined;
    children?: Readonly<Record<string, SlotSpec<SlotEntryDef>>> | undefined;
    store?: StoreDecl | undefined;
    locale?: string | undefined;
    registrant?: string | undefined;
}
```

A component is a **render function**, not an element. Options by kind: `{name}` alone for
`single`/`chain`; `{name, id, order?, label?}` for `list`; `{name, key}` for `keyed`;
`select: (owner) => unknown | null` required for `chain`. Declaring new child slots is done with
`children` (see `PKGS\dsh-client-ui-settings-general\lib\client.js` lines 536–565).

⚠️ `PKGS\dsh-client-ui-slots` (which owns `SlotCore.register` and `BaseOptions`) is **not installed
as a package** — it is bundled into the web shell as a seed word. The signature above was recovered
from the embedded catalog; `BaseOptions` itself could not be quoted.


### 8d. Verified slot ids (from the shipped `SlotMap` declarations)

| Slot id | kind | scope | Declared by |
|---|---|---|---|
| `settings.section` | `list` | `root` | dsh-client-ui-settings |
| `settings.general.item` | `list` | `root` | dsh-client-ui-settings |
| `settings.trigger` / `settings.header` / `settings.action` / `settings.close` / `settings.onboarding` / `settings.plugins.tab` | mixed | `root` | dsh-client-ui-settings |
| `sidebar.brand.mark` / `sidebar.brand.name` / `sidebar.workspaces` / `sidebar.settings` | `single` | `root` | dsh-client-ui-sidebar |
| `sidebar.footer.action` | `list` | `root` | dsh-client-ui-sidebar |
| `conversation.session` / `.header` / `.header.lineage` / `.header.actions` / `.header.utilities` / `.view` / `.chat.node` / `.message.images` / `.chat.commandview` / `.chat.turnTail` / `.chat.assistant-actions` / `.details.tool` | mixed | — | dsh-client-ui-conversation |
| `conversation.composer` / `.composer.dock` / `.composer.bar` / `.input.dock` / `.input.left` / `.input.right` / `.input.attachments` / `.input.plan` / `.input.model` / `.input.overlay` | mixed | — | dsh-client-ui-conversation / input-trigger |
| `conversation.hero.workspace` / `.workspace.directoryFlow` / `.brand.mark` / `.agentPreset` | — | — | dsh-client-ui-conversation / workspace |
| `sidebar.workspaces.directoryFlow` | — | — | dsh-client-ui-workspace |
| `tool.call.toolview` | keyed (key = tool name) | — | dsh-client-ui-tool |
| `tool.view.cordis` | keyed (`key: 'self'`) | — | dsh-client-ui-cordis |
| `root` | `single` | `root` | dsh-client-runtime (⚠️ documented "DO NOT register here") |

**Verbatim spec — file read:** `PKGS\dsh-client-ui-settings\lib\types\client\contract\slots.d.ts` (lines 67–71)

```ts
        'settings.section': {
            kind: 'list';
            scope: 'root';
            owner: SettingsSectionOwnerProps;
        };
```

**Verbatim spec — file read:** `PKGS\dsh-client-ui-sidebar\lib\types\client\contract\slots.d.ts` (lines 58–62, 93–97)

```ts
        'sidebar.footer.action': {
            kind: 'list';
            scope: 'root';
            owner: SidebarFooterActionOwnerProps;
        };
```
```ts
/** Owner share of an action rendered beside Settings at the sidebar foot. */
export interface SidebarFooterActionOwnerProps {
    /** Whether the sidebar renders wide content (false = 56px rail). */
    wide: boolean;
}
```

**A real registration call — file read:** `PKGS\dsh-client-ui-jobs\lib\client.js` (lines 262–276)

```js
			ctx.effect(() => ctx.locale.register("job", {
				zh,
				en
			}), "ui-job: dictionaries");
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "job-list",
				order: 20,
				locale: "job"
			}, JobListAction));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
```

So the contribution shape is `register({name, id?, order?, locale?, key?, children?, inject?}, Component)`.
`id`/`order` for `list` slots, `key` for keyed slots, `children` for declaring descendant slots (see
`PKGS\dsh-client-ui-settings-general\lib\client.js` lines 536–565).

**A real settings-page registration — file read:** `PKGS\dsh-client-ui-agent-preset\lib\client.js`
(lines 1706–1713):

```js
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "agent-presets",
				order: 20,
				label: () => ctx.locale.bind("settings.agentPreset")("nav"),
				locale: "settings.agentPreset",
				inject: sectionInjected
			}, AgentPresetSection));
```

**A real sidebar action — file read:** `PKGS\dsh-client-ui-cordis\lib\client.js` (lines 1337–1340):

```js
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "cordis-panel",
				locale: NS,
				inject: () => ({
```

**The composer-button seat, as the shipped catalog documents it** —
`PKGS\dsh-cordis-client-runner\lib\client.js` line 2789 (verbatim `example` field):

```js
				example: "return {\n  inject: ['slots'],\n  apply(ctx) {\n    ctx.slots.inject('conversation.input.right', () => ctx.slots.register(\n      { name: 'conversation.input.right', id: 'my-entry', order: 100, label: 'My entry' },\n      () => React.createElement('div', null, 'hello'),\n    ))\n  }\n}",
```

> `dsh-client-ui-agent-preset` is one of the installed `dsh-client-ui-*` packages; the call above is
> from its shipped `lib/client.js`. Still confirm the target slot's `kind`/`scope` from its own
> `SlotMap` declaration before registering, since a `single` slot **replaces** its occupant while a
> `list` slot is additive.

### 8e. Theme tokens

**File read:** `PKGS\dsh-client-ui-theme\lib\types\client\index.d.ts` (lines 26–52)

```ts
/** Theme token dictionary: --dsw-alias-* overrides keyed by variable name. */
export type ThemeTokens = Record<string, string>;
/**
 * One override-layer token value: both palette modes are mandatory (repeat
 * the same value when the token is scheme-invariant) so an override never
 * goes illegible when the user switches to the other scheme.
 */
export interface ThemeTokenModes {
    /** Value applied while the light base palette is active. */
    light: string;
    /** Value applied while the dark base palette is active. */
    dark: string;
}
/** Override-layer dictionary: token names to per-mode value pairs. */
export type ThemeTokenOverrides = Record<string, ThemeTokenModes>;
/** One selectable theme: id, dark/light semantics, and alias-token overrides. */
export interface ThemeDefinition {
    /** Theme id (the setTheme argument for concrete themes). */
    id: string;
    colorScheme: 'light' | 'dark';
    /** Alias-layer overrides applied as inline CSS variables over the base palette. */
    tokens: ThemeTokens;
}
```

Service surface (same file, lines 129–173, declarations verbatim): `listTokens()` (inspection),
`setTheme(id)`, `register(definition): () => void`, `overrideTokens(source: string, tokens:
ThemeTokenOverrides): () => void`.

**File read:** `PKGS\dsh-client-ui-theme\README.md` (line 3)

```markdown
Theme plugin: ThemeRuntime over the --dsw-* token base stylesheets (static scale + alias semantic layers).
```

(line 25)

```markdown
- **Third-party themes are an extension point, not a product** — registering one means overriding same-named alias variables; no validation exists that an override set is complete.
```

**Real token names** (extracted from `PKGS\dsh-client-ui-theme\lib\client.js`; 350 unique `--dsw-*`
custom properties). Representative, verified set:

```
--dsw-alias-bg-base              --dsw-alias-label-primary
--dsw-alias-bg-layer-1           --dsw-alias-label-secondary
--dsw-alias-bg-layer-2           --dsw-alias-label-tertiary
--dsw-alias-bg-layer-3           --dsw-alias-label-caption
--dsw-alias-bg-overlay           --dsw-alias-label-dimmed
--dsw-alias-bg-skeleton          --dsw-alias-label-primary-dimmed
--dsw-alias-border-l1            --dsw-alias-label-primary-inverted
--dsw-alias-border-l2            --dsw-alias-label-primary-foreground
--dsw-alias-border-l3            --dsw-specific-tip
--dsw-alias-border-l4            --dsw-alias-brand-primary
--dsw-alias-state-error-primary --dsw-alias-state-success-primary
--dsw-alias-state-error-secondary --dsw-alias-state-business-primary
--dsw-alias-interactive-bg-hover --dsw-alias-interactive-bg-active
--dsw-alias-button-primary-fill  --dsw-alias-button-primary-hover
--dsw-alias-scrollbar-bg-l1      --dsw-alias-scrollbar-bg-l2
--dsw-alias-markdown-inline-code --dsw-alias-markdown-code-block
```

**The enumerated, officially-overridable set is only 13 names** — `BUILTIN_INSPECT_TOKENS` in
`PKGS\dsh-client-ui-theme\lib\client.js` (lines 1007–1099), each `{name, description,
valueType: "CSS color", requiresLightAndDark: true, cssVariable}`:

```
--dsw-alias-bg-base              --dsw-alias-bg-layer-1
--dsw-alias-bg-layer-2           --dsw-alias-bg-overlay
--dsw-alias-border-l1            --dsw-alias-border-l2
--dsw-alias-brand-primary        --dsw-alias-label-primary
--dsw-alias-label-secondary      --dsw-alias-state-error-primary
--dsw-alias-state-success-primary --dsw-alias-state-warn-primary
--dsw-specific-sidebar-fill
```

`ThemeTokens = Record<string, string>` means **there is no closed token enum** — `overrideTokens`
accepts any name, and `exportInspectTokens()` adds names contributed by registered themes and
override layers. The DOM application mechanism is `body[data-ds-dark-theme]` plus each token written
as an inline custom property on `<body>` (`PKGS\dsh-client-ui-layout\lib\client.js` lines 345,
366–380).

⚠️ **`overrideTokens` requires the `{light, dark}` pair** and throws a teaching error on a bare
string (`PKGS\dsh-client-ui-theme\lib\client.js` lines 1276–1288):

```
theme override "${name}" from "${source}" is a bare string — pass { light: ..., dark: ... } (repeat the value when it is the same in both palettes)
```

Plus three layout tokens in the `--dsh-*` family (not `--dsw-*`). ⚠️ **The `--dsh-*` prefix is NOT a
colour-token family** — the only `--dsh-*` declarations in the theme plugin are these three plus
inter-package geometry contracts like `--dsh-composer-side-clearance`, `--dsh-composer-card-max-width`,
and `--dsh-composer-dock-inset` (declared by `dsh-client-ui-conversation`):

```
--dsh-scrollbar-thumb
--dsh-scrollbar-thumb-hover
--dsh-scrollbar-width
```

**Real usage in a plugin's own CSS — file read:** `PKGS\dsh-client-ui-goal\lib\client.js` (line 11, a
CSS-module string inside the bundle):

```css
.nLMEza_bar{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);border-radius:12px;...}
```

**Ownership rule — file read:** `PKGS\dsh-client-ui-theme\lib\types\client\index.d.ts` (from the module doc): a theme override is applied as **inline CSS variables**; theme CSS variables are read for the package's own components. Per the theme README (line 9):

```markdown
`src/styles/` holds five sheets imported in order by ui-theme's dynamic client entry: `base.css`, `design-platform.css`, `scrollbar.css`, `gradient-shadow-text.css`, and `shiki.css`. The client bundle compiles and injects them as plugin-owned global styles, so unload and HMR remove them with ui-theme instead of leaving theme CSS in the static web shell.
```

> **So what this means for a plugin author:** reference `var(--dsw-alias-*)` in your client CSS — the
> tokens are already defined by `dsh-client-ui-theme`. Register global *themes* only if you must;
> for your own components just consume the tokens. `--dsw-*` = design tokens; `--dsh-*` = harness
> layout/scrollbar tokens.

### 8f. Exact file/bundle naming and registration for a LOCAL plugin directory

**For a real `dsh.client` client half**, the required files are:

```
<plugin-dir>/
  package.json          ← name, type:module, main, exports{".": …, "./client": "./lib/client.js",
                           "./package.json": "./package.json"}, dsh.bundle.patch, dsh.client{platform:"web"}
  cordis.patch.yml      ← - insert: [{ id: <id>, name: <packageName> }]
  lib/index.js          ← Host half: exports name/inject/Config/apply  (may be an empty apply())
  lib/client.js         ← Client half: window.__ModuleLoader__.load({id:"<packageName>", factory(require){…}})
                           exporting apply (+ inject)
  lib/types/**/*.d.ts   ← optional but conventional
```

Wire-up: `dsh plugin --profile web add link:C:/abs/path/to/<plugin-dir>` → restart the profile. The
scan finds the Loader entry, resolves `<packageName>/package.json` (requires the `./package.json`
export!), reads `exports["./client"]`, hashes the file, adds a boot-graph row, and serves it at
`/plugins/<packageName>/client.js?rev=<hash>`. The bundle's own `id` string must equal `<packageName>`.

**A second, verified pattern with no `dsh.client` at all** — the working third-party whale widget
does exactly this and demonstrates that a plugin can ship browser UI from a Host-only package.
**File read:** `C:\Users\<user>\.dsh\plugins\DeepSeek-Balance-Whale-Widget-main\package.json`

```json
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib", "assets", "cordis.patch.yml", "README.md"],
  ...
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
```

— **no `exports`, no `dsh.client`.** Its Host half declares `const inject = ['webServer', 'credentials']`,
registers `/dsh-whale/widget.js` and its assets via `ctx.webServer.register({kind:'exact', path, handler})`,
and injects the `<script>` tag with `ctx.webServer.tapIndex(...)` (quoted in full in §5e).

> **So what this means for a plugin author:** for a small local widget, the whale pattern (Host-only +
> own HTTP route + `tapIndex`) is simpler and fully verified. Use the `dsh.client` dual-face pattern
> when you want React components mounted into *product* Slots (settings pages, sidebar, tool cards)
> with proper Cordis lifecycle, HMR, and disposal. **Note: `tapIndex` HTML injection does not cross
> the Electron desktop IPC boundary** — the `whale-desktop-bridge` plugin exists solely to work
> around that, which is why it re-emits the script as a structured `script-src` row.

---

## 9. Storage and filesystem APIs

### 9a. `ctx.fs` — the service is named `FileSystem`, and it has exactly 12 primitives

**File read:** `PKGS\dsh-fs\lib\types\index.d.ts`

```ts
export declare abstract class FileSystem extends Service {
    constructor(ctx: Context);
    get sandboxMode(): SandboxMode | undefined;
    abstract resolve(path: string, opts?: {
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<FsTarget>;
    abstract processPath(target: FsTarget): string;
    abstract fileUrl(target: FsTarget): string;
    abstract contains(parent: FsTarget, child: FsTarget): boolean;
    abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
    abstract lstat(path: string, opts?: {
        cwd?: string;
    }, signal?: AbortSignal): Promise<FsPathInfo | undefined>;
    abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
    abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>;
    abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
    abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
    abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>;
    abstract editText(target: FsTarget, edit: FsEditRequest, expected?: {
        version: FsVersion;
    }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>;
}
```

**`FsTarget` — file read:** `PKGS\dsh-fs\lib\types\types.d.ts`

```ts
export interface FsTarget {
    /** Opaque key for stale guards and target lookup. */
    targetKey: FsTargetKey;
    /**
     * Path for model/UI-facing output. May be a local absolute path,
     * workspace-relative path, or remote URI depending on the backend.
     */
    displayPath: string;
}
export type FsWriteIntent = {
    kind: 'createIfAbsent';
} | {
    kind: 'replaceIfVersion';
    version: FsVersion;
};
export interface FsWriteOutcome {
    /** Whether the write created a new file or replaced an existing one. */
    operation: 'create' | 'update';
    /** Opaque version of the file after the write. */
    version: FsVersion;
    before: string | null;
    after: string;
}
export interface FsEditRequest {
    /** Literal non-empty text to replace. Must match exactly (after line-ending normalization). */
    oldString: string;
    /** Literal replacement text. An empty string deletes the matched text. */
    newString: string;
    /** Replace every match instead of requiring exactly one. */
    replaceAll: boolean;
}
```

**`sandboxPolicy` — file read:** `PKGS\dsh-sandbox\lib\types\index.d.ts` (lines 13–58)

```ts
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>;
export interface SandboxExecutionPolicy {
    /** The file-effect mode this execution runs under. */
    mode: SandboxMode;
    /** Absolute root directory `workspace-write` may write under. */
    workspaceRoot: string;
    sessionId?: SessionId;
}
export interface SandboxPolicy extends SandboxExecutionPolicy {
    /** The file-effect mode this execution runs under. */
    mode: ConfinedSandboxMode;
}
```

⚠️ **There is no `FsSandboxPolicy` type, and no `Fs` type.**

⚠️ **`ctx.fs` has NO `readFile`, `writeFile`, `exists`, `mkdir`, `remove`, `move`, `copy`, `unlink`,
`rename`, `readdir`, `list`, `cwd()`, or `target()`.** `PKGS\dsh-fs\README.md` states it outright:

```markdown
- **Twelve primitives only** — no delete, rename/move, copy, or watch; `listDir` is single-level, with recursion, globbing, pagination, and search out of scope
```

**Target construction:** only `await ctx.fs.resolve(path, opts?)` — there is no `fs.target(...)` and no
`fs.cwd()`.

⚠️ **The bare local backend ignores `sandboxPolicy` entirely.** `PKGS\dsh-fs-local\lib\index.js`
declares `writeText`/`editText` with only **four** parameters (no `sandboxPolicy`); only the base
`FileSystem` class type and the `dsh-fs-sandbox` backend carry the 5th parameter. And
`PKGS\dsh-fs-local\README.md`:

```markdown
- **`config.cwd` is not a sandbox** — it is a resolution default, not containment: absolute paths and `..` escape it. Enforce containment with a stricter `ctx.fs` backend or a permission plugin on the `tools/execute` waterfall
```

### 9b. `ctx.storage` — a registry, NOT a key-value store

**File read:** `PKGS\dsh-storage\lib\types\index.d.ts`

```ts
export declare class Storage extends Service {
    /** Named backend table; multiple backends stay mounted side by side. */
    readonly backend: BackendRegistry;
    private readonly forms;
    constructor(ctx: Context);
    mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void;
    form<K extends keyof StorageForms>(form: K): StorageForms[K];
    /** Domain data form; present once the domain layer plugin is loaded. */
    get domain(): StorageForms extends {
        domain: infer D;
    } ? D : never;
}
```

**No `get`/`set`/`update`/`delete`/`keys`/`observe`/`watch`.** ⚠️ No `StorageHandle`, no `Store` type.
The raw layer is `StorageBackend` / `KvFacet` / `KvUnit` / `KvUnitDescriptor` — **file read:**
`PKGS\dsh-storage\lib\types\backend.d.ts`:

```ts
export interface StorageBackend {
    /** Key-value operations; absent when this backend cannot serve them. */
    readonly kv?: KvFacet;
    close(): Promise<void>;
}
export interface KvFacet {
    open(descriptor: KvUnitDescriptor): Promise<KvUnit>;
}
export interface KvUnitDescriptor {
    /** Unit name; must match {@link UNIT_NAME_RE}. Also the file-name / SQL-identifier segment. */
    readonly name: string;
    /** Unit format version; a non-negative integer stamped on the medium at first materialization. */
    readonly version: number;
    /** Table names; each must match {@link UNIT_NAME_RE}. */
    readonly tables: readonly string[];
    /** Whether this unit carries the global singleton slot. */
    readonly hasGlobal: boolean;
}
export interface KvUnit {
    loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown; }>;
    putRecord(table: string, key: string, value: unknown): Promise<void>;
    deleteRecord(table: string, key: string): Promise<void>;
    setGlobal(value: unknown): Promise<void>;
    close(): Promise<void>;
}
```

with the name rule — `PKGS\dsh-storage\lib\index.js` line 80:

```js
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
```

### 9c. `ctx.storageDomain` — the layer you should actually use

**File read:** `PKGS\dsh-storage-domain\lib\types\spec.d.ts`

```ts
export interface DomainGlobalSpec<G> {
    /** Validates the stored global at the durable boundary. */
    readonly schema: ZodType<G>;
    /** Value served when the medium holds no global yet; not written until the first `set`. */
    readonly initial: G;
}
export interface DomainTableSpec<K extends string = string, V = unknown> {
    /** Validates every stored record at the durable boundary. */
    readonly valueSchema: ZodType<V>;
    /** Phantom carrier for the key type; never present at runtime. */
    readonly __key?: K;
}
export interface DomainSpec {
    /** Domain name; must match `UNIT_NAME_RE` (doubles as the backend unit name). */
    readonly name: string;
    /** Domain format version; a medium stamped with a different version rejects at open. */
    readonly version: number;
    /** Optional global singleton slot. */
    readonly global?: DomainGlobalSpec<unknown>;
    /** Table declarations keyed by table name; each name must match `UNIT_NAME_RE`. */
    readonly tables: Record<string, DomainTableSpec>;
}
export type TableKeyOf<S extends DomainSpec, N extends keyof S['tables']> = S['tables'][N] extends DomainTableSpec<infer K> ? K : never;
export type TableValueOf<S extends DomainSpec, N extends keyof S['tables']> = S['tables'][N] extends DomainTableSpec<string, infer V> ? V : never;
export declare function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V>;
export declare function defineDomain<S extends DomainSpec>(spec: S): S;
export declare function descriptorOf(spec: DomainSpec): KvUnitDescriptor;
```

**`DomainSpec` has exactly three required fields (`name`, `version`, `tables`) and one optional
(`global`).**

**Domain handle — file read:** `PKGS\dsh-storage-domain\lib\types\domain.d.ts`

```ts
export interface DomainGlobal<G> {
    get(): G;
    set(value: G): Promise<void>;
}
export interface KvTable<K extends string, V> {
    get(key: K): V | undefined;
    entries(): IterableIterator<[K, V]>;
    keys(): IterableIterator<K>;
    readonly size: number;
    put(key: K, value: V): Promise<void>;
    delete(key: K): Promise<boolean>;
    update(key: K, fn: (current: V) => V): Promise<V>;
}
export interface Domain<S extends DomainSpec> {
    /** Domain name from the spec. */
    readonly name: string;
    /** Global singleton handle; a spec without `global` has no usable handle (`never`). */
    readonly global: DomainGlobalHandleOf<S>;
    table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>;
    close(): Promise<void>;
}
```

**Facility — file read:** `PKGS\dsh-storage-domain\lib\types\index.d.ts`

```ts
export interface Config {
    /** Default backend name for every domain without an explicit route. Required: there is no universally correct medium. */
    backend: string;
    /** Per-domain overrides: domain name → backend name. */
    routes?: Record<string, string>;
}
export declare class DomainFacility {
    open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
    get(name: string): DomainImpl | undefined;
    closeAll(): Promise<void>;
}
```

**⚠️ `ctx.storageDomain` has NO per-session / per-user scoping of any kind.** Scoping is your own key
design. Reads are synchronous from memory; writes are promises; it is `put`, not `set`.

**Change event — file read:** `PKGS\dsh-storage-domain\lib\types\events.d.ts`

```ts
export type DomainChanged = DomainChangedPut | DomainChangedDeleted;
declare module '@deepseek-ai/cordis' {
    interface Events {
        'domain/changed'(change: DomainChanged): void;
    }
}
```

`PKGS\dsh-storage-domain\README.md` limitations, verbatim:

```markdown
- **No cross-table transactions, secondary indexes, or multi-segment keys** — each write touches one record
- **Single-process change visibility** — `domain/changed` is an in-process event
```

### 9d. Where plugin-private state lives on disk

**File read:** `PKGS\dsh-home-paths\lib\index.js` (lines 49–84)

```js
function defaultDshHome() {
	return join(homedir(), DSH_HOME_DIR_NAME);
}
function expandHomePath(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}
function resolveDshHome(configured, env = process.env) {
	const fromEnv = env[DSH_HOME_ENV];
	return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())));
}
function dshHomePath(...segments) {
	return join(resolveDshHome(), ...segments);
}
```

with `DSH_HOME_DIR_NAME = ".dsh"` and `DSH_HOME_ENV = "DSH_HOME"`.

`dshHomePath` is also provided as a Context value before Loader mounts —
`PKGS\dsh-app-boot\lib\index.js` line 1172:

```js
		ctx.provide("dshHomePath", dshHomePath);
```

which is why `!!js dshHomePath('storages')` works inside YAML config.

**The shipped storage wiring — file read:** `PKGS\dsh-web-app\cordis.patch.yml` (lines 51–62)

```yaml
    - id: storage
      name: '@deepseek-ai/dsh-storage'

    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')

    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
```

**The exact on-disk naming — file read:** `PKGS\dsh-storage-json\lib\index.js` (lines 257–269)

```js
	async openUnit(descriptor) {
		await mkdir(this.root, {
			recursive: true,
			mode: 448
		});
		const unit = await openJsonUnit(descriptor, join(this.root, `${descriptor.name}.json`), () => this.open.delete(descriptor.name));
```

So **one domain = one file at `$DSH_HOME/storages/<domainName>.json`**, directory created `0o700`
(448 decimal) on demand. Confirmed on this machine: `C:\Users\<user>\.dsh\storages\workspace.json` and
`session_projcache.json` exist, and `workspace.json` begins:

```json
{
  "unit": {
    "name": "workspace",
    "version": 2
  },
  "global": {
```

`PKGS\dsh-storage-json\README.md` warnings, verbatim:

```markdown
- No cross-process write locking: two processes writing the same root can interleave whole-file replacements (last write wins).
```

| `$DSH_HOME` subdir | Owner | Use for plugin state? |
|---|---|---|
| `storages/` | `dsh-storage-json` (root `dshHomePath('storages')`) | **YES — recommended** |
| `sessions/` | session persistence (`dsh-base` wires `root: !!js dshHomePath('sessions')`) | No |
| `plugins/` | your plugin *sources* (profile links them with `link:`) | No — never mix data into the install tree |
| `cache/` | evictable cache | No |
| `attachments/` | `dsh-attachment-local` (`attachments/v1/objects/<sha256>`) | No |
| `profiles/` | `dsh-app-boot` (manifest + pnpm symlink farm) | No |
| `llm-deepseek/`, `mobile-access/`, `dsh-runtimes/` | their own features | No |

**Recommendation.** Use `ctx.storageDomain.open(defineDomain({...}))` on the shipped `json` backend.
You get durability, atomic whole-file republish, zod validation at the durable boundary, and a change
event — with zero path code, and it lands at `C:\Users\<user>\.dsh\storages\<your_domain>.json`.
Do **not** hand-roll files under `$DSH_HOME`: `ctx.fs` has no delete, no rename, and no `mkdir`, so a
memory store with pruning/GC is not expressible on `ctx.fs` alone.

Fallback (raw JSON via `ctx.fs`, e.g. for bytes or a non-store file):

```js
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
const target = await ctx.fs.resolve(dshHomePath('storages', 'my_state.json'))
const info = await ctx.fs.stat(target)                  // FsInfo | undefined — check before reading
const text = await ctx.fs.readText(target)              // throws FsError FS_NOT_FOUND
const { version } = await ctx.fs.writeText(target, json) // unconditional atomic create-or-overwrite
```

> **So what this means for a plugin author:** durable per-user state belongs in
> `$DSH_HOME/storages/<domain>.json` via `ctx.storageDomain` (names must match `/^[a-z][a-z0-9_]*$/`,
> no per-user scoping — encode it in your keys). `ctx.fs` is a 12-primitive capability seam, not a
> filesystem library; a target comes only from `await ctx.fs.resolve(...)`.

---

## 10. Sandbox / permission gate

### 10a. `ctx.approval` — the real service

**File read:** `PKGS\dsh-user-approval\lib\types\index.d.ts`

```ts
import { ApprovalRequestId } from './types.ts';
import type { ApprovalOutcome } from './types.ts';
export { ApprovalRequestId } from './types.ts';
export type { ApprovalOutcome } from './types.ts';
export type ApprovalPolicy = 'ask' | 'never';
export declare const APPROVAL_POLICIES: readonly ApprovalPolicy[];
export declare function effectiveApprovalPolicy(events: readonly SessionEvent[]): ApprovalPolicy | undefined;
export declare function setApprovalPolicy(session: Session, policy: ApprovalPolicy): void;
export interface ApprovalRequest {
    readonly agent: Agent;
    readonly toolName: string;
    readonly callId?: CallId;
    readonly reason?: string;
    readonly signal?: AbortSignal;
}
export declare class ApprovalService extends Service {
    setPolicy(agent: Agent, policy: ApprovalPolicy): void;
    request(req: ApprovalRequest): Promise<ApprovalOutcome>;
    overrideOf(session: Session): ApprovalPolicy | undefined;
}
```

**File read:** `PKGS\dsh-user-approval\lib\types\types.d.ts` (whole file)

```ts
import type { Branded } from '@deepseek-ai/dsh-brand';
export type ApprovalRequestId = Branded<'ApprovalRequestId'>;
export declare function ApprovalRequestId(id: string): ApprovalRequestId;
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
```

⚠️ **`ApprovalDecision` DOES NOT EXIST.** 0 grep matches across every `.d.ts`. The vocabulary is
`ApprovalOutcome` only. There is also **no `allow-always`**, no remembered rule, no grant store, no
revocation.

⚠️ **`dsh-authorization` is NOT a permission gate.** It is the *credential-obtaining* seam
(`ctx.authorization`, `registerFlow`, `AuthorizationOutcome = 'authorized' | 'cancelled'`) for OAuth /
API-key flows. Unrelated.

⚠️ **`dsh-permission-presets` is only a UI knob bundle** over the two independent knobs.
**File read:** `PKGS\dsh-permission-presets\lib\types\index.d.ts`

```ts
/** One preset's sandbox/approval bundle and optional client presentation. */
export interface PresetSpec {
    /** The `sandbox/mode` value the preset writes through. */
    sandbox: SandboxMode;
    /** The `approval/policy` value the preset writes through. */
    approval: ApprovalPolicy;
    name?: string;
    description?: string;
}
```

`request()` **throws outside an open turn** — `PKGS\dsh-user-approval\lib\index.js` (lines 144–160):

```js
	async request(req) {
		const session = req.agent.session;
		if (!hasOpenTurn(session.events)) throw new Error("approval.request() outside an open turn: the approval/asked + approval/decided audit pair must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). Ask from inside the turn that needs the decision.");
		const id = ApprovalRequestId(randomUUID());
		session.append("approval/asked", {
			id,
			toolName: req.toolName,
			...req.callId !== void 0 ? { callId: req.callId } : {},
			...req.reason !== void 0 ? { reason: req.reason } : {}
		});
		const outcome = await this.decide(req, session);
		session.append("approval/decided", {
			id,
			outcome
		});
		return outcome;
	}
```

`PKGS\dsh-user-approval\README.md` limits, verbatim:

```markdown
- **Requests are valid only inside an open turn** — an idle or between-turn caller throws before auditing
- **Only one-shot grants exist** — the outcome vocabulary has `allowed-once` but no `allow-always`, remembered rule, revocation, or grant store
- **The request carries no tool arguments** — an answerer sees the tool name, reason, and optional call id
- **No built-in answerer** — headless or incompletely composed deployments resolve `unavailable` and fail closed
```

### 10b. `SandboxExecutionPolicy` — declared exactly once

**File read:** `PKGS\dsh-sandbox\lib\types\index.d.ts` — quoted in full in §9a. Three fields
(`mode`, `workspaceRoot` required; `sessionId?` optional). ⚠️ **`ExecutionPolicy` (bare) does not exist.**

The escalation ladder — `PKGS\dsh-sandbox\lib\index.js` (lines 29–41):

```js
const WIDER_MODES = {
	"read-only": ["workspace-write", "danger-full-access"],
	"workspace-write": ["danger-full-access"]
};
const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"];
```

The policy is **carried per call**, never stored on the provider. `PKGS\dsh-sandbox\README.md`:

```markdown
- **File effects are the whole policy vocabulary** — the seam expresses no network, process, syscall, device, or credential restrictions.
```

Resolver — **file read:** `PKGS\dsh-sandbox-policy\lib\types\index.d.ts`

```ts
export declare class SandboxPolicyService extends Service {
    /** The deployment default mode — the fallback beneath a session override. */
    readonly defaultMode: SandboxMode;
    /** The absolute `workspace-write` fallback root for calls without a session cwd. */
    readonly workspaceRoot: string;
    resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy;
    overrideOf(session: Session): SandboxMode | undefined;
}
```

### 10c. Can a ToolDefinition declare file/network access? — NO

`ToolDefinition extends ToolSchema`, and `ToolSchema = {name, description, parameters}` plus
`output`/`execute`/`finalizeContent?`/`timeoutMs?`/`isConcurrencySafe?`/`presentCall?`/`presentResult?`.
Grep over every `.d.ts` in `PKGS` for `permissions?|requires?|network?|capabilities?|annotations?`
yields **one hit**, and it is a model-facing *argument*:

**File read:** `PKGS\dsh-tool-fs\lib\types\sandbox.d.ts`

```ts
/** The two escalation arguments a mutating tool may carry (advertised only under a confining backend). */
export interface FsEscalationArgs {
    sandbox_permissions?: string;
    justification?: string;
}
```

**Network: no declaration and no gate at all.** `PKGS\dsh-tool-web\README.md` line 154, verbatim:

```markdown
- **No web-specific permission policy** — both tools execute without requesting `ctx.approval`; a deployment that needs confirmation must add a `tools/pre-execute` policy, and the package does not define persistent URL/domain grants.
```

**Real enforcement is in the tool body — file read:** `PKGS\dsh-tool-fs\lib\index.js` (lines 802–816)

```js
		async execute(args, exec) {
			const input = parseEditArgs(args);
			const sandboxPolicy = await sandbox.resolvePolicy("edit", args, exec);
			const target = await ctx.fs.resolve(input.filePath, sessionResolveOptions(exec, input.filePath, sandboxPolicy?.workspaceRoot));
			let outcome;
			try {
				const intent = await ctx.waterfall("fs/edit-intent", target, exec, () => void 0);
				outcome = await ctx.fs.editText(target, {
					oldString: input.oldString,
					newString: input.newString,
					replaceAll: input.replaceAll
				}, intent, exec.signal, sandboxPolicy);
			} catch (error) {
				throw remediateFsError(sandbox.mapError(error, sandboxPolicy));
			}
```

### 10d. Does the pipeline enforce a gate automatically? — Yes, from ZERO definition fields

**File read:** `PKGS\dsh-tools\lib\index.js` (lines 3094–3145, `prepareExecution`)

```js
			const carrier = scopeTarget(this, exec.agent);
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
				decision: gate,
				approvalCancelled: false
			};
			const { decision } = askResolution;
			...
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
			if (denialReason !== void 0) return await next({
				kind: "post-result",
				exec,
				result: this.materializeFinalResult({
					content: [{
						type: "text",
						text: `Error: ${denialReason}`
					}],
					isError: true,
					error: { message: denialReason }
				})
			});
```

This runs **strictly before `tool.execute()`**. The decision type — **file read:**
`PKGS\dsh-tools\lib\types\index.d.ts` (lines 412–426):

```ts
/**
 * Pre-dispatch decision. `allow` runs the call; `deny` materializes an error;
 * `ask` runs only after an approval service returns `allowed-once` and otherwise
 * denies. Input rewriting is excluded because arguments are already logged and
 * presented.
 */
export type PreToolDecision = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
} | {
    kind: 'ask';
    reason?: string;
};
```

`serviceAsk` maps `allowed-once → allow`; `rejected`/`cancelled`/`unavailable` → **deny** with
distinct reasons; `ctx.get("approval") === undefined` → deny. It uses `ctx.get("approval")`
(opportunistic), **not** `static inject`.

**The pipeline reads no gating field from the `ToolDefinition`.** The only definition member touched
pre-dispatch is `finalizeContent`. The complete hook set is the `tools/pre-execute` waterfall and
`ctx.tools.guard(...)`.

⚠️ **No shipped plugin returns `kind: 'ask'` today.** The only real `tools/pre-execute` listener in the
whole install is `PKGS\dsh-tool-jobs\lib\index.js` (bookkeeping that always calls `next()`). `ask` is
a supported but currently unused extension point.

### 10e. OS-level sandbox inheritance

There **is** a real OS sandbox (Linux bwrap/Landlock, macOS Seatbelt, Windows `WRITE_RESTRICTED` ACL)
but it is **not ambient**. It is an argv prefix produced on demand by
`ctx.sandbox.confine(argv, policy)` and confines only the process spawned with that argv (inherited by
its descendants). **A plugin calling `child_process`/`ctx.subprocess` directly inherits nothing.**
The sole production `confine` call site is `PKGS\dsh-bash-sandbox\lib\index.js` line 229.

**File read:** `PKGS\dsh-sandbox-windows-acl\lib\types\index.d.ts` (lines 22–28)

```ts
 * Known boundaries (inherent to restricted tokens, not this port):
 *  - writes are restricted; reads, network, and process visibility are NOT
 *    (WRITE_RESTRICTED intersects only write accesses);
 *  - console isolation is unavailable — children share the host console
 *    (CREATE_NO_WINDOW / CREATE_NEW_CONSOLE children die with
 *    STATUS_DLL_INIT_FAILED under the restriction);
 *  - the private temp directory and every writable directory must be owned by the
 *    caller (owner-implicit WRITE_DAC);
```

> **So what this means for a plugin author:** the gate that exists is `tools/pre-execute` (returning
> `{kind:'ask'}`) plus `ctx.tools.guard()`. There is **no declarative way** for a tool to request
> approval or file/network access — you must (a) register a `tools/pre-execute` listener that returns
> `ask` when your tool is named, or (b) call `ctx.get('approval')?.request({agent, toolName, callId,
> reason, signal})` inside `execute` and treat anything other than `allowed-once` as a refusal.
> File fencing is your `execute`'s job: resolve the policy with `ctx.sandboxPolicy.resolve(...)` and
> pass it to `ctx.fs.*`. Network needs a policy you write yourself.

---

## 11. Minimal working Host plugin skeleton

Every API below was verified to exist in §2/§4/§5/§7/§9/§10. TypeScript-style types are annotated in
comments because the shipped plugins are plain ESM JavaScript; the file as written is valid JS.

### 11.1 `<plugin-dir>/package.json`

```json
{
  "name": "dsh-plugin-memory",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

> `"./package.json"` is only required if you also add a `dsh.client` half and an `"./client"` export.
> It is included here because omitting it later causes a **silent** client-plugin failure.

### 11.2 `<plugin-dir>/cordis.patch.yml`

```yaml
# Mounts this bundle into the cordis tree so apply() runs.
# Activate with:  dsh plugin --profile web add link:C:/abs/path/to/dsh-plugin-memory
- insert:
    - id: dsh-plugin-memory
      name: dsh-plugin-memory
```

### 11.3 `<plugin-dir>/lib/index.js` — the plugin

```js
// dsh-plugin-memory — a Host plugin that registers one Tool, one slash Command,
// one system-prompt section, and a durable domain-backed store.
//
// Verified APIs used:
//   ctx.tools.register / defineTool          -> @deepseek-ai/dsh-tools
//   ctx.commands.register                    -> @deepseek-ai/dsh-commands
//   ctx.systemPrompt.section                 -> @deepseek-ai/dsh-system-prompt
//   ctx.storageDomain.open / defineDomain    -> @deepseek-ai/dsh-storage-domain
//   ctx.sandboxPolicy.resolve                -> @deepseek-ai/dsh-sandbox-policy
//   ctx.fs.resolve / writeText / readText    -> @deepseek-ai/dsh-fs

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

// ── Plugin metadata ──────────────────────────────────────────────────────────
// `name` is optional (Cordis uses it for fiber diagnostics / logger names).
export const name = 'dsh-plugin-memory'

// `inject` lists HARD dependencies: the plugin stays unloaded (waiting) until all
// are available. Use `ctx.get('x')` for optional ones instead — never read
// `ctx.x` without declaring it.
export const inject = ['tools', 'systemPrompt', 'fs']

// ── Config: a Standard Schema validator (schemastery `z` is the shipped idiom) ─
export const Config = z.object({
  // Section text is re-evaluated on every prompt assembly, so this is live.
  instructionLimit: z.number().default(20),
  // Order band: -100 harness identity, 0 deployment persona, tool guidance 100-199.
  sectionOrder: z.number().default(50)
})

// ── Durable state: one domain == one JSON file at $DSH_HOME/storages/<name>.json ─
// Domain and table names must match /^[a-z][a-z0-9_]*$/. There is NO per-user or
// per-session scoping in the API — encode it in the key yourself.
const memoryRecord = z.object({
  text: z.string(),
  createdAt: z.string()
})

const MEMORY_DOMAIN = defineDomain({
  name: 'plugin_memory',   // -> C:\Users\<user>\.dsh\storages\plugin_memory.json
  version: 1,
  global: {
    schema: z.object({ schemaVersion: z.number() }),
    initial: { schemaVersion: 1 }
  },
  tables: {
    // domainTable<K, V>(valueSchema) — the key type is a phantom carrier.
    memories: domainTable(memoryRecord)
  }
})

// ── Canonical output contract (MANDATORY on every ToolDefinition) ────────────
// `schema` is raw JSON Schema; `render` is the pure model-facing projection.
const RECALL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string' },
            text: { type: 'string' }
          }
        }
      }
    }
  },
  render(_args, value) {
    const lines = (value?.items ?? []).map((it) => `- ${it.key}: ${it.text}`)
    return [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : '(no memories)' }]
  }
}

// ── apply(ctx, config) is the plugin body ────────────────────────────────────
export function apply(ctx, config) {
  const resolved = config

  // Keep the domain handle; close it when the fiber unloads.
  let domain
  const ready = ctx.storageDomain
    .open(MEMORY_DOMAIN)
    .then((d) => { domain = d; return d })

  ctx.effect(() => () => { void domain?.close() })

  // ── (1) System-prompt section: standing instructions on EVERY model step ────
  // `text` as a FUNCTION is re-evaluated per assembly, so the memory block can
  // change without re-registering. Avoid literal `{{...}}` — interpolation is
  // strict and an unregistered reference throws at render time.
  ctx.systemPrompt.section({
    name: 'plugin:memory:standing',
    order: resolved.sectionOrder,
    text: () => {
      if (domain === undefined) return ''
      const table = domain.table('memories')
      const keys = [...table.keys()].slice(0, resolved.instructionLimit)
      if (keys.length === 0) return ''
      const lines = keys.map((k) => `- ${k}: ${table.get(k).text}`)
      return `Here is what you remember about the user:\n${lines.join('\n')}`
    }
  })

  // ── (2) One Tool ───────────────────────────────────────────────────────────
  // defineTool({name, description, parameters, output, execute}).
  // `parameters` is DSH's own property-map DSL; `required: true` is a per-property
  // annotation on an implicitly open object root. `output` is MANDATORY.
  // Throwing from `execute` is how a call fails.
  ctx.tools.register(defineTool({
    name: 'remember',
    description: 'Store one durable memory about the user.',
    parameters: {
      key: { type: 'string', required: true, description: 'Stable short identifier.' },
      text: { type: 'string', required: true, description: 'The fact to remember.' }
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { stored: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: value?.stored ? 'Stored.' : 'Not stored.' }]
    },
    async execute(args, exec) {
      // exec: ToolRunContext — exec.signal (AbortSignal, required to observe),
      //       exec.agent (may be undefined), exec.callId, exec.deferContext(),
      //       exec.concludeTurn().
      const d = await ready
      await d.table('memories').put(args.key, {
        text: args.text,
        createdAt: new Date().toISOString()
      })
      return { stored: true }
    }
  }))

  // ── (3) One slash Command ──────────────────────────────────────────────────
  // Registering here makes it appear in the GUI `/` menu automatically — the
  // dsh-client-ui-commands client package calls command.list and renders it.
  // A handler returns CommandResult: {kind:'success', text?, sourceEventSeq?}
  //                              | {kind:'error', text}   — NOTHING ELSE.
  // There is NO file-return API. Command output never enters model history.
  ctx.commands.register({
    name: 'memory',
    description: 'Show or clear what the assistant remembers about you.',
    // Optional: advertises a free-form input hint to capable composers.
    input: { hint: 'list | clear <key>' },
    // `recordInput: false` would omit rawInput from the command/run log entry.
    async handler(invocation) {
      // invocation: {commandId, agent, rawInput, attachments, signal}
      const d = await ready
      const table = d.table('memories')
      const [verb, arg] = invocation.rawInput.trim().split(/\s+/, 2)

      if (verb === 'clear' && arg) {
        const existed = await table.delete(arg)
        return existed
          ? { kind: 'success', text: `Forgot "${arg}".` }
          : { kind: 'error', text: `No memory named "${arg}".` }
      }

      const keys = [...table.keys()]
      if (keys.length === 0) return { kind: 'success', text: 'Nothing remembered yet.' }
      return {
        kind: 'success',
        text: keys.map((k) => `${k}: ${table.get(k).text}`).join('\n')
      }
    }
  })

  // ── (4) OPTIONAL: honour the file sandbox when you touch ctx.fs ─────────────
  // There is no declarative "I need file access" field. Resolve the caller's
  // policy and pass it down; the 5th argument is ignored by the bare local
  // backend but enforced by dsh-fs-sandbox.
  ctx.tools.register(defineTool({
    name: 'memory_export_note',
    description: 'Write a plain-text memory dump into the workspace.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to write.' }
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { written: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `Wrote ${value?.written ?? '?'}` }]
    },
    async execute(args, exec) {
      const d = await ready
      const table = d.table('memories')
      const body = [...table.keys()].map((k) => `${k}: ${table.get(k).text}`).join('\n')

      // FsTarget exists ONLY via ctx.fs.resolve — there is no fs.target()/fs.cwd().
      const target = await ctx.fs.resolve(args.file_path, exec.signal ? { signal: exec.signal } : {})
      // ctx.sandboxPolicy.resolve() gives {mode, workspaceRoot, sessionId?}.
      const policy = ctx.sandboxPolicy?.resolve(
        exec.agent !== undefined ? { session: exec.agent.session } : {}
      )
      await ctx.fs.writeText(target, body, undefined, exec.signal, policy)
      return { written: target.displayPath }
    }
  }))
}
```

### 11.4 Adding a request for approval (optional, in `apply`)

```js
  // A tool CANNOT declare that it needs approval. Either register a
  // tools/pre-execute listener that returns {kind:'ask'}, or ask directly.
  // The listener form: the registry calls ctx.approval.request for you and
  // denies on anything other than 'allowed-once'.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'remember') {
      return Promise.resolve({ kind: 'ask', reason: 'store a durable memory' })
    }
    return next()
  })

  // The direct form (inside execute()), fail-closed by hand:
  //   const approval = ctx.get('approval')            // opportunistic, no inject
  //   if (approval === undefined) throw new Error('approval channel unavailable')
  //   const outcome = await approval.request({
  //     agent: exec.agent, toolName: 'remember', callId: exec.callId,
  //     reason: 'store a durable memory', signal: exec.signal
  //   })
  //   // ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  //   if (outcome !== 'allowed-once') throw new Error(`refused: ${outcome}`)
```

### 11.5 Import paths — what is verified and what is not

The import specifiers above were **resolved against the real `exports` maps** of the installed
packages:

- `defineTool` **is** exported from the `@deepseek-ai/dsh-tools` package root —
  `PKGS\dsh-tools\lib\index.js` line 3577:
  ```js
  export { CodeRunFailedError, JsonSchemaError, RUN_CODE_NAME, TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_RUNTIME_SCHEDULER, ToolArgsError, ToolNotFoundError, ToolOutputError, ToolRuntime, ToolRuntime as default, assertObjectJsonSchema, assertSupportedJsonSchema, defineContentToolFixture, defineTool, jsonSchemaToPy, jsonSchemaToTs, parameterSchemaSpecToJsonSchema, renderToolsSdk, renderToolsSdkPy, validateArgs, validateJsonSchemaValue, valueSchemaSpecToJsonSchema };
  ```
  (There is **no** `"./schema"` subpath in its `exports` map, even though `lib/types/schema.d.ts`
  ships.)
- `defineDomain` / `domainTable` **are** exported from the `@deepseek-ai/dsh-storage-domain` root —
  `PKGS\dsh-storage-domain\lib\index.js`:
  ```js
  export { Config, DomainError, DomainFacility, apply, defineDomain, descriptorOf, domainTable, inject, name };
  ```
- `z` from `@deepseek-ai/schemastery` is the default export, exactly as
  `PKGS\dsh-fs-local\lib\index.js` line 4 uses it.

Still **not verified** (no compiler was run, and nothing was executed):

- Whether all four `@deepseek-ai/*` packages resolve from a `link:`-installed out-of-tree plugin
  without declaring them in its own `package.json`. They should, via the flat
  `$DSH_HOME/profiles/node_modules` fallback (`healProfilesModuleFallback` symlinks the dsh app's
  whole dependency closure there, so "every in-box plugin resolves without pnpm ever managing it"),
  but **declare the `@deepseek-ai/*` packages you import as `peerDependencies`/`dependencies`**
  anyway.
- A local plugin must be `"type": "module"` (all shipped plugins are ESM).
- The skeleton was never type-checked or booted.

---

## 12. Things I could NOT verify, or that the task assumed and do not exist

| Assumed | Reality |
|---|---|
| `C:\…\app.asar\dsh\` is a readable checkout | **It is not.** `app.asar` is a packed file; `app.asar.unpacked\dsh\` holds only native-module `node_modules`. Real source used: `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\`. |
| `reusable` plugin field | **Absent.** 0 matches in Cordis 4.0.2. |
| `ctx.commands.registerFileReceiptResolver` / `FileReceipt` | **Absent.** 0 matches anywhere. `CommandResult` is `text` only. |
| `ApprovalDecision` | **Absent.** The type is `ApprovalOutcome = 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`. |
| `dsh-authorization` = permission gate | No — it is the credential/OAuth-flow seam. |
| `ToolDefinition.permissions` / `.requires` / `.network` / `.capabilities` / `.annotations` | **Absent.** The only similar name is the model-facing tool *argument* `sandbox_permissions`. |
| `ExecutionPolicy` (bare) | **Absent.** The type is `SandboxExecutionPolicy` (and `SandboxPolicy` for confined modes). |
| `Fs` type, `FsSandboxPolicy`, `ctx.fs.writeFile/readFile/exists/mkdir/remove/move/list` | **Absent.** The service type is `FileSystem`; there are exactly 12 primitives. |
| `StorageHandle`, `Store`, `ctx.storage.get/set` | **Absent.** `ctx.storage` is a backend registry; the raw layer is `StorageBackend`/`KvFacet`/`KvUnit`/`KvUnitDescriptor`. |
| `SubagentHandle` | **Absent.** Closest types: `AgentHandle`, `SubagentRun`. |
| `ctx.subagents.prompt(...)` method | **Absent.** `prompt` is a required request *field*; the follow-up method is `followup(...)`. |
| `ctx.storageDomain` per-user/per-session scoping | **Absent.** You must encode scope in your own keys. |
| `ctx.slots.contribute` | **Absent.** The API is `ctx.slots.inject(key, () => ctx.slots.register(opts, Component))`. |
| `listSubTree` as a Slots service method | No — it is the **Client Inspect provider** method `Slots.listSubTree`, delegating to `slots.snapshot(root)`. |
| `pnpm run dev:web` as a plugin-level build script | It is a **DSH monorepo** script. Installed packages expose `bundle: tsdown` / `watch: tsdown --watch`; a local plugin brings its own watcher. |
| The whale widget demonstrates the `dsh.client` contract | **It does not.** It has no `exports` and no `dsh.client`; it is a Host-only plugin serving its own JS route + `tapIndex`. Useful as local-plugin *wiring* ground truth only. |
| **Live verification of the running GUI** | **Not done.** I did not call `cordis_inspect_query` against a live page; the client Inspect providers time out when no page is connected (a subagent confirmed `Slots.listSubTree` and `Theme.listTokens` both timed out after 10 s with "Open or reconnect the Harness page"). Slot ids, props, and theme tokens above come from the shipped static declarations and bundles, not from a live tree. |
| **Compiling/running the §11 skeleton** | **Not done.** No type-checker or build was executed (read-only research). |
| `dsh.client` as a `.d.ts` type | **No declaration exists anywhere.** The only `dsh`-manifest type is `DshManifestSection`, which declares just `bundle`/`profile`. The authority is the runtime parser `parseDshClient` (quoted in §2c). |
| `SlotCore` / `BaseOptions` `.d.ts` | **Unavailable.** `@deepseek-ai/dsh-client-ui-slots` and `@deepseek-ai/dsh-client-ui-primitives` are **not installed packages** — the web shell seeds them. `SlotCore.register`'s signature was recovered from the embedded catalog in `dsh-cordis-client-runner\lib\client.js`; `BaseOptions` itself could not be quoted. |
| Full `design-platform.css` alias-token list | **Not obtainable.** It is one minified line (~2000+ chars) that the read tool truncates. The 13-name `BUILTIN_INSPECT_TOKENS` set is the authoritative *overridable* directory. |
| `--dsw-font-mono` | Used by a shipped package but **not declared anywhere** in the tree. |
| `hook/*` permission bridge | Only a documentation *reference* exists; no hooks package is installed. |
| Writer of `C:\Users\<user>\.dsh\storages\session_projcache\sessions\*.json` (100 files) | **Unidentified.** It does not match the installed `dsh-storage-json` naming or `UnitState` format. Treat as legacy residue, not a layout to copy. |
| Names that do **not** exist (do not invent identifiers) | `BundleManifest`, `PatchLayer`, `LoaderEntry`, `ResolvedBundle` (dsh-app-boot); `WebServerRoute`, `RouteOptions` (the webserver field is `handler`; the types are `WebRoute` / `WebUpgradeRoute` / `WebRouteKind` / `IndexInjection`). The patch element type is `PatchOptions` (from `cordis-plugin-include`); the inserted row type is `EntryOptions` (from `cordis-plugin-loader`). |

Every package inspected reports version `0.1.1-rc.2`; Cordis reports `4.0.2`.

**Files modified: none. One file created: this document.**
