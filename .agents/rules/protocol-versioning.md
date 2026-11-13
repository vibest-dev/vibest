# Protocol Versioning

1. `PROTOCOL` (`packages/schema/src/version.ts`) is one integer, sent in the `vibest-protocol` header for RPC and HTTP alike. HTTP paths carry no version.
2. An additive feature is a boolean flag in Ping's capabilities and does not bump `PROTOCOL`.
3. No compatibility with old versions. A mismatch is refused with a structured answer `{protocol, version, message, action}`: the message tells the user what happened, the action is the command to run (`vibest update`).
4. HTTP is plain POST routes on `${VIBEST_HOME}/vibest-http.sock`: a pulling integration asks `/inbox/take` every second while idle, and the answer is the batch with its execution id. No long polling.
5. `Daemon.Stop` and `Daemon.Handoff` are the same calls on every protocol, sent in the running vibestd's protocol: `vibest daemon restart` asks a vibestd of another protocol to stop with `Daemon.Stop`, and `vibest update` hands it over with `Daemon.Handoff`. A newer vibestd keeps both payloads and `vibest daemon import-check` and `vibest daemon --foreground --import` as an older one calls them. Ping answers without the header, and every field it adds is optional, so any vibest reads any build's Ping far enough to compare `protocol` and say so plainly.

Status: decided, being built on `feat/claude-http-transport`. On main, `PROTOCOL` is already one integer in the `vibest-protocol` header for RPC; there is no HTTP socket yet.
