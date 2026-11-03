# omac Plugin Architecture (Master Plan)

Status: Draft. Master plan + phased PRs (§7), progress tracked in issue #7. Installation / configuration / loading / activation aligned with OpenCode V2; hook execution rules follow omac's own design (§5), addressing OpenCode's open issues.
Reference: OpenCode V2 (anomalyco/opencode `dev` @ e31136bdb, 2026-10-11, effect 4.0.1), local `/tmp/github.com/anomalyco/opencode`.

First use case: A plugin intercepts session spawn to select harness and model based on task attributes (complexity, file paths, keywords, task type). A second use case: a plugin decides where a session restarts after a usage limit (`agent.fail`).

## 0. Decided Choices

| Decision                                  | Content                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                                       | Follow OpenCode V2 Effect edition: `Plugin.define({ id, effect })`, `ctx.<domain>.hook(...)`; Effect-only, no Promise edition                                        |
| Package                                   | `@omac/plugin` (repo package `packages/plugin`), mapped at runtime by omacd, normally imported by plugins                                                            |
| Config                                    | Single location: `plugins` field in `~/.omac/omac.json` (JSONC) + directory `~/.omac/plugins/` (`OMAC_HOME` relocates both); format aligned with OpenCode            |
| Project-level plugins                     | None for now, deferred for future consideration                                                                                                                      |
| npm plugins                               | Aligned with OpenCode: config specifies `pkg@ver` for automatic installation; implemented with omacd acting as bun (`BUN_BE_BUN=1 omac add`), adding no dependencies |
| Hot reload and activation wait            | Required once npm is supported (async installation), aligned with OpenCode's supervisor; spawn activation wait has a cap                                             |
| Multiple plugins modifying the same value | One event mutated in place by every callback in plugin order (no per-callback copy); later execution overrides; host records source via per-callback diffs           |
| Composition mode                          | Sequential for every hook; the default harness choice (`@vibest/plugin-harness-choice`, bundled by the product) runs first                                           |
| Rejection                                 | Only `agent.start.before` may refuse (`AgentRefused`): a defect or a timeout there is also a refusal. On `agent.fail` a defect or timeout fails that operation       |

## 1. OpenCode V2 Reference (Source Code Studied)

| Aspect                | Approach                                                                                                                                                                                                                                                                                                                                                                                           | Location                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Configuration source  | 6 tiers low to high: remote wellknown → global directory `~/.config/opencode/` (`opencode.json(c)` + `plugin(s)/`) → `OPENCODE_CONFIG` specified file → upward `opencode.json` from cwd → upward `.opencode/` from cwd → `OPENCODE_CONFIG_CONTENT`; plus managed policy. omac only uses the "global directory" tier                                                                                | `core/src/config.ts`, `config/discovery.ts`                          |
| Plugin entries        | `plugins: (string \| { package, options })[]`; `"-x"` denotes removal, supports `*`, `x.*`; `./`, `../`, `file://` resolved relative to config file; local paths in config must be directories (packages), files are warned and skipped                                                                                                                                                            | `schema/src/config/plugin.ts`, `config/plugin/source.ts`             |
| Plugin directory      | `plugin/`, `plugins/` under config root, sorted by path; `.ts`, `.js`, directory, symlink                                                                                                                                                                                                                                                                                                          | `plugin/source-directory.ts`                                         |
| Order                 | Directory-discovered first, config `plugins` after ("explicit config applied last to override/remove auto-discovered"); overall sorted by builtin pre → sdk → instance → user → builtin post                                                                                                                                                                                                       | `source.ts`, `supervisor.ts`                                         |
| Entrypoint            | Directory / package resolved via `server`, `tui`, `rpc` subpaths, defaulting to `index`; package entrypoint must reside within package directory                                                                                                                                                                                                                                                   | `plugin/src/host.ts`                                                 |
| Module validation     | `Schema.decodeUnknownEffect` validates `default` as `{id, effect}` or `{id, setup}`; `define` simply returns input as-is                                                                                                                                                                                                                                                                           | `plugin/module.ts`                                                   |
| npm                   | `@npmcli/arborist` installs to cache dir; activates with local existing version first, missing ones installed then activated; checks updates every 24h, locks per package                                                                                                                                                                                                                          | `util/src/npm.ts`, `plugin/update.ts`                                |
| Local source & reload | `Bun.Transpiler.scan` scans local dependency graph and watches each; evicts `require.cache` before reload; cached by sha256, unchanged content not re-executed (no retry on failure)                                                                                                                                                                                                               | `plugin/src/source.ts`, `source.bun.ts`                              |
| effect instance       | `Bun.plugin` `build.module` maps `effect`, `effect/*`, `@opencode/plugin` to host instances, foreign copies error; static subpath table generated at compile time                                                                                                                                                                                                                                  | `plugin/src/runtime.ts`, `runtime-modules.ts`, `cli/script/build.ts` |
| supervisor            | config / source files / policy / 24h / update events → capacity-1 sliding queue + 100ms debounce → single consumer serial `activate()`; on trigger `hold()` closes readiness Latch, entrypoint `awaitActivation`                                                                                                                                                                                   | `supervisor.ts`, `plugin/service.ts`                                 |
| Activation            | Serialized via Semaphore; diffs `(id, revision)` prefix: unchanged prefix retained, suffix torn down in reverse order then rebuilt in order; each plugin `Scope.fork(root)`, context retains only Scope + logger, `withSpan("Plugin.load")`; setup failure closes scope, marks failed, rolls back to previous version; same revision failure does not retry; duplicate ids first-come first-served | `core/src/plugin.ts`                                                 |
| Dispatch              | Serial in caller's fiber in registration order, callbacks directly mutate same event object; no timeout; failures bubble up (typed error on `tool.execute.before` is rejection); does not track who changed what                                                                                                                                                                                   | `plugin/hooks.ts`                                                    |

