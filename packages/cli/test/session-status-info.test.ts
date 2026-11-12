import { assert, it } from "@effect/vitest"
import { SessionStatusInfo } from "@vibest/protocol/rpc"
import { Schema } from "effect"

const olderGet = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "n",
  agent: "sub",
  harness: "pi",
  provider: null,
  model: null,
  status: "idle",
  startedAt: null,
  exitedAt: null,
  executionState: "completed",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  runtime: "herdr",
  address: { machine: "local", id: "t1" },
  worktree: "/w",
  repositoryRoot: null,
  git: null,
  createdAt: 1,
  lastActive: 1,
  task: null,
  latest: null,
  result: null,
}

it("a Get response from an older vibestd without reply decodes", () => {
  const decoded = Schema.decodeUnknownSync(SessionStatusInfo)(olderGet)
  assert.isUndefined(decoded.reply)
  assert.isNull(Schema.decodeUnknownSync(SessionStatusInfo)({ ...olderGet, reply: null }).reply)
})
