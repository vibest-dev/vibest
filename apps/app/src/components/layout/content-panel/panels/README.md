# Placeholder panels

Mock content, real wiring. These remain to exercise the panel shapes that do not
yet have real features behind them:

|           | arity                 | `create` | what it demonstrates                                |
| --------- | --------------------- | -------- | --------------------------------------------------- |
| `diff`    | singleton             | —        | the thin default handle; opening twice is one panel |
| `browser` | family (`key: tabId`) | ✓        | an instance with its own store (url, loading)       |

The real Files entry panel and path-keyed file viewer live in `features/files/`.
The real Terminal panel lives in `features/terminal/`.

There is one tab strip and it belongs to the host. A panel that wants "several
of a thing" — two shells, two files — opens several panels, so the strip stays
the only place a tab is drawn.

Before filling one in, check `packages/ui`: the browser panel's chrome already
exists there, unused, as `ai-elements/web-preview` — swap `onUrlChange` for the
payload and delete the hand-rolled bar rather than growing it.

Each of these belongs in its own `features/<name>/` directory once it has a
real implementation — a panel is owned by the feature it renders, not by the
layout. They sit here only because there is no feature behind them yet, which
also makes this whole directory deletable in one go.
