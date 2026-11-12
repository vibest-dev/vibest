import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { noticeEnvelope } from "@vibest/core/replies"
import { Effect, Fiber, Stream } from "effect"

import { CLAUDE, CURSOR, entryPending, FakeRuntime, PI, settled, projectOf } from "./fakes.ts"
import { test, client, asSession } from "./rpc-helpers.ts"

const PULLING = [{ ...PI, inbox: "subscribe" as const }, CLAUDE, CURSOR]

describe("vibest.sock", () => {
  test(
    "a Pi pane never gets agent.prompt; it is woken by its subscription and takes one sender's pending rows as a batch",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const general = {
        agent: "general",
        name: "n",
        harnessId: "pi" as const,
        provider: null,
        model: null,
        harnessSessionId: null,
        runtime: "herdr",
        address: { machine: "local", id: "test/p0" },
        status: "idle" as const,
        startedAt: 1,
        exitedAt: 1,
        executionState: "none" as const,
        executionPromptedAt: 0,
        metadata: {},
        createdAt: 1,
        lastActive: 1,
      }
      yield* db.insertSession({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...general }, yield* projectOf("r"))
      yield* db.insertSession({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ...general }, yield* projectOf("r"))
      yield* db.insertSession({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ...general }, yield* projectOf("r"))
      yield* herdr.addPane("w1:p8", "ws", "/")
      yield* herdr.seedAgent("w1:p8")
      const entry = yield* db.startEntry(
        yield* projectOf("r"),
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p8" },
        },
        { agent: "coordinator" },
      )
      const project = (yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.projectId
      const send = (sender: string, message: string) => db.insertSend(entry.sessionId, message, undefined, sender)
      yield* send("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "one")
      yield* send("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "two")
      yield* send("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "three")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).filter((p) => p.terminal === "w1:p8"),
        [],
      )
      assert.lengthOf(yield* entryPending(db, project), 3)

      const c = yield* asSession(yield* client, entry.sessionId)
      const woken = yield* c["Inbox.Subscribe"](undefined).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* Fiber.join(woken)
      const said = (sender: string, message: string) =>
        `<agent-message>\n<agent-id>${sender}</agent-id>\n<title>n</title>\n<message>\n${message}\n</message>\n</agent-message>`
      const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      const taken = yield* c["Inbox.Take"](undefined)
      assert.strictEqual(taken?.text, `${said(a, "one")}\n\n${said(a, "two")}`)
      assert.lengthOf(taken?.ids ?? [], 2)
      assert.isNull(yield* c["Inbox.Take"](undefined))
      assert.lengthOf(yield* entryPending(db, project), 1)
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).filter((p) => p.terminal === "w1:p8"),
        [],
      )
    }),
    { harnesses: PULLING },
  )

  test(
    "a subscription wakes when a row arrives for its session after it subscribed",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      yield* herdr.seedAgent("w1:p8")
      const entry = yield* db.startEntry(
        yield* projectOf("r"),
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p8" },
        },
        { agent: "coordinator" },
      )
      const c = yield* asSession(yield* client, entry.sessionId)
      const received = yield* c["Inbox.Subscribe"](undefined).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* settled
      assert.isUndefined(received.pollUnsafe())
      yield* db.insertNoticeTo(entry.sessionId, "back")
      yield* Fiber.join(received)
      assert.strictEqual((yield* c["Inbox.Take"](undefined))?.text, noticeEnvelope("back"))
    }),
    { harnesses: PULLING },
  )
})
