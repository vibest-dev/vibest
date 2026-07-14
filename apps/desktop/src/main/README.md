# Desktop main architecture

The Electron main process is organized around one composition root and one-way dependencies.
Effect owns resource lifetime, concurrency, and failure handling; it is not used to turn every
implementation detail into a service.

## Dependency graph

```text
index.ts
  -> desktop-runtime.ts
       -> application/desktop-application.ts
            -> backend/local-backend.ts
       -> backend/node-backend-process.ts
            -> backend/local-backend.ts (port types only)
       -> backend/login-shell-path.ts
       -> rpc/desktop-rpc.ts
            -> application/desktop-application.ts
       -> electron/app-protocol.ts
       -> electron/main-window.ts
```

`desktop-runtime.ts` is the only composition root. It creates the concrete adapters, injects them
into the application and backend modules, owns the root `ManagedRuntime`, and connects Electron
process events to the scoped application resources.

## Modules

### Application

`application/desktop-application.ts` defines the renderer-facing use cases: bootstrap, wait for a
new backend status revision, retry the backend, and quit. It knows the `LocalBackend` interface but
has no Electron, oRPC, Node process, or platform dependencies.

### Backend

`backend/local-backend.ts` owns backend supervision: the immutable connection, pinned port,
restart policy, status revisions, terminal failure, Retry, and scoped process cycles. It depends on
a `SpawnBackend` function supplied by the composition root.

`backend/node-backend-process.ts` is the production `SpawnBackend` adapter. It owns the child
process command, environment, ready handshake, output streams, startup timeout, and process
termination.

`backend/login-shell-path.ts` resolves the packaged app's login-shell PATH. It is a startup helper,
not an ambient service.

### RPC

`rpc/desktop-rpc.ts` is an inbound adapter. It maps the desktop-local oRPC contract to the
`DesktopApplication` interface and closes over that dependency. It does not receive the main
Effect context or access backend implementation details.

### Electron

`electron/app-protocol.ts` serves a generic Fetch request handler before static renderer assets. It
does not know that the handler is implemented by oRPC.

`electron/main-window.ts` owns the `BrowserWindow`, navigation policy, external links, and window
finalizer. It has no application, backend, or RPC dependencies.

## Dependency rules

- `index.ts` imports only `desktop-runtime.ts`.
- Only `desktop-runtime.ts` may assemble Layers or own a `ManagedRuntime`.
- Application code must not import Electron, oRPC, or Effect platform adapters.
- Backend supervision must not import Electron or oRPC.
- RPC may depend on the application interface, never on backend internals.
- Electron protocol and window adapters must not depend on the application or backend.
- Platform implementations are injected through explicit function parameters.
- Resources return Effects requiring `Scope`; pure calculations remain plain functions.
