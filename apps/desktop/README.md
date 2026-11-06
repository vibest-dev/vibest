# vibest desktop (`apps/desktop`)

Source: reherdr `feat/project-view` 4e0a802 (github.com/iamdin/reherdr), imported without its code comments.

> Status: the app runs on herdr-core protocol generation 1 (types generated from **herdr-core 0.1.18**) and vibestd; any core of that generation is accepted. Every check is a software one (fakes, MyGo's software renderer); real Core, native input (IME, clipboard, drop, editors) and an installed app are not qualified yet.

A native macOS frontend built with [MyGo](https://github.com/egoist/mygo). Vibest owns its workspace/tab/split document and window-local navigation; Core owns terminals, programs and remote routing. Not affiliated with herdr.

Requires Go (the version in `go.mod`), Make, Python 3, Git and macOS 13+. MyGo remains official v0.6.0 with the original eight patches plus tracked patches 0009 (input ownership), 0010 (VT rendering), 0011 (terminal-menu extension), 0012 (owned navigation batches/native text eligibility), 0013 (window-owned right-click and menu-clear admission), 0014 (captured local file/image paste), 0015 (capture before clipboard-provider acquisition, with an eager software-provider fixture), 0016 (emulator replies sent through `AutomaticWriter`, so they go to Core as AUTOMATIC_INPUT), and 0017 (`CaptureAutomaticInput`, so a terminal without the keyboard still answers its program). No earlier patches are changed. No fork, dependency upgrade or Ghostty update is included.

## Build and checks

```sh
make build    # build/vibest-desktop
make setup    # prepare the tracked patches for IDE/bare Go commands
make package  # local ad-hoc signed .app only; does not install or launch
make test     # software suite; needs the verified MyGo libghostty-vt (below)
make vet      # go vet and gofmt -l
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

Core activity/navigation software fixtures in the default App suite require `MYGO_GHOSTTY_VT` to name an explicitly checksum-verified, unchanged MyGo0.6 library. The extra VT, queue and App lanes are behind build tags:

```sh
MYGO_GHOSTTY_VT="$VT" go test -tags 'corevt corequeue' -race ./internal/core -count=1 -timeout 90s
MYGO_GHOSTTY_VT="$VT" go test -tags coreapp -race ./internal/app -count=1 -timeout 900s
```

These tests must not download or launch anything.

## Connection policy

The Core request, result and terminal types in `internal/core/hc_generated.go` come from the pinned OpenRPC document `packages/effect-hc-sdk/schema/hc-openrpc.json` (and `hc-version.json`), the one vibestd uses: `go run ./scripts/hcgen` regenerates them, and `make vet` (`pnpm typecheck`) fails when they are stale. At connect the app refuses a Core whose hello generation differs from the pinned one, or that lacks a method or feature the app calls, and stops reconnecting until Retry in the window is pressed: an older Core asks for `hc update`, a newer one asks for a newer Vibest. The event envelope is not in the document and stays hand-written.

The app reaches Core the way herdr-app does: it finds the `hc` (or `herdr-core`) binary, taking `-hc` first, then PATH, then the usual install places (`~/.local/bin`, Homebrew, mise, Nix, cargo, `~/.local/share/herdr-core/current/Contents/MacOS`), then the login shell's PATH (`HERDR_CORE_DIRS` replaces all of these, for tests), keeping only one whose `--version` says `hc …`. It runs `hc connect` and speaks the protocol over its stdin and stdout; `hc connect` starts the Core when none is running. Started from the Dock or Finder, the app first takes the login shell's PATH, so the Core it starts gives terminals the same PATH. The executable accepts `-core-socket` and `-core-session`, or the official `HC_SOCKET` / `HC_SESSION` defaults, and passes them to `hc connect`. If Core's TOML config exists, specify the socket explicitly rather than silently ignoring configured routing.

When no `hc` is found the window says so and shows the install command (`curl -fsSL https://releases.herdr.dev/core/install.sh | sh`) with Retry; when `hc connect` fails it shows `hc`'s own error. The app never installs or updates Core itself, and there is no legacy fallback, workspace import, or write to Desktop's `herdr-app` documents. Only explicit creation actions start terminal programs through Core.

Running the app against a real Core needs an isolated Core session; never point it at a session you use.

## Current policies

- Local input is bound to a captured viewer/selection and a parsed, fitted paint; unknown activity is not idle.
- **Remote human input is unsupported/read-only:** Core0.1.13 transparently reattaches relay channels without an ordered program-incarnation fence. Pinned-ID routing and remote output/catalog handling do not close this remaining remote migration/parity gap. Pinned remote pane activity remains unknown: alias-only mirror reports cannot prove its owner.
- Closing terminals requires explicit conservative confirmation.
- Ordinary text paste and user selection/copy use MyGo; program clipboard reads/writes are denied. Local right-click routing is window-owned; a modified secondary click always retains the context menu.
- Local copied files/images and dropped paths paste as bounded, quoted text; local file links use reported Core CWD or the explicit client-document workspace CWD. Local Git metadata refresh and worktree create/open/confirmed non-forced removal use bounded explicit argv through Core `machine.exec`; no frontend Git/SSH/scp subprocess or uploader is provided. Git argv is at most 32 entries / 16 KiB, paths at most 4096 bytes, each run has a 5 s server timeout, and repository metadata is at most 256 KiB / 256 worktrees; a timed-out, truncated or failed result is not retried. Git metadata refreshes on request, not by watching. Remote Git/files and Windows input remain unsupported.
- Scrollback export and supported local `:line[:column]` links use a session/ref/program/renderer-bound editor request. `VISUAL`/`EDITOR` names one executable, never a shell command; recognized terminal editors run in a new Core-owned tab, not as input to the existing program. Native/editor execution is unqualified.
- Toolkit Kitty image presentation has a 16 MiB decoded-storage budget per VT. File/temp/shared-memory image media remain disabled by the pinned VT library’s default direct-only policy. This does not enable program clipboard access.
- Existing chrome, themes, settings, sidebar and tab controls are reused; full interaction/native parity remains unverified.

Implementation: `internal/core` (Core connection, sessions, layout document), `internal/coreview` (VT per terminal), `internal/vibest` (vibestd RPC and Watch), `internal/app`. Docs: [themes](docs/themes.md), [sidebar](docs/sidebar.md), [activity](docs/activity.md), [navigation input](docs/navigation-input.md).
