# Embedding the web app into Electron: opencode vs t3code vs vibest

A dimension-by-dimension comparison of how three codebases put a shared web app
inside a desktop window. Everything here is read from source, not from docs or
blog posts:

- **opencode** — `/tmp/github.com/anomalyco/opencode`, `packages/desktop` (`@opencode-ai/desktop` 1.17.18)
- **t3code** — `/tmp/github.com/pingdotgg/t3code`, `apps/desktop`
- **vibest** — this repo, `apps/desktop`, as of PR #100

## Summary

All three converged on the same skeleton: **Electron, a sandboxed renderer, a
CommonJS preload, a custom privileged protocol for the window, and a local HTTP
server in a separate process, authenticated with a per-launch secret.** Nobody uses
Tauri. Nobody points a webview at a remote URL. Nobody serves the app document over
`file://`. Every one of them has code to repair `PATH` for GUI launches.

They diverge on three things, and each is a genuine fork:

1. **What the protocol handler does** — serve files off disk (opencode, vibest) or reverse-proxy the local server (t3code).
2. **How the server process starts** — Electron's `utilityProcess` (opencode) or a real child process on Electron's Node (t3code, vibest).
3. **Who picks the port** — the host, before the server starts (opencode) or the server, reporting back (vibest).

vibest takes opencode's answer to (1), t3code's to (2), and its own to (3).

## The dimensions

|                    | opencode                                     | t3code                                               | vibest                                       |
| ------------------ | -------------------------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| **Runtime**        | Electron 42.3.3                              | Electron 41.5.0                                      | Electron 41.10.1                             |
| **Tooling**        | electron-vite 5 + builder 26                 | electron-builder 26                                  | electron-vite + builder 26                   |
| **UI**             | SolidJS                                      | React                                                | React + TanStack Router                      |
| **Window origin**  | `oc://renderer`                              | `t3code://` / `t3code-dev://`                        | `vibest://app`                               |
| **Handler does**   | serves static files off disk                 | **reverse-proxies** the local server                 | serves static files off disk                 |
| **Routing**        | **MemoryRouter** — no URL paths              | **hash history** in Electron (client-side)           | real pathnames → **needs SPA fallback**      |
| **Server process** | `utilityProcess.fork(sidecar.js)`            | `spawn` + `ELECTRON_RUN_AS_NODE`                     | `spawn` + `ELECTRON_RUN_AS_NODE`             |
| **Port**           | host grabs a free one, passes it in          | **host-side sequential port scan** (config override) | **server binds `:0`, reports back**          |
| **Readiness**      | MessagePort `ready` **+ HTTP health poll**   | ready flag + poll                                    | stdout `vibest:ready {"port":N}`             |
| **Auth**           | HTTP **Basic**, password = `randomUUID()`    | **bearer** token (+ Clerk for cloud)                 | **bearer** token                             |
| **WebSocket auth** | `?auth_token=` / `?ticket=` query param      | ticket (`issueWebSocketTicket`)                      | single-use ticket                            |
| **CORS**           | allowlist `["oc://renderer"]`                | **wildcard `*`** — leans on the token, not origin    | allowlist `vibest://app` + dev origin        |
| **Preload**        | CJS, sandboxed                               | CJS, sandboxed                                       | CJS, sandboxed                               |
| **Bridge surface** | large (~35 methods)                          | **very large** (SSH, WSL, preview tabs, automation)  | **minimal** (one bootstrap call)             |
| **Host detection** | **`Platform` union + separate entry points** | `window.desktopBridge` sniffing                      | **`Platform` union + separate entry points** |
| **PATH repair**    | login-shell `env -0` probe                   | login shell **+ `launchctl getenv PATH`**            | login-shell probe                            |
| **asarUnpack**     | none — builder's default smart-unpack        | **everything** (`**/node_modules/**`)                | none needed                                  |
| **Agent binary**   | n/a — the server _is_ the agent              | **user's installed `claude`**                        | **user's installed `claude`**                |
| **Signing**        | real: hardened runtime + notarized           | real                                                 | ad-hoc (no Apple cert yet)                   |

## 1. How the window gets the UI

The biggest architectural fork.

**opencode serves files off disk.** It registers a privileged scheme (`secure`,
`standard`, `supportFetchAPI`), then in `protocol.handle` rejects any host that
isn't `renderer`, resolves the path under the renderer root, guards traversal with
`relative()`, and hands the file to `net.fetch(pathToFileURL(file))`
(`src/main/windows.ts:32`, `:251-283`). The server never delivers the UI. Origin:
`oc://renderer`.

**t3code reverse-proxies.** Its handler forwards every `t3code://` request to the
local server's HTTP origin — `proxyRequest(request, input.targetOrigin, contentSecurityPolicy)`
(`apps/desktop/src/electron/ElectronProtocol.ts:184`) — with a retry ladder
(0/50/150 ms) for transient failures, injecting a Content-Security-Policy on the way
through. The window cannot paint until the server is up.

**vibest follows opencode**, and needs an **SPA fallback** where the others sidestep
the problem. This is a routing decision, not a protocol one, and each project made a
different one:

