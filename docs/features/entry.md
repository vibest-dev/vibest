# The entry session

`vibest` in a project opens its entry session, the session that starts other sessions and gets the messages they send. Each
capability below says what it is and when it counts as working.

## S10. Starting, resuming and moving the entry session

`vibest` in a project starts its entry session, and `vibest ls` lists it. From a plain terminal, in any subdirectory, it
opens the entry session in a pane at the repository root (the parent workspace), with a system prompt file that names the
Project folder. After its pane closes, `vibest` reopens the same session and conversation; `vibest --new` starts a new
one. `vibest` in another terminal, answered yes, moves the entry session there: the first terminal keeps only its shell, and
the second resumes the same conversation.

## S69. Starting from a plain terminal and `vibest onboard`

Bare `vibest` on an interactive terminal outside any runtime's terminal, without `--runtime`, uses `defaultRuntime` from
`vibest.json` when that runtime is available; otherwise it looks for runtimes: none offers to install herdr-core (`hc`)
and starts it, one is taken, several are offered as a numbered list (herdr-core first) with the choice saved as
`defaultRuntime` on request. herdr-core is started with `hc server start` when it is installed but stopped, and the
entry session's terminal is attached into this terminal with `hc attach`. `defaultHarness` from `vibest.json` is the
lowest rung of the harness choice, wherever a harness is chosen (below `--harness`, the entry session's last harness and
an agent definition's harness, H6); when none is saved, a project's first start (or `--new`) on that plain-terminal path
takes a single usable harness and offers several as a list. Without a terminal and without `defaultRuntime` it asks nothing and
fails as before, naming `vibest onboard`. `vibest onboard` runs the runtime and harness steps anywhere, outside a git
repository too, and saves both choices. It counts as working when `vibest.json` keeps its other keys and a second bare
`vibest` asks nothing.

## S38. Focusing the entry session from herdr

herdr's open-entry action focuses the entry session's pane, through vibestd.
