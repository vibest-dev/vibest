# Extensions

An extension is a provider (`transform` of a harness or runtime definition), a decider (a `hook` core calls and waits
on) or a reaction (`event.subscribe` with `session.list`, `session.get`, `session.sentIn` and `session.send`). See
[architecture §7](../../docs/design/architecture.md#7-plugin-architecture).

1. Only core writes the ledger, through its commands. A plugin's send is recorded with the plugin as its sender, filled
   in by vibestd.
2. An extension holds no authoritative memory: no plugin storage, no event cursor, no durable delivery. A reaction
   covers reloads and restarts by a pass over current state when it activates, and makes its sends idempotent with
   `request`.
3. Core asks: a hook. Nobody asks: a reaction. Do not add a hook for something nobody waits on.
4. A builtin gets nothing a user plugin cannot.
5. If removing an extension would make an accepted command silently do nothing, it is engine and belongs in core, not
   in a plugin.
6. Core never awaits a plugin reaction while holding a session lock.
7. The plugin API stays small: a new context method, hook or fact for plugins comes only with a real use.

Status: decided (owner, 2026-11-18).