- opencode's renderer uses a **MemoryRouter** (`createMemoryHistory`, `src/renderer/index.tsx:20`), so the window only ever loads `index.html` and no navigation touches the URL. A 404 for unknown paths is correct.
- t3code uses the same TanStack Router as vibest, but **switches to hash history in Electron** (`createHashHistory()`, `apps/web/src/main.tsx:22`, with the comment "hash history avoids path resolution issues"), so the path the handler sees is always the document — the route lives after the `#`. Belt-and-braces, its proxied server _also_ serves `index.html` for non-file paths (`apps/server/src/http.ts:283-294`).
- vibest uses TanStack Router on **real pathnames**, so a reload or deep link asks the protocol handler for `/chat/<id>` — which is not a file. Without a fallback the window renders "Not Found," which is exactly what happened on the first packaged launch. Hash history (t3code's move) would have avoided it too; the SPA fallback is the equivalent fix on the file-serving side.

**Why files beat the proxy:** the UI paints instantly, independent of server health,
and there's no second HTTP hop per asset. The proxy earns its keep when the server
owns routing and rendering, which t3code has and vibest doesn't.

## 2. How the server process starts

**opencode uses `utilityProcess.fork`** on a bundled `sidecar.js`
(`src/main/server.ts:61`), which imports `virtual:opencode-server` — a Bun-built
**Node ESM bundle** of the opencode server, aliased at build time. So the "sidecar"
is not a binary and not a separate runtime; it's their server JS running inside an
Electron utility process.

Startup is a MessagePort conversation: the host posts
`{type:"start", hostname, port, password, userDataPath}`, the child answers `ready`
or `error` under a 60 s stall timeout — **and then the host separately polls
`GET /global/health` with Basic auth every 100 ms until it passes.** Two independent
readiness signals.

**t3code spawns Electron's own Node** (`ELECTRON_RUN_AS_NODE` on
`apps/server/dist/bin.mjs`). That runtime is asar-aware, so the entry is read
straight out of `app.asar`. Its WSL variant instead launches `wsl.exe -- node`,
which _cannot_ read an asar at all — the reason it unpacks so aggressively (§6).

**vibest follows t3code.** The decisive property: a packaged app needs no system
Node, and the server stays a plain Node process that runs unchanged under `node` in
browser mode.

## 3. Port and readiness

Three genuinely different answers.

- **opencode** picks the port itself _before_ starting anything: open a socket on `:0`, read the assigned port, close it, pass the number to the sidecar (`src/main/index.ts:307-332`). Simple, but there's a window between close and re-bind where another process could take it. `OPENCODE_PORT` overrides.
- **t3code** does a host-side **sequential scan**: start at a default port and probe upward, checking each candidate is free on every bind host (`net.canListenOnHost`) before using it (`apps/desktop/src/app/DesktopApp.ts:66-96`). A configured port is only an override. Deterministic ports, at the cost of a small race like opencode's.
- **vibest** inverts it: the server binds `:0` and prints `vibest:ready {"port":N}` on stdout; the host parses that line. No race — the port is never released — at the cost of a small stdout protocol.

## 4. Authentication

All three authenticate the loopback server, which matters more than it looks: any
process on the machine can reach `127.0.0.1`.

- **opencode**: HTTP **Basic**, username `opencode`, password `randomUUID()` per launch. The server is started with an exact CORS allowlist, `cors: ["oc://renderer"]`.
- **t3code**: a **bearer** token for the local server (`getLocalEnvironmentBearerToken` on the bridge). Its CORS, though, is wildcard `*` (`apps/server/src/httpCors.ts:11`) — it deliberately leans on the token, not the origin. It also has a _second_ auth layer the others lack: Clerk (`@clerk/electron`), for cloud/relay accounts. The bearer token secures the loopback server; Clerk secures the hosted side.
- **vibest**: a **bearer** token, minted per launch and never written to disk, plus an exact CORS allowlist.

Worth pausing on the CORS split, because it's a real disagreement: opencode and
vibest pin the allowed origin exactly; t3code opens it to `*` and treats the bearer
token as the whole boundary. Both are defensible on loopback — CORS is a browser
policy, not a server-side gate, and any native process ignores it — but the exact
allowlist is one cheap extra layer against a malicious _web page_ in the renderer.

**WebSockets force the same workaround on everyone.** Browsers cannot set headers on
a WS handshake, so the secret has to ride in the URL. opencode appends
`?auth_token=…` (and supports a `?ticket=` variant) on its PTY socket; t3code issues
a single-use ticket (`issueWebSocketTicket`, `apps/server/src/auth/EnvironmentAuth.ts:918`);
vibest mints a single-use ticket over HTTP and passes it as `?ticket=`. Three
codebases, one constraint, three near-identical answers.

One thing vibest does that neither peer does: the token reaches the server through
an env var that the server **deletes from `process.env` after reading**, so a bash
tool the agent spawns cannot inherit it.

## 5. The preload, and how the app knows where it is

