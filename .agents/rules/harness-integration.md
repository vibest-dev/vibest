# Harness Integration

1. Results and messages never come from a pane's screen. No screen text is pushed to an agent; `vibest peek` is only for the entry session to look when asked.
2. Claude is integrated through its native hooks module only (`turn.complete`, `prompt.submit`, `tool.call`): no `settings.json` and no classic hooks; its only `--settings` is inline and grants the project folder (`{"permissions":{"additionalDirectories":[<project folder>]}}`), with no hooks or deny rules. The plugin loads at launch with `--plugin-dir` and is never installed (see [user-file-mutation-safety.md](user-file-mutation-safety.md)).
3. The Claude plugin reaches vibestd only with `$.http.fetch` over the Unix socket; it does not run the `vibest` CLI. `$.env.get` takes literal names.
4. A delivered message shows as one line in the harness UI; its full text goes with it as `prompt.submit` context. Nothing is injected into the system prompt.
   - Line: `Message from @<session title>: <first line of the message>`, the first line trimmed to about 80 characters. One form for a send and a notice. A notice's sender is `vibest`. Several senders in one delivery are listed (`Message from @A, @B: <first line of the first message>`); several messages from one sender are not counted in the line.
   - An execution's completed or failed is what the harness reported (a normal end or an error), never parsed from the agent's text.
5. No recovery commands for the user to type (no `/vibest-reattach`). Delivery recovers by itself: a pulling integration takes its next batch whenever it is idle, and a batch it never took up is settled by the execution's confirmation timeout.
6. Per-harness differences (launch arguments, resume, `canResume`, models, subscription reading, the guard's answer shape) live in the harness definition (`HarnessDefinition` in `@vibest/plugin`), which a plugin adds; the builtin ones are in `packages/plugin-harnesses`. Core and the CLI never branch on a harness id; they read definition fields from the `Harnesses` registry.

Status: 1, 2 and 6 are in force on main (1 and 2 since #306). 3, 4 and 5 are decided and being built on `feat/claude-http-transport`; main still runs `vibest inbox` and `vibest integration …` through `$.process.run` and registers `/vibest-reattach`.
