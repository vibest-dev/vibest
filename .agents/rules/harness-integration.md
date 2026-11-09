# Harness Integration

1. Results and messages never come from a pane's screen. No screen text is pushed to an agent; `vibest peek` is only for the main agent to look when asked.
2. Claude is integrated through its native hooks module only (`turn.complete`, `prompt.submit`, `tool.call`): no `settings.json`, no `--settings`, no classic hooks. The plugin loads at launch with `--plugin-dir` and is never installed (see [user-file-mutation-safety.md](user-file-mutation-safety.md)).
3. The Claude plugin reaches vibestd only with `$.http.fetch` over the Unix socket; it does not run the `vibest` CLI. `$.env.get` takes literal names.
4. A delivered message shows as one line in the harness UI; its full text goes with it as `prompt.submit` context. Nothing is injected into the system prompt.
   - Line: `<Type> Agent "<title>" <status> (<first 8 characters of the session id>)`, for example `General Agent "Fix the guard rule" completed (349f65b2)`.
   - Statuses: completed, failed, was interrupted, sent a message. completed and failed are what the harness reported for the turn (a normal end or an error), never parsed from the agent's text.
   - A notice: `Notice: <first line>`. About 120 characters; a batch ends with ` · +N more`.
5. No recovery commands for the user to type (no `/vibest-reattach`). Delivery recovers by itself through leases and polling.
6. Per-harness differences (launch arguments, resume, `canResume`, models, subscription reading, the guard's answer shape) live in the harness definition (`HarnessDefinition` in `@vibest/plugin`), which a plugin adds; the builtin ones are in `packages/plugin-harnesses`. Core and the CLI never branch on a harness id; they read definition fields from the `Harnesses` registry.

Status: 1, 2 and 6 are in force on main (1 and 2 since #306). 3, 4 and 5 are decided and being built on `feat/claude-http-transport`; main still runs `vibest inbox` and `vibest integration …` through `$.process.run` and registers `/vibest-reattach`.
