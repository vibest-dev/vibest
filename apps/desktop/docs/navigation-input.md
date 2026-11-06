# Navigation input ownership

Machine/workspace/tab/pane activation is consumed before native text eligibility and
routing. The tracked MyGo patch drains pending activation through the existing
surface-frame path before the next physical intent or terminal input entry. This
covers keyDown, direct text commits and the production SurfaceCommand menu-paste
route, even when text is already active. Complete clicks resolve chronologically,
not in the order their controls happen to be visited by View.

An unacknowledged destination owns one temporary native input context per window.
It retains semantic terminal events, not bytes encoded for the old pane's mode.
Release requires the original endpoint/connection epoch and boot, the requested
workspace/tab/pane, matching authoritative focus after request dispatch, successful
navigation, and the existing surface/layout safeguards. Cached committed selections
need no speculative pane inference.

Cursor rendering is separate from input readiness. A fitting committed focused pane
with absent cursor coordinates gets a small IME anchor inside its visible terminal.
The fallback does not enable absent-surface, too-small, non-fitting/pending or foreign
pane/boot targets. Present cursors retain their existing geometry checks; blink or
Visible=false does not disable input. No ready clipped-cursor case is claimed.

Native input-session loss clears matching application preedit as well as native
marked text. Legitimate new commits are not rejected based on the unproved premise
that AppKit can send an old commit after discardMarkedText. The stable Panes
widget has a separate logical text-input session keyed by machine, Shell,
connection epoch, nonempty boot and actual pane/popup target. Ownership changes
cancel only matching old native/application composition; cursor/geometry-only
changes and background snapshots preserve it without refocusing widgets. A
focused input model query requests the existing surface frame when ownership
changed, even with no queued keys/activation, before native interpretation or
common input entry. Unchanged owners do not force a frame. The in-frame guard
prevents recursive preparation. Native interpretation captures its prepared
session; if ownership changes during that interpretation, callbacks cannot
commit its old marks to the replacement. A captured App handler also verifies
its owner under App.mu at acceptance, never rereading a newer target to retarget
old text. Tagged native events retain their prepared origin; untagged common
entries are fresh requests prepared before routing, not guessed old callbacks.
Outside keyDown, callbacks entering with live marks also capture that entry
session/client before preparation. If preparation changes their owner or clears
that composition, its supplied commit/update is rejected instead of receiving
the new session. Fresh unmarked outside input and genuinely new-session marking
remain valid; this is live entry provenance, not a speculative late-callback filter.

## Pending buffer versus accepted send

The fixed per-navigation limits are **1024 semantic events** and **64 KiB of retained
committed UTF-8 text/paste bytes**. Preedit belongs to the native session, not this
committed-text budget. One five-second deadline covers the navigation; typing never
restarts it.

Before local commit, overflow cancels the whole retained sequence and overflowing
event. Superseding navigation, modal/control focus, closure, boot/connection change,
error and timeout also cancel. Retained event/text references clear. Only a
cancellation that held events or a composition shows the non-content-bearing
"retained input was not sent" notice; a quiet one leaves any existing notice as
it is. Input the capture consumes without holding it shows "Terminal input was
not sent", unless a notice already shows: a paste over the bound by itself
or unreadable, and typing, a paste or a composition that finds the navigation
invalid or reaches the capture it canceled. While the latch blocks terminal input, a live "Terminal input paused" hint
says to click a pane, and goes when the latch ends. Typing that reaches the panes
while blocked, a Cmd+V paste included, shows the same notice, unless
a notice already shows; releases, keys that type nothing, app commands and an
empty composition do not;
a latch prevents fallback to an unresolved old pane or silent queue recreation.
Fresh explicit selection can recover. Modal dismissal resumes fresh input only if
that destination is acknowledged and ready; canceled content is never replayed.
Target-sensitive actions during pending capture cancel rather than overtake held
text. Navigation shortcuts retain their priority; activity visits remain on the
existing success-based acknowledgment path. Notification pane-focus
requests use the same destination-owned capture and require their explicit pane
to be visible on the ready surface; they do not send to the previously focused pane.
An RPC refusal is handled by its originating navigation result, not reclassified
by machine sync as a connection failure that cancels a newer intent. Actual failures
still invalidate capture on the affected connection, never its replacement.
Loss notices survive immediate cached handoff and later successful navigation,
and remain until explicitly dismissed; a dismiss of an older generation cannot erase newly canceled input.
Explicit metadata actions retain their
selected endpoint; only terminal-target mutations and implicit current-target
shortcuts use the unresolved-target guard. Focused workspace/tab/worktree creation
starts a fresh bounded context. Its explicit API-returned workspace/tab scope must
match a newer authoritative snapshot and ready surface before input drains.
Root-pane metadata is not focus authority, including already-open worktrees;
the focused pane comes from that matching authoritative state. Conflicting
parent identities or missing destination scope fail closed; empty or
wrong-scope results fail closed. It never guesses the old focused pane. Creation
as an application action is separate from its cancelable input buffer. Existing
single-outstanding-RPC ordering remains; a fresh creation can wait for an older
response without blocking View or redirecting its input.

