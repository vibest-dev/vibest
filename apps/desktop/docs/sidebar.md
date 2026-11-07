# Flat project sidebar

The sidebar has exactly one row per vibestd project: its name and one aggregate
agent status. There are no disclosure buttons, nested sessions, repository folds,
or machine/workspace trees. Projects without a directory use their ID as the name.

Status is the project's Watch `activity`: blocked, done, working, then idle.
The desktop does not rank sessions itself. The status is also an accessibility
description. Selecting a project does not mark every agent seen: `Session.Seen`
is sent only for a session whose terminal is drawn in the focused window, once
per turn.

## No main agent

A project with no entry session shows a placeholder instead of a terminal: the
harnesses from `Harnesses.List`, a problem in grey with no Start, and models
grouped by provider with the default selected. Start runs
`vibest --harness … --runtime hc` through Launch, with the chosen provider and
model. A project whose entry session exists but is stopped still starts with
plain `vibest`, which keeps that harness and session. A vibestd without the
`projects` or `harnesses` capability is shown as older than this app.

## Agent tabs

Selecting a project shows its main agents and subagents as tabs above the content.
Session names and parent relationships come from Watch. Main agents and their
subagents stay adjacent, with pinned sessions first among siblings. Number and
previous/next-tab shortcuts follow that displayed order, including agent panes
that share an existing Core tab.

Watch's project/session ownership is authoritative. Core terminals without a
Watch session join a project through `vibest.project` or `herdr.space`;
`herdr.tab` gives their tab grouping/order and fallback name. Existing
project-owned layout panes remain available too. The desktop adopts existing
terminal references into its own layout, retaining pane IDs and leaving other
clients' documents and presentation labels alone. It never duplicates a terminal
reference. A later session update adds a tab, not an automatic focus change.

Opening a project or an unplaced terminal retains first input for that specific
local terminal and program until its fitted paint is ready. Replacement intents,
program changes and reconnects cannot replay it into another pane. Remote tabs
remain read-only, including while they are being adopted. An empty project hides
the previous project's terminal and cannot send input to it.

## Actions

- Right-click a project for **Open**, **Start main agent**, and **New terminal**.
  Starting a main agent is disabled while one is running; creation needs a project
  directory. The content-area plus and Cmd-T create a terminal in the selected project.
- Right-click an agent tab for **Open**, **Pin/Unpin**, and **Stop…** (main agent)
  or **Archive…** (subagent). Stop/archive retain their confirmation and vibestd RPCs.
- Every agent also has an action submenu in its project's context menu. This keeps
  actions reachable for overflowed tabs and sessions in another runtime/Core;
  opening those sessions explains that their terminal is not in this Core rather
  than borrowing a local terminal with the same address.
- Pinning writes the existing `herdr.pinned` label; there is no separate desktop pin store.

## Unprojected terminals

**Terminals** is the single sidebar location for Core terminals outside known
projects. Its menu lists existing workspaces and unplaced live terminals, including
remote terminals. Choose a workspace's **Open**, or **Open <address>** for an
unplaced terminal. Unrecognized project labels do not make a terminal inaccessible.

Workspace submenus retain rename/close, Git metadata refresh and worktree actions.
Once opened, ordinary Core tabs and pane menus retain their existing controls,
including confirmation before closing terminals. New terminal in this menu, Cmd-N,
and the window's new-workspace button create an unprojected terminal.