Structurally identical everywhere — `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, and a preload emitted as **CommonJS**
(`output: { format: "cjs", entryFileNames: "[name].js" }`), because a sandboxed
preload cannot be ESM. opencode's rollup config (`electron.vite.config.ts:82-92`)
and vibest's are effectively the same file.

The bridges differ enormously in size. t3code's `desktopBridge` covers SSH, WSL,
preview tabs, browser automation, screen recording, menus and updates. opencode's
`window.api` has ~35 methods. vibest's is one synchronous call returning
`{httpBaseUrl, wsBaseUrl, token}` — the renderer gets its backend coordinates and
nothing else.

**Host detection is where opencode and t3code split, and vibest sides with opencode.**
t3code sniffs for `window.desktopBridge`. opencode instead models the host as a
**discriminated union with separate entry points**:

```ts
// packages/app/src/context/platform.tsx:123
type Platform = PlatformBase & (
  | { platform: "web";     os?: never }
  | { platform: "desktop"; os?: DesktopOS; openDirectoryPickerDialog(...): ... }
)
```

The shared app package never touches `window.api`. The web entry
(`packages/app/src/entry.tsx`) and the desktop entry
(`packages/desktop/src/renderer/index.tsx`) each construct their own `Platform` and
provide it through context. vibest does exactly this with
`{host:"web"} | {host:"desktop", os, backend}`. An `isElectron` boolean invites
`if (isElectron)` scattered through the UI; a union makes desktop-only data
unreachable unless you've narrowed the type.

## 6. Native binaries, packaging, and the thing that cost us a day

**The GUI PATH problem.** macOS hands a double-clicked app a bare
`/usr/bin:/bin:…` — not the PATH from your shell profile, nvm, Homebrew, or a native
installer. All three have code for this. opencode runs `spawnSync(shell, ["-il", "-c", "env -0"])`
with a `-l` fallback and a 5 s timeout (`src/main/shell-env.ts`). t3code does the
same and adds a **`launchctl getenv PATH` fallback on darwin**. vibest captures the
login shell's PATH and passes it to the spawned server.

**The agent binary.** opencode isn't comparable here: its server _is_ the agent, so
there's no external CLI to locate. (It has dead machinery for shipping an
`opencode-cli` binary — including an ad-hoc `codesign --force --sign -` — with no
live callers.)

t3code and vibest both drive the Claude Agent SDK, which execs a native `claude`
binary shipped as a ~230 MB optional platform dependency. **t3code does not bundle
it.** `ClaudeDriver` declares `executable: "claude"`, discovers the user's install on
PATH, stores the path as a setting, and passes it to the SDK as
`pathToClaudeCodeExecutable` (`apps/server/src/provider/Layers/ClaudeProvider.ts:600`).
It even ships an update flow that runs `claude update`. It has no real choice — it
supports Claude, Codex, opencode and Cursor, and can't bundle them all.

vibest now does the same, by decision. Bundling would have cost ~230 MB and pinned
Claude Code's version to whatever the SDK ships.

**Where this bites you.** electron-builder happily sweeps that binary into
`app.asar`, and **an OS `exec` cannot traverse an asar archive** — it fails with
`ENOTDIR`. That was vibest's silent 500 on `session/create`. The general rule:
_anything that must be `exec`'d, or read by a process that isn't Electron, has to be
a real file on disk._ t3code says so in a comment and solves it bluntly —
`asarUnpack: ["apps/server/dist/**", "**/node_modules/**"]`, unpack everything —
because its WSL backend runs plain `node`, which can't read an asar at all. opencode
sets **no `asarUnpack` at all**, relying on electron-builder's default smart-unpack
of native modules, and ships its one native addon via `extraResources` instead.

**Platform binaries and pnpm.** opencode declares every platform's native prebuild
explicitly in `optionalDependencies` (node-pty and parcel-watcher, all six
platform/arch combos). This is not decoration: **pnpm 10+ does not install transitive
platform binaries**, so without that declaration they never reach the bundle —
electron-builder warns about exactly this. vibest doesn't need it now that the
`claude` binary is excluded on purpose.

**Signing.** opencode does it properly: `hardenedRuntime: true`, `notarize: true`,
an entitlements plist granting JIT and unsigned executable memory, and a PowerShell
signer for Windows. vibest has no Apple certificate yet, so it ad-hoc signs in an
`afterPack` hook. This is not optional: electron-builder had already invalidated the
signature Electron ships with, and **macOS on Apple Silicon kills a bundle whose
signature doesn't verify — instantly, with no window, no output, and no crash
report.**

## What vibest should take next

- **opencode's two-signal readiness** — a process handshake _and_ an HTTP health poll. vibest trusts the stdout line alone; a server that prints ready and then wedges would hang the window.
- **t3code's `launchctl getenv PATH` fallback**, for users whose login-shell probe fails or times out.
- **opencode's explicit `optionalDependencies`**, the day we ship any native binary — otherwise cross-platform builds will silently omit it.
- **Real code signing.** Ad-hoc is fine for local builds and useless for distribution.
