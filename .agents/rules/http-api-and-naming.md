# HttpApi, Transport, and Naming

1. **Single Contract and Transport**: one `HttpApi.make("server")` (`effect/http-api`) in `@vibest/protocol`, served on `~/.vibest/vibest.sock` (`0600`) for all local CLI commands, `@vibest/client`, harness integrations (`claude`, `pi`, `cursor`, `agy`), and `vibest connect` SSH tunnels, plus the `vibest-token`-authenticated loopback `127.0.0.1:<port>` listener for local UI (`Origin` rejected with `403`, `UI_CALLS` gated). Zero second Unix socket and zero custom JSON-RPC / NDJSON-RPC server once the cutover lands.
2. **One-Domain-One-File Decomposition**: `packages/protocol/src/groups/<domain>.ts` pairs 1:1 with `packages/server/src/handlers/<domain>.ts` (`daemon`, `project`, `session`, `inbox`, `hook`, `worktree`, `agent`, `harness`, `runtime`, `plugin`, `subscription`, `machine`, `remote`, `event`, `watch`).
3. **Naming Convention**:
   - Group identifier: `"server.<domain>"` (singular lowercase noun).
   - Endpoint identifier: `"<domain>.<action>"` (lowercase camelCase action when multi-word, e.g. `hook.executionEnd`, matching OpenCode).
   - URL path: `/api/<domain>` or `/api/<domain>/<action>` (kebab-case path segments, e.g. `/api/hook/:harness/execution-end`; never versioned `/v1/...`).
   - Streaming: `HttpApiSchema.StreamSse({ data: Schema })` over `text/event-stream` with 15 s `: heartbeat\n\n` keepalive on long-lived fanout streams; volatile stream semantics where slow consumers fail rather than growing unbounded memory.
4. **Errors and Middleware**:
   - Every protocol error is a `Schema.TaggedError` with an explicit `{ httpApiStatus }` annotation.
   - `SchemaErrorMiddleware` maps request decode failures (`Params`, `Headers`, `Query`, `Payload`) to `400 InvalidRequestError` and response encode failures (`Body`, `ResponseHeaders`) to `500 UnknownError`.
   - `defectResponseLayer` logs unexpected defects and returns `500 UnknownError` while preserving the failure cause on spans.
5. **CLI Verb and Identifier Convention**:
   - Top-level `vibest ls` is preserved. Subcommands use canonical full verbs `list` and `remove` (`vibest machine list`, `vibest machine remove`, `vibest agent list`, `vibest harness list`, `vibest worktree list`) with `ls` and `rm` as convenience aliases.
   - Human and prompt surfaces display 8-char short session IDs and accept `--machine <name>` (never `<machine>/<id>`). JSON outputs always carry full canonical UUIDs alongside `machine`.

Status: CLI short session IDs and `--machine` are in force on `main` (PR #653); `HttpApi` unification onto single `vibest.sock` is decided and landing on `refactor/opencode-httpapi-unification`.