## 2. Verified (Bun 1.4.2 + effect 4.0.2, Compiled Binary)

```
Bun.plugin maps effect:                 plugin and host share same Effect module: true
No mapping:                             Cannot find package 'effect'
Plugin bundles its own effect:          host instance still used (mapping takes precedence)
import "effect/Schema" unmapped:        Cannot find module 'effect/Schema' (subpaths must also be mapped)
effect root namespace exports 145 top-level modules: effect/X maps directly to effect.X, no static table needed
BUN_BE_BUN=1 <binary> --version:        1.4.2
BUN_BE_BUN=1 <binary> add is-number@7.0.0 (no bun in PATH): 1 package installed
```

Timeout semantics (effect 4.0.2):

```
Effect.timeoutOption(Effect.never)                        → returns in 305ms
Effect.timeoutOption(Effect.promise(never resolves))       → returns in 302ms (Effect 4 promises are interruptible)
Effect.timeoutOption(Effect.uninterruptible(sleep 1.5s))  → returns in 1503ms (waits for uninterruptible region to finish)
timeoutOption(Fiber.join) after forkDetach                → returns in 304ms
```

## 3. Plugin API

```ts
// @omac/plugin
export namespace Plugin {
  export interface Plugin { readonly id: string; readonly effect: (ctx: Context) => Effect.Effect<void, never, Scope.Scope> }
  export const define = (plugin: Plugin) => plugin          // Identity function, for type inference only
}

// Hooks are registered on their domain (ctx.agent.hook("start.before", ...)), OpenCode V2 style
export interface Hooks {
  readonly "agent.start.before": { readonly event: AgentStartBefore; readonly error: AgentRefused }
  readonly "agent.fail": { readonly event: AgentFail; readonly error: never }
}

export interface Context {
  readonly options: Readonly<Record<string, unknown>>        // options from config entry
  readonly agent: { readonly hook: <S extends "start.before" | "fail">(short: S, callback: ...) => Effect.Effect<void, never, Scope.Scope> }
  readonly subscription: { readonly report: (input: SubscriptionReport) => Effect.Effect<void> }  // unregistered when scope closes; an unknown name fails setup
}

export interface AgentStartBefore {
  readonly project: string                                    // Project directory; readonly enforced at type level only, not checked at runtime
  readonly agentType: string                                  // "main" for the Project's main Agent, else the definition
  readonly parentSessionId: string | undefined                // who asked; undefined for the main Agent
  readonly access: "read" | "write"
  readonly harnesses: ReadonlyArray<HarnessOption>            // every harness as preflight saw it
  readonly subscriptions: ReadonlyArray<SubscriptionSnapshot> // logins and usage windows, per (harness, provider)
  readonly attempts: ReadonlyArray<Attempt>                   // earlier tries for this session
  prompt: string                                              // mutable: the session receives the final value
  harness: string | undefined                                 // mutable: the caller's preference on entry; validated post-hook by host (§5)
  provider: string | undefined
  model: string | undefined
}

export interface AgentFail {                                  // a started session's round failed
  readonly sessionId: string
  readonly reason: "limited"                                  // only reason produced today
  readonly error: string                                      // the harness's own error text
  readonly turn: string                                       // the failed round's text (what a move resends)
  readonly harness: string
  readonly provider: string | undefined
  move: { harness: string; provider?: string | undefined; model?: string | undefined } | undefined  // mutable: where the session restarts
}

export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", { reason: Schema.String }) {}
```

