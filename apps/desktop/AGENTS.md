# Desktop architecture instructions

These instructions apply to `apps/desktop/**`.

## Dependency direction

Electron Main has one composition root:

```text
src/main/index.ts
  -> src/main/desktop-runtime.ts
       -> application
       -> backend
       -> rpc
       -> electron adapters
```

Allowed production dependencies:

- `src/main/index.ts` imports only `desktop-runtime.ts`.
- `desktop-runtime.ts` may import every Main module because it is the composition root.
- `application/**` may depend on backend interfaces, shared desktop types, and Effect core.
- `backend/local-backend.ts` may depend on Effect core and shared desktop types.
- Backend platform adapters may depend on backend-owned ports, Effect platform, and the CLI handshake.
- `rpc/**` may depend on the application interface, the shared contract, oRPC, and Effect core.
- `electron/**` may depend on Electron and generic callbacks supplied by the composition root.
- `preload/**` may depend only on Electron and transport constants from `shared/**`.
- `renderer/**` may depend on browser APIs, the shared contract, oRPC client packages, React, and `@vibest/app`.

Forbidden dependencies:

- Application or backend modules must not import Electron or oRPC.
- RPC modules must not import Electron or backend implementations.
- Electron adapters must not import application or backend implementations.
- Renderer modules must not import Electron, Main modules, or Effect.
- Preload must not import application, backend, RPC router, React, or renderer modules.
- Do not add dependencies from an inner module back to `desktop-runtime.ts`.

Keep implementation adapters behind interfaces owned by the module that consumes the capability. Wire concrete adapters only in `desktop-runtime.ts`.

## Renderer/Main transport

- Renderer/Main business communication uses the native oRPC MessagePort adapters:
  - Main: `@orpc/server/message-port`
  - Renderer: `@orpc/client/message-port`
- Main creates `MessageChannelMain` and transfers one port to the renderer document.
- The preload is a narrow one-time relay from `ipcRenderer` to a DOM `MessagePort`.
- `ipcRenderer` is allowed only in `src/preload/index.ts` for this port handoff.
- Do not add `ipcMain`, `contextBridge`, `window.vibest`, invoke/send wrappers, or arbitrary IPC channels.
- Do not implement a custom request/response protocol over `postMessage`; oRPC owns correlation, serialization, cancellation, and stream transport.
- Backend status is an oRPC AsyncIterator backed by an Effect Stream. Do not reintroduce polling or long-polling.
- Keep the monotonic status revision as the resume cursor between bootstrap and stream subscription.

## Custom protocol

- `vibest://app` is a renderer asset origin only.
- It may serve the application entry, assets, and SPA fallback routes.
- Do not route desktop RPC through the custom protocol.
- Do not add CORS or Fetch RPC handling to `app-protocol.ts`.

## Effect usage

- `desktop-runtime.ts` is the only production Layer composition root and `ManagedRuntime` owner.
- Use Scope for child processes, MessagePorts, protocol handlers, windows, and subscriptions.
- Prefer explicit constructor parameters and plain capability values over a `Context.Service` for every file.
- Keep restart policy, path calculation, and other pure calculations as plain functions.
- Keep `@effect/platform-node` imports on direct subpaths. Importing its barrel can eagerly load `NodeRedis` and break packaged startup when `ioredis` is absent.

## Window and port lifecycle

- Create a fresh MessagePort for every renderer document after `did-finish-load`.
- Close the previous port before attaching a replacement.
- Window close and runtime disposal must close the active RPC peer.
- Renderer reload must not restart the backend or change its pinned connection.
- Backend restart must not replace the renderer MessagePort.

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

Tests must cover MessagePort unary RPC, stream delivery, client cancellation running the server finalizer, renderer reload receiving a new port, backend recovery, Retry, Quit, and child-process cleanup. Package the unpacked app and smoke-test it after changes to preload, Electron platform imports, or runtime paths.
