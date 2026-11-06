# vibest desktop (`apps/desktop`)

Imported as a plain copy of reherdr `feat/project-view` 4e0a802 (github.com/iamdin/reherdr). Its history and the reasoning in its code comments stay readable there; the copy here carries no comments (`.agents/rules/no-comments.md`).

> Draft Core migration: the executable now uses **herdr-core 0.1.13**, not legacy Herdr. Three reproduced editor/link/provider review findings are corrected at code checkpoint `95f322b`; its complete default and whole App race selfchecks pass. Independent reviews at `7dfd7cc` remain separate; a small independent delta recheck and native qualification are still required; this branch is **not ready to deploy**. See [status and acceptance gaps](docs/core-migration.md).

A native macOS frontend built with [MyGo](https://github.com/egoist/mygo). Reherdr owns its workspace/tab/split document and window-local navigation; Core owns terminals, programs and remote routing. Not affiliated with herdr.

Requires Go (the version in `go.mod`), Make, Python 3, Git and macOS 13+. MyGo remains official v0.6.0 with the original eight patches plus tracked patches 0009 (input ownership), 0010 (VT rendering), 0011 (terminal-menu extension), 0012 (owned navigation batches/native text eligibility), 0013 (window-owned right-click and menu-clear admission), 0014 (captured local file/image paste), and 0015 (capture before clipboard-provider acquisition, with an eager software-provider fixture). No earlier patches are changed. No fork, dependency upgrade or Ghostty update is included.

## Build and checks

```sh
make build    # build/reherdr
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

Core activity/navigation software fixtures in the default App suite require `MYGO_GHOSTTY_VT` to name an explicitly checksum-verified, unchanged MyGo0.6 library. Additional VT/App lanes use build tags `corevt corequeue coreapp`. These tests must not download or launch anything. See the migration checklist for exact commands, current results and retained red baselines.

## Connection policy

The executable accepts `-core-socket` and `-core-session`, or the official `HC_SOCKET` / `HC_SESSION` defaults. If Core's TOML config exists, specify the socket explicitly rather than silently ignoring configured routing.

`-autostart=false` is the default and never starts a helper; `-autostart=true` is rejected. There is no legacy fallback, automatic installation, workspace import, or write to Desktop's `herdr-app` documents. Only explicit creation actions start terminal programs through Core.

Running/qualifying this draft requires separate authorization and isolated Core/native ownership. The old App E2E lifecycle sources were removed, not relabeled as Core acceptance.

## Current policies

- Local input is bound to a captured viewer/selection and a parsed, fitted paint; unknown activity is not idle.
- **Remote human input is unsupported/read-only:** Core0.1.13 transparently reattaches relay channels without an ordered program-incarnation fence. Pinned-ID routing and remote output/catalog handling do not close this remaining remote migration/parity gap. Pinned remote pane activity remains unknown: alias-only mirror reports cannot prove its owner.
- Closing terminals requires explicit conservative confirmation.
- Ordinary text paste and user selection/copy use MyGo; program clipboard reads/writes are denied. Local right-click routing is window-owned; a modified secondary click always retains the context menu.
- Local copied files/images and dropped paths paste as bounded, quoted text; local file links use reported Core CWD or the explicit client-document workspace CWD. Local Git metadata refresh and worktree create/open/confirmed non-forced removal use bounded explicit argv through Core `machine.exec`; no frontend Git/SSH/scp subprocess or uploader is provided. Remote Git/files and Windows input remain unsupported.
- Scrollback export and supported local `:line[:column]` links use a session/ref/program/renderer-bound editor request. `VISUAL`/`EDITOR` names one executable, never a shell command; recognized terminal editors run in a new Core-owned tab, not as input to the existing program. Native/editor execution is unqualified.
- Toolkit Kitty image presentation has a 16 MiB decoded-storage budget per VT. File/temp/shared-memory image media remain disabled by the pinned VT library’s default direct-only policy. This does not enable program clipboard access.
- Existing chrome, themes, settings, sidebar and tab controls are reused; full interaction/native parity remains unverified.

Implementation: `internal/core`, `internal/coreview`, `internal/app/core_*.go`. Themes: [docs/themes.md](docs/themes.md). Historical legacy design and E2E documents remain archival, not current qualification instructions.