The plugin's `AgentRefused` only contains `reason`; wire (RPC) error is defined by the host, see §5.

Examples:

```ts
// ~/.omac/plugins/route.ts
import { Plugin } from "@omac/plugin"
import { Effect } from "effect"

export default Plugin.define({
  id: "route",
  effect: (ctx) =>
    ctx.agent.hook("start.before", (e) =>
      Effect.sync(() => {
        if (e.model) return // Don't override if already selected by coordinator or earlier plugin (convention)
        if (/^(research|investigate)\b/i.test(e.prompt)) {
          e.harness = "claude"
          e.model = "claude-haiku-5-5"
        } else if (/refactor|migrat/i.test(e.prompt)) {
          e.harness = "claude"
          e.model = "claude-opus-5-5"
          e.prompt += "\n\nRun the full test suite before reporting."
        }
      }),
    ),
})
```

```ts
// Guard: refuse
import { AgentRefused, Plugin } from "@omac/plugin"
export default Plugin.define({
  id: "budget",
  effect: (ctx) =>
    ctx.agent.hook("start.before", (e) =>
      e.model?.includes("opus") && e.project.includes("/sandbox/")
        ? Effect.fail(new AgentRefused({ reason: "opus is not allowed in sandbox repositories" }))
        : Effect.void,
    ),
})
```

```ts
// Move a limited session somewhere else (the builtin default already does this; a plugin may override)
import { Plugin } from "@omac/plugin"
export default Plugin.define({
  id: "cheap-second",
  effect: (ctx) =>
    ctx.agent.hook("fail", (e) =>
      Effect.sync(() => {
        if (e.reason === "limited" && e.move === undefined) e.move = { harness: "cursor" }
      }),
    ),
})
```

Setup can use `Effect.acquireRelease` for resources (tied to plugin scope, released on unload / reload / omacd exit); callbacks can perform async work (subject to timeout).

## 4. Configuration, Installation, and Loading (Aligned with OpenCode)

```jsonc
// ~/.omac/omac.json (parsed as JSONC, comments and trailing commas allowed, matching OpenCode's opencode.jsonc)
{
  "plugins": [
    "/Users/me/omac-plugins/route", // Local package directory (local paths in config must be directories)
    { "package": "omac-plugin-budget@1.2.0", "options": { "deny": ["opus"] } }, // npm (Phase 3)
    "-hello", // Removal; supports "*", "x.*"
  ],
}
```

- Directory `~/.omac/plugins/`: `.ts`, `.js`, directories, and symlinks are plugins, sorted by path; skips `node_modules`, dot-prefixed entries, and `*.d.ts`. Directories without entrypoints are skipped with a warning (matching OpenCode `config/plugin/source.ts:154`, with an added log line in omac).
- Type dependencies for plugin development (`package.json`, `node_modules`) live under `~/.omac/` root, not inside `plugins/`; Bun resolves them upwards from the plugin file.
- **Order**: Discoveries in `~/.omac/plugins/` first (sorted by path), then `omac.json` `plugins` (explicit config applied last, allowing it to remove auto-discovered plugins). This defines the execution order.
- Entrypoint: A file is its own entrypoint; a directory looks for `server.{ts,js,mts,mjs}`, falling back to `index.*` (Phase 1; resolving `server` subpaths in `package.json` comes with npm in Phase 3).
- Validation: `default` must be `{ id: string, effect: function }`, otherwise marked failed with reason.
- Setup timeout: Setup also has a timeout (same Layer parameter as callbacks): timeouts mark the plugin failed ("setup timed out") and close its scope without blocking omacd startup.
- effect instance: `src/platform/bun.ts` (typecheck rules require `Bun.*` to remain inside `src/platform/`) installs `Bun.plugin` before loading, mapping `effect`, `effect/*` (excluding `internal/`), and `@omac/plugin`; `effect/X` dynamically maps at runtime to host `effect.X` (§2), identical in dev and compiled binary, no build script needed; plugin's bundled copy is shadowed by mapping (`test/plugin-binary.test.ts`). Plugins declare `effect` as peerDependency.
- npm (Phase 3): `BUN_BE_BUN=1 <omac binary> add <pkg@ver>` installs into `~/.omac/packages/`; locally available versions activated first, missing ones activated once installed; 24h update check.
- Trust: Plugins share process and permissions with omacd, no sandbox; synchronous infinite loops will hang omacd, an accepted limit.
- Plugin directory is not exposed to sessions; session rules and tools never touch it. Sessions already share permissions with the user and can edit any file under the user's home directory (shell config, harness settings); the plugin directory introduces no additional attack surface and requires no special guards. In Phase 2, file-change-triggered reloads log an info line specifying which file changed (the 1s reconciliation read below has no trigger file, so it skips this line).

