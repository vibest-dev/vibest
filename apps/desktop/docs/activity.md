# Activity and deliberate visits

Project rows aggregate their Watch sessions: error, waiting for you, working, then
unseen done, in that order. Agent tabs show the individual session status. Working,
waiting and error come only from vibestd; Core supplies the shared seen/pinned labels.
The sidebar has no machine/workspace hierarchy or separate Agents roster. See
[sidebar actions and grouping](sidebar.md).

Ordinary Core tabs retain their existing status slot: actual working agents show a
spinner; otherwise an authoritative unacknowledged completion shows a checkmark.
Unknown status, offline transport and input waits are not successful completion.
Hovering these tabs replaces the slot with their existing close control. Agent tabs
use Stop/Archive in context menus instead of a terminal-kill close button.

All status indicators are passive and have no keyboard stop or pointer interception.
The row/tab accessibility description conveys the status.

## Authoritative tokens, local acknowledgments

The endpoint pairs completion sequences with the snapshot's boot and revision.
Only that paired projection supplies completion tokens; backend status changes,
notifications or inferred run IDs never manufacture them. Each machine keeps a
small window-local pane-to-sequence acknowledgment map, reset for another boot
or a removed/retargeted machine. A valid same-boot reconnect preserves history;
authoritative deletion/replacement prunes stale acknowledgments.

At the first trusted attachment, tokens of already-seen idle agents are seeded
as acknowledged; backend done remains unvisited. A missing projection is **not**
an authoritative empty projection, and does not erase same-boot history.

Deliberate Workspace activation acknowledges currently known tokens across that
Workspace's tabs; tab activation acknowledges its tab; Agent/pane activation
acknowledges that pane. Directional pane navigation acknowledges only the
changed destination returned by the successful RPC, without waiting for another
snapshot. Legacy/empty or malformed direction results acknowledge nothing.
Reactivating the selected item counts too. Tokens are
captured at intent and acknowledged only after successful navigation. Deferred
remote navigation never acknowledges tokens arriving after the click, or on
failure. A newer completion sequence remains new even if an older visit finishes
later. This does not change the backend's shared seen state.

Rendering, selected/focused state, restored sessions, hovering, resizing
and reconnecting do not acknowledge completions. Geometry/refocus requests are
not deliberate visits.

### Older endpoints

Without a trusted completion projection, actual working agents can still show
progress, but this client cannot safely offer completion checks or acknowledge
completion sequences. If a projection is unavailable when navigation finishes,
that visit conservatively leaves tokens unacknowledged; existing same-boot
acknowledgments are retained. It deliberately does not fall back to a local run ledger
or interpret idle/blocked/disconnection as completion.

## Headless visual comparison

The compact fixture renders the sidebar and top tabs without opening an
application window. These archived comparisons predate the flat project sidebar:
the before images use main `423077610869294a48236bc0e6de62118cf03b26`. They are
activity-rendering history, not evidence of the current sidebar layout.

| Theme | Before                                                  | After                                                 |
| ----- | ------------------------------------------------------- | ----------------------------------------------------- |
| Paper | ![Before, Paper](screenshots/activity-before-Paper.png) | ![After, Paper](screenshots/activity-after-Paper.png) |
| Nord  | ![Before, Nord](screenshots/activity-before-Nord.png)   | ![After, Nord](screenshots/activity-after-Nord.png)   |

Capture with `THEME_SHOTS=/tmp/activity-shots go test ./internal/app -run '^TestActivityVisuals$' -count=1`.
The ordinary suite also checks built-in themes at 1x/2x and uses the headless
clock to verify animation, stopping and stable slot geometry.

## Seen and pinned shared with other herdr clients

The labels of herdr-app `docs/labels.md` carry seen and pinned state across
clients. `herdr.seen=<turn>` is written for a terminal while its pane is drawn
and the window is in front, only to raise it or when it is missing, and once per
turn while it stays on screen: a "mark unread" from another client is not
overruled until the pane leaves the screen or the window loses focus and the
agent is looked at again. A terminal this app starts gets `herdr.seen=0`. Where
the label is present it decides the Done mark (`turn > herdr.seen`) for the
workspace and tab marks and for a vibest session that vibestd reports neither
working, blocked nor error; without it the deliberate-visit rules above stay in force.
`herdr.pinned=1` (written by Pin and Unpin on a agent tab or project submenu; Unpin writes it
empty) puts a session first among its sibling content tabs.
