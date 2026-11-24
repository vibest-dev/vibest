import { assert, describe, it } from "@effect/vitest"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { randomId } from "@vibest/schema/id"
import { Inbound } from "@vibest/server/machine/inbound"
import { Effect, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { SqlClient, Statement } from "effect/sql"

import * as Platform from "#platform"

import { until } from "./lib/fakes.ts"
import { onB, peerSession, repoStack, twoMachines } from "./lib/machines-fakes.ts"

const outboxCount = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`SELECT id FROM outbox WHERE acked_at IS NULL`.pipe(Effect.map((r) => r.length)),
)

const inboxCount = (recipient: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT id FROM inbox WHERE recipient_session_id = ${recipient}`.pipe(Effect.map((r) => r.length)),
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

  it.effect("items queued while the remote was away are all sent, read in pages of 100, after it connects", () =>
    Effect.gen(function* () {
      const b = yield* repoStack()
      const remote = randomId()
      const ids = Array.from({ length: 2500 }, () => randomId())
      yield* b.as(remote, "p1")

      for (const id of ids) yield* b.db.remote.sendToRemote(randomId(), remote, randomId(), "x", id)
      const inbound = yield* b.run(Inbound.Service)
      const reads: Array<ReadonlyArray<unknown>> = []

      const countReads: Statement.Transformer = (statement) => {
        const [text, params] = statement.compile()

        if (text.includes("FROM outbox o")) reads.push(params)

        return Effect.succeed(statement)
      }

      const sent = yield* inbound
        .outbox(remote)
        .pipe(
          Stream.take(ids.length),
          Stream.runCollect,
          Effect.provideService(Statement.CurrentTransformer, countReads),
        )

      assert.deepStrictEqual(
        sent.map((row) => row.id),
        ids,
      )
      assert.strictEqual(reads.length, 25)
      assert.isTrue(reads.every((params) => params.includes(100)))
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