**Hot Reload (Phase 2)**

- Startup: omacd does not block on plugins; initial activation runs in background; spawn and `omac plugins` await it (§5).
- Watching: `omac.json`, `plugins/`, and each plugin's local dependency graph (files imported via `./`, `../`, absolute paths, or `file://`, recursively; excluding `node_modules`). Creation, deletion, rename, and atomic saves (write tmp file then rename) count as changes. Non-existent paths (uncreated directories in config, unresolved imports) watch nearest existing ancestor directory.
- Coalescing: Changes enter a capacity-1 sliding queue, quiet for 100ms debounce, then re-read and activated by a single consumer; activations never overlap. If the watched set changes during re-read (watchers opened or closed, including initial startup setup), re-read until stable, followed by a one-time catch-up re-read after 1s; reloads without watched set changes skip catch-up (macOS `fs.watch` in Bun 1.4 occasionally drops events for other directories after closing a watcher). Only this single catch-up is done, no continuous polling; watching does not guarantee zero dropped events.
- Revision: Hash of all file contents across the local dependency graph (plus listing of directories containing unresolved imports). On reload, entrypoints and their local imports use a fresh module key (`<file>?omac-load=<n>`) before `import()`, evicting old keys from module cache; modified transitive dependencies re-evaluate (including top-level await), matching across source and binary. Since Bun 1.4.3, top-level await from unfinished modules remains keyed by path outside `require.cache`, causing subsequent imports of the same path to hang indefinitely, so cache eviction alone is insufficient.
- Symlinks: Entrypoints imported by realpath, dependency graph computed from real files; symlink itself is watched so target changes, dangling links, or fixes trigger reload.
- Activation: Finds longest unchanged prefix by `[source, revision, options]`, tears down remainder in reverse order and rebuilds in order; each rebuilt plugin becomes visible to dispatch immediately; in-flight dispatches finish before tearing down old hooks.
- Bounds: import and setup each capped at 5s (`import timed out after 5s`, `setup timed out`); abandoned async imports may finish top-level side effects, but results are discarded (no setup, no hooks registered); these side effects (filesystem writes, modifying global/shared module state) may affect running versions without isolation.
- Failure: import or setup failures on the same revision do not retry; unrelated changes will not re-import it. When a new revision fails, rollback restores previous working version, `omac plugins` reports `revision X failed, still running Y: …`; if previous version also fails to restore (setup fails or id claimed by earlier plugin), marked failed with `revision Y not restored: …`. Broken `omac.json` retains last valid config.
- `node_modules` is neither watched nor evicted from module cache. Newly installed missing dependencies wait for changes in the plugin's own dependency graph before re-importing (changes in other plugins won't retry an unchanged revision); updated or modified loaded packages continue using cached version until omacd restart.
- Known limits: Teardown capped at 5s; timed-out old scope finishes on its own, so finalizers may overlap with new setup; omacd exit does not time out plugin finalizers, uninterruptible finalizers can stall exit; sync infinite loops hang omacd (see "Trust" above).

## 5. Execution Rules (omac's Own)

