# Desktop architecture instructions

These instructions apply to `apps/desktop/**`.

## Dependency direction

Electron Main has one composition root:

```text
src/main/index.ts
  -> src/main/desktop-runtime.ts
       -> application
       -> server
       -> rpc
       -> electron adapters
```

Allowed production dependencies:

- `src/main/index.ts` imports only `desktop-runtime.ts`.
- `desktop-runtime.ts` and `desktop-runtime-glue.ts` may import every Main module because they are the composition root. `desktop-runtime-glue.ts` holds the subset of glue Layers that need to stay importable from tests without pulling in `electron/main-window.ts` (see "Tag and Layer ownership" below).
- `desktop-config.ts` has no dependencies of its own (besides the shared `APP_ORIGIN` constant) and may be depended on by any Main module.
- `application/**` may depend on server interfaces, shared desktop types, and Effect core.
- `server/local-server.ts` may depend on Effect core and shared desktop types.
- Server platform adapters (including `server/local-server-live.ts`) may depend on server-owned ports, `desktop-config.ts`, Effect platform, and the CLI handshake.
- `rpc/**` may depend on the application interface, the shared contract, oRPC, and Effect core.
- `electron/**` may depend on Electron, `desktop-config.ts`, other `electron/**` modules, and generic callbacks supplied by the composition root.
- `preload/**` may depend only on Electron and transport constants from `shared/**`.
- `renderer/**` may depend on browser APIs, the shared contract, oRPC client packages, React, and the root `@vibest/app` composition interface. Compose `PlatformProvider` with `AppInterface`; do not reach into app subpaths or recreate its client/router/chat wiring in Desktop.
- Create the BrowserWindow and React startup shell immediately, but mount `AppInterface` only after `server.connection` resolves for the first time. Keep `ServerStatusOverlay` outside that Suspense boundary so initial failure still exposes Retry/Quit, while later restarts leave the mounted app and its clients intact.

Forbidden dependencies:

- Application or server modules must not import Electron or oRPC.
- RPC modules must not import Electron or server implementations.
- Electron adapters must not import application or server implementations.
- Renderer modules must not import Electron, Main modules, or Effect.
- Preload must not import application, server, RPC router, React, or renderer modules.
- Do not add dependencies from an inner module back to `desktop-runtime.ts`.

Keep implementation adapters behind interfaces owned by the module that consumes the capability. Wire concrete adapters only in `desktop-runtime.ts`.

### Tag and Layer ownership

Most capability modules (`LocalServer`, `DesktopApplication`, `RendererChannel`, `MainWindow`, `DesktopConfig`) are exposed as an Effect `Context.Service` Tag rather than a plain interface, so the composition root can wire them as a Layer graph instead of threading constructor parameters by hand.

- The Tag and its factory function live together in the module that owns the capability (e.g. `LocalServer` and `makeLocalServer` in `server/local-server.ts`). The factory keeps taking plain parameters and stays the unit tests target — Layer wiring is a thin wrapper around it, not a replacement for it.
- The `Live` Layer for a Tag lives next to the Tag **only if building it needs nothing the module isn't already allowed to import** (e.g. `MainWindowLive` in `electron/main-window.ts` only needs `DesktopConfig` and `RendererChannel`, both already-allowed electron/** dependencies).
- When building a Tag's `Live` Layer needs a capability the owning module is forbidden to import (e.g. `DesktopApplicationLive` needs `app.quit()`, which `application/**` may not import), the `Live` Layer is defined in `desktop-runtime-glue.ts` instead, next to the other glue. This is the same "adapter lives at the composition root" rule the dependency table already states — Tag-ification does not relax it. `desktop-runtime-glue.ts` is a separate file from `desktop-runtime.ts` itself only so composition tests can import it without loading `electron/main-window.ts`'s `BrowserWindow` import, which fails to resolve under the test runner's Electron shim; it is otherwise still composition-root code.
- Modules only ever import another module's Tag and its `Service` shape type (`Foo["Service"]`), never another module's `Live` Layer or factory internals.
- Not every module gets a Tag. Pure functions (`restartBackoff`, `formatStartupFailure`, `resolveAssetPath`, `resolveServerEntry`), single-consumer plain constructs (`makeDesktopRpcServer`, `makeDesktopRouter`), and injected function ports (`SpawnServer`) stay as-is. Reach for a Tag when a capability has (or will imminently have) more than one consumer reachable only by threading it through several layers of constructor parameters — not by file-per-service default.

Example of the resulting composition:

```ts
ManagedRuntime.make(
  MainWindowLive.pipe(
    Layer.provide(RendererChannelLive),
    Layer.provide(DesktopApplicationLive),
    Layer.provide(LocalServerLive),
    Layer.provide(DesktopConfigLive),
    Layer.provide(ChildProcessSpawnerLive),
  ),
);
```

## Renderer/Main transport

- Renderer/Main business communication uses the native oRPC MessagePort adapters:
  - Main: `@orpc/server/message-port`
  - Renderer: `@orpc/client/message-port`
- Main creates `MessageChannelMain` and transfers one port to the renderer document.
- The preload is a narrow one-time relay from `ipcRenderer` to a DOM `MessagePort`.
- `ipcRenderer` is allowed only in `src/preload/index.ts` for this port handoff.
- Do not add `ipcMain`, `contextBridge`, `window.vibest`, invoke/send wrappers, or arbitrary IPC channels.
- Do not implement a custom request/response protocol over `postMessage`; oRPC owns correlation, serialization, cancellation, and stream transport.
- Server status is an oRPC AsyncIterator backed by an Effect Stream. Do not reintroduce polling or long-polling.
- Keep the monotonic status revision as the resume cursor between bootstrap and stream subscription.

## Custom protocol

- `vibest://app` is a renderer asset origin only.
- It may serve the application entry, assets, and SPA fallback routes.
- Do not route desktop RPC through the custom protocol.
- Do not add CORS or Fetch RPC handling to `app-protocol.ts`.

## Effect usage

- `desktop-runtime.ts` is the only production Layer composition root and `ManagedRuntime` owner; `desktop-runtime-glue.ts` supplies it with the Electron-touching Live Layers that can't live next to their Tag (see "Tag and Layer ownership").
- Use Scope for child processes, MessagePorts, protocol handlers, windows, and subscriptions.
- RPC handlers run detached from the ManagedRuntime; they inherit the composition root's Context (including logger and other references) through `effect/context` plus the wrapper's outer `Effect.provide`. Handing over the full ServiceMap is intentional — do not pass `Context.empty()` and do not hand-pick reference keys.
- No bare `console.*` in Main; log through `Effect.log*`. Raw child-process output is relayed via `Effect.log`/`Effect.logError` with a source annotation.
- See "Tag and Layer ownership" above for when a module gets a `Context.Service` Tag versus staying a plain factory.
- Keep restart policy, path calculation, and other pure calculations as plain functions.
- Keep `@effect/platform-node` imports on direct subpaths. Importing its barrel can eagerly load `NodeRedis` and break packaged startup when `ioredis` is absent.
- Packaged GUI startup must recover the complete exported login-shell environment, not only `PATH`, so proxy and authentication variables reach the server and agent subprocesses.
- `apps/desktop/turbo.json` must pass the complete environment through for `desktop#dev`; Turborepo strict mode otherwise removes undeclared proxy, authentication, and tool variables. Keep this exception scoped to Desktop development.
- Never log, expose through RPC, or snapshot the resolved environment because it may contain credentials.

## Window and port lifecycle

- Open the window and mount the React startup shell while the local server is still starting. Server environment resolution and port readiness must stay inside the supervised fiber and must not block Layer construction or window creation.
- The renderer awaits its one-time MessagePort and first successful server connection through nested React Suspense boundaries before mounting `AppInterface`. The app's WebSocket oRPC client still uses lazy `connect` for runtime reconnects, and Desktop HTTP is only for minting the single-use WebSocket ticket.
- Create a fresh MessagePort for every renderer document after `did-finish-load`.
- Close the previous port before attaching a replacement.
- Window close and runtime disposal must close the active RPC peer.
- Renderer reload must not restart the server or change its pinned connection.
- Server restart must not replace the renderer MessagePort.

## Security

Keep BrowserWindow configured with:

```text
sandbox: true
contextIsolation: true
nodeIntegration: false
```

The preload must not expose Node or Electron objects to the page. The renderer must continue to observe `window.require`, `window.process`, and `window.vibest` as undefined.

## Verification

For transport or lifecycle changes, run:

- `pnpm --filter desktop test`
- `pnpm --filter desktop typecheck`
- `pnpm --filter desktop build`
- `pnpm --filter desktop e2e`
- `pnpm check`
- `pnpm test`

Tests must cover MessagePort unary RPC, stream delivery, client cancellation running the server finalizer, renderer reload receiving a new port, server recovery, Retry, Quit, and child-process cleanup. Package the unpacked app and smoke-test it after changes to preload, Electron platform imports, or runtime paths.
