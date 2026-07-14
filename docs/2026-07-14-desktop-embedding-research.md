# Desktop Embedding Research: How OSS AI Coding/Chat Tools Wrap a Web Frontend in a Native Shell

This doc surveys how comparable open-source projects embed a browser-based UI inside a native
desktop app shell, as prior art for a possible vibest desktop wrapper around `apps/web` +
`packages/cli`. Every claim below is cited to a specific source file (permalinked to a commit SHA
or fetched directly via the GitHub API) or an official page that was actually fetched and read.

## Identification note

The user's second research target, verbally transcribed as "t3cdoe," was first investigated as a
possible mishearing of "T3 Chat desktop app" (Theo Browne's t3.chat product). That search came up
empty — no `t3-chat`/`t3chat` repo exists under `github.com/t3dotgg` or `github.com/t3-oss`, and
`t3.chat`'s own feedback board shows a desktop app is still an unshipped "Planned" feature request
([feedback.t3.chat/p/desktop-app-19](https://feedback.t3.chat/p/desktop-app-19), 76 upvotes). An
earlier draft of this doc substituted Ollama's and Jan.ai's desktop apps as stand-ins for this
reason.

**The user has since clarified that "t3cdoe" refers to `github.com/pingdotgg/t3code`** — a real,
actively developed, MIT-licensed repo (also published as npm's `t3` / `npx t3@latest`) from
`pingdotgg` (Theo Browne's GitHub org — the "t3" naming similarity was the source of the original
mishearing/confusion). Its README describes it as "a minimal web GUI for coding agents (currently
Codex, Claude, Cursor, and OpenCode, more coming soon)," and it ships a desktop app via GitHub
Releases, `winget` (Windows), and Homebrew (macOS)
([github.com/pingdotgg/t3code](https://github.com/pingdotgg/t3code)). This is a direct architectural
peer of vibest: `apps/server/package.json` depends on `@anthropic-ai/claude-agent-sdk` and
`@opencode-ai/sdk` directly
([apps/server/package.json](https://github.com/pingdotgg/t3code/blob/main/apps/server/package.json)),
i.e. it is, like vibest, a Claude-Agent-SDK-powered coding-agent server paired with a web UI and a
desktop shell. This doc now covers **opencode and t3code** as the two primary projects. The earlier
Ollama/Jan.ai research is kept as a short appendix at the end since it remains independently useful
prior art (a third, non-Electron/non-Tauri pattern, and a Tauri-sidecar pattern), but it is no
longer a substitute for anything.

## opencode

opencode's canonical repo moved. `github.com/sst/opencode` is no longer canonical — fetching
`opencode.ai` shows the project now points to **`github.com/anomalyco/opencode`**
([opencode.ai](https://opencode.ai/), confirmed via WebFetch of the live page, which links
`anomalyco/opencode` as the source repo and confirms org rename from SST to Anomaly). All findings
below are from `anomalyco/opencode` at commit
[`e71fbb6`](https://github.com/anomalyco/opencode/tree/e71fbb6d48512c2376faab4cbeb21d63fadb929c).

### 1. Desktop runtime/shell

opencode ships a real desktop app, built with **Electron**, in
`packages/desktop`. Proof: `package.json` declares `"electron": "42.3.3"`,
`"electron-builder": "26.15.2"`, and `"electron-vite": "^5"` as dependencies, with scripts like
`"package": "electron-builder --config electron-builder.config.ts"`.
[packages/desktop/package.json](https://github.com/anomalyco/opencode/blob/e71fbb6d48512c2376faab4cbeb21d63fadb929c/packages/desktop/package.json)

This is a recent, deliberate change: opencode **used to ship on Tauri** and migrated to Electron.
A core contributor (`Brendonovich`, confirmed as a top-15 contributor via the GitHub contributors
API for this repo) wrote the migration rationale in a first-party post:
["Moving OpenCode Desktop to Electron"](https://dev.to/brendonovich/moving-opencode-desktop-to-electron-4hip)
(DEV Community, Apr 19 2026). Key quotes: "Tauri uses WebKit on macOS and Linux, which not only
has worse performance than Chromium when rendering our app, but also has minor inconsistencies
with it, especially around styles," and on Electron's larger bundle size: "Yeah, it's a trade-off
we're willing to make." The post also notes Tauri "remains suitable for apps with a simpler UI
that demands native performance or easy access to system APIs" — i.e., the team isn't claiming
Electron is universally better, just a better fit for their specific TS/Node server + rich-UI case.

### 2. Localhost server + webview, or bundled static + custom protocol?

**Both, split cleanly.** The static UI (`apps/web`-equivalent renderer bundle) is loaded via a
**custom privileged protocol**, not `http://localhost`. `src/main/windows.ts` registers a scheme
`oc://` (`protocol.registerSchemesAsPrivileged([{ scheme: "oc", privileges: { secure: true,
standard: true, supportFetchAPI: true } }])`) and serves files straight off disk via
`protocol.handle("oc", ...)` reading from a `rendererRoot` directory, with the window loaded via
`win.loadURL('oc://renderer/index.html')` in production (falling back to
`process.env.ELECTRON_RENDERER_URL` in dev, i.e. the Vite dev server).
[packages/desktop/src/main/windows.ts](https://github.com/anomalyco/opencode/blob/e71fbb6d48512c2376faab4cbeb21d63fadb929c/packages/desktop/src/main/windows.ts)

The **API/agent server** (the actual opencode server — equivalent to vibest's `packages/cli`) is a
**separate local HTTP+SSE server bound to `127.0.0.1` on a randomly assigned free port**, protected
by HTTP Basic Auth with a random per-launch password (`randomUUID()`), which the renderer receives
over IPC and then talks to directly via `fetch`/EventSource. Loopback-only binding is reinforced by
explicitly forcing `127.0.0.1`/`localhost`/`::1` into `NO_PROXY` so no system proxy can intercept
local traffic. [packages/desktop/src/main/index.ts](https://github.com/anomalyco/opencode/blob/e71fbb6d48512c2376faab4cbeb21d63fadb929c/packages/desktop/src/main/index.ts)

### 3. How the local server is packaged/started

Spawned as an **Electron `utilityProcess`** (not a separately bundled binary, not embedded
in-process with the main process): `utilityProcess.fork(sidecar, [], { serviceName: "opencode
server", stdio: "pipe" })`, where `sidecar` is a compiled `sidecar.js` produced by their Vite build
(referencing a `virtual:opencode-server` module — the TypeScript API server code, bundled inline
rather than shipped as a separate Bun executable). The main process and sidecar talk over
Electron's structured `postMessage`/`parentPort` protocol for lifecycle control (`start`/`stop`/
`ready`/`error`), while actual application traffic goes over HTTP once the sidecar reports ready.
[packages/desktop/src/main/sidecar.ts](https://github.com/anomalyco/opencode/blob/e71fbb6d48512c2376faab4cbeb21d63fadb929c/packages/desktop/src/main/sidecar.ts)

This lines up exactly with the migration blog's stated goal: run the server "within Electron's
built-in Node process" instead of bundling/spawning the separate Bun CLI, which had caused startup
delays and occasional failures. The blog also notes they had to strip Bun-specific APIs from the
server so it can run under Node.

### 4. Client/server communication

**HTTP + Server-Sent Events**, via the project's own Effect-based HTTP API framework. The event
stream handler (`server.event` → `event.subscribe`) returns `text/event-stream` with a 15-second
heartbeat and an Effect `Stream` pipeline encoding events as SSE frames — architecturally very
close to vibest's own `eventIteratorToStream` pattern in `packages/server-rpc`.
[packages/server/src/handlers/event.ts](https://github.com/anomalyco/opencode/blob/e71fbb6d48512c2376faab4cbeb21d63fadb929c/packages/server/src/handlers/event.ts)
IPC (Electron's `ipcMain`/`ipcRenderer`) is used only for desktop-shell concerns — window/menu
control, deep links, auto-updater state, native file/store access — not for the actual chat/agent
data path. [packages/desktop/src/main/ipc.ts](https://github.com/anomalyco/opencode/blob/e71fbb6d48512c2376faab4cbeb21d63fadb929c/packages/desktop/src/main/ipc.ts)

### 5. Tradeoffs/gotchas opencode calls out

- **WebKit vs Chromium rendering consistency** was the headline reason for leaving Tauri (blog,
  cited above) — a real cost of relying on OS-native webviews across platforms.
- **Bundle size** is an explicit, accepted tradeoff of Electron ("it's a trade-off we're willing to
  make" — same source).
- **Loopback security**: random port + random Basic Auth password per launch, `oc://` custom
  protocol restricted to a specific host/pathname with traversal checks (`rel.startsWith("..")`
  rejected), and forced loopback `NO_PROXY` — all visible directly in the source cited above,
  not just asserted.
- **Code signing/notarization**: `electron-builder.config.ts` sets `mac.notarize: true`,
  `mac.hardenedRuntime: true`, `dmg.sign: true`, and a custom PowerShell Windows signing step
  invoked only in CI (`GITHUB_ACTIONS === "true"`).
  [packages/desktop/electron-builder.config.ts](https://github.com/anomalyco/opencode/blob/e71fbb6d48512c2376faab4cbeb21d63fadb929c/packages/desktop/electron-builder.config.ts)
- **Auto-update**: uses `electron-updater` with `autoDownload: false` / manual
  `checkForUpdates`/`downloadUpdate`/`quitAndInstall` flow, polling every 10 minutes.
  [packages/desktop/src/main/updater.ts](https://github.com/anomalyco/opencode/blob/e71fbb6d48512c2376faab4cbeb21d63fadb929c/packages/desktop/src/main/updater.ts)

## t3code (`pingdotgg/t3code`)

All findings below were pulled directly via the GitHub Contents API (`api.github.com/repos/
pingdotgg/t3code/contents/...`) from the `main` branch, since raw.githubusercontent.com fetches
were intermittently unreachable during this research; each snippet quoted was the literal decoded
file content returned by the API, not a search-result summary.

### 1. Desktop runtime/shell

**Electron.** `apps/desktop/package.json` declares `"electron": "41.5.0"`, `"electron-updater":
"^6.6.2"`, `"electron-store": "^8.2.0"`, and a devDependency on `"electron-builder": "26.15.6"`,
with `"main": "dist-electron/main.cjs"`.
[apps/desktop/package.json](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/package.json)
A GitHub issue on the repo itself,
["Explore electrobun as a possible future desktop runtime" (#355, closed)](https://github.com/pingdotgg/t3code/issues/355),
confirms this from the maintainers' own words: "the desktop app currently relies on Electron pretty
deeply: `apps/desktop/src/main.ts` uses `BrowserWindow`, `protocol`, `ipcMain`, `Menu`, `dialog`,
`nativeImage`, `shell`, etc. ... `apps/desktop/package.json` depends on `electron` and
`electron-updater`" — floated only as a "maybe worth a spike" exploration, not an active migration.

### 2. Localhost server + webview, or bundled static + custom protocol?

**A third pattern, distinct from both opencode and Ollama: a custom protocol that reverse-proxies
to a localhost HTTP server**, rather than either loading `http://localhost` directly or serving
static files off disk through the protocol handler. `apps/desktop/src/electron/ElectronProtocol.ts`
registers scheme `t3code://` (production) / `t3code-dev://` (dev) via `Electron.protocol.handle`,
and its handler (`proxyRequest`) rewrites every incoming `t3code://app/...` request to
`new URL(pathname+search, targetOrigin)` and forwards it with `Electron.net.fetch`, stripping
hop-by-hop headers and re-attaching a `Content-Security-Policy` header to the response before
returning it to the renderer:

```ts
export const DESKTOP_PRODUCTION_SCHEME = "t3code";
export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://app/`;
}
```

[apps/desktop/src/electron/ElectronProtocol.ts](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/electron/ElectronProtocol.ts)
`targetOrigin` is the locally-spawned backend's own `httpBaseUrl` (see #3 below) — meaning the same
Node/Effect HTTP server that serves `apps/web`'s built static assets _also_ serves the API, and the
custom protocol is purely a stable-origin proxy in front of it (so the renderer's origin is always
`t3code://app`, independent of the backend's randomly-assigned port). `apps/desktop/src/
window/DesktopWindow.ts` then does a plain `window.loadURL(applicationUrl)` against that
`t3code://app/` URL, with retry/backoff logic if the protocol handler briefly rejects a request
while the backend is still starting.
[apps/desktop/src/window/DesktopWindow.ts](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/window/DesktopWindow.ts)

### 3. How the local server is packaged/started

**Spawned as a genuine OS child process** (not Electron's `utilityProcess`, not embedded
in-process) via Effect's `ChildProcessSpawner` abstraction, wrapped in a hand-rolled supervisor
(`DesktopBackendManager.makeBackendInstance`) that tracks `executablePath`, `args`, `entryPath`,
`cwd`, `env`, and polls a readiness endpoint (`/.well-known/t3/environment`) with a 1-minute
timeout before considering the backend "ready"; on unexpected exit it auto-restarts with
exponential backoff from 500ms up to a 10s cap
(`INITIAL_RESTART_DELAY` / `MAX_RESTART_DELAY` constants).
[apps/desktop/src/backend/DesktopBackendManager.ts](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/backend/DesktopBackendManager.ts)
A separate `DesktopBackendPool.ts` service can register **more than one** backend instance
concurrently — notably to support a second backend running inside WSL alongside the primary
Windows-native one, each on its own loopback port with its own log file — which is a materially
more advanced process-lifecycle design than either opencode's or Ollama's single-backend model.
[apps/desktop/src/backend/DesktopBackendPool.ts](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/backend/DesktopBackendPool.ts)
The backend itself (`apps/server`) is a Node/Bun-buildable package whose `package.json` lists
`@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk`, and `@effect/platform-node` /
`@effect/platform-bun` as dependencies, with `"bin": { "t3": "./dist/bin.mjs" }` — i.e. the same
compiled artifact also ships as the standalone `npx t3` CLI, and the desktop app just spawns it.
[apps/server/package.json](https://github.com/pingdotgg/t3code/blob/main/apps/server/package.json)

### 4. Client/server communication

**HTTP, through the `t3code://` proxy described in #2**, for the actual chat/agent data path — the
renderer never talks to `127.0.0.1:<port>` directly; it always calls the custom-protocol origin,
which `ElectronProtocol.ts` transparently forwards. Separately, `DesktopServerExposure.ts` supports
binding the backend to `0.0.0.0` (not just loopback) in an opt-in **"network-accessible" mode**, so
other devices on the same LAN can reach the same server directly over plain HTTP — plus a
`readTailscaleStatus`/Tailscale Serve integration for exposing the local backend outside the LAN.
[apps/desktop/src/backend/DesktopServerExposure.ts](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/backend/DesktopServerExposure.ts)
IPC (`ipcMain`/`contextBridge`, per the `#355` issue text above) is reserved for desktop-shell
concerns (menu actions via a dedicated `MENU_ACTION_CHANNEL`, window control, update state), the
same separation of concerns opencode uses.

### 5. Tradeoffs/gotchas t3code calls out

- **Loopback-by-default, opt-in LAN/Tailscale exposure**: `DesktopServerExposure.ts`'s own code
  comments explain that switching to LAN mode requires finding a non-internal, non-link-local IPv4
  address, and that Tailscale's own CLI is deliberately _not_ invoked unless the user has opted
  into network exposure, "since the spawn itself triggers a macOS 'Other apps' TCC prompt on Mac
  App Store Tailscale builds" — a first-party-documented tradeoff of shelling out to a third-party
  CLI from inside a sandboxed Mac app.
- **Custom protocol chosen specifically to decouple the renderer's origin from the backend's
  ephemeral port** — evident from the proxy design itself (`t3code://app` is stable; the backend's
  `httpBaseUrl` behind it is not), which is a subtly different design goal from opencode's
  file-serving `oc://` (opencode's static assets don't move; only its _API_ server's port is
  dynamic, and opencode's renderer calls that port directly via IPC-delivered credentials instead
  of proxying through the custom protocol).
- **Bun-friendliness noted as an open question**: the maintainers' own `#355` issue explicitly
  raises "Is there any real startup / packaging / DX benefit" to a Bun-native Electron alternative
  (`electrobun`), listing "custom protocol / deep link support" and "updater story ... compared to
  `electron-updater`" as open unknowns worth spiking — i.e., the team is aware Electron's overhead
  is a live cost, not treating the current choice as final.
- **Auto-update**: `electron-updater` (`^6.6.2`) with a channel-aware update state machine
  (`DesktopUpdates.ts`), a 15-second startup delay before the first check, and a 4-minute poll
  interval (`AUTO_UPDATE_STARTUP_DELAY` / `AUTO_UPDATE_POLL_INTERVAL` constants).
  [apps/desktop/src/updates/DesktopUpdates.ts](https://github.com/pingdotgg/t3code/blob/main/apps/desktop/src/updates/DesktopUpdates.ts)
- **Preflight-failure UX for a spawned backend**: `DesktopBackendManager`/`DesktopBackendPool`
  distinguish transient preflight failures (e.g. WSL cold-booting) from fatal ones (e.g. missing
  Node) and only give up — surfacing a native `electronDialog.showErrorBox` and falling back to a
  working backend — after `MAX_PREFLIGHT_FAILURE_ATTEMPTS` (5) consecutive fatal failures; this
  kind of graceful degradation logic is a direct, first-party-documented consequence of choosing
  "spawn a real child process" over an in-process or single-binary design.

## Appendix: additional prior art (Ollama, Jan.ai)

These two were originally researched as stand-ins before "t3cdoe" was correctly identified as
`pingdotgg/t3code` (see Identification note above). They are kept here, condensed, because they
illustrate two more distinct points on the design spectrum that opencode and t3code don't cover:
a **single-binary, no-Electron/no-Tauri** design (Ollama) and a **Tauri + externalBin sidecar**
design (Jan.ai).

### Ollama desktop app

Source: `github.com/ollama/ollama`, `app/` directory, at commit
[`82f905c`](https://github.com/ollama/ollama/tree/82f905cd9c06c6f0254d74c5326aa2a7f2f07e1f).

Source: `github.com/ollama/ollama`, `app/` directory, at commit
[`82f905c`](https://github.com/ollama/ollama/tree/82f905cd9c06c6f0254d74c5326aa2a7f2f07e1f).
(Release binaries are published to a separate `github.com/ollama/app` repo per the README's
download links, but the actual source lives in the main `ollama/ollama` monorepo, which is what
was inspected.)

#### 1. Desktop runtime/shell

Not Electron, not Tauri — a **custom native wrapper written in Go**, using the popular
`webview`/`webview_go` C++ library vendored at `app/webview/` (`webview.h`, `webview.cc`,
`webview.go`, plus a Windows `WebView2.h` header for the WebView2 backend). This is a thin binding
to the OS's own web-rendering engine (WebView2 on Windows, WKWebView on macOS via
`app_darwin.m`/Objective-C), not a bundled Chromium.
[app/README.md](https://github.com/ollama/ollama/blob/82f905cd9c06c6f0254d74c5326aa2a7f2f07e1f/app/README.md),
[app/webview](https://github.com/ollama/ollama/tree/82f905cd9c06c6f0254d74c5326aa2a7f2f07e1f/app/webview)

#### 2. Localhost server vs bundled/custom-protocol

**Localhost webview**, all served from **one process**. `app/cmd/app/app.go`'s `main()` opens a
TCP listener on `127.0.0.1:0` (random free port, or fixed `3001` in `-dev` mode), starts two HTTP
services on it in goroutines — the actual Ollama model-serving API (`server.New(...)`) and a UI
server (`ui.Server{...}.Handler()`) — then calls `Webview.Run()`, which navigates the native webview
to `http://127.0.0.1:<port>` (or `http://localhost:5173` against the Vite dev server in dev mode).
Auth is a random UUID token set as a cookie on first load, not HTTP Basic Auth.
[app/cmd/app/app.go](https://github.com/ollama/ollama/blob/82f905cd9c06c6f0254d74c5326aa2a7f2f07e1f/app/cmd/app/app.go),
[app/cmd/app/webview.go](https://github.com/ollama/ollama/blob/82f905cd9c06c6f0254d74c5326aa2a7f2f07e1f/app/cmd/app/webview.go)

The static React UI itself is **embedded directly into the Go binary** with `//go:embed app/dist`
and served by `http.FileServer` with an SPA fallback to `index.html` — there's no separate asset
protocol or file:// loading; it's just another route on the same localhost HTTP server.
[app/ui/app.go](https://github.com/ollama/ollama/blob/82f905cd9c06c6f0254d74c5326aa2a7f2f07e1f/app/ui/app.go)

#### 3. Packaging/startup of the local server

**Embedded in-process** — the model-serving server and the UI/webview shell are the _same compiled
Go binary_ and the _same OS process_, run as goroutines, not a spawned child process or separate
sidecar binary. This is the leanest of the three patterns researched.

#### 4. Client/server communication

Plain HTTP from the webview's JS to `http://127.0.0.1:<port>/...` (the code shows explicit REST
calls like `POST http://127.0.0.1:<port>/api/me` for auth checks), plus native JS↔Go bindings via
`webview.Bind(...)` for OS-integration calls the browser can't do itself (native file/directory
pickers, window drag, custom context menus) — visible directly in `webview.go`'s `wv.Bind("selectModelsDirectory", ...)` etc.

#### 5. Tradeoffs/gotchas

- **Native webview coupling**: because it uses WebView2/WKWebView instead of a bundled Chromium,
  Ollama inherits whatever rendering/JS engine version ships with the user's OS — the same class of
  cross-platform inconsistency risk that opencode's own blog post cites as a reason to _avoid_
  OS-native webviews (Tauri). Ollama accepts this in exchange for a much smaller binary and no
  bundled browser engine.
  [app/cmd/app/webview.go](https://github.com/ollama/ollama/blob/82f905cd9c06c6f0254d74c5326aa2a7f2f07e1f/app/cmd/app/webview.go)
  includes explicit Windows-only WebView2 scrollbar CSS patches — direct evidence of exactly this
  kind of engine-specific inconsistency being worked around by hand.
- **Single-instance handling and a `background` launch mode**: the app spawns a second copy of
  itself in a special "background" mode specifically so macOS's "Allow in the Background" setting
  can be toggled without killing the main app window — a packaging/process-lifecycle wrinkle unique
  to this single-binary-does-everything design. Same file as above.
- **Auto-update**: a homegrown `updater` package with `IsUpdatePending()`/`DoUpgradeAtStartup()`
  and a "post-upgrade cleanup" step handled specially on first launch after an update — visible in
  the same `app.go`.

### Jan.ai

Source: `github.com/janhq/jan` at commit
[`3a8355c`](https://github.com/janhq/jan/tree/3a8355c1a986b8940ad848b526d2d9229812df3d). Note: Jan
is commonly described as Electron-based in older write-ups; **that is no longer accurate** — the
repo now builds on **Tauri 2**, confirmed by `src-tauri/tauri.conf.json`'s `"$schema":
"https://schema.tauri.app/config/2"` and root `package.json`'s `"@tauri-apps/cli": "^2.7.0"`
devDependency and `"dev": "yarn dev:tauri"` script.
[package.json](https://github.com/janhq/jan/blob/3a8355c1a986b8940ad848b526d2d9229812df3d/package.json),
[src-tauri/tauri.conf.json](https://github.com/janhq/jan/blob/3a8355c1a986b8940ad848b526d2d9229812df3d/src-tauri/tauri.conf.json)

#### 1. Desktop runtime/shell

**Tauri** (Rust + OS-native webview), with a React frontend at `web-app/`.

#### 2. Localhost server vs bundled/custom-protocol

**Hybrid, and split differently than opencode's.** The frontend bundle itself is loaded via
Tauri's asset protocol from a prebuilt static dist: `tauri.conf.json`'s `build.frontendDist` is
`"../web-app/dist"`, with `devUrl: "http://localhost:1420"` for local dev, and the CSP config
explicitly enables `assetProtocol` and allow-lists `http://127.0.0.1:*` /`ws://127.0.0.1:*` in
`connect-src` for local inference-server traffic.
[src-tauri/tauri.conf.json](https://github.com/janhq/jan/blob/3a8355c1a986b8940ad848b526d2d9229812df3d/src-tauri/tauri.conf.json)

The local inference backend (an embedded **llama.cpp `llama-server`**, i.e. Jan's equivalent of
`packages/cli`) is managed on the **Rust side**, not fetched directly by the renderer. A dedicated
Tauri plugin, `tauri-plugin-llamacpp`, spawns and supervises the `llama-server` child process and
itself makes the HTTP calls to `http://127.0.0.1:<port>/models`, `/models/load`, `/models/sse`,
etc. — the React frontend talks to Rust via Tauri's `invoke()` command layer, and Rust proxies to
the local HTTP server, rather than the frontend hitting `127.0.0.1` directly the way opencode's
Electron renderer does.
[src-tauri/plugins/tauri-plugin-llamacpp/src/commands.rs](https://github.com/janhq/jan/blob/3a8355c1a986b8940ad848b526d2d9229812df3d/src-tauri/plugins/tauri-plugin-llamacpp/src/commands.rs)

#### 3. Packaging/startup of the local server

**Bundled external binary via Tauri's sidecar mechanism.** `tauri.macos.conf.json` and
`tauri.windows.conf.json` both declare `"externalBin": ["resources/bin/bun", "resources/bin/uv"]`
(Linux only bundles `uv`) — i.e. Jan ships a **compiled Bun runtime binary** alongside the app to
run parts of its own TypeScript backend/extension code, plus `uv` for Python-based components. The
`llama-server` inference binary is a separate resource fetched/managed by the Rust plugin and
spawned with Rust's own `tokio::process::Child`, with OS-specific graceful-shutdown logic
(`SIGTERM` then `SIGKILL` on Unix; force-kill only on Windows because `llama-server`'s console
handler only reacts to `CTRL_C_EVENT`, which can't be targeted at a single process without also
killing the parent).
[src-tauri/plugins/tauri-plugin-llamacpp/src/process.rs](https://github.com/janhq/jan/blob/3a8355c1a986b8940ad848b526d2d9229812df3d/src-tauri/plugins/tauri-plugin-llamacpp/src/process.rs)

#### 4. Client/server communication

**Two layers**: (a) React frontend ↔ Rust main process via Tauri's IPC `invoke()` commands for
anything requiring native access or process control; (b) Rust ↔ local inference server via plain
HTTP, including an SSE endpoint (`/models/sse`) for load-progress streaming, which Rust then
presumably re-emits to the frontend as Tauri events (not directly inspected, but the SSE consumption
is in Rust, confirmed above).

#### 5. Tradeoffs/gotchas

- **Auto-update**: Tauri's official `updater` plugin, configured with a minisign public key and two
  endpoints (a first-party `apps.jan.ai/update-check` and a GitHub Releases `latest.json` fallback),
  `windows.installMode: "passive"`.
  [src-tauri/tauri.conf.json](https://github.com/janhq/jan/blob/3a8355c1a986b8940ad848b526d2d9229812df3d/src-tauri/tauri.conf.json)
- **Process lifecycle edge cases**: the Windows-specific comment in `process.rs` about
  `llama-server`'s console-handler limitations is a concrete, first-party-documented gotcha of
  spawning a third-party native server binary and needing clean shutdown across platforms.
- **CSP had to be deliberately loosened** for localhost traffic (`connect-src` allows
  `http://127.0.0.1:*` and `ws://127.0.0.1:*` explicitly) — a reminder that Tauri's default CSP
  posture doesn't allow arbitrary local-network calls out of the box; it's an explicit opt-in.

## Recommendation for vibest

**t3code is the closest structural peer vibest has**: same shape (a Claude-Agent-SDK-powered
Node/Effect server serving a built web UI plus a JSON/HTTP API), same monorepo-with-a-desktop-app
goal, and it has already shipped a working Electron wrapper around exactly this problem. opencode
is the second-closest peer and independently valuable because its own team already ran the
Tauri-vs-Electron experiment and wrote up why they left Tauri. Both point at Electron, and both
avoid `loadURL('http://localhost:PORT')` for the UI shell itself in favor of a custom protocol —
but they solve the "protocol vs. dynamic backend port" problem differently, and that difference is
the concrete decision vibest needs to make.

**Concrete recommended pattern**: Electron, with `packages/cli`'s Express server spawned as a real
child process from the main process (`child_process.spawn` from `app.whenReady()`, or Electron's
`utilityProcess.fork` if `packages/cli` is bundled to run under Electron's own Node — opencode's
`utilityProcess` choice is the tighter integration, but a plain spawned child process, as t3code
uses via its own `ChildProcessSpawner` abstraction, is the lower-effort starting point since
`packages/cli` already runs as ordinary `node`/`express` with no changes needed to how it's
invoked). The server binds to `127.0.0.1` on an OS-assigned free port. Rather than pointing
`BrowserWindow.loadURL` at that dynamic `http://127.0.0.1:<port>` directly (which ties the UI's own
origin to a port that changes every launch and disappears if the server restarts), register a
**custom privileged protocol** with `protocol.registerSchemesAsPrivileged` +
`protocol.handle('vibest', ...)` and, following t3code's `ElectronProtocol.ts` design, make the
handler a **reverse proxy** (`Electron.net.fetch` against the real `http://127.0.0.1:<port>`
origin) rather than opencode's file-serving approach. This is the better fit for vibest specifically
because `packages/cli` already serves both the static `apps/web` build _and_ the `@orpc` RPC/SSE
API from the same Express instance — proxying the whole origin through `vibest://app/` keeps that
single-server design completely intact, whereas opencode's split (static files via file-serving
protocol, API via a _separate_ HTTP+SSE server reached over IPC-delivered credentials) would require
peeling vibest's static-serving and RPC concerns apart for no real benefit. The renderer's
`@orpc/client` then just calls same-origin `vibest://app/rpc` (whatever path `packages/cli` already
mounts oRPC under) instead of `http://localhost:PORT`, so `apps/web`'s RPC client code needs
near-zero change — only the base URL becomes protocol-relative. `BrowserWindow` should use
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, matching both opencode's and
t3code's config.

**Main tradeoff vs. the alternative (Tauri + compiled sidecar, à la Jan)**: Tauri would need
`packages/cli` compiled to a standalone native binary (e.g. `bun build --compile`) shipped via
`bundle.externalBin` and started through Tauri's `shell.sidecar` / Rust `Command::new(...).spawn()`
— a real advantage in final install size and no bundled Chromium, but it (a) reintroduces the
WebKit/WebView2/WKWebView rendering-consistency risk that opencode's own migration blog explicitly
moved away from, and that neither of the two closest peers (opencode, t3code) chose, and (b) adds a
new build target and packaging step `packages/cli` doesn't have today. Given both of the projects
architecturally closest to vibest independently converged on Electron with a spawned/forked Node
child process and a custom protocol in front of it, that combination — not Tauri — is the
lower-risk, more directly reusable starting point for vibest; a Tauri sidecar remains a reasonable
fallback if install size becomes a hard constraint later, using Jan's `externalBin` pattern as the
template.
