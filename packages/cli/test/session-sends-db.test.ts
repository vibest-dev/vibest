import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import * as Projectors from "@vibest/core/database/projectors"
import { SessionLive } from "@vibest/core/session/live"
import { systemPrompt } from "@vibest/core/system-prompt"
import { entryPending, projectOf } from "@vibest/platform-bun/test/lib/fakes"
import { place, session } from "@vibest/platform-bun/test/lib/unit-helpers"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const memory = <A, E>(program: Effect.Effect<A, E, Db.Service | SqlClient.SqlClient>) =>
  program.pipe(
    Effect.provide(
      Db.layer.pipe(
        Layer.provide(Projectors.layer),
        Layer.provide(Bus.layer),
        Layer.provide(SessionLive.layer),
        Layer.provideMerge(Platform.sqlite(":memory:")),
      ),
    ),
  )

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

const setup = Effect.gen(function* () {
  const db = yield* Db.Service
  const project = yield* projectOf("r")
  const entry = yield* db.session.startRoot(project, "pi", false, place, { agent: "coordinator" })
  yield* db.session.insertSession(session(A), project, { cwd: "/w", task: "a", parentSessionId: entry.sessionId })

  return { db, project, entryId: entry.sessionId }
})

describe("sends from sessions", () => {
  it.effect("an acked outbound id does not swallow a later forward of the same transfer", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, entryId } = yield* setup
        const remoteId = "11111111-1111-4111-8111-111111111111"
        const remote = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        const middle = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        const ended = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        const id = "22222222-2222-4222-8222-222222222222"
        yield* db.remote.noteRemote({ id: remoteId, name: "remote-b" })
        yield* db.session.insertSession(session(B), project, { cwd: "/w", task: "child", parentSessionId: entryId })
        yield* db.remote.sendToRemote(B, remoteId, remote, "orig", id)
        yield* db.remote.ackOutbox(remoteId, [id])
        yield* db.session.insertSession(session(middle), project, {
          origin: { remote: remoteId, project: "p", reportTo: remote },
        })
        yield* db.session.insertSession(session(ended), project, { parentSessionId: middle })
        yield* db.session.archive(middle)
        yield* db.session.archive(ended)

        const back = {
          id,
          recipient: ended,
          kind: "send" as const,
          sender: "remote-b/dddddddd",
          from: { session: remote, machine: "remote-b" },
          content: "came back",
        }

        assert.strictEqual(yield* db.remote.receiveRemoteItem(back), "queued")
        assert.lengthOf(yield* db.remote.outboxOf(remoteId), 1)
        assert.strictEqual(yield* db.remote.receiveRemoteItem(back), "duplicate")
        assert.lengthOf(yield* db.remote.outboxOf(remoteId), 1)
      }),
    ),
  )

  it.effect("an outbound transfer id is not proof that the same id was received", () =>
    memory(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const { db, project, entryId } = yield* setup
        const remoteId = "11111111-1111-4111-8111-111111111111"
        const remote = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        const id = "11111111-1111-4111-8111-111111111112"

        yield* db.remote.noteRemote({ id: remoteId, name: "remote-b" })
        yield* db.session.insertSession(session(B), project, { cwd: "/w", task: "child" })
        yield* db.remote.sendToRemote(B, remoteId, remote, "orig", id)
        yield* db.remote.ackOutbox(remoteId, [id])

        const back = {
          id,
          recipient: entryId,
          kind: "send" as const,
          sender: "remote-b/dddddddd",
          from: { session: remote, machine: "remote-b" },
          content: "orig",
        }

        assert.strictEqual(yield* db.remote.receiveRemoteItem(back), "queued")
        assert.deepStrictEqual(yield* sql<{ n: number }>`SELECT count(*) AS n FROM inbox WHERE transfer_id = ${id}`, [
          { n: 1 },
        ])
        assert.strictEqual(yield* db.remote.receiveRemoteItem(back), "duplicate")
      }),
    ),
  )

  it.effect("a send to the entry session waits as a pending row like a send to any session", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, entryId } = yield* setup
        assert.isDefined(yield* db.inbox.insertSend(entryId, "hello", { type: "agent", session: A }))
        assert.deepStrictEqual(
          (yield* entryPending(db, project)).map((r) => [r.sender, r.recipient]),
          [[{ type: "agent", session: A, agent: session(A).agent, title: session(A).name }, entryId]],
        )
      }),
    ),
  )

  it.effect(
    "a session may send to the session that started it and to the sessions it started, and to no one else",
    () =>
      memory(
        Effect.gen(function* () {
          const { db, project, entryId } = yield* setup
          yield* db.session.insertSession(session(B), project, { cwd: "/w", task: "b", parentSessionId: entryId })
          yield* db.session.insertSession(session(X), project, { cwd: "/w", task: "x", parentSessionId: A })
          assert.isFalse(yield* db.inbox.maySend(A, B))
          assert.isFalse(yield* db.inbox.maySend(B, A))
          assert.isFalse(yield* db.inbox.maySend(X, entryId))
          assert.isTrue(yield* db.inbox.maySend(entryId, B))
          assert.isTrue(yield* db.inbox.maySend(B, entryId))
          assert.isTrue(yield* db.inbox.maySend(A, X))
          assert.isTrue(yield* db.inbox.maySend(X, A))
        }),
      ),
  )

  it.effect(
    "insertSession links from/to/with edges and linkSessions/unlinkSessions update directed messaging permissions",
    () =>
      memory(
        Effect.gen(function* () {
          const { db, project, entryId } = yield* setup
          const start = { cwd: "/w", task: "t", parentSessionId: entryId }
          assert.isTrue(
            yield* db.session.insertSession(session(B), project, {
              ...start,
              links: { from: [A] },
            }),
          )
          assert.isTrue(yield* db.inbox.maySend(A, B))
          assert.isFalse(yield* db.inbox.maySend(B, A))

          assert.isTrue(
            yield* db.session.insertSession(session(X), project, {
              ...start,
              links: { to: [B], with: [A] },
            }),
          )
          assert.isTrue(yield* db.inbox.maySend(X, B))
          assert.isFalse(yield* db.inbox.maySend(B, X))
          assert.isTrue(yield* db.inbox.maySend(A, X))
          assert.isTrue(yield* db.inbox.maySend(X, A))

          const targets = yield* db.session.linkedTargets(X, entryId)
          assert.deepStrictEqual(targets.map((t) => t.id).sort(), [A, B].sort())

          const edges = yield* db.session.sessionEdges([A, B, X])
          assert.deepStrictEqual([...(edges.get(X) ?? [])].sort(), [A, B, entryId].sort())

          yield* db.session.linkSessions([{ from: B, to: X }])
          assert.isTrue(yield* db.inbox.maySend(B, X))

          yield* db.session.unlinkSessions([{ from: A, to: X }])
          assert.isFalse(yield* db.inbox.maySend(A, X))
          assert.isTrue(yield* db.inbox.maySend(X, A))
        }),
      ),
  )

  it.effect("Db.inbox.maySend refuses a session sending to itself", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, entryId } = yield* setup
        assert.isTrue(
          yield* db.session.insertSession(session(B), project, {
            cwd: "/w",
            task: "t",
            parentSessionId: entryId,
          }),
        )
        assert.isFalse(yield* db.inbox.maySend(B, B))
        assert.isFalse(yield* db.inbox.maySend(A, A))
        assert.isFalse(yield* db.inbox.maySend(entryId, entryId))
      }),
    ),
  )

  it.effect(
    "a session whose creator has ended still names it as its creator, and its notices go to the nearest creator above that is running",
    () =>
      memory(
        Effect.gen(function* () {
          const { db, project, entryId } = yield* setup
          yield* db.session.insertSession(session(B), project, { cwd: "/w", task: "b", parentSessionId: A })
          yield* db.session.archive(A)
          assert.deepStrictEqual(yield* db.session.nearestAlive(B), { local: entryId })
          assert.isTrue(yield* db.inbox.maySend(B, A))
          const creator = yield* db.session.creatorLabel(B)
          assert.deepStrictEqual(creator, { id: A, label: `agent ${session(A).name}`, remote: undefined })

          const prompt = systemPrompt({
            system: "",
            id: B,
            projectDir: "/w",
            preferences: "",
            memories: "",
            creator,
            agents: [],
          })

          assert.include(prompt, `send ${A} --`)
          assert.include(prompt, "nearest session above it that is still running")
        }),
      ),
  )

  it.effect(
    "a send to the nearest living creator on another machine reaches that machine's outbox from any depth",
    () =>
      memory(
        Effect.gen(function* () {
          const { db, project } = yield* setup
          const remote = "11111111-1111-4111-8111-111111111111"
          const reportTo = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
          yield* db.remote.noteRemote({ id: remote, name: "other" })
          yield* db.session.insertSession(session(B), project, {
            cwd: "/w",
            task: "b",
            origin: { remote, project: "p", reportTo },
          })
          yield* db.session.insertSession(session(X), project, { cwd: "/w", task: "x", parentSessionId: B })
          yield* db.session.archive(B)
          const { execution } = yield* db.session.startExecution(X, 1)
          const heir = yield* db.session.nearestAlive(X)
          assert.deepStrictEqual(heir, { remote, session: reportTo })
          assert.isTrue(yield* db.remote.sendToRemote(X, remote, reportTo, "report"))
          const out = yield* db.remote.outboxOf(remote)
          assert.deepInclude(out[0]!, { kind: "send", content: "report", reportTo })
          assert.deepStrictEqual(out[0]!.from, { session: X, agent: session(X).agent, title: session(X).name })
          assert.isFalse(yield* db.remote.sendToRemote(X, "22222222-2222-4222-8222-222222222222", reportTo, "report"))
          assert.isTrue(
            yield* db.remote.sendToRemote(X, remote, reportTo, "again", "6f1c2a3e-8b7d-4c5a-9e10-2d3f4a5b6c7d"),
          )
          assert.isTrue(
            yield* db.remote.sendToRemote(X, remote, reportTo, "again", "6f1c2a3e-8b7d-4c5a-9e10-2d3f4a5b6c7d"),
          )
          assert.lengthOf(yield* db.remote.outboxOf(remote), 2)
          yield* db.remote.ackOutbox(
            remote,
            (yield* db.remote.outboxOf(remote)).map((row) => row.id),
          )
          assert.isTrue(
            yield* db.remote.sendToRemote(X, remote, reportTo, "again", "6f1c2a3e-8b7d-4c5a-9e10-2d3f4a5b6c7d"),
          )
          assert.lengthOf(yield* db.remote.outboxOf(remote), 0, "a retry of an acknowledged request is not sent again")
          assert.strictEqual(
            yield* db.inbox.sentIn(X, execution),
            2,
            "both sends count in X's execution, also once acked",
          )
        }),
      ),
  )

  it.effect(
    "an item for an ended session whose nearest living creator is on another machine goes on to that machine, once",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const { db, project } = yield* setup
        const remote = "11111111-1111-4111-8111-111111111111"
        const reportTo = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        const middle = B
        const ended = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        yield* db.remote.noteRemote({ id: remote, name: "other" })
        yield* db.session.insertSession(session(middle), project, { origin: { remote, project: "p", reportTo } })
        yield* db.session.insertSession(session(ended), project, { parentSessionId: middle })
        yield* db.session.archive(middle)
        yield* db.session.archive(ended)

        const item = {
          id: "7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f",
          recipient: ended,
          kind: "send" as const,
          sender: "mb/cccccccc",
          from: { session: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", agent: "general", title: "Far away", machine: "mc" },
          content: "report",
        }

        assert.strictEqual(yield* db.remote.receiveRemoteItem(item), "queued")
        assert.strictEqual(yield* db.remote.receiveRemoteItem(item), "duplicate")
        assert.deepStrictEqual(yield* sql`SELECT status FROM inbox WHERE recipient_session_id = ${ended}`, [])
        const out = yield* db.remote.outboxOf(remote)
        assert.lengthOf(out, 1)
        assert.deepInclude(out[0]!, { kind: "send", content: "mb/cccccccc: report", reportTo })
        assert.strictEqual(out[0]!.id, item.id, "the forward reuses the incoming transfer id")
        assert.deepInclude(
          out[0]!,
          { sessionId: ended, from: null },
          "the relay wrote the new message, so it is the sender",
        )
      }).pipe(memory),
  )
})
