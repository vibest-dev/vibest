# Electron coding-agent runtime distribution research

- **Date:** 2026-07-14
- **Scope:** T3 Code, Paseo, Craft Agents, OpenAI Codex Desktop, Claude Agent SDK, Codex CLI, and Pi
- **Question:** Which projects bundle their agent runtimes inside Electron, which require system-installed CLIs, and can these agents be installed and run when the user has no Node.js environment?

## Executive summary

There are three distinct things that are easy to conflate:

1. **The JavaScript SDK or adapter layer** loaded by an Electron/backend process.
2. **The agent executable** spawned by that SDK or adapter, such as `claude` or `codex`.
3. **The JavaScript runtime** required by JS-based agents, such as Node.js or Bun.

The projects studied take different approaches:

| Project              | Claude SDK core in desktop distribution          | Claude executable                                             | Codex executable                                    | Pi runtime                          | Requires user Node.js                                                            |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| T3 Code              | Yes, through the bundled server dependency graph | Uses user-installed `claude`                                  | Uses user-installed `codex`                         | Uses user-installed `pi`            | Not for the desktop app itself, but external npm-installed agents may require it |
| Paseo                | Yes, through the bundled daemon/server           | Explicitly removes SDK-provided Claude binaries and uses PATH | Uses user-installed `codex`                         | Uses user-installed `pi`            | Yes for Pi and `npx`-based ACP providers unless installed another way            |
| Craft Agents         | Yes                                              | Bundles the matching platform Claude binary                   | No longer maintains a separate Codex binary backend | Bundles a Pi server and Bun runtime | No                                                                               |
| OpenAI Codex Desktop | Not applicable                                   | Not applicable                                                | Bundles its own native `codex` executable           | Not applicable                      | No                                                                               |

The clearest architectural alternatives are:

- **Paseo model:** bundle the adapter/SDK core but require an existing system CLI.
- **Craft model:** bundle the SDK, native agent binary, and any necessary JS runtime.
- **Managed-runtime model:** ship a small desktop app, then download versioned, checksummed agent runtimes into app data on first use.

No studied Electron project uses the full managed-runtime model for Claude. Paseo uses a similar on-demand approach for some ACP providers through pinned `npx -y` commands, while OpenAI's standalone Codex installer is a strong example of managed native-binary installation.

---

## Repositories and revisions inspected

