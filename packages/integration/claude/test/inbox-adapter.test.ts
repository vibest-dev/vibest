import { assert, describe, it } from "@effect/vitest"
import { adaptAttach, adaptPull, adaptSettle } from "../src/inbox-adapter.ts"

const uuid = "00000000-0000-4000-8000-000000000001"

describe("Claude inbox adapter", () => {
  it("maps JSON replies and rejects contradictory ones", () => {
    assert.deepStrictEqual(adaptAttach(0, JSON.stringify({ generation: "g" })), { kind: "attached", generation: "g" })
    assert.deepStrictEqual(adaptAttach(0, JSON.stringify({ error: "stale-receiver" })), { kind: "stale-receiver" })
    assert.deepStrictEqual(adaptAttach(0, JSON.stringify({ generation: "g", error: "stale-receiver" })), { kind: "unparsed" })
    assert.deepStrictEqual(adaptAttach(0, JSON.stringify({ error: "not-reported" })), { kind: "not-reported" })
    assert.deepStrictEqual(adaptAttach(0, JSON.stringify({ generation: "g", error: "not-reported" })), { kind: "unparsed" })
    assert.deepStrictEqual(adaptAttach(0, JSON.stringify({ generation: "", error: "not-reported" })), { kind: "unparsed" })
    assert.deepStrictEqual(adaptAttach(0, JSON.stringify({ generation: null, error: "not-reported" })), { kind: "unparsed" })
    assert.deepStrictEqual(adaptAttach(0, JSON.stringify({ generation: 7, error: "not-reported" })), { kind: "unparsed" })
    assert.deepStrictEqual(adaptAttach(1, JSON.stringify({ error: "not-reported" })), { kind: "lost" })
    assert.deepStrictEqual(adaptAttach(1, ""), { kind: "lost" })

    assert.deepStrictEqual(adaptPull(0, JSON.stringify({ token: uuid, file: "/tmp/f" })), { kind: "claim", token: uuid, file: "/tmp/f" })
    assert.deepStrictEqual(adaptPull(0, JSON.stringify({ token: uuid, file: "/tmp/f", error: "stale-receiver" })), { kind: "unparsed" })
    assert.deepStrictEqual(adaptPull(0, JSON.stringify({ token: "", file: "" })), { kind: "unparsed" })
    assert.deepStrictEqual(adaptPull(0, JSON.stringify({ empty: true, token: uuid, file: "/tmp/f" })), { kind: "unparsed" })
    assert.deepStrictEqual(adaptPull(0, JSON.stringify({ empty: true })), { kind: "none" })
    assert.deepStrictEqual(adaptPull(0, JSON.stringify({ error: "too-large", bytes: 9 })), { kind: "none" })
    assert.deepStrictEqual(adaptPull(0, JSON.stringify({ error: "stale-receiver" })), { kind: "stale-receiver" })
    assert.deepStrictEqual(adaptPull(2, "{}"), { kind: "lost" })

    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ acked: true }), "ack"), { kind: "ok" })
    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ acked: true, already: true }), "ack"), { kind: "already" })
    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ released: true }), "release"), { kind: "ok" })
    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ released: true, already: true }), "release"), { kind: "already" })
    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ released: true }), "ack"), { kind: "unparsed" })
    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ already: true }), "ack"), { kind: "unparsed" })
    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ already: true, error: "stale-receiver" }), "ack"), { kind: "unparsed" })
    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ acked: true, error: "stale-receiver" }), "ack"), { kind: "unparsed" })
    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ acked: false, already: true }), "ack"), { kind: "unparsed" })
    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ error: "stale-receiver" }), "ack"), { kind: "stale-receiver" })
    assert.deepStrictEqual(adaptSettle(0, JSON.stringify({ error: "unavailable" }), "release"), { kind: "unparsed" })
  })
})
