# The main agent

`vibest` in a project opens its main agent, the coordinator that starts sessions and gets the messages they send. Each
capability below says what it is and when it counts as working.

## S10. Starting, resuming and moving the main agent

`vibest` in a project starts its main agent, and `vibest ls` lists it. From a plain terminal, in any subdirectory, it
opens the main agent in a pane at the repository root (the parent workspace), with a system prompt file that names the
Project folder. After its pane closes, `vibest` reopens the same session and conversation; `vibest --new` starts a new
one. `vibest` in another terminal, answered yes, moves the main agent there: the first terminal keeps only its shell, and
the second resumes the same conversation.

## S38. Focusing the main agent from herdr

herdr's open-main action focuses the main agent's pane, through vibestd.
