# vibest desktop (`apps/desktop`)

Source: reherdr `feat/project-view` 4e0a802 (github.com/iamdin/reherdr), imported without its code comments.

> Status: the app runs on herdr-core protocol generation 1 (types generated from **herdr-core 0.1.18**) and vibestd; any core of that generation is accepted. Software checks cover input ownership and rendering. An isolated hc 0.1.18/native-window smoke demo verified app-started Core, terminal creation, typed input and typing during resize. Native IME, clipboard/drop, editors and an installed app remain unqualified; see [limits](docs/mygo.md#limits-and-visible-changes).

A native macOS frontend built with [MyGo](https://github.com/egoist/mygo). Vibest owns its workspace/tab/split document and window-local navigation; Core owns terminals, programs and remote routing. Not affiliated with herdr.

Requires Make, Python 3, Git and macOS 13+. Builds use Go 1.27.3 or newer. An installed Go 1.27.2 works without a manual upgrade: with the default `GOTOOLCHAIN=auto`, the `go 1.27.3` line in `go.mod` selects and downloads the required toolchain. No separate `toolchain` line is needed. The first download needs network access; with automatic switching disabled (`GOTOOLCHAIN=local`), install Go 1.27.3 or newer manually.

MyGo is official main commit `9092c954015a9be5c48d7f5ee5929d41c0924ab3`, pinned as `v0.7.5-0.20261106112742-9092c954015a`. The latest tag when selected, v0.7.4, lacked the held-letter repeat fix (PR 1374); this commit includes it and Option-as-Meta PR 1004. The libghostty-vt source and binary checksum are unchanged.

All 20 downstream patches remain: 0001–0003 (Grid rendering and separate cursor), 0004–0007 (native activation and composition ownership), 0008 (blur-time drag cancellation), 0009 (captured input queue and paint proof), 0010 (font smoothing and wide cursor), 0011 (menu extension), 0012 (owned semantic batches), 0013 (window-owned right-click/menu clear), 0014 (file-paste ownership), 0015 (capture before clipboard access), 0016–0018 (automatic replies, keyboard-independent capture and retention on input cancellation), 0019 (visible-change-only terminal output frames), and 0020 (app-painted in-window menus). The first 18 were ported; 0001–0019 were deletion-tested, and none of those is fully supplied by this upstream version. See the [per-patch evidence and migration notes](docs/mygo.md), including the distinction between missing-API and runtime negative tests.

## Build and checks

```sh
make build    # build/vibest-desktop
make setup    # prepare the tracked patches for IDE/bare Go commands
make package  # local ad-hoc signed .app only; does not install or launch
make test     # software suite; needs the verified MyGo libghostty-vt (below)
make vet      # MyGo lifetime vet (includes go vet), generated types and gofmt -l
```

From the repository root these run as `pnpm build`, `pnpm typecheck` and `pnpm test` (package `@vibest/desktop`). On another OS than macOS every target prints `apps/desktop: macOS only, skipped` and succeeds.

`make test` takes `MYGO_GHOSTTY_VT`, else MyGo's cache file `~/Library/Caches/mygo/natives/<sha256>/libghostty-vt.dylib`, and refuses a file whose SHA256 is not the darwin-arm64 one in `third_party/mygo/plugins/terminal/mygo-plugin.json` (`6f385d32…6b41`). It never downloads it; the CI job `.github/workflows/desktop.yml` fetches it from that manifest's URL and checks the checksum.

Preparation verifies the pinned module checksum, applies tracked patches into ignored `third_party/mygo`, and refuses local edits or symlinks rather than overwriting them. A shared Make prerequisite runs once before parallel consumers; do not run independent Make invocations concurrently in one checkout. First preparation requires cached modules or network access.

Current safe focused lane (no backend, PTY or native window):

```sh
go test -race ./internal/core ./internal/coreview
go test -race ./internal/app -run '^TestCoreApp' -count=1
python3 scripts/test_patch_mygo.py
python3 scripts/test_make.py
```

Core activity/navigation software fixtures in the default App suite require `MYGO_GHOSTTY_VT` to name an explicitly checksum-verified libghostty-vt library (the same binary as before the MyGo upgrade). The extra VT, queue and App lanes are behind build tags:

```sh
MYGO_GHOSTTY_VT="$VT" go test -tags 'corevt corequeue' -race ./internal/core -count=1 -timeout 90s
MYGO_GHOSTTY_VT="$VT" go test -tags coreapp -race ./internal/app -count=1 -timeout 900s
```

These tests must not download or launch anything.

## Connection policy

The Core request, result and terminal types in `internal/core/hc_generated.go` come from the pinned OpenRPC document `packages/effect-herdr-core-sdk/schema/hc-openrpc.json` (and `hc-version.json`), the one vibestd uses: `go run ./scripts/hcgen` regenerates them, and `make vet` (`pnpm typecheck`) fails when they are stale. At connect the app refuses a Core whose hello generation differs from the pinned one, or that lacks a method or feature the app calls, and stops reconnecting until Retry in the window is pressed: an older Core asks for `hc update`, a newer one asks for a newer Vibest. The event envelope is not in the document and stays hand-written.

The app reaches Core the way herdr-app does: it finds the `hc` (or `herdr-core`) binary, taking `-hc` first, then PATH, then the usual install places (`~/.local/bin`, Homebrew, mise, Nix, cargo, `~/.local/share/herdr-core/current/Contents/MacOS`), then the login shell's PATH (`HERDR_CORE_DIRS` replaces all of these, for tests), keeping only one whose `--version` says `hc …`. It runs `hc connect` and speaks the protocol over its stdin and stdout; `hc connect` starts the Core when none is running. Started from the Dock or Finder, the app first takes the login shell's PATH, so the Core it starts gives terminals the same PATH. The executable accepts `-core-socket` and `-core-session`, or the official `HC_SOCKET` / `HC_SESSION` defaults, and passes them to `hc connect`. If Core's TOML config exists, specify the socket explicitly rather than silently ignoring configured routing.

When no `hc` is found the window says so and shows the install command (`curl -fsSL https://releases.herdr.dev/core/install.sh | sh`) with Retry; when `hc connect` fails it shows `hc`'s own error. The app never installs or updates Core itself, and there is no legacy fallback, workspace import, or write to Desktop's `herdr-app` documents. Only explicit creation actions start terminal programs through Core.

Running the app against a real Core needs an isolated Core session; never point it at a session you use.

## Current policies

- Local input is bound to a captured viewer/selection and a parsed, fitted paint; unknown activity is not idle.
- **Remote human input is unsupported/read-only:** Core0.1.13 transparently reattaches relay channels without an ordered program-incarnation fence. Pinned-ID routing and remote output/catalog handling do not close this remaining remote migration/parity gap. Pinned remote pane activity remains unknown: alias-only mirror reports cannot prove its owner.
- Closing terminals requires explicit conservative confirmation.
- Ordinary text paste and user selection/copy use MyGo; program clipboard reads/writes are denied. Local right-click routing is window-owned; a modified secondary click always retains the context menu.
- Popup menus draw in the window. A right-click in the terminal or in a text field is fully visible on the first frame; every other menu fades and slides 8px from its resolved side over 170ms (`cubic-bezier(.16, 1, .3, 1)`), and closes at once. Reduced motion skips that entrance. The menu bar and confirmation dialogs stay the system's.
- Local copied files/images and dropped paths paste as bounded, quoted text; local file links use reported Core CWD or the explicit client-document workspace CWD. Local Git metadata refresh and worktree create/open/confirmed non-forced removal use bounded explicit argv through Core `machine.exec`; no frontend Git/SSH/scp subprocess or uploader is provided. Git argv is at most 32 entries / 16 KiB, paths at most 4096 bytes, each run has a 5 s server timeout, and repository metadata is at most 256 KiB / 256 worktrees; a timed-out, truncated or failed result is not retried. Git metadata refreshes on request, not by watching. Remote Git/files and Windows input remain unsupported.
- Scrollback export and supported local `:line[:column]` links use a session/ref/program/renderer-bound editor request. `VISUAL`/`EDITOR` names one executable, never a shell command; recognized terminal editors run in a new Core-owned tab, not as input to the existing program. Native/editor execution is unqualified.
- Toolkit Kitty image presentation has a 16 MiB decoded-storage budget per VT. File/temp/shared-memory image media remain disabled by the pinned VT library’s default direct-only policy. This does not enable program clipboard access.
- Existing chrome, themes, settings, sidebar and tab controls are reused; full interaction/native parity remains unverified.

Implementation: `internal/core` (Core connection, sessions, layout document), `internal/coreview` (VT per terminal), `internal/vibest` (vibestd RPC and Watch), `internal/app`. Docs: [themes](docs/themes.md), [sidebar](docs/sidebar.md), [activity](docs/activity.md), [navigation input](docs/navigation-input.md).
