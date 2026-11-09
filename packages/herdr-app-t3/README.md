# T3 layout for herdr-app

A [herdr-app](https://herdr.dev) 0.1.13 layout that makes the window read like
[T3 Code](https://github.com/pingdotgg/t3code): spaces are projects and their tabs are threads in a 256 px
sidebar, each thread showing Working, Awaiting Input or Done, else how long ago it changed; a 52 px top bar
carries the `project / thread` breadcrumb and branch; the middle is the shown tab's terminals; the Diff
(shipped `changes`) and Files panels open on the right. Light and dark themes use T3 Code's own tokens and
terminal colors and follow the system appearance.

## Files

| Path                                                        | Copy to (in the herdr-app home, `~/.config/herdr-app` or `$HERDR_APP_HOME`) |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `layouts/t3.json`, `layouts/t3.svg`                         | `layouts/`                                                                  |
| `themes/t3-light.json`, `themes/t3-dark.json`               | `themes/`                                                                   |
| `mods/t3/` (`main.js`, `topbar.js`, `model.js`, `mod.json`) | `mods/t3/`                                                                  |

The layout also uses the shipped `changes`, `files`, `menu`, `picker` and `machine-add` mods and the icons in
`mods/workspace-chrome/`.

## Install

```sh
H=${HERDR_APP_HOME:-~/.config/herdr-app}
cp layouts/t3.json layouts/t3.svg "$H/layouts/"
cp themes/t3-*.json "$H/themes/"
mkdir -p "$H/mods/t3" && cp mods/t3/*.js mods/t3/mod.json "$H/mods/t3/"
herdr-app check "$H/mods/t3"
herdr-app do layout.switch --name t3
```

`ctrl-shift-l` switches back; deleting the copied files removes it.

## Test

`pnpm test` in this folder runs `test/model.test.mjs` (thread titles, status labels, relative times).
