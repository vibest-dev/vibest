# vibestd RPC contract

What a client outside this TypeScript workspace (for example `apps/desktop`) builds against. Both files are generated
and checked by `pnpm test`; never edit them by hand.

- `rpc.json`: `{ protocol, capabilities, methods }`. Each method has its `access` (who may call it: `open`, `cli`,
  `agent`, `owner`, `session`, `self`, `peer`; a pair such as `["agent", "peer"]` when another
  machine's vibestd may call it too), whether it is a `stream`, and draft 2020-12 JSON Schemas of its
  `payload`, `success` (for a stream: one element) and `error` (the method's errors and those of its middleware:
  `ProtocolRejected`, `InvalidCaller`, `NoSuchSession`, `DaemonStopping`). Regenerate with
  `pnpm --filter @vibest/protocol contract`.
- `fixtures/*.ndjson`: lines recorded on `vibest.sock` against the real server with the test fakes. A line with a
  `method` was sent by the client; a line without one was sent by vibestd. Ids, times, temp paths and the version are
  replaced by fixed values. Re-record with `VIBEST_RECORD_FIXTURES=1 pnpm test contract-fixtures` and review the diff.

Wire: one JSON object per line (effect `RpcSerialization.layerNdJsonRpc`). A request is
`{"jsonrpc":"2.0","id":<number>,"method":<tag>,"params":<payload>,"headers":[[name,value],…]}`. A stream answers
`{"jsonrpc":"2.0","chunk":true,"id":<id>,"result":[<element>,…]}` and sends the next chunk only after the client
answers `{"jsonrpc":"2.0","method":"@effect/rpc/Ack","params":{"requestId":<id>}}`; the client ends it with
`@effect/rpc/Interrupt`; vibestd then answers an error whose `data` holds causes with `_tag` `Interrupt`. Match that
answer by the `Interrupt` tag only, never by how many causes it lists: the count is effect's and may change. A failure is `{"jsonrpc":"2.0","id":<id>,"error":{"_tag":"Cause","code":0,"message":…,"data":[{"_tag":"Fail","error":<error>}]}}`.

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

`Integration.Guard` (`open`) `{harness, agent, input}`: a harness's pre-tool hook input, judged by the guard rules of
`agent` in vibestd. `answer` is what the harness's hook prints (its own JSON shape), or for a harness without one the
reason the call is refused; no `answer` means the call is allowed.
