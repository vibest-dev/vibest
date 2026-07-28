# Stack quirks

These differ from what the library names suggest.

- **Effect is 4.x beta, not v3.** `Schema` imports from `"effect"` (not
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

New disk, path, randomness, and child-process code uses `effect/FileSystem`,
`effect/Path`, `effect/Crypto`, and `effect/unstable/process`'s
`ChildProcessSpawner` — not `node:fs` / `node:path` / `node:crypto` /
`node:child_process`. `packages/server` was migrated wholesale in
`docs/2026-07-27-effect-platform-migration.md`; matching the surrounding style
means matching this.

- **The dependency rides the `R` channel.** A function that touches disk is
  `Effect<A, E, FileSystem.FileSystem | Path.Path>`. Don't seal a layer inside
  the module and don't promote the need into a new service — the requirement
  bubbles to a composition root (`rpc/runtime.ts`, `apps/desktop`'s
  `desktop-runtime.ts`, the CLI), which is the only place `NodeFileSystem.layer`
  / `NodePath.layer` / `NodeCrypto.layer` appear.
- **A service shape stays `R`-free.** Bind the platform once while building the
  Layer — `const platform = yield* Effect.context<FileSystem | Path>()` — and
  `Effect.provide(platform)` each method. `infra/json-store.ts` plus the four
  repositories are the pattern to copy.
- **Platform failures get mapped at the seam,** not propagated raw: the store's
  `StoreReadError` / `StoreWriteError` wrap them, and "file isn't there" is
  `error.reason._tag === "NotFound"` (`isNotFound`), never an errno string.
- **Two gaps to route around.** `FileSystem.access` has no `X_OK` — test
  executability with `stat` + `(info.mode & 0o111) !== 0`, as both executable
  resolvers do. `Path` has no `delimiter` — derive it from the platform locally.
- **Tests:** real-fs + `mkdtemp` for behaviour, `FileSystem.makeNoop` (see
  `packages/server/test/fake-file-system.ts`) for failures a real disk won't
  produce on demand.

Exempt, deliberately — these are boundaries Effect doesn't model, and "it's
already written" is not a reason to add to the list:

| Location                                                                  | Why                                                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `daemon/launcher.ts`'s `spawnDetached`                                    | detached + unref + stdio to a log fd is the opposite of `ChildProcessSpawner`'s supervised semantics |
| `http/server.ts` as a whole                                               | node:http, ws, the oRPC WS handler, and Vite HMR share one server and its upgrade event              |
| Call sites inside an exempt file                                          | e.g. `http/auth.ts`'s ticket `randomUUID`, called synchronously from Promise-shaped `http/server.ts` |
| `apps/desktop/src/main`'s Electron-bound files                            | `app-protocol`, `main-window`, `desktop-config`, `lib/utils` are tied to the Electron lifecycle      |
| `packages/services`' terminal-manager                                     | node-pty has no Effect equivalent (and the package is dormant)                                       |
| `node:os.homedir` (`config/paths.ts`, `rpc/fs.ts`)                        | Effect has no OS/home-directory service                                                              |
| `node:module.createRequire` (`harness/claude-code/executable.ts`)         | no Effect equivalent                                                                                 |
| `daemon/port.ts`, and the `process.kill` signals in `liveness`/`launcher` | Effect has no port-probe or process-signal service                                                   |

Exempt files keep `node:path` too; migrated ones switch to the `Path` service.
