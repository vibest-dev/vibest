# The herdr-core runtime (`hc`)

`packages/runtime-hc` is the builtin runtime plugin of kind `hc`. It drives herdr-core through `effect-hc-sdk`, a client generated from the OpenRPC document `hc schema` prints (pinned in `packages/effect-hc-sdk/schema/`). herdr stays the default runtime: `hc` is chosen with `vibest --runtime hc`, `"runtime": "hc"` in `vibest.json`, or by a subagent whose parent runs in hc.

## Which core

vibestd talks to one core: `HC_SOCKET`, else `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, else `${XDG_STATE_HOME:-$HOME/.local/state}/herdr-core/<session>/<session>.sock`, with `<session>` from `HC_SESSION` (default `default`), as hc resolves it. The `socket` key of the core's `config.toml` is not read. vibest never starts the core; `status` says `offline` and names `hc server start`. Remote machines (`on`, `machine/t7`) are not used yet: every terminal is on the core's own machine.

Each call opens its own connection in plain mode (one JSON-RPC message per line). One more connection holds `events.subscribe` filtered by `vibest.runtime=hc`; it is re-made every 2 s after a loss, and each new subscription after the first publishes `reset`. A `missed` notice drops the connection so the next subscription starts from a fresh snapshot.

## Terminals

- A terminal's vibest id is its hc name: `s-<30 hex>` from `VIBEST_SESSION_ID`, else `vbt-<28 hex>`. `open` sets `VIBEST_RUNTIME` to `{"runtime":"hc","machine":…,"terminal":<name>}` in the terminal's environment, so a main agent typed into it by `Launch` (`--in-parent`) knows its terminal and runtime without any `HC_*` variable.
- `open` runs the machine's shell (`keep: true`) and types the argv into it with `terminal.send`, so the shell stays after the program (runtime-boundary rule 4) and `run` types the next program into the same shell. `terminal.send` waits until nobody typed for about 3 s, so each prompt takes at least that long.
- A kept terminal whose program is lost (a signal death, a core crash) gets a shell with the same environment (the runtime-hc test kills the shell with `kill -9` and reads the variable back).
- Exits come from events: `finished`, `removed`, `lost`, and a `foreground` change back to an interactive shell (`sh`, `bash`, `zsh`, `fish`, `dash`, `ksh`, `tcsh`, `nu`, with no script argument) after a program ran. A harness that is itself a shell script would look like a shell; none is.
- Agent state (`state`) is not offered: readiness and turns come from the harness integrations.
- A text vibestd sends carries no `caller`, and the core types it byte-identical (no `<hc>` tag), proved by the runtime-hc test.

## Labels: herdr-app's conventions

So vibest agents show in herdr-app too (its `docs/labels.md` and the model of spaces, tabs and terminals):

- Every terminal: `vibest.runtime=hc`; a subagent also `vibest.project=<project id>` and `vibest.session=<session id>` from its environment.
- A main agent's terminal: when vibestd records it (`Project.CoordinatorSession`), it calls `present` with `mainSession` and `projectId`, and runtime-hc labels the terminal `vibest.project`, `vibest.session`, `herdr.space=<project id>` and `herdr.tab=<main session id>`. Other `present` calls change nothing.
- A subagent opened near another terminal (the main agent's, or a `--peer`'s) is started with `parent` set to it, `outlive_parent` (it keeps running when the main agent's program ends) and `no_notify` (the core types no notes into the parent). Without a terminal to start near, `no_parent`. Delivery, parents and results stay vibest's own.
