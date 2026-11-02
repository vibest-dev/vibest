# Runtime Boundary

The terminal runtime (herdr today) is a plugin behind `Runtime` in `@vibest/plugin`. This is not the Bun boundary; for that see [bun-runtime-boundary.md](bun-runtime-boundary.md).

1. Core, environment names, headers and the protocol carry no runtime-specific names: no herdr pane ids, no `HERDR_*` outside `packages/runtime-herdr`. A terminal `{machine, id}` is opaque to core.
2. Runtime data travels as one opaque field: `VIBEST_RUNTIME` in the environment and the `vibest-runtime` header, for example `{"runtime":"herdr","machine":"local","terminal":"<id>"}`.
3. Core checks whether an optional runtime member exists (`h.state === undefined`), never which runtime it is. A new runtime operation is an optional member, added only when something needs it.
4. Never close a pane to restart, replace or move an agent. A restart ends only the harness process; the pane and its shell stay.
5. Remote machines will come. Do not bake in "local only" without a `ponytail:` note naming the ceiling.
6. The runtime is the terminal, the process and the machine: open and placement, labels, close, liveness and exit, keys and reading the screen on request, machine status and setup. Agent state comes from the harness integrations, not the runtime: readiness, turn state, waiting for a permission decision, and the conversation id.

Status: 1 and 3 are in force on main for core, with two leftovers: `packages/core/src/guard.ts` refuses `herdr` commands by name, and a comment in `packages/core/src/harness.ts` names `HERDR_PANE_ID`. 2 is decided, on `feat/claude-http-transport`. 4 is decided; main still closes the pane in the usage-limit move (`packages/core/src/move.ts`). 5 is a direction. 6 is decided; readiness by the integration is being built on `feat/update-restart-agents`. On main the runtime still supplies the agent state, blocked included (`state`, from herdr agent detection), and the Cursor conversation id (`session`), both to move later.
