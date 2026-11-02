import { assert, describe, it } from "@effect/vitest"
import * as Platform from "#platform"
import { Effect, Fiber, FileSystem, Layer, Path, Stream } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import { cliHeaders, connect, sessionHeaders } from "@vibest/client/client"
import { CLAUDE_INBOX_MAX_BYTES } from "@vibest/core/claude-inbox"
import { Db, type SessionRow } from "@vibest/core/db"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import * as Server from "@vibest/server/server"
import { authed, FakeRuntime, makeRepository, testLayer, type TestOptions } from "./fakes.ts"
import { repositoryKey } from "@vibest/core/worktree"

const served = (options?: TestOptions) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer(options)),
  )

const test = (name: string, program: () => Effect.Effect<void, any, any>) =>
  it.effect(name, () => program().pipe(Effect.provide(served())))

const session = (id: string): Omit<SessionRow, "projectId"> => ({
  id, agent: "general", name: "n", harnessId: "pi", provider: null, model: null, harnessSessionId: null,
  runtime: RUNTIME, address: { machine: "local", id: "default" },
  status: "idle", startedAt: 1, exitedAt: null, turnState: "none", turnPromptedAt: 0, metadata: {}, createdAt: 1, lastActive: 1,
})

const pane = "w1:p1"
const claudeId = "claude-session-1"

const ready = Effect.gen(function* () {
  const db = yield* Db
  const inbox = yield* Inbox
  const herdr = yield* FakeRuntime
  const repo = yield* makeRepository
  const key = yield* repositoryKey(repo)
  const coord = yield* db.coordinatorLaunch(key, "claude", false, { runtime: RUNTIME, address: { machine: "local", id: pane } })
  yield* db.reportCoordinatorSession(coord.sessionId, "claude", claudeId)
  yield* herdr.seedAgent(pane)
  assert.isTrue(yield* db.insertSession(session("aaaaaaaa"), key))
  const projectId = yield* db.projectId(key)
  const call = { projectId, terminal: pane, claudeSessionId: claudeId }
  return { db, inbox, herdr, repo, key, coord, projectId, call }
})

