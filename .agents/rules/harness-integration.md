# Harness Integration

1. Results and messages never come from a pane's screen. No screen text is pushed to an agent; `vibest peek` is only for the main agent to look when asked.
2. Claude is integrated through its native hooks module only (`turn.complete`, `prompt.submit`, `tool.call`): no `settings.json`, no `--settings`, no classic hooks. The plugin loads at launch with `--plugin-dir ${VIBEST_HOME}/harnesses/claude`, the copy vibestd syncs from its own bundle (see [update-restart.md](update-restart.md) 1), and is never installed (see [user-file-mutation-safety.md](user-file-mutation-safety.md)); Pi loads `pi -e ${VIBEST_HOME}/harnesses/pi/extension.mjs` the same way.
3. The Claude plugin reaches vibestd only with `$.http.fetch` over the Unix socket; it does not run the `vibest` CLI. `$.env.get` takes literal names.
4. A delivered message shows as one line in the harness UI; its full text goes with it as `prompt.submit` context. Nothing is injected into the system prompt.
   - Line: `<Type> Agent "<title>" <status> (<session id>)`, for example `General Agent "Fix guard scratch rule" completed (349f65b2)`.
   - Statuses: completed, failed, was interrupted, sent a message. completed and failed are what the harness reported for the turn (a normal end or an error), never parsed from the agent's text.
   - A notice: `Notice: <first line>`. About 120 characters; a batch ends with ` · +N more`.
5. No recovery commands for the user to type (no `/vibest-reattach`). Delivery recovers by itself through leases and polling.
6. Per-harness differences (launch arguments, resume, `canResume`) live in the harness adapter (`packages/core/src/harness.ts`, `packages/core/src/harnesses/`). Core never branches on a harness id; it reads adapter fields.
7. Every harness integration, current or future, states and provides for updates ([update-restart.md](update-restart.md)):
   1. how it loads vibest's plugin from `${VIBEST_HOME}/harnesses/<id>`, the directory vibestd syncs when it starts;
   2. whether it reloads that plugin in place (its adapter's `reloads`, set per harness), and what triggers the reload;
   3. if it reloads, what survives it: state in harness state that outlives a reload, work that must finish awaited inside a hook, and only the newest load polls or subscribes;
   4. if it cannot reload, it reports its harness pid and readiness, so vibest restarts it in place;
   5. if it does neither, the update lists it to be restarted by hand.

| Harness | Loads (1)                                              | Reloads (2)                                                                      | Survives a reload (3)                                                      | Otherwise (4, 5)                                                  |
| ------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| claude  | `--plugin-dir ${VIBEST_HOME}/harnesses/claude`         | yes: Claude's `--plugin-dir` watch, when the turn ends or at the next turn start | `$.state` (inbox, unacked rows, unsent reports); awaited hooks; one poller | —                                                                 |
| pi      | `pi -e ${VIBEST_HOME}/harnesses/pi/extension.mjs`      | no                                                                               | —                                                                          | cannot reload: restarted in place (reports pid and readiness)     |
| cursor  | its hook script from `${VIBEST_HOME}/harnesses/cursor` | no                                                                               | —                                                                          | reports no pid: keeps its old integration until restarted by hand |

Status: 1, 2 and 6 are in force on main (1 and 2 since #306). 3, 4 and 5 are decided and being built on `feat/claude-http-transport`; main still runs `vibest inbox` and `vibest integration …` through `$.process.run` and registers `/vibest-reattach`. 7 is on `feat/lossless-update`; Cursor is not yet named by the update (update-restart.md known limits).
