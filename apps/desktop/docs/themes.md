# Themes

One theme colors the whole window: the sidebar, the tab bar, the controls,
the pane gutter and dividers, and the terminal colors of the panes. herdr
stays the only backend. A theme changes how the client draws herdr's data.
It does not change sessions, panes, agent states or the client protocol.
Switching themes keeps the connection and the pane contents. It reports the
new terminal colors to herdr, which answers OSC 10/11/4 queries and mode
2031 with them. A switch does not always keep the pane size: a theme with a
different font size or cell height changes the space left for the panes, so
herdr is sent the new columns and rows and the programs in the panes reflow.
None of the built-in themes do that. Newsprint asks for Office Code Pro when
that family is installed; otherwise the pane font stays yours.

reherdr does not read Otty, Otty's configuration, or any theme file.

## Choosing a theme

- Click the half-filled circle at the bottom of the sidebar, or use the
  **Theme** menu in the menu bar. Both menus list the same entries and
  change the same setting.
- **Follow System Appearance** (on by default) keeps two choices: one for
  light mode and one for dark mode. The window switches between them when
  macOS changes appearance.
- With following off, there is one choice. Native menus and alerts follow
  that theme's lightness.

Built-in themes:

| Name        | Lightness | Notes                                                                                                                                                                                                                                                                                               |
| ----------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paper       | light     | Neutral off-white chrome, a white selected card. The default light theme.                                                                                                                                                                                                                           |
| Newsprint   | light     | Cream and ink, a dark slate selected row with white text.                                                                                                                                                                                                                                           |
| TVA Light   | light     | The light companion of TVA Control: warm neutral off-white paper, subtle warm-gray surfaces, tobacco-brown text and a burnt-orange accent, with olive, ochre and wine statuses. The selected row and tab have a thin rust edge, warm gray while the window is not focused. It keeps your pane font. |
| Nord        | dark      | The [Nord](https://www.nordtheme.com) palette (MIT). The default dark theme.                                                                                                                                                                                                                        |
| TVA Control | dark      | reherdr's own warm control-room look: charcoal brown, cream text and amber. The selected row and tab have a thin amber edge, tan while the window is not focused. It keeps your pane font.                                                                                                          |
| Ghostty     | either    | Shown only when your Ghostty config sets `theme`. The panes use your Ghostty colors, including `light:X,dark:Y` pairs. The chrome is a neutral shade between the terminal's background and foreground, and its accent and status colors come from the terminal palette.                             |

The color roles of Paper, Newsprint and Nord (surfaces, text, borders, the
selected card, hover, the terminal colors and palette) are the values
audited from the Otty themes of the same names. Those values are built into
reherdr. No Otty code, assets or files are read. Where that audit set no
value, such as status colors, cursor, selection or the divider, the value
is reherdr's own. Paper and Newsprint are different themes; Paper is not
Newsprint.

TVA Control and TVA Light are not from Otty or any other source; all of
their values are reherdr's own. They are an original retro look, inspired by
a color family, with no film artwork or logos, and no claim to match any
film's colors. To pair them, follow the system appearance and choose
TVA Light under **Light Appearance** and TVA Control under **Dark
Appearance**. The defaults stay Paper and Nord; nothing changes a saved
choice. TVA Light's ANSI colors are all dark enough to read on its paper,
ANSI 7 and 15 included, which are dark brown-grays as in Paper. Selected
text and the block cursor's character take the theme's own colors, and
the keyboard focus ring is the solid accent, so it shows on the paper.

One exception, for readability: in Paper and Newsprint, ANSI white (7) and
bright white (15) take the corrected values built into Otty 1.6.2, not the
audited files' values, which were nearly the background color and made
SGR 37 and 97 text unreadable.

| Theme     | ANSI 7    | ANSI 15   | The audit had        |
| --------- | --------- | --------- | -------------------- |
| Paper     | `#474646` | `#2F2E2E` | `#C1BEB5`, `#EBEBE6` |
| Newsprint | `#434340` | `#121211` | `#BFBAAE`, `#DFDBD1` |

Only these four built-in values differ from that audit. Ghostty's colors
are used as they are.

A first start, with no `settings.json`, uses Paper for light mode and Nord
for dark mode, following the system, even when Ghostty has a theme. Choose
**Ghostty** in the theme menu to keep Ghostty's terminal colors. A saved
choice, Ghostty included, is always kept. A saved name that is not one of
these themes is kept in the file, and that appearance uses Paper or Nord
instead. A line under the panes says so.

Your Ghostty font family, features and `font-thicken` are always used.

The pane font size is the first of these that is set:

1. the zoom from ⌘+ and ⌘−, until ⌘0 resets it;
2. Ghostty's `font-size`;
3. 13.

## Where the choice lives

| What                    | Where                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration directory | `$HERDR_MYGO_CONFIG_DIR`, else `$XDG_CONFIG_HOME/herdr-mygo`, else `~/.config/herdr-mygo`                                                                                                                                              |
| State directory         | `$HERDR_MYGO_STATE_DIR`, else `$XDG_STATE_HOME/herdr-mygo`, else `~/.local/state/herdr-mygo`                                                                                                                                           |
| Choice                  | `settings.json` in the configuration directory: `{"theme": "Paper", "theme_dark": "Nord", "follow_system": true}`                                                                                                                      |
| Window                  | `window-state.json` in the state directory: MyGo's position, size, and maximized and full screen state of the window, which reopens there while it fits a connected display. Missing, damaged or foreign, the window opens at 1280x800 |

A relative `XDG_CONFIG_HOME` or `XDG_STATE_HOME` is ignored, as the XDG Base
Directory Specification says. Each directory is resolved on its own: setting
only `HERDR_MYGO_CONFIG_DIR` leaves the state in the default one.

Builds before the state directory kept `window-state.json` in the
configuration directory. While the state directory has none, a valid one
there is copied to the state directory and used; it is left in place. A
state file that exists, even a damaged one, is never replaced by it.

Development previews set both directories to `herdr-mygo-dev`, with
`open -n APP --env HERDR_MYGO_CONFIG_DIR=$HOME/.config/herdr-mygo-dev --env
HERDR_MYGO_STATE_DIR=$HOME/.local/state/herdr-mygo-dev`, so their theme
choice and window stay apart from the installed app's. `scripts/perf.sh`,
`scripts/e2e-window.sh` and the Go tests set both to temporary directories
of their own and never touch either.

`settings.json` stores only the theme choice, `window-state.json` only the
window's geometry, saved when the window closes or the app quits. Both are
written atomically: a temporary file is written, then renamed over the old
one. There is no themes directory.

When something goes wrong, the window stays usable and a line under the
panes says what happened. The line can be dismissed.

- A missing or unreadable `settings.json`: the defaults are used.
- A theme name that is not built in: that appearance uses Paper (light) or
  Nord (dark), and the note names the saved choice.

Details go to the log.

## herdr's own theme

herdr ([herdrdev/herdr](https://github.com/herdrdev/herdr)) stays the
backend. Its `[theme]` setting and reherdr's themes are separate, and
neither has to change for the other. You do not need to change herdr's
configuration to use reherdr.

- **Terminal colors.** herdr's theme does not define the terminal's default
  colors or its 16-color palette. reherdr reports its theme's foreground,
  background and ANSI 0-15 to herdr over the client protocol, when it
  connects and on every theme switch. herdr then answers programs' OSC
  10/11/4 queries with them and tells programs using mode 2031 when the
  lightness changes.
- **Which cell colors a theme sets.** reherdr maps the default colors and
  ANSI 0-15 to its theme. Entries 16-255 use the fixed xterm cube and grays,
  and RGB colors are drawn as they are. A palette entry a program
  redefined with OSC 4 reaches reherdr as an RGB color, so it keeps the
  program's value across theme switches. The theme does not change these
  colors itself; a program may still change them when it is told of a
  switch.
- **Several clients on one herdr.** The terminal's default colors, its
  answers to color queries and mode 2031 reports follow the client that is
  active. Another app or terminal on the same herdr with a different theme
  changes what programs see while it is active.
- **Colors herdr draws itself (known limitation).** A few cells of the
  pane area come with RGB colors from herdr's own theme, not reherdr's:
  - pane border titles and agent labels: reherdr draws its own borders and
    dividers but keeps the label text's color, so a label can contrast
    poorly with a reherdr theme. For example, catppuccin-latte's labels on
    Nord or Paper measure about 2.5:1. This is read from both programs'
    source;
  - herdr's scrollbar column: herdr's source puts it outside a pane's
    terminal area, and reherdr shows the whole area of an unframed pane,
    so these cells would be drawn with herdr's colors. This is read from
    the source only and was not seen in a running app.

  Restyling these belongs to the planned pane headers.

## Active pane cue

With multiple visible panes, inactive content gets a pass-through tint of
`Foreground` at 6%; headers stay untinted. The pending navigation destination
(or otherwise the focused surface pane) stays normal and its header title
uses `Accent` while the window is focused. A single visible pane, including
zoom, has no tint; neither do popup or too-small surfaces. This is visual
only: it adds no backend focus or input-routing actions.

## Translucent window

Theme > Translucent Window (`"translucent": true` in `settings.json`, off by
default) puts macOS's under-window material behind the window. The colour model
is Monocode Native's (`crates/monocode-gpui`, `theme.rs`): translucency is an
alpha on surfaces, never on ink, and every grey is the theme's `Foreground` at
a fixed alpha, so greys keep their contrast over whatever shows through.

| Role                                      | Translucent value                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Background`, `Sidebar`, `TabBar` (shell) | the theme's colour at 81%                                                                                         |
| `Container.Background` (pane)             | `Background` at 28%                                                                                               |
| `Border`, `SidebarBorder`                 | ink 8%                                                                                                            |
| `Divider`                                 | ink 10%                                                                                                           |
| row and tab states                        | base text ink 55%; hover fill ink 7%; selected fill ink 10% with ink text; selected in an unfocused window ink 7% |

`Surface` (menus, cards), the accent and status colours and the terminal
colours stay as the theme has them. Terminal panes stay opaque: MyGo's
`terminal.Options.Transparent` is fixed when a terminal view is made, so
switching it would remake every view. The translucent theme is used only while
the window shows its material: with the setting off, under macOS's Reduce
Transparency (read when the setting changes) or where MyGo reports no
vibrancy, every surface is the opaque audited value, exactly as before.

The opaque built-ins are not derived from the model: their audited greys are
warm or cool tints (Paper's `Secondary` `#8C8A80` over `#F5F4F0`) that no single
alpha of their `Foreground` reproduces within rounding, so they keep their hex
values and only the translucent theme uses ink alphas.

## What a theme does not do

Unless Translucent Window is on, the window is opaque. A translucent role in
the audited values is stored as the opaque color it showed on its surface.

- **Layout.** Only the sidebar-left layout is supported. There is no title
  bar strip, no details panel, and no tab indicator bar.
- **Theme behavior.** Theme switches are instant, with no color transition.
  Chrome colors are not derived from terminal colors, except in the Ghostty
  adapter, which shades its own terminal colors.
- **Native UI.** Native menus and alerts are not themed; they follow light or
  dark only. The window's title bar and the menus it opens take the shown
  theme's lightness. While following the system, the menu bar and alerts
  keep the system's appearance, because that appearance chooses the theme.
  With following off, they take the chosen theme's lightness too.
- **Shapes.** Rounded corners use MyGo's continuous curve. Borders are a
  single color and are rounded to device pixels.
