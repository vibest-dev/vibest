# OpenCode Platform and AppInterface design

## Scope

This note examines how OpenCode composes its shared app into Web and Electron, specifically:

- what `Platform` means;
- what `PlatformProvider`, `AppBaseProviders`, and `AppInterface` each own;
- where server connection data, query clients, and SDK clients live;
- how Desktop waits for and recovers from local-server startup;
- which parts are useful for Vibest and which parts conflict with Vibest's non-blocking startup requirements.

Source snapshot: OpenCode `dev` at commit [`17544802c38a4d35834275526ccf38be1cdcfbf4`](https://github.com/anomalyco/opencode/tree/17544802c38a4d35834275526ccf38be1cdcfbf4), package version `1.18.2`.

## Executive summary

OpenCode has three separate public seams:

```text
PlatformProvider
  └─ host-specific browser/native capabilities

AppBaseProviders
  └─ app-wide UI infrastructure

AppInterface
  └─ server selection, connection gate, router, and product UI
```

Its active server is **not stored in `Platform`**. Web and Desktop construct `ServerConnection` values and pass them to `AppInterface` through `defaultServer`, `servers`, and related props. Query clients and SDK clients are created inside the app, including per-server SDK/query state.

OpenCode avoids an “App mounted before the local-server address exists” state by waiting. Desktop Main starts the sidecar, waits for readiness and health, and only then restores windows. The renderer also gates `AppInterface` behind an asynchronous `awaitInitialization()` resource and displays a splash while required resources are pending. This is not the same as Vibest's desired non-blocking model.

OpenCode's shared app is not platform-agnostic in the strict sense: `Platform` is a `"web" | "desktop"` discriminated union, and app code branches on `platform.platform` and `platform.os` in many places.

## 1. Package-level composition

`@opencode-ai/app` exports `AppBaseProviders`, `AppInterface`, `Platform`, and `PlatformProvider` as separate public symbols. It also exports many app hooks and several desktop-related subpaths. Desktop depends on the app package as source and provides its own renderer entry point.

Sources:

- [`packages/app/src/index.ts`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/index.ts)
- [`packages/app/package.json`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/package.json)
- [`packages/desktop/package.json`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/package.json)

Desktop's Vite config applies `@opencode-ai/app/vite`. That plugin aliases `@` to the app package's `src` directory and installs the shared Tailwind/Solid configuration. Desktop therefore bundles shared app source into its own renderer build rather than loading the Web app's already-built artifact.

Sources:

- [`packages/desktop/electron.vite.config.ts#L1-L101`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/electron.vite.config.ts#L1-L101)
- [`packages/app/vite.js`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/vite.js)

## 2. What OpenCode means by Platform

OpenCode's `Platform` is a host capability object delivered through context. Its required base capabilities are:

- app version, optionally;
- open an external link;
- restart;
- browser history back/forward;
- system notification.

Optional capabilities include:

- opening or revealing local paths;
- native directory, attachment, and save pickers;
- platform storage and window identity;
- updater operations;
- a `fetch` override;
- reading and writing the preferred default-server key;
- WSL server management;
- display-backend settings;
- native Markdown parsing;
- webview zoom and menu operations;
- editor-app discovery;
- clipboard image reading;
- debug-log export and fatal-renderer-error recording.

The type is explicitly discriminated:

```ts
PlatformBase &
  (
    | { platform: "web"; os?: never }
    | {
        platform: "desktop";
        os?: "macos" | "windows" | "linux";
        openDirectoryPickerDialog(...): Promise<...>;
      }
  )
```

`PlatformProvider` is a real context provider. It stores the value; consumers use the corresponding `usePlatform` hook.

Source: [`packages/app/src/context/platform.tsx#L30-L139`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/platform.tsx#L30-L139).

### Important qualification

OpenCode does not keep the shared app ignorant of Desktop. The app checks `platform.platform === "desktop"` and reads `platform.os` for title bars, persistence, native file operations, settings, open-in-app behavior, diagnostics, and other UI decisions.

Examples:

- [`packages/app/src/components/titlebar.tsx`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/components/titlebar.tsx)
- [`packages/app/src/components/session/open-in-app.tsx`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/components/session/open-in-app.tsx)
- [`packages/app/src/utils/persist.ts`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/utils/persist.ts)
- [`packages/app/src/components/directory-picker.tsx`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/components/directory-picker.tsx)

This is a deliberate capability-plus-discriminator design, not a strict “app never knows which host it is running in” design.

## 3. Server connection is a separate domain model

OpenCode models servers separately as `ServerConnection` values. Supported variants include:

- regular HTTP;
- the built-in Desktop sidecar;
- WSL sidecars;
- SSH-backed connections that expose an HTTP endpoint.

Each connection contains its HTTP URL and optional credentials. Identity is derived through `ServerConnection.key()`.

Source: [`packages/app/src/context/server.tsx#L181-L253`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/server.tsx#L181-L253).

`AppInterface` receives server state explicitly:

```ts
{
  defaultServer: ServerConnection.Key;
  canonicalLocalServer?: ServerConnection.Key;
  servers?: ServerConnection.Any[];
  router?: Component<BaseRouterProps>;
  disableHealthCheck?: boolean;
  startup?: Promise<void>;
  serverScoped?: JSX.Element;
}
```

It installs `ServerProvider`, app state providers, the initial connection gate, the router, and the route tree.

Source: [`packages/app/src/app.tsx#L514-L570`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/app.tsx#L514-L570).

`ServerProvider` merges host-provided servers with persisted user servers, tracks the active server key, exposes the current server, and scopes project state by server.

Source: [`packages/app/src/context/server.tsx#L255-L357`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/server.tsx#L255-L357).

Therefore OpenCode's separation is:

```text
Platform
  = host-specific behavior

ServerConnection
  = where and how product data is reached
```

The platform contains server-adjacent host operations such as persisting the preferred default-server key and optionally overriding `fetch`, but it does not contain the active `ServerConnection`, SDK client, or query client.

## 4. What AppBaseProviders owns

`AppBaseProviders` installs application-wide UI infrastructure:

- document metadata;
- fonts and theme;
- language and UI translations;
- error boundary;
- a Query provider;
- WSL context;
- dialogs;
- Markdown rendering;
- file rendering.

Source: [`packages/app/src/app.tsx#L353-L385`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/app.tsx#L353-L385).

The `QueryProvider` creates its own `QueryClient`; callers do not pass one.

Source: [`packages/app/src/app.tsx#L241-L252`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/app.tsx#L241-L252).

`AppInterface` also creates a query scope around its shared router shell, and each server context creates a per-server `QueryClient`. OpenCode therefore has multiple deliberate query scopes, all created inside the app implementation.

Sources:

- [`packages/app/src/app.tsx#L514-L570`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/app.tsx#L514-L570)
- [`packages/app/src/context/global.tsx#L96-L132`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/global.tsx#L96-L132)

## 5. How SDK clients are created

OpenCode does not pass an SDK client through `Platform` or `AppInterface`.

For each server, the app creates a server context containing:

- a per-server query client;
- an SDK client configured from the server URL and Basic-auth credentials;
- a synchronization context;
- project state.

`createSdkForServer` turns `ServerConnection.HttpBase` into an SDK client by setting `baseUrl` and an Authorization header.

Sources:

- [`packages/app/src/utils/server.ts#L20-L43`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/utils/server.ts#L20-L43)
- [`packages/app/src/context/global.tsx#L96-L132`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/global.tsx#L96-L132)
- [`packages/app/src/context/server-sdk.tsx#L79-L303`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/server-sdk.tsx#L79-L303)

The global server context caches one SDK/sync context per server key and disposes it when that server leaves the list. `ServerSDKProvider` resolves the current server reactively instead of requiring a root-level singleton client.

Sources:

- [`packages/app/src/context/global.tsx#L13-L94`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/global.tsx#L13-L94)
- [`packages/app/src/context/server-sdk.tsx#L282-L303`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/server-sdk.tsx#L282-L303)

## 6. Web composition

The Web entry constructs two independent values:

1. a Web `Platform` adapter implementing browser operations;
2. a regular HTTP `ServerConnection` containing the server URL and optional credentials derived from the URL token.

It composes them as:

```tsx
<PlatformProvider value={platform}>
  <AppBaseProviders>
    <AppInterface
      defaultServer={...}
      canonicalLocalServer={...}
      servers={[server]}
      disableHealthCheck
    />
  </AppBaseProviders>
</PlatformProvider>
```

Source: [`packages/app/src/entry.tsx#L57-L180`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/entry.tsx#L57-L180).

The server URL is still explicit data even in Web. Production may use `location.origin`, but the entry converts it into `ServerConnection` before mounting the shared app.

## 7. Desktop composition

Desktop has its own renderer entry. It constructs a Desktop `Platform` adapter over `window.api`, including native pickers, storage, updater, restart, notifications, WSL, zoom, menus, and diagnostics.

Source: [`packages/desktop/src/renderer/index.tsx#L113-L317`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/renderer/index.tsx#L113-L317).

Separately, it requests sidecar initialization data:

```ts
const [sidecar] = createResource(() => window.api.awaitInitialization());
```

When available, it converts `{ url, username, password }` into a `ServerConnection.Sidecar`. It then passes that server list to `AppInterface`, along with a Desktop memory router and an onboarding startup promise.

Source: [`packages/desktop/src/renderer/index.tsx#L331-L445`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/renderer/index.tsx#L331-L445).

The resulting shape is:

```text
Desktop window.api
  ├─ createPlatform() -> PlatformProvider
  └─ awaitInitialization() -> ServerConnection -> AppInterface
```

That is the central design fact: **native host capability adaptation and server connection assembly are separate operations.**

## 8. Desktop startup timing

### Main process

Desktop Main:

1. creates a `Deferred<ServerReadyData>`;
2. registers `await-initialization` IPC, which waits on that Deferred;
3. selects a free loopback port and generates a password;
4. starts the sidecar utility process;
5. waits for the sidecar's `ready` message, emitted after `Server.listen()` succeeds;
6. resolves the Deferred with URL and credentials;
7. waits for a health check, with a 30-second timeout whose failure is logged and recovered;
8. only then restores BrowserWindows.

Sources:

- [`packages/desktop/src/main/index.ts#L250-L381`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/main/index.ts#L250-L381)
- [`packages/desktop/src/main/server.ts#L55-L172`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/main/server.ts#L55-L172)
- [`packages/desktop/src/main/sidecar.ts#L32-L59`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/main/sidecar.ts#L32-L59)

This means the initial Desktop window is normally not created until the local server has listened and passed health checking. OpenCode avoids the missing-connection problem primarily by ordering startup, not by making its root client lazy.

### Renderer

The renderer still treats initialization as a resource. It renders `LoadingSplash` until window state, sidecar data, default-server settings, window count, and locale are ready. Initialization errors are rethrown and marked as local-server startup failures before server providers are rendered.

Sources:

- [`packages/desktop/src/renderer/index.tsx#L331-L454`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/renderer/index.tsx#L331-L454)
- [`packages/desktop/src/renderer/initialization.ts`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/renderer/initialization.ts)
- [`packages/desktop/src/renderer/initialization.test.ts`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/renderer/initialization.test.ts)

The preload exposes `awaitInitialization` as one method on a broad Electron bridge.

Sources:

- [`packages/desktop/src/preload/index.ts`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/preload/index.ts)
- [`packages/desktop/src/preload/types.ts`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/preload/types.ts)

## 9. Connection health and recovery

`AppInterface` wraps product UI in `ConnectionGate`. The gate performs startup health checking, shows a blocking splash while checking, presents a connection-error UI on failure, retries in the background, and allows selection of another configured server.

Source: [`packages/app/src/app.tsx#L387-L512`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/app.tsx#L387-L512).

The app also polls server health and maintains an SDK event stream with an internal reconnect loop, 250 ms retry delay, and heartbeat-triggered abort/reconnect behavior.

Sources:

- [`packages/app/src/utils/server-health.ts`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/utils/server-health.ts)
- [`packages/app/src/context/server-sdk.tsx#L106-L249`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/server-sdk.tsx#L106-L249)
- [`packages/app/src/context/server-sync.tsx#L440-L458`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/server-sync.tsx#L440-L458)

The built-in sidecar itself is not supervised by an automatic respawn loop in Desktop Main. Its exit is logged. The Desktop `Platform.restart` implementation kills the sidecar and relaunches the whole app. OpenCode's recovery model is therefore different from Vibest's supervised same-port server restart.

Sources:

- [`packages/desktop/src/main/index.ts#L64-L180`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/main/index.ts#L64-L180)
- [`packages/desktop/src/main/index.ts#L341-L381`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/main/index.ts#L341-L381)
- [`packages/desktop/src/renderer/index.tsx#L245-L248`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/renderer/index.tsx#L245-L248)

## 10. Renderer origin and server access

Packaged Desktop loads renderer assets from a custom `oc://renderer` protocol. The sidecar explicitly allows that origin through CORS and uses Basic-auth credentials. The renderer therefore remains cross-origin from its local server and must receive the sidecar URL and credentials explicitly.

Sources:

- [`packages/desktop/src/main/windows.ts#L252-L304`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/main/windows.ts#L252-L304)
- [`packages/desktop/src/main/sidecar.ts#L32-L59`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/main/sidecar.ts#L32-L59)
- [`packages/desktop/src/preload/types.ts#L16-L20`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/preload/types.ts#L16-L20)

Waiting does not remove the need to communicate connection data; it only means OpenCode communicates a resolved `ServerConnection` before constructing SDK clients.

## 11. Direct answers for Vibest

### Does OpenCode put server connection data in Platform?

No. It puts native/browser host operations in `Platform` and passes actual server descriptors to `AppInterface`. Some host-specific server-adjacent operations, such as persisting the preferred default server and overriding fetch, remain on `Platform`.

### Does OpenCode pass QueryClient or SDK clients through Platform?

No. Query clients and SDK clients are created inside app/server contexts.

### Why does OpenCode not need an asynchronously configured root client?

Because it does not mount the server-dependent shared app until it has a resolved sidecar descriptor, and its SDK clients are created below `ServerProvider` from that descriptor. Desktop Main also delays initial window creation until sidecar startup and health checking complete.

### Is OpenCode's shared app unaware of Desktop?

No. Its Platform type and many consumers explicitly know `"desktop"` and desktop OS values.

### Is OpenCode's Desktop using the same built Web artifact?

No. Desktop owns a separate renderer entry and bundles shared app source using the app's Vite plugin. This is source-level composition.

## 12. Implications for Vibest

The useful part to copy is the separation of seams:

```text
PlatformProvider
  = host capabilities

AppInterface input
  = server/RPC connection model

App implementation
  = query client, oRPC client, query utils, router, chat manager
```

The parts not to copy are:

- delaying BrowserWindow creation until server health is known;
- making shared app code branch on a Desktop discriminator when Vibest wants stricter host independence;
- treating whole-app relaunch as the normal local-server recovery path;
- exposing the broad Electron bridge or OpenCode's broad app package surface merely for parity.

For Vibest's current custom renderer origin and dynamic loopback server, some connection information must still cross from Electron Main to the renderer. The design choice is where that seam lives, not whether the information exists. Vibest can copy OpenCode's resolved-server input without copying its delayed BrowserWindow:

```tsx
<PlatformProvider value={platform}>
  <ServerStatusOverlay feed={status} />
  <Suspense fallback={<StartupScreen />}>
    <ReadyApp server={serverPromise} />
  </Suspense>
</PlatformProvider>
```

`ReadyApp` reads the first successful connection and passes the resolved server to `AppInterface`. The lifecycle overlay remains outside the suspended subtree, so initial failure still exposes Retry/Quit and a successful retry resolves the original promise. After first readiness, the pinned port and stable token let the same app clients survive daemon restarts.

This keeps `queryClient`, `orpcClient`, and `orpcQueryUtils` as internal implementation details, removes server state from Platform, and confines asynchronous startup composition to Desktop. Retry belongs to the server lifecycle; quit/relaunch belongs to Platform.

## Source index

- [App public exports](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/index.ts)
- [Platform type and provider](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/platform.tsx)
- [AppBaseProviders, ConnectionGate, AppInterface](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/app.tsx)
- [ServerConnection and ServerProvider](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/server.tsx)
- [SDK construction](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/context/server-sdk.tsx)
- [Web composition](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/app/src/entry.tsx)
- [Desktop renderer composition](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/renderer/index.tsx)
- [Desktop Main startup](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/main/index.ts)
- [Desktop sidecar startup and health](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/main/server.ts)
- [Desktop renderer protocol](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/desktop/src/main/windows.ts)
