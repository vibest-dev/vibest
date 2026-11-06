# Sidebar machine groups

- Machine headers are neutral navigation controls, not selected Workspace cards.
  The selected Workspace alone keeps its existing selection fill/border. Keyboard
  focus uses the existing control focus ring.
- The chevron is a separate disclosure with expanded/collapsed accessibility
  state. Pointer clicks keep pane focus; Enter/Space operate the disclosure while
  it has keyboard focus. Up from a machine title reaches its disclosure within
  the existing vertical focus group.
- A disclosure only hides/shows that machine's Workspace rows.
  Its title and connecting/offline status stay visible, even without a snapshot
  and even for a single remaining machine. No connection, session, machine or Workspace selection changes.
- Clicking/activating the title still shows that machine, including an offline
  or unloaded machine. Activating the current title also returns focus to Panes.
  Title navigation does not toggle the disclosure.
- Groups start expanded. Collapse intent is window-local, like repository folds;
  there is no new disk setting. Keys are `local` and `remote/<machine-id>`, never names.
  Catalog renames, snapshots, reconnects and normal rerenders retain that intent;
  removing/retargeting a machine forgets its fold. Repository/worktree folds stay
  independent and survive closing/reopening their enclosing machine group.
- Explicit navigation/notifications and focus changes from another client do not
  reopen an intentionally collapsed group. Its header remains available; use its
  disclosure to reveal the current Workspace. This avoids asynchronous server
  responses unexpectedly undoing a user's collapse.