describe("Claude inbox bridge", () => {
  test("identity refusals write nothing, and a worker or cli caller is refused", () =>
    Effect.gen(function* () {
      const { db, inbox, projectId, call, coord, repo } = yield* ready
      const sql = yield* SqlClient.SqlClient
      yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "result", message: "keep", details: {} })
      const badPane = yield* inbox.attach({ ...call, terminal: "other", replace: false })
      const badSession = yield* inbox.attach({ ...call, claudeSessionId: "nope", replace: false })
      const badPlace = yield* inbox.attach({ ...call, terminal: "elsewhere:p1", replace: false })
      assert.strictEqual(badPane.error, "stale-receiver")
      assert.strictEqual(badSession.error, "stale-receiver")
      assert.strictEqual(badPlace.error, "stale-receiver")
      const unreported = yield* db.coordinatorLaunch(yield* repositoryKey(yield* makeRepository), "claude", true, { runtime: RUNTIME, address: { machine: "local", id: "w2:p2" } })
      const unreportedProject = yield* db.projectOfSession(unreported.sessionId)
      const missing = yield* inbox.attach({ projectId: unreportedProject!, terminal: "w2:p2", claudeSessionId: claudeId, replace: false })
      assert.strictEqual(missing.error, "not-reported")
      const piRepo = yield* makeRepository
      const pi = yield* db.coordinatorLaunch(yield* repositoryKey(piRepo), "pi", false, { runtime: RUNTIME, address: { machine: "local", id: "w9:p9" } })
      assert.isTrue(yield* db.insertSession(session("bbbbbbbb"), yield* repositoryKey(piRepo)))
      yield* db.insertInbox({ sessionId: "bbbbbbbb", kind: "result", message: "pi-row", details: {} })
      const wrong = yield* inbox.attach({ projectId: yield* db.projectId(yield* repositoryKey(piRepo)), terminal: "w9:p9", claudeSessionId: "x", replace: true })
      assert.strictEqual(wrong.error, "wrong-harness")
      const meta = yield* sql<{ bridge: string | null }>`SELECT json_extract(metadata, '$.bridge') AS bridge FROM session WHERE id = ${pi.sessionId}`
      assert.strictEqual(meta[0]?.bridge ?? null, null)
      const kept = yield* sql<{ status: string }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE m.output = 'keep' OR m.output = 'pi-row' ORDER BY i.id`
      assert.deepStrictEqual(kept.map((row) => row.status), ["pending", "pending"])
      const marker = yield* sql<{ bridge: string | null }>`SELECT json_extract(metadata, '$.bridge') AS bridge FROM session WHERE id = ${coord.sessionId}`
      assert.strictEqual(marker[0]?.bridge ?? null, null)
      const raw = yield* Effect.flatMap(Layout, (layout) => connect(layout.socket))
      const place = { terminal: pane }
      const worker = authed(raw, sessionHeaders("aaaaaaaa"))
      const cli = authed(raw, cliHeaders(repo))
      for (const call of [
        worker["Inbox.Attach"]({ claudeSessionId: claudeId, replace: true, ...place }),
        worker["Inbox.Pull"]({ generation: "g", claudeSessionId: claudeId, ...place }),
        worker["Inbox.Ack"]({ generation: "g", claudeSessionId: claudeId, token: "t", ...place }),
        worker["Inbox.Release"]({ generation: "g", claudeSessionId: claudeId, token: "t", retry: true, ...place }),
        cli["Inbox.Attach"]({ claudeSessionId: claudeId, replace: true, ...place }),
        cli["Inbox.Pull"]({ generation: "g", claudeSessionId: claudeId, ...place }),
        cli["Inbox.Ack"]({ generation: "g", claudeSessionId: claudeId, token: "t", ...place }),
        cli["Inbox.Release"]({ generation: "g", claudeSessionId: claudeId, token: "t", retry: false, ...place }),
      ]) assert.strictEqual((yield* Effect.exit(call))._tag, "Failure")
      assert.strictEqual((yield* sql<{ bridge: string | null }>`SELECT json_extract(metadata, '$.bridge') AS bridge FROM session WHERE id = ${coord.sessionId}`)[0]?.bridge ?? null, null)
      assert.strictEqual((yield* db.coordinatorPending(projectId)).length, 1)
    }))

  test("attach waits out an entered paste, then the marker suppresses later paste", () =>
    Effect.gen(function* () {
      const { db, inbox, herdr, projectId, call } = yield* ready
      yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "result", message: "pasted", details: {} })
      const held = yield* herdr.hold("send", pane)
      const delivering = yield* Effect.forkChild(inbox.deliver(projectId))
      yield* held.reached
      const attaching = yield* Effect.forkChild(inbox.attach({ ...call, replace: false }))
      const raced = yield* TestClock.withLive(Effect.race(
        Fiber.join(attaching).pipe(Effect.as("done")),
        Effect.sleep("40 millis").pipe(Effect.as("waiting")),
      ))
      assert.strictEqual(raced, "waiting")
      yield* held.release()
      yield* Fiber.join(delivering)
      const attached = yield* Fiber.join(attaching)
      assert.strictEqual(attached.error, undefined)
      assert.isString(attached.generation)
      assert.strictEqual((yield* herdr.callsTo("send")).length, 1)
      yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "result", message: "held", details: {} })
      yield* inbox.deliver(projectId)
      assert.strictEqual((yield* herdr.callsTo("send")).length, 1)
      assert.deepStrictEqual((yield* db.coordinatorPending(projectId)).map((row) => row.message), ["held"])
    }))

  test("claims once, settles idempotently, and a stale Pi stream does not take Claude rows", () =>
    Effect.gen(function* () {
      const { db, inbox, projectId, call, key, coord } = yield* ready
      const sql = yield* SqlClient.SqlClient
      const fs = yield* FileSystem.FileSystem
      yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "result", message: "one", details: {} })
      yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "result", message: "two", details: {} })
      yield* sql`UPDATE inbox SET delivery_status = 'delivering' WHERE result_message_id = (SELECT id FROM message WHERE output = 'two' ORDER BY id DESC LIMIT 1)`
      const generation = (yield* inbox.attach({ ...call, replace: false })).generation!
      const both = yield* Effect.all([inbox.pull({ ...call, generation }), inbox.pull({ ...call, generation })], { concurrency: 2 })
      assert.strictEqual(both[0]!.token, both[1]!.token)
      assert.strictEqual(yield* fs.readFileString(both[0]!.file!), "one")
      const token = both[0]!.token!
      assert.deepStrictEqual(yield* inbox.ack({ ...call, generation, token }), { acked: true })
      assert.deepStrictEqual(yield* inbox.ack({ ...call, generation, token }), { acked: true, already: true })
      assert.strictEqual((yield* sql<{ status: string }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE m.output = 'one'`)[0]?.status, "delivered")
      assert.strictEqual((yield* sql<{ status: string }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE m.output = 'two'`)[0]?.status, "delivering")
      assert.strictEqual((yield* inbox.release({ ...call, generation, token, retry: false })).error, "stale-receiver")

      yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "result", message: "drop", details: {} })
      const drop = (yield* inbox.pull({ ...call, generation })).token!
      assert.deepStrictEqual(yield* inbox.release({ ...call, generation, token: drop, retry: true }), { released: true })
      assert.deepStrictEqual(yield* inbox.release({ ...call, generation, token: drop, retry: true }), { released: true, already: true })
      assert.strictEqual((yield* inbox.release({ ...call, generation, token: drop, retry: false })).error, "stale-receiver")
      assert.strictEqual((yield* sql<{ status: string }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE m.output = 'drop'`)[0]?.status, "pending")

      const live = yield* inbox.pull({ ...call, generation })
      const replaced = yield* inbox.attach({ ...call, replace: true })
      assert.notStrictEqual(replaced.generation, generation)
      assert.strictEqual((yield* sql<{ status: string }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE m.output = 'drop'`)[0]?.status, "failed")
      assert.strictEqual((yield* sql<{ status: string }>`SELECT i.delivery_status AS status FROM inbox i LEFT JOIN message m ON m.id = i.result_message_id WHERE m.output = 'two'`)[0]?.status, "delivering")
      assert.strictEqual((yield* inbox.pull({ ...call, generation })).error, "stale-receiver")
      assert.strictEqual((yield* inbox.ack({ ...call, generation, token: live.token! })).error, "stale-receiver")

      const huge = "x".repeat(CLAUDE_INBOX_MAX_BYTES + 1)
      yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "result", message: huge, details: {} })
      const oversized = yield* inbox.pull({ ...call, generation: replaced.generation! })
      assert.strictEqual(oversized.error, "too-large")
      assert.isAbove(oversized.bytes!, CLAUDE_INBOX_MAX_BYTES)
      yield* db.coordinatorLaunch(key, "claude", false, { runtime: RUNTIME, address: { machine: "local", id: "w1:p2" } })
      yield* inbox.reconcile(projectId)
      assert.strictEqual((yield* inbox.pull({ ...call, generation: replaced.generation! })).error, "stale-receiver")

      const path = yield* Path.Path
      const layout = yield* Layout
      yield* fs.writeFileString(path.join(layout.home, "blocked-claims"), "x")
      yield* db.coordinatorLaunch(key, "claude", false, { runtime: RUNTIME, address: { machine: "local", id: pane } })
      yield* db.reportCoordinatorSession(coord.sessionId, "claude", claudeId)
      const renewed = (yield* inbox.attach({ ...call, replace: true })).generation!
      yield* fs.remove(path.join(layout.home, "inbox-claims"), { recursive: true }).pipe(Effect.ignore)
      yield* fs.writeFileString(path.join(layout.home, "inbox-claims"), "not-a-directory")
      yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "notice", message: "fault", details: {} })
      const faulted = yield* inbox.pull({ ...call, generation: renewed })
      assert.strictEqual(faulted.error, "unavailable")
      assert.strictEqual((yield* sql<{ status: string }>`SELECT delivery_status AS status FROM inbox WHERE content = 'fault'`)[0]?.status, "pending")

      yield* fs.remove(path.join(layout.home, "inbox-claims")).pipe(Effect.ignore)
      yield* db.coordinatorLaunch(key, "pi", false, { runtime: RUNTIME, address: { machine: "local", id: pane } })
      const stream = yield* Effect.forkChild(inbox.stream(projectId).pipe(Stream.take(1), Stream.runCollect))
      yield* db.coordinatorLaunch(key, "claude", false, { runtime: RUNTIME, address: { machine: "local", id: pane } })
      yield* db.reportCoordinatorSession(coord.sessionId, "claude", claudeId)
      const back = (yield* inbox.attach({ ...call, replace: true })).generation!
      yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "result", message: "after-switch", details: {} })
      const native = yield* inbox.pull({ ...call, generation: back })
      assert.strictEqual(yield* fs.readFileString(native.file!), "after-switch")
      yield* Fiber.interrupt(stream)
    }))
})
