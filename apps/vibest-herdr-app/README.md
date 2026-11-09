# vibest-herdr-app

Vibest's own interface for [herdr-app](https://herdr.dev) **0.1.13**: a layout, two themes and one mod. The layout
started from T3 Code's look: herdr spaces are projects and their tabs are threads in a 256 px sidebar; a 52 px top
bar carries the `project / thread` breadcrumb and branch; the middle is the shown tab's terminals; a right panel holds
Diff (shipped `changes`), Files (shipped `files`) and **Agents**, the vibest sessions of every project.

Private: not published, not part of a release.

## Files

`home/` is exactly what goes into a herdr-app home (`~/.config/herdr-app`, or `$HERDR_APP_HOME`):

| Path in `home/`                                       | What it is                                            |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `layouts/vibest.json`, `layouts/vibest.svg`           | the layout and its preview                            |
| `themes/vibest-light.json`, `themes/vibest-dark.json` | the light and dark themes the layout follows          |
| `mods/vibest/main.js`, `mods/vibest/mod.json`         | the mod, built from `src/` (committed; `place: none`) |

The layout also uses the shipped `changes`, `files`, `menu`, `picker` and `machine-add` mods and the icons in
`mods/workspace-chrome/`.

## Layout

```
root (row)
├─ sidebar (column, 256 px)
│  ├─ sidebar-header   vibest part "header": the Vibest wordmark
│  ├─ sidebar-threads  vibest part "threads": projects and their threads
│  └─ sidebar-footer   vibest part "footer": settings, add machine, palette
└─ workspace (column)
   ├─ topbar           vibest part "topbar": breadcrumb, branch, split, panel toggles, zoom
   └─ workspace-body (row)
      ├─ terminals     the shown tab's terminals
      └─ right-panel (stack, hidden, 540 px): changes | files | agents (vibest part "agents")
```

The top bar's Files, Diff and Agents buttons select that child of `right-panel` and show it; pressing the shown one
hides the panel.

## Mod

One mod, `vibest`, draws each part named by its `props.part`. `src/` is split by part:

- `header.ts`, `footer.ts`, `topbar.ts`, `ui.ts` (the icon button they share);
- `threads/`: `model.ts` (projects, thread titles, status pills, relative times) and `view.ts`;
- `agents/`: `cli.ts` (the `vibest ls` command line and parsing its JSON),
  `model.ts` (grouping, row text, stale-result handling) and `view.ts`;
- `host.d.ts`: a hand-copied subset of herdr-app's type files (`herdr.d.ts`, `gpui-kit.d.ts`) for the `herdr`, `gpui-kit`
  and `gpui-base` modules the mod uses.

The Agents panel reads once when it starts and again on **Refresh**; there is no timer. Each read runs, with
`VIBEST_SESSION_ID`, `VIBEST_AGENT` and `VIBEST_PROJECT_ID` removed so the CLI acts as the owner,
`vibest ls` in the herdr-app home, which starts vibestd for the user when it is not running, as every vibest client does; a
non-zero exit shows its error text. A newer Refresh or the copy closing drops an older result. `exec` is capped at
30 s and 8 MiB and cannot be cancelled. Rows are grouped by project: the title takes the width, then the status and
turn state, then the short id; the tooltip has the full id, the harness and, for a session that is not a local herdr-core
terminal, why. The panel does not focus terminals: herdr-app does not name the core of this window.

The panel expects the herdr-app home to be outside a git repository: `vibest ls` lists every project only when it runs
outside one, and inside a checkout it would list that project's sessions only.

The mod runs in herdr-app's gpui-kit JavaScript: no Node, Effect or `setTimeout`, and it cannot import files from
another mod's folder, so `scripts/build.ts` bundles `src/main.ts` into `home/mods/vibest/main.js` with `gpui-kit`,
`gpui-base` and `herdr` left external.

## Build, test, install

```sh
pnpm --filter vibest-herdr-app build   # rewrites home/mods/vibest/main.js; commit it
pnpm --filter vibest-herdr-app test    # vitest over the threads and agents models
herdr-app check apps/vibest-herdr-app/home/mods/vibest

H=${HERDR_APP_HOME:-~/.config/herdr-app}
cp -R apps/vibest-herdr-app/home/* "$H/"
herdr-app do layout.switch --name vibest
```

`herdr-app check` renders only the fallback part (threads), not the header, footer, topbar or agents parts. It writes
`gpui-kit.d.ts` and `jsconfig.json` beside the mod; they are gitignored. `ctrl-shift-l`
switches back to another layout; deleting the copied files removes it.
