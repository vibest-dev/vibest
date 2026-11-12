import { assert, describe } from "@effect/vitest"
import { Bus, type EngineEvent } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { type Fact } from "@vibest/schema/event"
import { Cause, Effect, Exit, PubSub } from "effect"
import { SqlClient } from "effect/sql"

import { projectOf } from "./lib/directory.ts"
import { testEffect } from "./lib/effect.ts"
import { compile } from "./lib/layers.ts"

const it = testEffect(compile(LayerNode.group([Db.node, Bus.node, PlatformNode.sqlClient])))

const session = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agent: "general",
  name: "n",
  harnessId: "pi" as const,
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: "bench",
  address: { machine: "bench", id: "b0" },
  status: "unknown" as const,
  startedAt: null,
  exitedAt: null,
  executionState: "none" as const,
  executionPromptedAt: 0,
  metadata: {},
  createdAt: 1,
  lastActive: 1,
}

const isStored = (event: EngineEvent): event is Fact => "seq" in event

describe("bus", () => {
  it("a commit publishes in id order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Db
        const bus = yield* Bus
        yield* db.insertSession(session, yield* projectOf("r"))
        const sub = yield* bus.subscribe
        yield* db.restartProcess(session.id)
        const published = (yield* PubSub.takeUpTo(sub, 10)).filter(isStored)
        assert.deepStrictEqual(
          published.map((event) => event.type),
          ["process.ended", "process.started"],
        )
        assert.isBelow(published[0]!.seq, published[1]!.seq)
      }),
    ))

  it("a rollback publishes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Db
        const bus = yield* Bus
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session, yield* projectOf("r"))
        const before = yield* sql<{ n: number }>`SELECT count(*) AS n FROM event`
        yield* sql.unsafe(`CREATE TEMP TRIGGER refuse BEFORE INSERT ON event WHEN NEW.type = 'process.started'
          BEGIN SELECT RAISE(ABORT, 'refused'); END`)
        const sub = yield* bus.subscribe
        const exit = yield* db.restartProcess(session.id).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
        assert.deepStrictEqual(yield* PubSub.takeUpTo(sub, 10), [])
        assert.deepStrictEqual(yield* sql<{ n: number }>`SELECT count(*) AS n FROM event`, before)
      }),
    ))

  it("a nested tx publishes once, after the outer commit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Db
        const bus = yield* Bus
        const project = yield* projectOf("r")
        const entry = yield* db.startEntry(
          project,
          "pi",
          false,
          {
            runtime: "bench",
            address: { machine: "bench", id: "main" },
          },
          { agent: "coordinator" },
        )
        yield* db.insertSession(session, project, { parentSessionId: entry.sessionId })
        const notice = (text: string) => db.insertInbox({ sessionId: session.id, message: text })
        const rows = [(yield* notice("one"))!, (yield* notice("two"))!]
        yield* db.claim(
          rows[0]!.recipient!,
          rows.map((row) => row.id),
        )
        const sub = yield* bus.subscribe
        yield* db.recoverDelivering(() => "")
        const published = (yield* PubSub.takeUpTo(sub, 10))
          .filter(isStored)
          .filter((event) => event.type === "inbox.moved")
        assert.deepStrictEqual(
          published.map((event) => [
            event.type,
            event.type === "inbox.moved" ? event.data.inbox : 0,
            (event.data as { to?: string }).to,
          ]),
          rows.map((row) => ["inbox.moved", row.id, "failed"]),
        )
      }),
    ))

  it("a start that opens the terminal places the unplaced process and keeps its ready report", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Db
        const bus = yield* Bus
        yield* db.insertSession({ ...session, address: { machine: "bench", id: "" } }, yield* projectOf("r"))
        yield* db.patchLive(session.id, { ready: 5, pid: 4242 })
        const sub = yield* bus.subscribe
        yield* db.updateSession(session.id, { address: { machine: "bench", id: "b0" }, startedAt: 10 })
        const published = (yield* PubSub.takeUpTo(sub, 10)).filter(isStored)
        assert.deepStrictEqual(
          published.map((event) => event.type),
          ["process.placed"],
        )
        assert.strictEqual((yield* db.getSession(session.id))!.metadata.pid, 4242)
      }),
    ))
})