- Trigger point: In `Sessions.spawn` (`packages/cli/src/sessions.ts`), resolve `repositoryRoot` to repo root first (moving `topLevel` before validation), run hooks immediately after, then run `checkProvider` / `available` / `integration` and row insertion. CLI `omac run` passes through `Server.Spawn` → `Sessions.spawn` (the former MCP `assign` / `handoff` did too; removed in #13), the sole trigger point. herdr session is resolved in `Server.Spawn` prior to hooks, which does not affect "rejection prevents pane launch".
- Every hook is `sequential`: callbacks run serially in the caller's fiber in §4 order (the default harness choice, `@vibest/plugin-harness-choice`, first, then the runtime plugins), before the session is admitted or its pane started (`agent.start.before`), or before the round ends on a limit (`agent.fail`). A usage-limit move runs `agent.start.before` once more for every candidate it is about to start, with the move's harness/provider/model and the session's earlier tries prefilled: a refusal there skips that candidate, and what the chain decides is what starts.
- Two hooks are registered: `agent.start.before`, `agent.fail`. `ctx.agent.hook` with any other name (including the earlier `session.start.before`, `session.spawn` and `worker.spawn`, which have no alias) fails the plugin's setup with `unsupported hook "<name>"; supported: agent.start.before, agent.fail`, so a stale plain-JS plugin shows as `failed` in `omac plugins` instead of running.
- Every callback mutates the one event in place: no per-callback copy, so a later plugin sees (and may overwrite) what an earlier one wrote, and a failed or timed-out callback's writes stand unless a later callback overwrites them. Host diffs top-level fields generically (no field whitelist), recording trace `{ plugin, hook, ms, outcome: "ok" | "refused" | "crashed" | "timeout", changes }`. Readonly fields enforced at compile time via TS `readonly`.
- 5s callback timeout: Callback forked into plugin's own scope with timeout on `Fiber.join`, returning on time even with uninterruptible regions; abandoned fiber finishes on its own, cleaned up by plugin scope (§2). Timeout is Layer parameter (like `options.maxSessions`), default 5s, tests inject shorter values; not user-configurable for now.
- On `agent.start.before`, a callback failure or timeout is a refusal, never a skip: nothing is inserted, no pane starts. On `agent.fail` a failure or timeout fails that operation: the round ends failed with the plugin error (no move). Nothing is skipped silently.
- `AgentRefused` (only meaningful on `agent.start.before`): Stops immediately, no row inserted, no pane started. Host maps it to wire error `AgentRefused { plugin, reason }` (host injects `plugin`), added to `Spawn.error` in `rpc.ts`; `omac run` reports `AgentRefused: …` on stderr and exits 1. Elsewhere an `AgentRefused` counts as a crash.
- Normal validation after merging; invalid values yield `HarnessUnavailable` with plugin id that wrote it. If no source provides a harness, returns tagged `NoHarnessChosen` with actionable message: "pass harness, or install a routing plugin", also added to `Spawn.error`.
- New hooks are added to the `Hooks` map in `@omac/plugin` with their event and error types; every hook composes the same way (sequential, one event mutated in place).
- From Phase 2: spawn and `omac plugins` await in-flight activations (including queued pending changes) up to 10s; timeouts proceed with currently active plugins, spawn trace records `plugins still activating`.
- Observability: trace recorded in session row `metadata.routing`; `assign` return value and `list_siblings` include final harness / model and deciding plugin; each callback gets an `omac.plugin.hook` span. `agent.fail` traces live with the move's failure result.

Coordinator side: `harness` becomes optional in `Spawn` (`rpc.ts` → `SpawnInput`); CLI spawn harness positional argument accepts `auto` (delegated to plugins; retains positional arg without breaking existing usage); `rules.ts` "Harnesses and models" adds a note: when a routing plugin is installed, harness / model may be omitted, and results will report what was chosen.

No task attributes: model-reported type/complexity is subjective, keywords duplicate prompt; plugins route based on `prompt` and `repository`. Claude Code / OpenCode let models pick named agent profiles; consider this path if needed, rather than adding attributes.

## 6. Verification Clauses (Test Coverage Requirements)

Sources are issues from anomalyco/opencode; mostly from V1, while V2 resolved deterministic ordering and interruptibility, timeouts, conflicts, and traceability remain open. "Phase" indicates which PR delivers the clause.

| #   | Phase  | Clause                                                                                                                                                                                                                                   | Source                                                 | Test                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | 1      | Deterministic ordering: `plugins/` path-sorted first, `omac.json` `plugins` after; independent of directory listing order; `-x` removes; `node_modules`, dotfiles, `*.d.ts`, and directories without entrypoints do not count as plugins | #45367                                                 | Two plugins write the same field: swapping config order swaps result; discovery unit test injects shuffled listing, output order unchanged; removed via `-x` does not execute; `node_modules/`, `.x.ts`, `a.d.ts`, empty dir under `plugins/` do not appear in plugin list (empty dir warns)                                                                                                                |
| P2  | 1      | A hook failure is a refusal that names the plugin; nothing is inserted or started                                                                                                                                                        | #45367, #39031                                         | Plugin 1 throws: spawn fails `AgentRefused` with `plugin <id> crashed: …`; later plugins not called; no row in db, no pane in herdr; trace has the crash                                                                                                                                                                                                                                                    |
| P3  | 1      | Hung hook does not hang spawn                                                                                                                                                                                                            | #39031                                                 | `Effect.never`, `Effect.promise(() => new Promise(() => {}))`, long `Effect.sleep`, `Effect.uninterruptible(Effect.sleep(...))`: spawn returns within timeout (asserted with TestClock virtual time; `TestClock.adjust` past sleep before test teardown so teardown does not await fiber), trace records `timeout`; after reject or timeout db has no extra row, herdr has no pane                          |
| P5  | 1      | Writable field mutations actually take effect                                                                                                                                                                                            | #39674, #31680, #26910                                 | Plugin mutates harness / provider / model: session row and `ADAPTERS[harness].launchArgs` reflect new values                                                                                                                                                                                                                                                                                                |
| P6  | 1      | Overrides are traceable                                                                                                                                                                                                                  | #6261, #12223                                          | A writes `model=a`, B writes `model=b`: final b; trace is `[{A, from: requested, to: a}, {B, from: a, to: b, overwrote: A}]`; return value and `list_siblings` show decided by B                                                                                                                                                                                                                            |
| P7  | 1      | All entrypoints share same path and same rules                                                                                                                                                                                           | #6261                                                  | All entrypoints going through `Spawn` (currently only CLI spawn) produce identical results and trace for identical input                                                                                                                                                                                                                                                                                    |
| P8  | 1      | Correct hook timing, output re-validated                                                                                                                                                                                                 | #19960, #44081                                         | Event `repository` is already repo root; plugin writes `harness = "vim"` → `HarnessUnavailable` includes plugin id                                                                                                                                                                                                                                                                                          |
| P9  | 1      | Readonly fields not writable in types; a refused callback stops the chain                                                                                                                                                                | Inherent risk of mutable objects                       | `e.project = ...` fails compilation (`@ts-expect-error`); mutating `prompt` takes effect, session receives new prompt                                                                                                                                                                                                                                                                                       |
| P10 | 1      | Setup failure or hang isolates to itself                                                                                                                                                                                                 | V2 scope-per-plugin                                    | Registers hook then throws: hook not called; other plugins normal; plugin failed with reason; setup is `Effect.never`: omacd listens normally, plugin failed with "setup timed out"; duplicate ids first-come first-served                                                                                                                                                                                  |
| P11 | 1      | Shared effect instance in compiled binary                                                                                                                                                                                                | §2                                                     | `test/plugin-binary.test.ts`, run binary after `bun run build`: plugin `import { Effect } from "effect"` and `import * as S from "effect/Schema"` work and share host instance; plugin's bundled effect still uses host's; `@omac/plugin` `AgentRefused` matches host `instanceof`                                                                                                                          |
| P12 | 1      | Plugin loading and execution visible at a glance, including running version                                                                                                                                                              | #39674                                                 | `omac plugins` shows source, revision (content hash / package version), load time, status, errors, plus calls, mutations, failures / timeouts / rejections, and latest error since omacd start; counts increment after spawn; file edits visibly desync with disk (auto-reloads from Phase 2). omacd log has one line per plugin loaded, one line per hook execution (info: plugin, duration, what changed) |
| P13 | Future | User plugins follow builtin plugins                                                                                                                                                                                                      | #12223                                                 | Add when introducing first builtin plugin                                                                                                                                                                                                                                                                                                                                                                   |
| P14 | 1      | Separate refusal from crash                                                                                                                                                                                                              | V2 `tool.execute.before`, #45367                       | Plugin 1 `AgentRefused("budget")`, plugin 2 writes model: plugin 2 not called, no row inserted, no pane started; RPC client receives `AgentRefused { plugin: plugin1, reason }`; a defect or timeout is also a refusal. A plugin that unsets the harness leaves `NoHarnessChosen`                                                                                                                           |
| P16 | 2      | Hot reload only rebuilds plugins after the change                                                                                                                                                                                        | V2 prefix diff                                         | Edit 2nd of 3 plugins: 1st does not re-setup (setup count unchanged), 2nd and 3rd rebuild in order, old scope finalizers executed                                                                                                                                                                                                                                                                           |
| P17 | 2      | Failed new revision preserves old revision without re-executing                                                                                                                                                                          | V2 rollback + digest cache                             | Break plugin: old version remains active, `omac plugins` shows error; unrelated file changes do not re-import broken file (import side-effect count unchanged); recovers when fixed                                                                                                                                                                                                                         |
| P18 | 2      | Coalesce rapid changes into single activation                                                                                                                                                                                            | V2 sliding queue + debounce                            | Save 10 times within 50ms: activates only once                                                                                                                                                                                                                                                                                                                                                              |
| P19 | 2      | Spawn waiting for activation is bounded                                                                                                                                                                                                  | V2 `awaitActivation` waits until npm install completes | Spawn waits at most 10s when activation is stuck, proceeds with active plugins, trace records `plugins still activating`                                                                                                                                                                                                                                                                                    |
| P20 | 3      | npm install does not block local plugins; failures isolated                                                                                                                                                                              | V2 local first then pending                            | Local plugins active while `pkg@ver` installs; activates automatically after install; install failure only marks that entry failed; installs even without bun in PATH                                                                                                                                                                                                                                       |
| P21 | 3      | npm plugins also share effect instance                                                                                                                                                                                                   | §2, OpenCode `runtime.ts`                              | Two use cases: npm plugin dependency tree includes another effect, bare `effect` and mapped subpaths both get host instance; referencing unmapped subpaths (resolving to bundled copy) fails load with path error                                                                                                                                                                                           |

## 7. Phased PRs

Each phase is a standalone PR, usable upon merge; subsequent phases only add to earlier APIs without modifying them.

**Phase 1: Core, usable and observable (local plugins, loaded on startup)**

- `packages/plugin` (`@omac/plugin`): §3 types, `Plugin.define`, `AgentRefused`.
- Configuration and discovery: `plugins` in `~/.omac/omac.json` (local path entries, removal, wildcards) + `~/.omac/plugins/`; npm entries marked failed initially: "npm plugins are not supported yet".
- Loading: Entrypoint resolution, Schema validation, `Bun.plugin` mapping (`effect/X` → `effect.X`, generated at runtime).
- Activation: One-time activation when omacd builds Layer (listens after Server, no waiting needed), `Scope.fork`, failure isolation, id deduplication; plugin changes require omacd restart.
- Execution: All §5 rules; changes to `sessions.ts`, `rpc.ts`, `rules.ts`, `daemon.ts`, `paths.ts`; SPEC §14 "no separate config file" changed to `omac.json`, SPEC §7 adds `Plugins`.
- CLI: spawn harness accepts `auto`; RPC contract (SPEC §7) adds `Plugins`, `omac plugins` queries through it.
- Types for plugin authors: Provided by mapping at runtime; when writing plugins, run `bun add -d github:iamdin/orchestrate-my-agent-cli#path:packages/plugin` or use local `file:` path under `~/.omac/` root (not in `plugins/`, §4); verified `bun add -d file:<clone>/packages/plugin effect@4.0.2`: plugin typecheck passes, writing readonly fields raises TS2540. GitHub subpath install unverified; before npm publishing (Phase 3), package must be converted to publish build artifacts rather than `.ts` sources.
- Observability:
  - Loading: `omac plugins` lists source, revision, load time, status (active / failed), and errors for each plugin; omacd logs one line per plugin loaded.
  - Runtime: `omac plugins` also lists calls, mutations, failures, timeouts, rejections, and latest error for each plugin since startup (in-memory counters, reset on restart); each spawn trace appears in `assign` return value, `list_siblings`, and session row `metadata.routing`; omacd logs one line per hook execution (info: plugin, duration, what changed).
- Tests: P1–P3, P5–P12, P14.
- Acceptance scenarios (each step proven by test or script; use `FakeRuntime` in unit tests, real binary in `test/plugin-binary.test.ts`, real herdr gated by `HERDR_LIVE` following `live.test.ts`):
  1. `bun run build` generates binary; temporary `OMAC_HOME`, `plugins/` populated with `default.ts`, `route.ts`, `budget.ts`, `broken.ts`;
  2. Start omacd, `omac plugins`: first three active, `broken` failed with reason;
  3. Spawn with `type=research`: return value indicates route chose haiku, herdr `agent.start` args include `--model claude-haiku-5-5`;
  4. Spawn with sandbox repo + opus: rejected by budget, returns reason and plugin id;
  5. Check `omac plugins` again: counters reflect executions.
- Definition of done: All acceptance scenarios verified with evidence; P1–P3, P5–P12, P14 each have tests (P3 includes uninterruptible sections, P11 tested on real binary); `bun run typecheck` and all tests pass, missing `kind` in hook definition fails compilation, every hook is `sequential` (formerly P15); PR runs `/thermo-nuclear-code-quality-review` and `/ponytail-review` sequentially, up to 3 rounds each, both converging; SPEC §7 and §14 updated; issue #7 Phase 1 checked off with PR linked.

**Phase 2: Supervisor (hot reload and activation wait)**

- Watch `omac.json`, `~/.omac/plugins/`, and local plugin dependency graph; sliding queue + 100ms debounce + serial activation; prefix diff, rollback to last working version, no retry on same revision, digest cache; readiness Latch, spawn waits up to 10s. Actual behavior and known limits in §4 "Hot Reload".
- Tests: P16–P19 (`test/plugin-reload.test.ts`; binary reloading in `test/plugin-binary.test.ts`).

**Phase 3: npm Plugins**

- `BUN_BE_BUN` install to `~/.omac/packages/` (with file locking), pending activation, 24h update check, `omac plugins update <pkg>`; publish `@omac/plugin` to npm (the `@omac` org is not registered yet).
- Tests: P20, P21.

**Future (on demand, separate PRs; exposure order and boundaries in §8)**

- `omac route --prompt ...` dry-run (must reuse same trigger, P7).
- More hooks (proposed, not registered; `ctx.agent.hook` refuses them today): `session.result`, `session.send`, `coordinator.launch`.
- `first` / `parallel` composition modes; transform registry (plugins registering harness adapters or custom model catalogs).
- Project-level plugins (requires trust model: plugins execute inside daemon, sessions can write repository).
- Subprocess isolation.

## 8. Extension Mechanisms and Roadmap

Reference systems provide five primary extension mechanisms (Oct 2026 survey of OpenCode V2 `d21b0790a`, Pi 1.1.0, herdr `75f46fe8`):

| Mechanism         | Meaning                                | OpenCode V2                                                                                                                       | Pi                                                                                                  | herdr                                                                   |
| ----------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ① Intercept       | Mutate data or veto in-flight flows    | `session.hook("prompt" / "context")`, `tool.hook("execute.before")`, `permission.hook("evaluate")`, `shell.hook("create.before")` | `pi.on("input" / "tool_call" / "before_agent_start" ...)`, returns transform / block / cancel       | None                                                                    |
| ② Contribute      | Add new capabilities into system       | `transform` editor adds tool, command, provider, model, agent, skill, MCP, VCS, websearch, worktree policy, auth                  | `registerTool / Command / Shortcut / Flag / Provider / VirtualModel / McpServer`, various renderers | Manifest `[[actions]]`, `[[panes]]`, `[[link_handlers]]`, `[[startup]]` |
| ③ Edit State      | Mutate existing configs and registries | `ctx.<domain>.transform(editor)`, replayed on `reload`                                                                            | `setActiveTools`, `setModel`, `setThinkingLevel`                                                    | None                                                                    |
| ④ Callback System | Plugin invokes system capabilities     | Narrowed client subset per domain (`Pick<...Api>`), `generate`, `storage`, `rpc.register`                                         | `sendMessage`, `exec`, `ctx.ui` ..., tiered by Tool / Command context                               | Entire CLI / socket API serves as plugin SDK                            |
| ⑤ Observe         | Subscribe to events                    | `ctx.event.subscribe` → Stream                                                                                                    | Notification-only events + `pi.events` bus                                                          | `[[events]] on = "pane.*"`, `events.subscribe`                          |

omac's tradeoff: **Expose minimally first** (following herdr's philosophy). Interception opens only critical points, while other needs callback via `omac` CLI; open further points only with concrete demand, each in a separate PR.

