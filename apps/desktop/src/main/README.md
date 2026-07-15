# Desktop Main

Electron Main starts the local backend, owns the application window, and exposes desktop shell operations to the renderer through oRPC over a transferred MessagePort.

```text
index.ts
  -> desktop-runtime.ts
       -> desktop-runtime-glue.ts
       -> desktop-config.ts
       -> application/desktop-application.ts
       -> backend/
       -> rpc/
       -> electron/
```

- `desktop-runtime.ts` creates the root Effect runtime and composes the module `Layer`s into it.
- `desktop-runtime-glue.ts` holds the Electron-touching `Live` Layers (`DesktopApplicationLive`, `RendererChannelLive`) that can't live next to their Tag; split out so they stay importable from tests without pulling in `electron/main-window.ts`.
- `desktop-config.ts` resolves host/environment facts (packaged state, dev URL, server entry, token, allowed origins) once and exposes them as a `DesktopConfig` Tag.
- `application/` contains renderer-facing desktop use cases, exposed as a `DesktopApplication` Tag.
- `backend/` contains local backend supervision (`LocalBackend` Tag) and the Node child-process adapter.
- `rpc/` contains the transport-neutral router and oRPC MessagePort server.
- `electron/` contains BrowserWindow (`MainWindow` Tag), MessageChannel (`RendererChannel` Tag), and custom asset protocol adapters.

Most capability modules are `Context.Service` Tags with a plain-parameter factory function alongside them; `desktop-runtime.ts` wires their `Live` Layers into one graph instead of threading constructor parameters by hand. See "Tag and Layer ownership" in `apps/desktop/AGENTS.md` for which module owns a Tag's `Live` Layer and when a capability stays a plain factory instead.

The production renderer is served from `vibest://app`. The custom protocol is used only for application assets; Renderer/Main RPC travels over MessagePort. See `apps/desktop/AGENTS.md` for dependency and implementation rules.
