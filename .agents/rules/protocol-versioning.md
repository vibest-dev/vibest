# Protocol Versioning

1. `PROTOCOL` (`packages/schema/src/version.ts`) is one integer, sent in the `vibest-protocol` header for every request. HTTP paths carry no version (`/api/...`, never `/v1/...`).
2. An additive feature is a boolean flag in `daemon.ping` capabilities and does not bump `PROTOCOL`.
3. No compatibility with old versions. A mismatch is refused with a structured answer `{ protocol, version, message, action }`: the message tells the user what happened, and the action is the command to run (`vibest update`).
4. `daemon.ping`, `daemon.stop`, and `daemon.handoff` are exempt from the `vibest-protocol` match check so `vibest daemon restart` and `vibest update` can inspect, stop, or hand off a running vibestd of another protocol without spoofing headers. A newer vibestd keeps both payloads and `vibest daemon import-check` / `vibest daemon --foreground --import` compatible with older callers. `daemon.ping` answers without headers, and every field it adds is optional.
5. All local CLI, client, harness integration, and SSH tunnel traffic shares `${VIBEST_HOME}/vibest.sock` (`HttpApi`, see [http-api-and-naming.md](http-api-and-naming.md)).

Status: in force on `main` (PR #658 unified all traffic onto `HttpApi` over `vibest.sock`).
