# MyGo pin and patch maintenance

## Upstream and native library

The pin is **v0.7.5-0.20261106112742-9092c954015a**, official main commit
9092c954015a9be5c48d7f5ee5929d41c0924ab3. At selection, v0.7.4 was the latest
release; PR 1374 (held-letter repeat, 79c8b7779915) was 239 commits ahead of
that tag. Main also includes PR 1004 (Option-as-Meta, 1b8a218666d6).
Go's minimum rises from 1.27.2 to 1.27.3.

The upstream terminal manifest still names Ghostty source
befcdfd2c3a1cb24d9ec886e93c95b2b5daa7028 and darwin-arm64 SHA256
6f385d3221f8c776ba40530db9baf8c71478907897959849896eeb0ddbf16b41.
The Makefile and CI checksum therefore stay unchanged. No Ghostty upgrade is part
of this change. The module checksum is pinned in patches/mygo/BASE.

## Patch inventory

The original 18 patches were ported; none could be dropped as upstream-equivalent. Each named
regression passes with the full stack. Negative checks physically move the patch
out, run make setup, retain its test hunks as a temporary test-only patch,
and run the named test before restoring the patch and rerunning setup and tests.
Some patches depend on earlier ones: when omission prevents later patches from
applying, the negative check also removes that suffix and tests the prefix plus
the retained regression. It never tests the previous generated tree after a
failed setup. Preparation's checksum, dirty-tree/symlink refusal, rollback and
lock are unchanged.

**API** means the regression fails to compile because upstream lacks the named
contract; it is not a runtime failure. **Runtime** means the test executes and
fails without the implementation. Patch 0003 had no standalone assertion for its
Terminal-free contract; that assertion was added to its existing cursor test.

| Patch | Disposition / port adjustment                                                                                            | Regression and negative proof                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0001  | Changed: retain upstream cell-width fitting and Kitty placeholder rows in Grid's shared painter                          | TestGridRowAsView: API, no Cell, NewGrid or CellSize                                                                                |
| 0002  | Ported: separate Grid cursor paint                                                                                       | TestGridCursorApart: API, no DrawCursor                                                                                             |
| 0003  | Ported; strengthen existing cursor test                                                                                  | TestGridCursorApart: runtime, Grid still depends on a Terminal                                                                      |
| 0004  | Changed: use current click dispatch and native composition discard; fixture accepts composition as upstream now requires | TestNativeInputResolvesQueuedActivation, commit/preedit/modal/native preparation tests: API, missing preparation/session contract   |
| 0005  | Changed: classify logical-session field in upstream layout-cache test                                                    | TestCustomTextOwnerKeepsWidgetAndCancelsOnlyOldPreedit: API, no TextInputSession                                                    |
| 0006  | Changed: retain native key codes, held-letter repeat and Option composition rejection; classify preparation field        | TestLogicalOwnerPreparationNoKeysAndStableWidget: API, no PrepareInput/event session                                                |
| 0007  | Ported; fixture acknowledges accepted composition                                                                        | TestOutsideCompositionEntrySurvivesPreparationOnlyForItsOwner: runtime, retired entry text resurrects                               |
| 0008  | Ported onto current blur/release path                                                                                    | TestBlurCancelsLocalValueDrag: runtime, abandoned drag survives blur                                                                |
| 0009  | Changed: preserve upstream shell-integration parsing before output observation                                           | TestCapturedInput*: API, no captured queue, cancellation or capacity errors                                                         |
| 0010  | Changed: preserve upstream cell-width font key                                                                           | TestPaneFontSmoothing, TestCursorOnWideTailShowsTheCharacter: API, no Font.Antialiased                                              |
| 0011  | Ported                                                                                                                   | TestCoreAppTerminalMenuKeepsEditingAndPaneActions (coreapp): API, no ExtendMenu                                                     |
| 0012  | Changed: retain upstream platform-key test seam in batch encoder                                                         | TestCapturedNavigationBatch*: API, no Input/SendInput                                                                               |
| 0013  | Ported                                                                                                                   | TestNavigationRightClickRoutingChangesOnlyAfterAdmission: API, no ProgramRightClick/OnMenuClear                                     |
| 0014  | Ported; option placement avoids unrelated menu-patch context dependence                                                  | TestCapturedInputDropPolicyPrecedesConversion, TestCapturedInputOwnedPasteCannotRecaptureLaterOwner: API, no owned paste/drop hooks |
| 0015  | Ported                                                                                                                   | TestCapturedInputPreparePaste*: API, no PreparePaste/eager-provider fixture                                                         |
| 0016  | Ported                                                                                                                   | TestEmulatorRepliesGoAsAutomaticInputInOrderWithTyping, fallback test: API, no automatic queue entry                                |
| 0017  | Ported                                                                                                                   | TestEmulatorRepliesUseTheirOwnCaptureWithoutTheKeyboard: API, no separate automatic capture                                         |
| 0018  | Ported                                                                                                                   | TestCancelingInputKeepsQueuedEmulatorReplies: runtime, only the following human-input marker remains                                |

