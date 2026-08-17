# Stack quirks

These differ from what the library names suggest.

- **Effect is 4.x RC, not v3.** `Schema` imports from `"effect"` (not
  `@effect/schema`); services are `Context.Service<Self, Shape>()("Tag")` with a
  hand-written `Layer`, not `Effect.Service`. Two experimental modules are in
  production use: `effect/unstable/cli` and `effect/unstable/process`.
- **oRPC is a locked beta and the transport is WebSocket**, not HTTP: one
  multiplexed connection via `@orpc/client/websocket`, with a lazy `connect`
  factory so each reconnect fetches a fresh ticket (browsers can't set headers on
  a WS upgrade, hence `POST /api/ws-ticket`). Server handlers are Effect-native
  through a side-effect import — `import "@orpc/experimental-effect/extensions/effect"`
  is what puts `.effect()` on procedures; delete it and the router stops compiling.
  Effect `Stream` → oRPC event iterator has one seam: `packages/server/src/rpc/stream.ts`.
- **`@vibest/contract` uses Effect Schema, not zod**, bridged through a local
  `toStandardSchema`. Chunk/message-shaped outputs deliberately use `type<T>()`
  and are not validated on the wire.
- **`packages/ui` sits on Base UI, not Radix** — compose with `render={<Button/>}`,
  not `asChild`.
- **TypeScript is 7.x, the native compiler.** `noEmit` everywhere; packages export
  `./src/*.ts` directly and only `server` and `vibest` build. `lib` is `es2022`,
  so `toSorted`/`toSpliced` don't typecheck — write `Array.from(list).sort()`.
  `noUncheckedIndexedAccess` is on, so indexed access yields `T | undefined`.

## Side effects go through Effect's platform services

New disk, randomness, and child-process code uses `effect/FileSystem`,
`effect/Crypto`, and `effect/unstable/process`'s `ChildProcessSpawner` — not
`node:fs` / `node:crypto` / `node:child_process`. `packages/server` was migrated
wholesale in `docs/2026-07-27-effect-platform-migration.md`; matching the
surrounding style means matching this.

## Where the boundary is

**Don't return `Effect` from a helper unless it actually performs effectful
work. Synchronous parsing, validation, path math, and option building stay
synchronous.** (Same rule opencode states in its `AGENTS.md`.)

The test is _"is this an effect?"_ — does it touch the outside world, can it
fail, is it non-deterministic — **not** _"did it come from a `node:` module?"_

|                                                                           | goes through Effect   | stays plain `node:`              |
| ------------------------------------------------------------------------- | --------------------- | -------------------------------- |
| read/write, `stat`, `mkdir`, `rename`                                     | `FileSystem`          |                                  |
| ids and tokens (non-deterministic, must be fakeable)                      | `Crypto`              |                                  |
| spawning children                                                         | `ChildProcessSpawner` |                                  |
| `join` / `dirname` / `relative` / `isAbsolute` / `sep` — pure string math |                       | `node:path`                      |
| `homedir()`                                                               |                       | `node:os` (no Effect equivalent) |

`effect/Path` is therefore reached for only when a library asks for it. Taking
`Path.Path` as a _parameter_ to do string work, or turning a pure function into
an `Effect` to reach it, is the thing this rule forbids. `packages/server` has
exactly one `Path.Path`, in `http/ui.ts`, and it is not ours —
`HttpStaticServer.make` requires it. (Reference point: opencode, also on Effect
4.x beta, uses `Path.Path` in 2 files across its core and server and
`Crypto.Crypto` in none.)

- **The dependency rides the `R` channel.** A function that touches disk is
  `Effect<A, E, FileSystem.FileSystem>`. Don't seal a layer inside
  the module and don't promote the need into a new service — the requirement
  bubbles to a composition root (`rpc/runtime.ts`, `apps/desktop`'s
  `desktop-runtime.ts`, the CLI), which is the only place `NodeFileSystem.layer`
  / `NodePath.layer` / `NodeCrypto.layer` appear.
