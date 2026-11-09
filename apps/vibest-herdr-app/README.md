# vibest-herdr-app

Vibest's own interface for [herdr-app](https://herdr.dev) **0.1.13**: a layout, two themes and one mod per layout block that herdr-app's shipped mods do not cover. The layout
started from T3 Code's look: herdr spaces are projects and their tabs are threads in a 256 px sidebar; a 52 px top
bar carries the `project / thread` breadcrumb and branch; the middle is the shown tab's terminals; a right panel holds
Diff (shipped `changes`), Files (shipped `files`) and **Agents**, the vibest sessions of every project.

Private: not published, not part of a release.

## Files

Source lives in `src/`, laid out like the herdr-app home it installs into (`~/.config/herdr-app`, or
`$HERDR_APP_HOME`). `pnpm build` writes that home, ready to copy, into `dist/`, which is gitignored and never committed.

| Path                                                          | What it is                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/layouts/vibest.json`, `src/layouts/vibest.svg`           | the layout and its preview                                     |
| `src/themes/vibest-light.json`, `src/themes/vibest-dark.json` | optional light and dark themes (see Look)                      |
| `src/mods/<name>/`                                            | one mod: `mod.json`, `index.ts`, its other sources and tests   |
| `src/shared/`                                                 | code two or more mods use, with its tests                      |
| `types/herdr-app-0.1.13/`                                     | herdr-app's own `herdr.d.ts` and `gpui-kit.d.ts`, unchanged    |
| `build.ts`                                                    | the build: `src/` to `dist/`                                   |
| `dist/`                                                       | built: `layouts/`, `themes/`, `mods/<name>/{mod.json,main.js}` |

The layout uses herdr-app's shipped pieces wherever they do the job: `workspace-chrome` for the sidebar footer
(Settings, Add machine), `pane` for each terminal card's header (split, zoom, close), `changes` and `files` in the right
panel, `menu`, `picker` and `machine-add`, the commands, and the icons in `mods/workspace-chrome/`. Our mods cover only
what nothing shipped does: the Vibest wordmark, threads nested under their projects, the `project / thread` breadcrumb with
the Agents toggle, and the vibest sessions.

## Look

Like the shipped `main` layout, `vibest` has no look of its own: the person's `settings.json` (and Settings) decides
fonts, sizes, theme, colors and appearance. The vibest themes are optional; pick them in Settings, or set them in
`settings.json`:

```json
"theme": {"light": "vibest-light", "dark": "vibest-dark"}
```

## Layout

```
root (row)
├─ sidebar (column, 256 px)
│  ├─ sidebar-header   mod vibest-sidebar-header: the Vibest wordmark
│  ├─ sidebar-threads  mod vibest-sidebar-threads: projects and their threads
│  └─ sidebar-footer   shipped workspace-chrome (footer): settings, add machine
└─ workspace (column)
   ├─ topbar           mod vibest-topbar: breadcrumb, branch, panel toggles, window buttons
   └─ workspace-body (row)
      ├─ terminals     the shown tab's terminals, each card headed by the shipped pane mod
      └─ right-panel (stack, hidden, 540 px): changes | files | agents (mod vibest-agents)
```

The top bar's Files, Diff and Agents buttons select that child of `right-panel` and show it; pressing the shown one
hides the panel.

Terminals and the right panel share one grid: `workspace-body` has 8 px padding and an 8 px gap, terminal panes are
cards with an 8 px gap, a 1 px `border` edge and 10 px corners (`lone: true` frames a single pane too), and the
right panel has no frame of its own, because the shipped Diff and Files mods, like the Agents mod, draw that same card.

## Mods

Each of our layout blocks is its own mod, named after its block, in one folder:

- `src/mods/<name>/index.ts` is the mod's entry and builds to `dist/mods/<name>/main.js`; nothing else is an entry.
- A mod imports only from its own folder and `src/shared/`; `src/shared/` imports nothing from `src/mods/`; there are
  no cycles.
  `mod-folders.test.ts` checks these rules, and that every mod folder has an `index.ts` and a `mod.json`.
- In a mod, `index.ts` reads herdr or vibest and keeps the copy's state, the data modules turn what was read into
  plain values and import nothing from gpui (their tests sit beside them), and `view.ts` draws.

| Folder                             | Files                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mods/vibest-sidebar-header/`  | `index.ts`, the wordmark                                                                                                                                                                 |
| `src/mods/vibest-sidebar-threads/` | `index.ts`, `projects.ts` (spaces and panes to projects and threads, status labels, times, the stored fold), `view.ts`                                                                   |
| `src/mods/vibest-topbar/`          | `index.ts`, `topbar-state.ts` (breadcrumb, shown panel, sidebar shown), `view.ts`                                                                                                        |
| `src/mods/vibest-agents/`          | `index.ts`, `ls.ts` (the `vibest ls` command line, parsing its JSON, the result a read shows), `sessions.ts` (grouping and row text), `pull.ts` (which read's result to keep), `view.ts` |
| `src/shared/`                      | `theme-colors.ts`, `icon-button.ts`, `traffic-lights.ts`, `thread-title.ts`                                                                                                              |

Types come from herdr-app 0.1.13's own `herdr.d.ts` and `gpui-kit.d.ts`, vendored unchanged in
`types/herdr-app-0.1.13/`; `tsconfig.json` maps `herdr` to the first and uses the compiler options of the
`jsconfig.json` herdr-app writes beside a mod.

The Agents panel reads once when it starts and again on **Refresh**; there is no timer. Each read runs, with
`VIBEST_SESSION_ID`, `VIBEST_AGENT` and `VIBEST_PROJECT_ID` removed so the CLI acts as the owner,
`vibest ls` in the herdr-app home, which starts vibestd for the user when it is not running, as every vibest client does; a
non-zero exit shows its error text. A newer Refresh or the copy closing drops an older result. `exec` is capped at
30 s and 8 MiB and cannot be cancelled. Rows are grouped by project: the title takes the width, then the status and
turn state, then the short id; the tooltip has the full id, the harness and, for a session that is not a local herdr-core
terminal, why. The panel does not focus terminals: herdr-app does not name the core of this window.

The panel expects the herdr-app home to be outside a git repository: `vibest ls` lists every project only when it runs
outside one, and inside a checkout it would list that project's sessions only.

The mods run in herdr-app's gpui-kit JavaScript: no Node, Effect or `setTimeout`, and a mod cannot import files from
another mod's folder, so `build.ts` empties `dist/`, bundles each `src/mods/*/index.ts` it finds on its own into
`dist/mods/<name>/main.js`, inlining what it uses from `src/shared/`, with `gpui-kit`, `gpui-base` and `herdr` left
external, and copies `layouts/`, `themes/` and each `mod.json` beside them.

## Build, test, install

```sh
pnpm --filter vibest-herdr-app build   # src/ to dist/
pnpm --filter vibest-herdr-app test    # the tests beside the code, and the mod folder rules
pnpm --filter vibest-herdr-app check   # herdr-app check on every dist/mods/*/ folder
```

Install copies `dist/` into the herdr-app home:

```sh
cp -R apps/vibest-herdr-app/dist/* "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/"
herdr-app do layout.switch --name vibest
```

`ctrl-shift-l` switches back to another layout; deleting the copied files removes it.
