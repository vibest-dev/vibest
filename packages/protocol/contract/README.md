# vibestd RPC contract

What a client outside this TypeScript workspace (for example `apps/desktop`) builds against. Both files are generated
and checked by `pnpm test`; never edit them by hand.

- `rpc.json`: `{ protocol, capabilities, methods }`. Each method has its `access` (who may call it: `open`, `cli`,
  `agent`, `owner`, `coordinator`, `session`, `self`), whether it is a `stream`, and draft 2020-12 JSON Schemas of its
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