- **A service shape stays `R`-free.** Bind the platform once while building the
  Layer — `const platform = yield* Effect.context<FileSystem | Crypto>()` — and
  `Effect.provide(platform)` each method. The `project` and `session`
  repositories are the pattern to copy.
- **Platform failures get mapped at the seam,** not propagated raw: the
  repositories' `StoreReadError` / `StoreWriteError` wrap them, and "file isn't
  there" is `error.reason._tag === "NotFound"`, never an errno string.
- **One gap to route around.** `FileSystem.access` has no `X_OK` — test
  executability with `stat` + `(info.mode & 0o111) !== 0`, as both executable
  resolvers do.
- **Tests:** real-fs + `mkdtemp` for behaviour, `FileSystem.makeNoop` (see
  `packages/server/test/fake-file-system.ts`) for failures a real disk won't
  produce on demand. A test that needs the real Node platform gets it from
  `@effect/vitest`'s `layer(...)` and writes `it.effect` bodies — never a local
  `run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(...)))`
  wrapper. That wrapper rebuilds its layer on every call, so two `run`s in one
  test silently get two service instances; it also forces every assertion out
  of the effect and into an `await`.
- **Per-test isolation is `Layer.build` inside the body,** not a second
  `layer(...)`: `layer(...)` memoizes per block, so anything stateful (a temp
  `$VIBEST_HOME`, an EventBus) would leak between tests. Put the platform in
  `layer(NodePlatformLayer)`, then build the service graph per test —
  `Context.get(yield* Layer.build(...), Tag)`. `it.effect` bodies are scoped, so
  `fs.makeTempDirectoryScoped` and `Effect.addFinalizer` replace
  `beforeEach`/`afterEach` and fire on the failure path too
  (`test/session-service.test.ts`, `test/daemon/launcher.test.ts`).
  `layer(..., { excludeTestServices: true })` when the code under test polls a
  real clock — the default `TestClock` never advances a retry schedule.
- **The HTTP seam is `NodeHttpServer.makeHandler`,** not `HttpServer.serve`:
  `serve` registers its own `upgrade` listener, and that event belongs to oRPC.
  `makeHandler` yields a plain node `request` listener,
  so `http/app.ts` is an ordinary Effect while `http/server.ts` keeps the raw
  upgrade block.

Exempt, deliberately — these are boundaries Effect doesn't model, and "it's
already written" is not a reason to add to the list:

| Location                                                                  | Why                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `daemon/launcher.ts`'s `spawnDetached`                                    | detached + unref + stdio to a log fd is the opposite of `ChildProcessSpawner`'s supervised semantics  |
| `http/server.ts`'s `upgrade` path                                         | oRPC owns that event; Effect's own websocket handler would fight it for the listener                  |
| Call sites inside an exempt file                                          | e.g. `http/auth.ts`'s ticket `randomUUID`, called synchronously from Promise-shaped `http/server.ts`  |
| `apps/desktop/src/main`'s Electron-bound files                            | `app-protocol`, `main-window`, `desktop-config`, `lib/utils` are tied to the Electron lifecycle       |
| `node:os.homedir` (`config/paths.ts`, `rpc/fs.ts`)                        | Effect has no OS/home-directory service                                                               |
| `node:module.createRequire` (`harness/claude-code/executable.ts`)         | no Effect equivalent                                                                                  |
| `packages/server/src/pty/spawn.ts`                                        | node-pty allocates a real TTY; `ChildProcessSpawner` is piped stdio and cannot resize or drive curses |
| `daemon/port.ts`, and the `process.kill` signals in `liveness`/`launcher` | Effect has no port-probe or process-signal service                                                    |

`node:path` is not on this list because it never needed an exemption — see
"Where the boundary is" above. Path math is pure, so it stays `node:path`
everywhere, and ten files in `packages/server/src` import it for exactly
that.
