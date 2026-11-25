# vibestd HTTP API contract

What a client outside this TypeScript workspace (for example `apps/desktop`) builds against. Generated from `VibestApi`;
never edit by hand.

- `openapi.json`: OpenAPI 3.1 specification of every endpoint, request/response schema, and error (`ProtocolRejected`,
  `InvalidCaller`, `NoSuchSession`, `DaemonStopping`, etc.). Regenerate with `pnpm --filter @vibest/protocol contract`.
- Wire: HTTP/1.1 over `~/.vibest/vibest.sock` (`0600`) and the loopback UI server (`127.0.0.1:<port>` with `vibest-token`).
  Streaming endpoints (`GET /api/watch`, `GET /api/event`, `GET /api/remote/outbox`, `GET /api/inbox/subscribe`,
  `POST /api/project/clone`) use Server-Sent Events (`text/event-stream`).

`Watch` (`cli`, capability `watch`): the first element is a `Snapshot` of every project with a directory and every
session `List({ all: true })` answers, each with its `parentId`; after it come `Project`, `Session` and
`SessionEnded` as they commit. A session that leaves the `List` set is `SessionEnded`; the same row may come again.
When the client stops acknowledging, the stream fails with `WatchLagged` instead of buffering without bound; on that
or any other end, reconnect and take the new `Snapshot` as the truth.

With capability `projects`: each project has `activity` (`blocked`, `done`, `working` or `idle`), and each session
`finished` (null: its runtime counts nothing) and may have `status` `done` (idle with a finished execution nobody looked at).
A `Project` comes again whenever one of its sessions changes. Show these as they are. When a session's terminal is
drawn in the focused window, send `Session.Seen` (`cli`) `{id, finished}` with the `finished` Watch last gave it, once per
finished execution; vibestd writes only a mark that rises, so a stale or repeated call changes nothing, and the result comes back
through Watch.

`Harnesses.List` (`open`, payload `{provider?}`): one entry per harness the loaded plugins provide, `{harness, binary, problem, models}`. `problem` is null when vibestd can
start that harness, else the reason to show; `models` (empty with a problem) are `{provider, model, name, default}`,
provider null meaning the harness's default provider and `default` the model it runs when none is given. A start
passes the chosen `harness`, `provider` and `model` to `vibest` unchanged. With `provider`, only that provider's
models are listed, and a harness that refuses the provider or lists none for it gives that as its `problem`.

`Agents.List` (`open`, payload `{machine?}`): the agent definitions sessions can run as, `{agents, invalid}`. Each agent is
`{id, description, plugin, harness?, provider?, model?, system}`: `plugin` is the id of the plugin that added it
(`vibest.agent-files` for a file in `~/.vibest/agents`), the launch fields are what a start without them uses, and
`system` is the full definition prompt. `invalid` lists `{id, source, error, plugin}` for each definition a plugin
could not register; `source` is where it came from, such as the file path.

`Integration.Guard` (`open`) `{harness, agent, input}`: a harness's pre-tool hook input, judged by the guard rules of
`agent` in vibestd. `answer` is what the harness's hook prints (its own JSON shape), or for a harness without one the
reason the call is refused; no `answer` means the call is allowed.