Patch **0019** adds output-only visibility control and drawable-change detection.
Its original six TestOutput regressions passed both with this patch stack and
with 0019 alone over the official pin (Go overlay; no earlier patches). Three
additional request-level regressions cover pointer shape/tracking, scrollback
growth and offscreen search matches; each fails before the review fixes. They
check the invalidation count and pending frame before running a frame. Removing 0019,
preparing with make setup and retaining only its tests makes identical titles
request 100 frames, held output request unchanged frames, and unchanged cursor
commands request frames. The hidden-output test also detects the missing
SetVisible API. Restoring 0019 and preparing again passes under the race detector.

The app currently uses Terminal, not Grid. Removing the unused Grid extension is
a separate dependency-removal decision, not evidence that upstream implements it.

## Output frame requests

Terminal.SetVisible controls only output-driven invalidation; it never suspends
the reader, parsing, automatic replies or callbacks. It defaults to visible for
existing MyGo callers. Desktop starts attached viewers hidden and supplies the
selected tab and zoom state independently of keyboard focus: every on-screen
split remains visible, including unfocused splits. Showing a retained terminal
requests its accumulated state immediately. Changes to Core input-mode
classification also invalidate the shown view: the input-readiness notice and
fitted keyboard ownership can change without dirty VT cells. No output clock or input delay is
introduced.

Under the existing VT and render-state locks, 0019 updates the render snapshot
without consuming dirty rows, then checks dirty state, cursor, colors, scrollbar
and Kitty graphics generation against the last paint. Pointer shape and mouse
tracking are compared with the last view build, where the native pointer is
chosen. Active searches feed their bounded VT snapshot and request a frame for
pending work or a changed match count; unchanged titles do not wake a settled
search. Only paint cleans render-state changes.
Starting synchronized output still requests the frame that schedules the existing
one-second timeout; subsequent held output does not request unchanged frames.
Clipboard service requests and terminal lifecycle invalidation are unchanged.

Core 0.1.18 emits a title event for every identical OSC title. The app still
applies each Core snapshot and its side effects, but requests a window frame only
when that snapshot changed. A changed title or sidebar status therefore still
redraws, even for a hidden terminal. The regression restores unconditional event
invalidation through a Go overlay and observes 20 frames for 20 identical events;
the changed code observes none.

Isolated demo measurements with MYGO_FRAME_STATS=all, the same hc 0.1.18 Core and
10-second samples: hidden 60 Hz output fell from 59.8 to 0 frames/s; repeated
identical titles fell from 59.0 to 0; a visible 60 Hz spinner remained live at
48.6 before and 60.0 after. Cursor blinking was disabled by the workloads. These
are window-frame counts, not presentation latency or a visible-output speedup.
The visible trial used more CPU (7.2% before, 9.2% after), so this is not evidence
of a visible-output CPU improvement. Full terminal/VT and tagged desktop race
suites, make test, make vet, pnpm typecheck and pnpm test pass. Native re-show
and typed x echo were verified by screenshots and Core readback; no
millisecond input-to-display latency is claimed.

## Drawn menus

