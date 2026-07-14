# Desktop Main

Electron Main starts the local backend, owns the application window, and exposes desktop shell operations to the renderer through oRPC over a transferred MessagePort.

```text
index.ts
  -> desktop-runtime.ts
       -> application/desktop-application.ts
       -> backend/
       -> rpc/
       -> electron/
```

- `desktop-runtime.ts` creates the root Effect runtime and assembles the concrete modules.
- `application/` contains renderer-facing desktop use cases.
- `backend/` contains local backend supervision and the Node child-process adapter.
- `rpc/` contains the transport-neutral router and oRPC MessagePort server.
- `electron/` contains BrowserWindow, MessageChannel, and custom asset protocol adapters.

The production renderer is served from `vibest://app`. The custom protocol is used only for application assets; Renderer/Main RPC travels over MessagePort. See `apps/desktop/AGENTS.md` for dependency and implementation rules.
