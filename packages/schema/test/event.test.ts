import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"

import {
  AllDurableDefinitions,
  decodeRow,
  DurableEvents,
  encodeData,
  PublicEvents,
} from "../src/durable-event-manifest.ts"
import { Event } from "../src/event.ts"
import { ProcessEvent } from "../src/process-event.ts"
import { SessionEvent } from "../src/session-event.ts"

describe("event primitives and manifest", () => {
  for (const ms of [Number.NaN, Number.POSITIVE_INFINITY])
    it.effect(`encoding refuses data whose JSON does not read back (trace ms ${ms})`, () =>
      Effect.gen(function* () {
        const exit = yield* encodeData(ProcessEvent.Started, {
          sessionId: "00000000-0000-4000-8000-000000000001",
          processId: 1,
          harness: "pi",
          runtime: "herdr",
          routing: { decidedBy: {}, trace: [{ plugin: "p", hook: "h", outcome: "ok", ms, changes: [] }] },
        }).pipe(Effect.exit)

        assert.isTrue(Exit.isFailure(exit))
      }),
    )

  it("Event.durable and Event.ephemeral attach metadata and validate payloads", () => {
    const Ping = Event.ephemeral({
      type: "test.ping",
      schema: { value: Schema.String },
    })

    assert.strictEqual(Ping.type, "test.ping")
    assert.strictEqual(Ping.durability, "ephemeral")
    assert.strictEqual(Ping.durable, undefined)

    const id = Event.createId(1_700_000_000_000)
    assert.isTrue(id.startsWith("evt_"))
    assert.strictEqual(id.length, 4 + 12 + 16)

    const decoded = Schema.decodeUnknownSync(Ping)({
      id,
      type: "test.ping",
      created: 1_700_000_000_000,
      data: { value: "hi" },
    })

    assert.deepStrictEqual(decoded.data, { value: "hi" })

    assert.strictEqual(SessionEvent.Created.durability, "durable")
    assert.deepStrictEqual(SessionEvent.Created.durable, { aggregate: "sessionId", version: 1 })
  })

  it("PublicEvents has 22 public events and zero process.* or internal events; DurableEvents has 31 versioned entries", () => {
    assert.strictEqual(PublicEvents.length, 22)
    assert.strictEqual(AllDurableDefinitions.length, 31)
    assert.strictEqual(DurableEvents.size, 31)

    const publicTypes = PublicEvents.map((definition) => definition.type)
    assert.isFalse(publicTypes.some((type) => type.startsWith("process.")))
    assert.isFalse(publicTypes.includes("session.inbox.delivering" as never))
    assert.isFalse(publicTypes.includes("machine.connected" as never))
    assert.isFalse(publicTypes.includes("remote.seen" as never))
    assert.isFalse(publicTypes.includes("remote.outbox.queued" as never))
    assert.isFalse(publicTypes.includes("remote.outbox.acked" as never))

    assert.strictEqual(DurableEvents.get("session.created.1"), SessionEvent.Created)
    assert.strictEqual(DurableEvents.get("process.started.1"), ProcessEvent.Started)
  })

  it.effect("decodeRow decodes versioned types and refuses unknown types", () =>
    Effect.gen(function* () {
      const id = Event.createId(100)

      const decoded = yield* decodeRow({
        id,
        aggregateId: "s1",
        seq: 1,
        created: 100,
        type: "session.renamed.1",
        data: JSON.stringify({ sessionId: "s1", name: "alpha" }),
      })

      assert.strictEqual(decoded.id, id)
      assert.strictEqual(decoded.type, "session.renamed")
      assert.deepStrictEqual(decoded.durable, { aggregateId: "s1", seq: 1, version: 1 })
      assert.deepStrictEqual(decoded.data, { sessionId: "s1", name: "alpha" })

      const bad = yield* decodeRow({
        id,
        aggregateId: "s1",
        seq: 2,
        created: 100,
        type: "session.renamed",
        data: JSON.stringify({ sessionId: "s1", name: "alpha" }),
      }).pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(bad))
    }),
  )
})
