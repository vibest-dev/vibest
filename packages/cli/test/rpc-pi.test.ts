import net from "node:net"

import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { PROTOCOL } from "@vibest/protocol/protocol"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { FakeRuntime, settled, until, projectOf } from "./fakes.ts"
import { test, client, asSession } from "./rpc-helpers.ts"

describe("vibest.sock", () => {
  test(
    "a Pi pane never gets agent.prompt; its subscription takes pending rows first, then new ones as they arrive",
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
      const coord = yield* db.startEntry(yield* projectOf("r"), "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p8" },
      })
      const project = (yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.projectId
      const send = (sender: string, message: string) => db.insertSend(coord.sessionId, message, undefined, sender)
      yield* send("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "one")
      yield* send("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "two")
      yield* send("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "three")
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).filter((p) => p.terminal === "w1:p8"),
        [],
      )
      assert.lengthOf(yield* db.entryPending(project), 3)

      const c = yield* asSession(yield* client, coord.sessionId)
      const received = yield* c["Inbox.Subscribe"](undefined).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
      yield* until(db.entryPending(project), (rows) => rows.length === 0)
      yield* send("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "four")
      const said = (sender: string, message: string) =>
        `<agent-message>\n<agent-id>${sender}</agent-id>\n<title>n</title>\n<message>\n${message}\n</message>\n</agent-message>`
      const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      assert.deepStrictEqual(Array.from(yield* Fiber.join(received)), [
        `${said(a, "one")}\n\n${said(a, "two")}`,
        said("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "three"),
        said("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "four"),
      ])
      assert.deepStrictEqual(yield* db.entryPending(project), [])
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).filter((p) => p.terminal === "w1:p8"),
        [],
      )
    }),
  )

  test(
    "a Pi subscription wakes when a row for its entry session goes back to pending (a released lease)",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const inbox = yield* Inbox
      const db = yield* Db
      yield* db.insertSession(
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          agent: "general",
          name: "n",
          harnessId: "pi",
          provider: null,
          model: null,
          harnessSessionId: null,
          runtime: "herdr",
          address: { machine: "local", id: "test/p0" },
          status: "idle",
          startedAt: 1,
          exitedAt: 1,
          executionState: "none",
          executionPromptedAt: 0,
          metadata: {},
          createdAt: 1,
          lastActive: 1,
        },
        yield* projectOf("r"),
      )
      yield* herdr.seedAgent("w1:p8")
      const coord = yield* db.startEntry(yield* projectOf("r"), "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p8" },
      })
      const project = yield* projectOf("r")
      const row = yield* inbox.enqueue({
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        message: "back",
      })
      const claimedElsewhereBeforeSubscribe = yield* db.claim(row.recipient!, [row.id])
      assert.deepStrictEqual(claimedElsewhereBeforeSubscribe, [row.id])
      const c = yield* asSession(yield* client, coord.sessionId)
      const received = yield* c["Inbox.Subscribe"](undefined).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* settled
      assert.isUndefined(received.pollUnsafe())
      yield* db.releaseLeased(project, [row.id])
      assert.deepStrictEqual(Array.from(yield* Fiber.join(received)), ["back"])
    }),
  )

  test(
    "a withheld Pi chunk with no Ack stays sending, then failed; a later batch is not confirmed",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      const statusFrom = (sender: string) =>
        sql<{ status: string }>`SELECT status FROM inbox WHERE sender_session_id = ${sender}`.pipe(
          Effect.map((rows) => rows[0]?.status),
        )
      const layout = yield* Layout
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
      yield* herdr.addPane("w1:p7", "ws", "/")
      yield* herdr.seedAgent("w1:p7")
      const coord = yield* db.startEntry(yield* projectOf("r"), "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p7" },
      })
      yield* db.insertSend(coord.sessionId, "one", undefined, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      yield* db.insertSend(coord.sessionId, "two", undefined, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
      const sock = yield* Effect.promise(
        () =>
          new Promise<net.Socket>((resolve, reject) => {
            const socket = net.connect(layout.socket)
            socket.pause()
            socket.once("error", reject)
            socket.once("connect", () => {
              socket.off("error", reject)
              socket.on("error", () => {})
              resolve(socket)
            })
          }),
      )
      const rpc = (id: string, method: string, params: unknown, headers?: ReadonlyArray<readonly [string, string]>) =>
        JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(headers ? { headers } : {}) }) + "\n"
      sock.write(
        rpc("s", "Inbox.Subscribe", null, [
          ["vibest-protocol", String(PROTOCOL)],
          ["vibest-caller", "session"],
          ["vibest-session-id", coord.sessionId],
          ["vibest-project-id", String(coord.projectId)],
        ]),
      )
      const claimed = yield* until(statusFrom("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), (status) => status !== "pending")
      assert.strictEqual(claimed, "delivering")
      assert.strictEqual(yield* statusFrom("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), "pending")
      sock.destroy()
      const closed = yield* until(
        statusFrom("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        (status) => status === "failed" || status === "delivered",
      )
      assert.strictEqual(closed, "failed")
      assert.strictEqual(yield* statusFrom("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), "pending")
    }),
    undefined,
    15_000,
  )

  test(
    "the next pull marks an acked Pi batch delivered, and closing while idle keeps it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const inbox = yield* Inbox
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
      yield* herdr.addPane("w1:p6", "ws", "/")
      yield* herdr.seedAgent("w1:p6")
      const coord = yield* db.startEntry(yield* projectOf("r"), "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p6" },
      })
      yield* inbox.enqueue({
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        message: "one",
      })
      const c = yield* asSession(yield* client, coord.sessionId)
      const got = yield* Deferred.make<string>()
      const fiber = yield* c["Inbox.Subscribe"](undefined).pipe(
        Stream.runForEach((text) => Deferred.succeed(got, text).pipe(Effect.asVoid)),
        Effect.forkChild,
      )
      assert.strictEqual(yield* Deferred.await(got), "one")
      yield* until(
        db.latestInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "notice"),
        (row) => row?.status === "delivered",
      )
      yield* Fiber.interrupt(fiber)
      yield* TestClock.withLive(Effect.sleep("50 millis"))
      assert.strictEqual((yield* db.latestInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "notice"))?.status, "delivered")
    }),
    undefined,
    15_000,
  )
})