- [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at [`c1ec1915`](https://github.com/pingdotgg/t3code/commit/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526)
- [getpaseo/paseo](https://github.com/getpaseo/paseo) at [`b4ab0d9d`](https://github.com/getpaseo/paseo/commit/b4ab0d9db6e5668218e5aaa34f15ef3dd133e3ec)
- [craft-ai-agents/craft-agents-oss](https://github.com/craft-ai-agents/craft-agents-oss) at [`4289b160`](https://github.com/craft-ai-agents/craft-agents-oss/commit/4289b16097322e9911d3078d8a64bd8c830717c3)
- [openai/codex](https://github.com/openai/codex) at [`4aa950d4`](https://github.com/openai/codex/commit/4aa950d456c6c90174d3269d7eaab4a2823e5889)

The complete OpenAI Codex Desktop frontend and packaging source is not present in the public `openai/codex` repository. Claims about the desktop bundle therefore use OpenAI's public documentation in addition to the public CLI/app-server source.

---

## Claude Agent SDK distribution model

Current Claude Agent SDK releases have two relevant layers:

```text
@anthropic-ai/claude-agent-sdk
  ├── SDK core, including sdk.mjs
  └── optional platform package
       └── @anthropic-ai/claude-agent-sdk-<platform>-<arch>
            └── claude or claude.exe
```

The SDK core is JavaScript/ESM and needs a compatible JS runtime. The spawned `claude` program is a platform-native executable.

A user does **not** need a system Node.js installation when the SDK is loaded by an Electron main process, because Electron already contains Node.js. An application may also run the SDK in a separate process by:

- launching Electron with `ELECTRON_RUN_AS_NODE=1`,
- shipping a private Node.js runtime, or
- shipping a private Bun runtime.

The native Claude executable can be bundled with the application or downloaded separately. When downloaded separately, the SDK core and binary package should be kept at the same exact version.

### Suggested managed layout

```text
app-data/runtimes/
└── claude/
    ├── 0.3.197/
    │   ├── sdk/
    │   │   └── sdk.mjs
    │   └── bin/
    │       └── claude
    └── current -> 0.3.197
```

In practice, bundling the small SDK core with the app and downloading only the large platform binary is simpler than dynamically loading an entire npm package tree from app data.

A safe downloader needs:

- platform and architecture selection,
- exact version pinning,
- SHA-256 or stronger integrity validation,
- temporary download and extraction directories,
- an atomic `current` switch,
- rollback support,
- executable permissions on Unix,
- Windows antivirus/file-lock handling,
- macOS code-signing and quarantine consideration,
- proxy and interrupted-download support.

---

## T3 Code

### Desktop architecture

T3 Code's desktop app is an Electron shell that launches a bundled T3 backend. The backend directly depends on the Claude Agent SDK:

- [`apps/server/package.json`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/apps/server/package.json)

The desktop build constructs a staging package from both server production dependencies and desktop runtime dependencies, installs them, and copies the server build into the Electron application:

- [`scripts/build-desktop-artifact.ts`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/scripts/build-desktop-artifact.ts)

This places the SDK core in the desktop backend's dependency graph. The build process may also install the SDK's matching optional platform binary, but the runtime does not intentionally use that binary.

### Claude runtime

T3's default Claude setting is a binary path of `claude`, and the SDK call explicitly sets `pathToClaudeCodeExecutable` to the configured binary path:

- [`packages/contracts/src/settings.ts`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/packages/contracts/src/settings.ts)
- [`apps/server/src/provider/Layers/ClaudeAdapter.ts`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/apps/server/src/provider/Layers/ClaudeAdapter.ts)
- [`apps/server/src/provider/Layers/ClaudeProvider.ts`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/apps/server/src/provider/Layers/ClaudeProvider.ts)

The README explicitly instructs users to install Claude Code and authenticate it:

- [`README.md`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/README.md)

Therefore T3 bundles the SDK integration layer but deliberately uses a user-installed Claude executable.

### Codex and Pi

T3 similarly expects Codex and Pi executables to be available externally. Codex configuration defaults to a `codex` binary path, and its getting-started documentation asks users to place Codex CLI on PATH:

- [`docs/getting-started/codex-prerequisites.md`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/docs/getting-started/codex-prerequisites.md)
- [`apps/server/src/provider/Drivers/CodexDriver.ts`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/apps/server/src/provider/Drivers/CodexDriver.ts)

### Dynamic installation and updates

T3 does not automatically install a missing provider. It does have a provider-maintenance system that can update an already-detected CLI according to its installation source. It may run commands such as:

```text
npm install -g <package>@latest
bun i -g <package>@latest
pnpm add -g <package>@latest
brew upgrade <formula>
claude update
```

Sources:

- [`apps/server/src/provider/providerMaintenance.ts`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/apps/server/src/provider/providerMaintenance.ts)
- [`apps/server/src/provider/providerMaintenanceRunner.ts`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/apps/server/src/provider/providerMaintenanceRunner.ts)
- [`apps/server/src/provider/Drivers/ClaudeDriver.ts`](https://github.com/pingdotgg/t3code/blob/c1ec1915fc16f3dc1ec5d47d9a97f6210a574526/apps/server/src/provider/Drivers/ClaudeDriver.ts)

This is an in-app update mechanism, not a self-contained first-install mechanism. On a pristine system with no Node/npm, an npm-based update or installation route cannot work unless T3 first provides a runtime/package manager or chooses a native installer.

---

## Paseo

### Desktop architecture

Paseo's Electron app bundles and launches its own daemon/server. The server directly depends on `@anthropic-ai/claude-agent-sdk`, and the desktop package depends on that server:

- [`packages/server/package.json`](https://github.com/getpaseo/paseo/blob/b4ab0d9db6e5668218e5aaa34f15ef3dd133e3ec/packages/server/package.json)
- [`packages/desktop/package.json`](https://github.com/getpaseo/paseo/blob/b4ab0d9db6e5668218e5aaa34f15ef3dd133e3ec/packages/desktop/package.json)

The SDK core is therefore part of the bundled daemon dependency graph.

### Claude runtime

Paseo explicitly removes every `claude-agent-sdk-*` optional platform binary during Electron `afterPack` processing:

```js
for (const entry of fs.readdirSync(anthropicDir)) {
  if (entry.startsWith("claude-agent-sdk-")) {
    rmSafe(path.join(anthropicDir, entry));
  }
}
```

Its comment states that these binaries are approximately 210 MB and that Paseo deliberately requires `claude` on PATH:

- [`packages/desktop/scripts/after-pack.js`](https://github.com/getpaseo/paseo/blob/b4ab0d9db6e5668218e5aaa34f15ef3dd133e3ec/packages/desktop/scripts/after-pack.js)

Paseo passes the externally resolved binary to the SDK through `pathToClaudeCodeExecutable`:

- [`packages/server/src/server/agent/providers/claude/agent.ts`](https://github.com/getpaseo/paseo/blob/b4ab0d9db6e5668218e5aaa34f15ef3dd133e3ec/packages/server/src/server/agent/providers/claude/agent.ts)

Its changelog records the deliberate removal of the bundled fallback:

> Claude agents now require `claude` on your PATH. Paseo no longer ships a bundled fallback binary, reducing the desktop install by approximately 210 MB per platform.

- [`CHANGELOG.md`, version 0.1.70](https://github.com/getpaseo/paseo/blob/b4ab0d9db6e5668218e5aaa34f15ef3dd133e3ec/CHANGELOG.md)

### Codex and Pi

Current Paseo discovers Codex from PATH or supported OS installation locations. If no binary is found, it reports that the user must install Codex CLI:

- [`packages/server/src/server/agent/providers/codex-app-server-agent.ts`](https://github.com/getpaseo/paseo/blob/b4ab0d9db6e5668218e5aaa34f15ef3dd133e3ec/packages/server/src/server/agent/providers/codex-app-server-agent.ts)

Paseo's Pi provider also requires a user-installed `pi` executable and talks to it through `pi --mode rpc`; it does not embed Pi SDK/runtime packages:

- [`docs/providers.md`](https://github.com/getpaseo/paseo/blob/b4ab0d9db6e5668218e5aaa34f15ef3dd133e3ec/docs/providers.md)

### Dynamic ACP providers

Paseo does have a provider catalog whose entries commonly use exact-version `npx -y` commands, for example:

```text
npx -y @augmentcode/auggie@0.32.0 --acp
npx -y @google/gemini-cli@0.50.0 --acp
npx -y @qwen-code/qwen-code@0.19.9 --acp
```

- [`packages/app/src/data/acp-provider-catalog.ts`](https://github.com/getpaseo/paseo/blob/b4ab0d9db6e5668218e5aaa34f15ef3dd133e3ec/packages/app/src/data/acp-provider-catalog.ts)
- [`packages/app/src/screens/settings/providers-section.tsx`](https://github.com/getpaseo/paseo/blob/b4ab0d9db6e5668218e5aaa34f15ef3dd133e3ec/packages/app/src/screens/settings/providers-section.tsx)

The catalog's Install action stores the provider command and refreshes/probes it. The first `npx` execution downloads and caches the package. This is an on-demand agent acquisition model, but it fails on machines without Node/npm/npx unless the application supplies those tools itself.

---

## Craft Agents

### Claude runtime

Craft directly depends on the Claude Agent SDK:

- [`package.json`](https://github.com/craft-ai-agents/craft-agents-oss/blob/4289b16097322e9911d3078d8a64bd8c830717c3/package.json)

The Electron main build marks the SDK as external to the single-file `main.cjs` bundle, but the SDK is still physically packaged. `electron-builder.yml` copies both the SDK core and a stable alias containing the matching platform-native Claude binary:

```text
app/node_modules/@anthropic-ai/claude-agent-sdk
app/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude
```

Sources:

- [`apps/electron/package.json`](https://github.com/craft-ai-agents/craft-agents-oss/blob/4289b16097322e9911d3078d8a64bd8c830717c3/apps/electron/package.json)
- [`apps/electron/electron-builder.yml`](https://github.com/craft-ai-agents/craft-agents-oss/blob/4289b16097322e9911d3078d8a64bd8c830717c3/apps/electron/electron-builder.yml)

The build selects the target architecture's package and stages it as `claude-agent-sdk-binary` so runtime resolution is stable across platforms:

- [`scripts/build/common.ts`](https://github.com/craft-ai-agents/craft-agents-oss/blob/4289b16097322e9911d3078d8a64bd8c830717c3/scripts/build/common.ts)

Release notes describe the resulting approximately 210 MB per-platform increase:

- [`apps/electron/resources/release-notes/0.9.0.md`](https://github.com/craft-ai-agents/craft-agents-oss/blob/4289b16097322e9911d3078d8a64bd8c830717c3/apps/electron/resources/release-notes/0.9.0.md)

Craft users therefore do not need a system-installed `claude` or Node.js runtime.

### Pi runtime

Craft implements Pi as a bundled out-of-process server rather than requiring the user's `pi` CLI. It:

1. downloads a target-platform Bun runtime during the application build,
2. verifies Bun against the published SHA-256 checksum,
3. bundles the Pi SDK into a `pi-agent-server/index.js`,
4. copies the server and required native dependencies into Electron resources,
5. starts the Pi server with the bundled Bun runtime.

Sources:

- [`scripts/build/common.ts`, Bun download](https://github.com/craft-ai-agents/craft-agents-oss/blob/4289b16097322e9911d3078d8a64bd8c830717c3/scripts/build/common.ts)
- [`scripts/build/common.ts`, Pi server build/copy](https://github.com/craft-ai-agents/craft-agents-oss/blob/4289b16097322e9911d3078d8a64bd8c830717c3/scripts/build/common.ts)
- [`packages/shared/src/agent/backend/internal/runtime-resolver.ts`](https://github.com/craft-ai-agents/craft-agents-oss/blob/4289b16097322e9911d3078d8a64bd8c830717c3/packages/shared/src/agent/backend/internal/runtime-resolver.ts)
- [`apps/electron/electron-builder.yml`](https://github.com/craft-ai-agents/craft-agents-oss/blob/4289b16097322e9911d3078d8a64bd8c830717c3/apps/electron/electron-builder.yml)

The packaged app deliberately refuses to fall back to an arbitrary system Bun, avoiding compatibility drift.

### Codex

Current Craft architecture has consolidated around two backends: Claude and Pi. Release notes mention removing stale standalone Copilot/Codex binary packaging after this consolidation:

- [`apps/electron/resources/release-notes/0.9.4.md`](https://github.com/craft-ai-agents/craft-agents-oss/blob/4289b16097322e9911d3078d8a64bd8c830717c3/apps/electron/resources/release-notes/0.9.4.md)

OpenAI/Codex models can be accessed through the Pi backend without maintaining a separate bundled Codex CLI backend.

---

## OpenAI Codex CLI and Desktop App

### Codex CLI does not require Node.js

Current Codex is a native Rust executable. OpenAI supports a standalone installation path that does not use npm:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Windows:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

The README also links directly to platform binaries in GitHub Releases:

- [`openai/codex README`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/README.md)

The standalone installer downloads a platform-specific package such as:

```text
codex-package-<vendor-target>.tar.gz
```

and maintains it under:

```text
$CODEX_HOME/packages/standalone/<version>/
$CODEX_HOME/packages/standalone/current/
```

- [`scripts/install/install.sh`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/scripts/install/install.sh)
- [`codex-rs/app-server-daemon/README.md`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/app-server-daemon/README.md)

The app-server daemon's bootstrap mode can periodically rerun the installer, restart app-server on the new binary, and then replace its own updater process. This is a first-party example of a versioned, managed native agent runtime.

### Codex Desktop bundles Codex

OpenAI's troubleshooting documentation explicitly exposes the app-bundled Codex executable at:

```sh
/Applications/Codex.app/Contents/Resources/codex --version
```

- [OpenAI Codex troubleshooting](https://developers.openai.com/codex/reference/troubleshooting)

Public issue logs also show the desktop application invoking that executable with `app-server`. The desktop application therefore does not depend on a separately installed npm Codex CLI for its basic operation.

The public CLI implements `codex app` on macOS by:

1. checking `/Applications/Codex.app` and `~/Applications/Codex.app`,
2. downloading the official DMG if absent,
3. mounting the DMG,
4. copying `Codex.app` into an Applications directory,
5. launching the requested workspace through a `codex://` URL.

- [`codex-rs/cli/src/desktop_app/mac.rs`](https://github.com/openai/codex/blob/4aa950d456c6c90174d3269d7eaab4a2823e5889/codex-rs/cli/src/desktop_app/mac.rs)

This desktop installation flow also requires no Node.js environment.

---

## Pi without a preinstalled Node.js environment

The standard Pi npm package is a JavaScript CLI whose package entry is:

```json
{
  "bin": {
    "pi": "dist/cli.js"
  }
}
```

It therefore needs Node.js or Bun when installed from npm.

Pi supports several ways to remove the system-Node requirement:

### Official installer

Pi's documented installer is:

```sh
curl -fsSL https://pi.dev/install.sh | sh
```

- [`@earendil-works/pi-coding-agent` README](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)

When a suitable Node/npm installation is absent, the installer downloads a standalone Node.js 22 distribution, verifies it, installs it into a Pi-managed location, and uses that private npm environment to install Pi. The user does not need to prepare Node beforehand, although Pi still runs on the installed private Node runtime.

### Bundled Bun

Craft demonstrates the most practical Electron approach:

```text
Electron resources/
├── vendor/bun/bun
└── resources/pi-agent-server/index.js
```

The Electron application spawns the bundled Bun executable with the Pi server entry point.

### Compiled executable

Pi's package scripts include a Bun compiled-binary build using `bun build --compile`. A vendor can build one executable per target platform, but must validate extension loading, native dependencies, package installation, and runtime filesystem expectations. Bundling a normal Pi server plus Bun is generally less restrictive.

---

## Can an Electron app download these tools without Node.js?

Yes. Electron can perform HTTPS requests and filesystem operations itself. System Node.js is not required to download any of the runtimes. The decisive issue is what is needed to execute the downloaded artifact.

| Runtime                 | Download without Node                  | Execute without system Node                   | Notes                                                          |
| ----------------------- | -------------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| Claude SDK core         | Yes                                    | Yes, from Electron's Node or bundled Bun/Node | Keep SDK and native binary versions aligned                    |
| Claude native binary    | Yes                                    | Yes                                           | Set `pathToClaudeCodeExecutable`                               |
| Codex                   | Yes                                    | Yes                                           | Native Rust executable; ideal for managed download             |
| Pi npm package          | Yes                                    | No, not by itself                             | Needs Node/Bun                                                 |
| Pi server + bundled Bun | Yes                                    | Yes                                           | Proven by Craft                                                |
| `npx -y` ACP package    | No practical execution without npm/npx | No                                            | Electron includes Node but not a complete npm/npx installation |

Electron's embedded Node does not automatically provide `npm` or `npx`. An application that shells out to `npm install`, `npx`, or `pnpm` still depends on those commands being installed unless it bundles a package manager or implements package download and extraction itself.

---

## Recommended Vibest architecture

Avoid making global Node/npm installation a prerequisite. Use a small built-in host plus versioned managed runtimes:

```text
Vibest.app
├── Electron and its embedded Node runtime
├── bundled Claude SDK core
└── app-data/runtimes/
    ├── claude/<version>/claude
    ├── codex/<version>/codex
    ├── bun/<version>/bun
    └── pi/<version>/pi-agent-server.js
```

### Claude

- Bundle the SDK core with Vibest.
- Either bundle the platform Claude binary or download it on first enablement.
- Pass the managed path through `pathToClaudeCodeExecutable`.
- Pin SDK core and binary to the same exact version.

### Codex

- Download OpenAI's standalone platform package rather than invoking npm.
- Verify and extract it into a versioned directory.
- Start `codex app-server` directly.
- Keep a `current` pointer and retain the prior version for rollback.

### Pi

- Bundle Bun or download a checksummed Bun runtime once.
- Build Pi and its SDK dependencies into a Pi server entry point.
- Spawn the Pi server with the managed Bun executable.
- Do not rely on global npm or the user's `pi` command.

### Shared runtime manager requirements

A single runtime manager should own:

- manifest retrieval,
- OS/architecture mapping,
- download resumption,
- checksum/signature verification,
- extraction,
- executable permissions,
- atomic activation,
- rollback and garbage collection,
- version compatibility constraints,
- proxy support,
- diagnostics and repair.

This approach gives Vibest an initial package closer to Paseo's size while preserving an onboarding experience closer to Craft and the official Codex Desktop app.