Patch **0020** keeps MyGo's menu placement, focus and keys, and lets the app paint the card.
`SetMenuPresentation(PopoverMenus)` draws context menus, menu buttons and text-field
editing menus in the window. A press outside that card does not reach the control
under it. The app menu bar is unchanged.

## App migration

The app already used checked Element values, stable Handles for retained identity
and bounds, and Services for persistent clipboard callbacks. Upstream's
migrate-ui internal moved the remaining fluent constructor keys to c.Key(...)
in capture, pane, project, sidebar and tab views. Constructors now receive
identity before widget state is initialized. No persistent Element or Context
field was introduced; make vet now runs MyGo's lifetime checker as well as
ordinary Go vet.

A removed tab's zero-sized drag source keeps an inert input handler until release:
new MyGo treats a handler disappearing as the end of that press. The existing
removed-source and fresh-gesture test catches the resulting stuck drag.

The loading-ring fixture no longer demands that repainting a child also invokes
its parent's painter: upstream can repaint the ring alone. It still verifies
changed pixels, no view rebuilds, and no scheduled work after the ring stops.
The scrollbar fixture now hovers the terminal and checks the new 9-DIP paint strip
(the default 6-DIP thumb plus 3-DIP inset), including fractional pixel rounding.

## Verification

Run ordinary gates from the app directory and repository root as in the README.
The patch tests live inside the generated module, so the app's go test ./...
alone does not run them. Run their families explicitly:

```sh
make setup
MYGO_GHOSTTY_VT="$VT" go -C third_party/mygo test ./plugins/terminal ./ui ./internal/darwin -run 'Test(Output|Grid|Captured|EmulatorReplies|CancelingInput|NativeInputResolves|CommitEntryResolves|NativePrepareBefore|NativeCommitResolves|TextSessionLoss|ModalReplacement|CustomTextOwner|LogicalOwnerPreparation|OutsideCompositionEntry|BlurCancelsLocal|LayoutInputs)' -count=1
MYGO_GHOSTTY_VT="$VT" go test -tags 'corevt corequeue coreapp' -race ./internal/core ./internal/coreview ./internal/app -count=1 -timeout 900s
```

A fresh clone at 52f967b passed the desktop Turbo build/typecheck/test graph with
an empty HOME, GOPATH, GOMODCACHE and GOCACHE and an explicitly verified
MYGO_GHOSTTY_VT: seven successful tasks, zero cached, 2m29s. Starting with the
owner's Go 1.27.2 printed “requires go >= 1.27.3; switching to go1.27.3”. The
go.mod minimum and default GOTOOLCHAIN=auto suffice; no manual Go upgrade or
separate toolchain directive is required.

The complete tagged Core/App race lane passes. It covers input during resize,
focused/unfocused automatic replies, queued replies surviving cancellation,
composition ownership, file paste and Core discovery. The isolated demo uses
scripts/demo.sh and hc 0.1.18, never the user's Core: the app starts Core through
hc connect, creates a terminal, and sends an exact line while its window is
resized. Core readback showed 88×33, 143×45, 106×37 and 126×39 grids; partial input
was observed at the first resized grid and the complete command echoed once.

## Limits and visible changes

- Upstream scrollbars are now hover/drag-only and occupy a wider inset strip.
- Patch 0004 also adapts TestPopoverMenuButtonKeysInOneFrame to its chronological
  preparation rule: Enter chooses the highlighted item and closes the menu, then
  Down reaches the restored button focus and reopens the menu. The assertion
  preserves the chosen item and pinned state checks and requires the reopened
  menu. The full patched upstream UI, terminal and Darwin suites pass.
- Native IME candidate selection, physical Option/dead keys and held-key repeat,
  native Finder/image paste, file drop, editors and packaged distribution were
  not exercised by the native smoke demo. Their software regressions are not
  native qualification.
- Go toolchain download may require network even with a cached module when the
  installed Go is older than 1.27.3. The library must still be supplied and
  checksum-verified in a fresh HOME; the test task passes MYGO_GHOSTTY_VT
  through Turbo explicitly.
