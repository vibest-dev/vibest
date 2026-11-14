import { assert, describe, it } from "@effect/vitest"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { randomId } from "@vibest/schema/id"
import { Effect, Queue, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { until, yieldToIo } from "./fakes.ts"
import { onB, peerSession, repoStack, twoMachines } from "./machines-fakes.ts"

const outboxCount = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`SELECT id FROM outbox`.pipe(Effect.map((r) => r.length)),
)

const inboxCount = (recipient: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT id FROM inbox WHERE session_id = ${recipient}`.pipe(Effect.map((r) => r.length)),
  )

describe("a Send retried with the same request across machines", () => {
  it.effect("reaches A once, to the creator and past an ended session, also after the ack", () =>
    Effect.gen(function* () {
      const { a, b, entryId, asEntry } = yield* twoMachines()
      const spawned = yield* asEntry(a.raw.Spawn({ agent: "general", machine: "mb", prompt: "ask me", callerEnv: {} }))
      const middle = onB(spawned.id)
      const child = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      yield* b.db.session.insertSession(
        { ...peerSession, id: child, name: "child", createdAt: 1, lastActive: 1 },
        b.project,
        {
          parentSessionId: middle,
        },
      )
      const asB =
        (sessionId: string) =>
        <A, E>(effect: Effect.Effect<A, E>) =>
          RpcClient.withHeaders(
            effect,
            sessionHeaders({ sessionId, projectId: b.project, repositoryRoot: b.directory }),
          )
      const sendTwice = (from: string, to: string, request: string) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 2; attempt++)
            yield* asB(from)(b.raw.Send({ id: to, message: request, request }))
        })
      const arrived = (count: number) =>
        Effect.gen(function* () {
          yield* until(a.run(inboxCount(entryId)), (n) => n === count)
          yield* until(b.run(outboxCount), (n) => n === 0)
          assert.strictEqual(yield* a.run(inboxCount(entryId)), count)
        })

      const toCreator = randomId()
      yield* sendTwice(middle, entryId.slice(0, 8), toCreator)
      yield* arrived(1)
      yield* sendTwice(middle, entryId.slice(0, 8), toCreator)
      yield* arrived(1)

      yield* b.db.session.archive(middle)
      const pastEnded = randomId()
      yield* sendTwice(child, middle, pastEnded)
      yield* arrived(2)
      yield* sendTwice(child, middle, pastEnded)
      yield* arrived(2)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("an item queued again right after its ack is sent again, not held back as already sent", () =>
    Effect.gen(function* () {
      const b = yield* repoStack()
      const peer = randomId()
      const a1 = yield* b.as(peer, "p1")
      const item = randomId()
      const sent = yield* Queue.unbounded<string>()
      yield* a1.outbox.pipe(
        Stream.runForEach((row) => Queue.offer(sent, row.id)),
        Effect.forkScoped,
      )
      const queue = b.db.remote.sendToPeer(randomId(), peer, randomId(), "x", item)
      yield* queue
      assert.strictEqual(yield* Queue.take(sent), item)
      yield* b.db.remote.ackOutbox(peer, [item])
      yield* queue
      assert.strictEqual(yield* Queue.take(sent), item)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("an item whose sender ends before the ack leaves the sent set, so queuing it again sends it again", () =>
    Effect.gen(function* () {
      const b = yield* repoStack()
      const peer = randomId()
      const a1 = yield* b.as(peer, "p1")
      const sender = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      yield* b.db.session.insertSession(
        { ...peerSession, id: sender, name: "sender", createdAt: 1, lastActive: 1 },
        b.project,
      )
      const item = randomId()
      const sent = yield* Queue.unbounded<string>()
      yield* a1.outbox.pipe(
        Stream.runForEach((row) => Queue.offer(sent, row.id)),
        Effect.forkScoped,
      )
      yield* b.db.remote.sendToPeer(sender, peer, randomId(), "x", item)
      assert.strictEqual(yield* Queue.take(sent), item)
      yield* b.db.session.archive(sender)
      yield* until(b.db.remote.outboxOf(peer), (rows) => rows.length === 0)
      yield* yieldToIo
      yield* b.db.remote.sendToPeer(sender, peer, randomId(), "x", item)
      assert.strictEqual(yield* Queue.take(sent), item)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