Native ask/confirm accept, cancel and error paths share owned completion handling.
Only the current dialog and unchanged navigation generation may perform a guarded
ready-destination resume; callbacks opening replacement inline/native dialogs keep
their ownership. Ordinary blur/refocus while that native owner remains current
is not navigation supersession; actual window closure explicitly retires the
owner and prevents late completion/handback. These are source/policy checks,
not executed NSAlert observations.

**Local commit** occurs under App.mu when an ordinary ready event is accepted, or
when the acknowledged navigation buffer transfers to the captured connection FIFO.
It freezes connection, target and semantic events. Accepted sends are immutable:
later navigation does not retract them, retarget them, or apply a new generation
check. Bytes already handed to transport cannot be promised retractable. An I/O
failure is reported, never replayed into a replacement connection. Local acceptance
is not delivery: an input failure permanently fails that connection FIFO and closes
the captured connection. Following accepted jobs, including a queued Enter, are not
attempted after the missing prefix. Other connections and fresh replacement streams
are unaffected.

Missing claimed or trusted boot identities never admit input. Malformed decoded
snapshot/surface boot identity ends the connection before publication; a rejected
caller claim alone does not poison an otherwise healthy valid owner.

Before transport admission, boot/connection invalidation rejects queued old-owner
jobs even when pane IDs are reused. Boot and ownership are checked under the
transport writer mutex, not only before waiting for it. Rejection does not poison
a healthy new-boot owner; real I/O/short-write failures permanently fail the physical
writer. Old-boot surfaces are discarded. Ordinary later UI navigation is not this
failure path and still cannot retract accepted sends.

FIFO is per captured connection/boot, including the pending-buffer-to-live-input drain.
Text, editing, Enter and paste preserve receipt order. Blocking Shell.Input never
holds App.mu, and a blocked A connection cannot hold healthy B input behind it.
A rejected _uncommitted_ prefix still cannot release an unbound trailing Enter;
that is distinct from immutable events already accepted for the earlier context.

## Tab reorder gestures

Dragging a top tab is metadata, not navigation. Both tab-strip layouts keep the
actual keyboard owner on pointer-down, including Terminal preedit or a focused
control. A completed or canceled drag does not request Panes focus, activate a
tab, acknowledge activity or send terminal input. A held tab press consumes
Terminal Escape even before MyGo recognizes its drag threshold, without clearing
Terminal preedit. Ordinary clicks and keyboard
activation retain the existing navigation path.

The gesture captures machine, connection, epoch, boot, workspace and source tab
on pointer-down. A stable element-local payload and latched invalidation prevent
MyGo's per-frame Drag refresh from rebinding it, including after source removal
or a temporary context change. A removed pressed source is retained as one
inert zero-sized element so MyGo 0.6 can retire its local drag on release.
Style and sidebar presentation changes wait for that release, preserving the
source's original parent identity; snapshots and drop validation remain live.
Completed gesture state is cleared before requested presentation resumes.
Only a fresh press arms another gesture. An invalidated sub-threshold press
cannot activate or acknowledge a reused tab on release. Drop indices still come
from the current authoritative tab order; the client neither reorders locally nor changes activation. Move right uses the original-list gap
`i+2`.

On window blur, the app invalidates the old intent immediately. Tracked MyGo
patch 0008 cancels and retires the local value drag before releasing pointer
capture, without dropping it. The first fresh post-refocus drag uses its own
source; no retry or abandoned-source move is allowed. Native data drags retain
their existing host-owned completion lifecycle. Existing blur-time composition
cancellation is unchanged; the recovered gesture preserves refocused keyboard
and preedit ownership.

Known follow-up: with a non-Terminal control focused, a press, Escape and inside
release all before one frame can still activate the tab (not send PTY input).
Ordinary framed control cancellation is covered; general event interception is
not added for this rare sequence.

Standalone tests use private wires and headless UI/native-entry seams, not native
IME/AppKit observations. Future Chat integration must separately prove that a
local draft retains its actual keyboard/composition owner through move and
cancellation without forced returnFocus, terminal sends or Chat-only imports here.

## Verification

Preparation retains the pinned checksum and modified-tree/symlink/rollback protections;
the MyGo fork is untouched.

```sh
make setup
go test ./internal/app -run 'TestNavigation|TestGenericTypeKey' -count=1
go test -race ./internal/app -run 'TestNavigation|TestGenericTypeKey|TestMachineNavigation|TestRapidMachineNavigation|TestFirstSnapshot|TestActivityExplicitVisit|TestActivityNavigation|TestNotificationNavigation' -count=1
go -C third_party/mygo test -race ./ui ./internal/darwin -run 'Test(NativeInputResolves|CommitEntryResolves|NativePrepareBefore|NativeCommitResolves|TextSessionLoss|ModalReplacement)' -count=1
```

Clipboard-provider error propagation and notices for stale prepared terminal-owner
callbacks remain separate follow-ups. This change does not cover every clipboard
failure or native-input-loss path.

These are offscreen source-grounded native-gate tests, supplied interpreter actions
and private endpoint wires, not native AppKit timing, IME/first-responder acceptance
or renderer reentrancy/performance observations. No real herdr/SSH/daemon, native
launch or installation is needed. Frozen baseline artifacts and old-target negative
controls remain preserved. The existing modal focus primitive now validates current
focus-order membership before retaining a same-scope field. Cross-shape replacement
therefore focuses its intended first field/safe Cancel in the first committed frame,
retaining the original opener; modal workflows and native alerts are unchanged.