| Mechanism         | omac Extension Points                                                                                                                                                                       | Status                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| ① Intercept       | `agent.start.before` (select harness / model / provider, mutate prompt, refuse); `agent.fail` (move a limited session); `session.result` (quality gate: send back for rework, auto-open PR) | `agent.start.before`, `agent.fail` implemented; `session.result` proposed, not registered |
| ② Contribute      | Harness adapter registration (add aider, gemini, opencode, etc.); `omac` subcommands; rule snippets                                                                                         | Not open for now; first candidate is harness adapter                                      |
| ③ Edit State      | Model catalog / defaults, rule templates                                                                                                                                                    | Not open for now                                                                          |
| ④ Callback System | Plugins directly invoke `omac` CLI (env provides `OMAC_HOME` / `OMAC_COMMAND`); narrowed omac client subset                                                                                 | No SDK provided for now, CLI is sufficient                                                |
| ⑤ Observe         | `session.status`, `session.spawned` (readonly, with trace), provided via Stream or `parallel` hook                                                                                          | Proposed, not registered; pending demand                                                  |

Constraints:

- Plugins do not access omacd internal services (Db, herdr connections); capabilities are strictly exposed via narrow interfaces on `ctx` or CLI.
- When contribution capabilities exceed two or three types, unify them into `ctx.<domain>.transform`; do not establish domain structures prematurely.
- All hooks compose the same way (§5): sequential, one event mutated in place.
