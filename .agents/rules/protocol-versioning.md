# Protocol Versioning

1. `PROTOCOL` (`packages/protocol/src/protocol.ts`) is one integer, sent in the `vibest-protocol` header for RPC and HTTP alike. HTTP paths carry no version.
2. An additive feature is a boolean flag in Ping's capabilities and does not bump `PROTOCOL`.
3. No compatibility with old versions. A mismatch is refused with a structured answer `{protocol, version, message, action}`: the message tells the user what happened, the action is the command to run (`vibest update`).
4. HTTP is plain POST routes on `${VIBEST_HOME}/vibest-http.sock`: short polling every second, leases, ack by row id. No long polling.
5. `Daemon.Stop` is the same call on every protocol: `vibest daemon restart` asks a vibestd of another protocol to stop with it. Ping answers without the header, and every field it adds is optional, so any vibest reads any build's Ping far enough to compare `protocol` and say so plainly.

Status: decided, being built on `feat/claude-http-transport`. On main, `PROTOCOL` is already one integer in the `vibest-protocol` header for RPC; there is no HTTP socket yet.
