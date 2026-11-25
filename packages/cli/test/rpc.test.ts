import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, protocolHeaders } from "@vibest/client/client"
import { withHeaders } from "@vibest/client/unix-http"
import { Db } from "@vibest/core/database/db"
import { executionStateOf } from "@vibest/core/database/db-rows"
import { unwrapped } from "@vibest/core/replies"
import { Session } from "@vibest/core/session"
import { PRESENT_TIMEOUT } from "@vibest/core/session/entry"
import { authed, FakeRuntime, makeRepository, until, writeEnd } from "@vibest/platform-bun/test/lib/fakes"
import { served, test, client, asCli, asEntry, asSession, failureTag } from "@vibest/platform-bun/test/lib/rpc-helpers"
import { session as draftSession } from "@vibest/platform-bun/test/lib/unit-helpers"
import { ACCESS } from "@vibest/protocol/access"
import { VibestApi } from "@vibest/protocol/api"
import { MISMATCH_ACTION, sessionHeaders } from "@vibest/protocol/protocol"
import { EdgeMutual } from "@vibest/protocol/schemas"
import { PROTOCOL } from "@vibest/schema/version"
import { Cause, Effect, Exit, Fiber, FileSystem, Path, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { VERSION } from "../src/version.ts"

describe("vibest.sock", () => {
  test(
    "a direct request succeeds without Hello; missing or bad caller is refused and does not become cli",
    Effect.gen(function* () {
      const raw = yield* client
      const repo = yield* makeRepository
      assert.strictEqual((yield* raw["server.daemon"]["daemon.ping"]({})).protocol, PROTOCOL)

      const newer = yield* Effect.exit(
        withHeaders(raw["server.session"]["session.list"]({ query: {} }), { "vibest-protocol": String(PROTOCOL + 1) }),
      )

      assert.include(
        String(Exit.isFailure(newer) && Cause.pretty(newer.cause)),
        `vibestd is older (${VERSION}); run ${MISMATCH_ACTION}`,
      )
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(withHeaders(raw["server.session"]["session.list"]({ query: {} }), protocolHeaders())),
        ),
        "InvalidCaller",
      )
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            withHeaders(raw["server.session"]["session.list"]({ query: {} }), {
              ...protocolHeaders(),
              "vibest-caller": "cli",
            }),
          ),
        ),
        "InvalidCaller",
      )
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            withHeaders(raw["server.session"]["session.list"]({ query: {} }), {
              ...cliHeaders(repo),
              "vibest-session-id": "abc",
            }),
          ),
        ),
        "InvalidCaller",
      )
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            withHeaders(raw["server.session"]["session.list"]({ query: {} }), {
              ...protocolHeaders(),
              "vibest-caller": "session",
            }),
          ),
        ),
        "InvalidCaller",
      )
      assert.deepStrictEqual(
        yield* withHeaders(raw["server.session"]["session.list"]({ query: {} }), cliHeaders(repo)),
        { sessions: [], machines: [] },
      )
      assert.deepStrictEqual(yield* asCli(raw, repo)["server.session"]["session.list"]({ query: {} }), {
        sessions: [],
        machines: [],
      })
    }),
  )

  it.effect(
    "Daemon.Handoff to a vibest whose import check fails (a database it cannot open) refuses before the takeover, and this vibestd keeps serving",
    () =>
      Effect.gen(function* () {
        const raw = yield* client
        const c = asCli(raw, yield* makeRepository)
        const instance = (yield* raw["server.daemon"]["daemon.ping"]({})).instance!
        const cannotOpen = 'echo "vibest.db is not this vibest\'s schema" >&2; exit 1'

        const refused = yield* Effect.flip(
          c["server.daemon"]["daemon.handoff"]({
            payload: { instance, command: ["sh", "-c", cannotOpen, "newer-vibest"] },
          }),
        )

        assert.strictEqual(refused._tag, "LaunchFailed")
        assert.include(refused.message, "cannot take over this vibestd (vibest.db is not this vibest's schema)")
        assert.include(refused.message, "it keeps running")
        assert.strictEqual((yield* raw["server.daemon"]["daemon.ping"]({})).instance, instance)
        assert.deepStrictEqual(yield* c["server.session"]["session.list"]({ query: {} }), {
          sessions: [],
          machines: [],
        })
      }).pipe(Effect.provide(served({ identity: { instance: "vibestd-before" } }))),
  )

  test(
    "a session is named by its full id or a unique prefix of 8 or more characters; the answers name the full id",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const spawner = yield* asEntry(yield* client, repo)

      const { id } = yield* spawner["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* until(
        db.session.getSession(id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )
      assert.strictEqual(
        (yield* Effect.flip(c["server.session"]["session.get"]({ params: { id: "nothing!" }, query: {} })))._tag,
        "NoSuchSession",
      )
      assert.deepStrictEqual(
        yield* c["server.session"]["session.send"]({ params: { id: id.slice(0, 12) }, payload: { message: "more" } }),
        { id },
      )

      const sharer = yield* spawner["server.session"]["session.spawn"]({
        payload: {
          agent: "general",
          callerEnv: {},
          harness: "pi",
          prompt: "beside it",
          share: id.slice(0, 10),
        },
      })

      assert.strictEqual(
        yield* db.session.sessionDirectory(sharer.id),
        yield* db.session.sessionDirectory(id),
        "--share takes a prefix",
      )
      const twinWithSameFirst8 = `${id.slice(0, 8)}-0000-4000-8000-000000000000`
      const row = (yield* db.session.getSession(id))!
      yield* db.session.insertSession(draftSession(twinWithSameFirst8), row.projectId)

      const ambiguous = yield* Effect.flip(
        c["server.session"]["session.get"]({ params: { id: id.slice(0, 8) }, query: {} }),
      )

      assert.strictEqual(ambiguous._tag, "AmbiguousSession")
      assert.include(ambiguous.message, id)
      assert.include(ambiguous.message, twinWithSameFirst8)
      assert.include(ambiguous.message, "retry with more characters of the session id")
      assert.strictEqual(
        (yield* c["server.session"]["session.get"]({ params: { id: id.slice(0, 13) }, query: {} })).id,
        id,
      )

      const slashRef = yield* Effect.flip(
        c["server.session"]["session.get"]({ params: { id: `mb/${id.slice(0, 8)}` }, query: {} }),
      )

      assert.strictEqual(slashRef._tag, "NoSuchSession")
    }),
  )

  test(
    "a Send or Spawn repeated with its request id queues nothing more and answers as the first; a Send repeat still answers once archived",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sql = yield* SqlClient.SqlClient
      const db = yield* Db.Service
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const spawner = yield* asEntry(yield* client, repo)

      const first = yield* spawner["server.session"]["session.spawn"]({
        payload: {
          agent: "general",
          callerEnv: {},
          harness: "pi",
          prompt: "do it",
          request: "spawn-1",
        },
      })

      assert.deepStrictEqual(
        yield* spawner["server.session"]["session.spawn"]({
          payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it", request: "spawn-1" },
        }),
        first,
      )
      assert.deepStrictEqual(
        (yield* db.session.listSessions()).filter((w) => w.parentId !== null).map((w) => w.id),
        [first.id],
      )
      const worktree = (yield* db.session.sessionDirectory(first.id))!
      assert.deepStrictEqual(
        yield* fs.readDirectory(path.dirname(worktree)),
        [path.basename(worktree)],
        "the repeat's reserved worktree directory went again",
      )
      yield* until(
        db.session.getSession(first.id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )

      const queued = (request: string) =>
        sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE type = 'session.inbox.enqueued.1'
          AND json_extract(data, '$.requestId') = ${request}`.pipe(Effect.map((rows) => rows[0]!.n))

      const sends = sql<{ n: number }>`SELECT count(*) AS n FROM inbox i WHERE i.sender_type != 'vibest'
          AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = i.recipient_session_id AND s.message_id = i.id)`.pipe(
        Effect.map((rows) => rows[0]!.n),
      )

      assert.strictEqual(yield* queued("spawn-1"), 1)

      const sent = yield* c["server.session"]["session.send"]({
        params: { id: first.id },
        payload: { message: "more", request: "6f1c2a3e-8b7d-4c5a-9e10-2d3f4a5b6c7d" },
      })

      yield* c["server.session"]["session.archive"]({ params: { id: first.id }, payload: {} })
      assert.deepStrictEqual(
        yield* c["server.session"]["session.send"]({
          params: { id: first.id },
          payload: { message: "more", request: "6f1c2a3e-8b7d-4c5a-9e10-2d3f4a5b6c7d" },
        }),
        sent,
      )
      assert.strictEqual(yield* sends, 1)
      assert.strictEqual(
        (yield* Effect.flip(
          c["server.session"]["session.send"]({
            params: { id: first.id },
            payload: { message: "more", request: "7a2d3b4f-9c8e-4d6b-8f21-3e4a5b6c7d8e" },
          }),
        ))._tag,
        "NoSuchSession",
      )
    }),
  )

  test(
    "a Cursor afterAgentResponse stop ends the execution with its text as execution.reply and as Get's reply",
    Effect.gen(function* () {
      const raw = yield* client
      const db = yield* Db.Service
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const c = asCli(raw, yield* makeRepository)
      const spawner = yield* asEntry(raw, yield* makeRepository)

      const { id } = yield* spawner["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "cursor", prompt: "work" },
      })

      yield* until(
        db.session.getSession(id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )
      yield* TestClock.adjust("2 seconds")
      yield* withHeaders(
        raw["server.hook"]["hook.executionEnd"]({
          params: { harness: "cursor" },
          payload: JSON.stringify({ hook_event_name: "afterAgentResponse", text: "cursor said this" }),
        }),
        { ...protocolHeaders(), "vibest-session-id": id },
      )
      yield* herdr.endExecution(id)
      yield* until(
        sessions.check(id).pipe(Effect.andThen(db.session.getSession(id))),
        (w) => (w ? executionStateOf(w) : undefined) === "completed",
      )

      const [execution] = yield* sql<{
        reply: string | null
      }>`SELECT reply FROM execution WHERE session_id = ${id}`

      assert.strictEqual(execution?.reply, "cursor said this")
      const reply = (yield* c["server.session"]["session.get"]({ params: { id }, query: {} })).reply
      assert.deepInclude(reply, { status: "completed", text: "cursor said this", failure: null })
    }),
  )

  test(
    "List cuts a task past 500 characters; Get keeps it, and latest is the newest message",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const db = yield* Db.Service
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const spawner = yield* asEntry(yield* client, repo)
      const exact = "e".repeat(500)
      const prompt = "p".repeat(501)

      const fit = yield* spawner["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: exact },
      })

      const { id } = yield* spawner["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt },
      })

      yield* until(
        db.session.getSession(id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )
      yield* until(
        db.session.getSession(fit.id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )
      const listed = new Map((yield* c["server.session"]["session.list"]({ query: {} })).sessions.map((w) => [w.id, w]))
      const cut = `${"p".repeat(499)}…`
      const open = { status: "working", summary: "", endedAt: null } as const
      assert.strictEqual(listed.get(fit.id)!.task, exact)
      assert.deepStrictEqual(listed.get(fit.id)!.latest, open)
      assert.strictEqual(listed.get(id)!.task, cut)
      assert.deepStrictEqual(listed.get(id)!.latest, open)
      assert.strictEqual((yield* c["server.session"]["session.get"]({ params: { id }, query: {} })).task, prompt)
      yield* writeEnd(id, "pi", { text: "\nfixed it\nand more" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)

      const after = (yield* c["server.session"]["session.list"]({ query: {} })).sessions.find(
        (w) => w.id === id,
      )!.latest

      assert.strictEqual(after?.status, "completed")
      assert.strictEqual(after?.summary, "fixed it")
      assert.isNumber(after?.endedAt)
      yield* c["server.session"]["session.send"]({ params: { id }, payload: { message: "follow up" } })
      assert.strictEqual(
        (yield* c["server.session"]["session.list"]({ query: {} })).sessions.find((w) => w.id === id)!.task,
        cut,
        "a follow-up is not the task",
      )
      assert.strictEqual((yield* c["server.session"]["session.get"]({ params: { id }, query: {} })).task, prompt)
    }),
  )

  test(
    "Peek returns the runtime's terminal text and asks for at most 500 lines; an exited session has no terminal to read",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const raw = yield* client
      const c = asCli(raw, repo)
      const spawner = yield* asEntry(raw, repo)

      const { id } = yield* spawner["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* until(
        db.session.getSession(id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )
      assert.deepStrictEqual(yield* c["server.session"]["session.peek"]({ params: { id }, query: {} }), {
        text: "pane tail",
      })
      yield* c["server.session"]["session.peek"]({ params: { id }, query: { lines: 100_000 } })
      assert.deepInclude((yield* herdr.callsTo("read")).at(-1), { lines: 500 })
      yield* db.session.endProcess(id, "exited")
      assert.strictEqual(
        failureTag(yield* Effect.exit(c["server.session"]["session.peek"]({ params: { id }, query: {} }))),
        "NoSuchSession",
      )
    }),
  )

  test(
    "Project.EntrySession answers and frees the project when the runtime's present never returns",
    Effect.gen(function* () {
      const runtime = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const held = yield* runtime.hold("present")

      const launch = yield* c["server.session"]
        ["session.claim"]({
          payload: {
            agent: "coordinator",
            harness: "claude",
            fresh: false,
            terminal: { id: "test/p1" },
          },
        })
        .pipe(Effect.forkChild)

      yield* held.reached
      yield* TestClock.adjust(PRESENT_TIMEOUT)
      const saved = yield* Fiber.join(launch)
      assert.isString(saved.sessionId)

      const again = yield* c["server.session"]
        ["session.claim"]({
          payload: {
            agent: "coordinator",
            harness: "claude",
            fresh: false,
            terminal: { id: "test/p1" },
          },
        })
        .pipe(Effect.forkChild)

      yield* TestClock.adjust(PRESENT_TIMEOUT)
      assert.strictEqual((yield* Fiber.join(again)).sessionId, saved.sessionId)
    }),
  )

  test(
    "every entry session launch names its own process, so a new conversation in the same entry session is told apart",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const c = asCli(yield* client, yield* makeRepository)

      const enter = (harness: "pi" | "claude") =>
        c["server.session"]["session.claim"]({
          payload: { agent: "coordinator", harness, fresh: false, terminal: { id: "test/p1" } },
        })

      const first = yield* enter("pi")
      assert.strictEqual(first.command.env.VIBEST_PROCESS, String(yield* db.session.currentProcessId(first.sessionId)))
      const second = yield* enter("claude")
      assert.strictEqual(second.sessionId, first.sessionId)
      assert.strictEqual(second.command.env.VIBEST_PROCESS, String(yield* db.session.currentProcessId(first.sessionId)))
      assert.notStrictEqual(second.command.env.VIBEST_PROCESS, first.command.env.VIBEST_PROCESS)
    }),
  )

  test(
    "a session sends only as itself; an unknown session is refused",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const repo = yield* makeRepository
      const raw = yield* client
      const c = asCli(raw, repo)
      const spawner = yield* asEntry(raw, repo)

      const { id } = yield* spawner["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* until(
        db.session.getSession(id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )
      yield* (yield* FakeRuntime).seedAgent("test/p1")

      const launch = yield* c["server.session"]["session.claim"]({
        payload: {
          agent: "coordinator",
          harness: "claude",
          fresh: false,
          terminal: { id: "test/p1" },
        },
      })

      yield* withHeaders(
        raw["server.hook"]["hook.ready"]({
          payload: { conversation: { harness: "claude", id: "s1" } },
        }),
        sessionHeaders({
          sessionId: launch.sessionId,
          projectId: launch.projectId,
          pluginVersion: "1.2.3",
        }),
      )

      const bare = yield* client
      yield* withHeaders(
        bare["server.hook"]["hook.executionEnd"]({ params: { harness: "pi" }, payload: "{}" }),
        sessionHeaders({ sessionId: id, pluginVersion: "1.2.3" }),
      )
      assert.deepStrictEqual(
        (yield* db.session.getSession(id))?.process?.integration,
        { version: "1.2.3", protocol: PROTOCOL },
        "an integration's version is recorded even when its protocol is refused",
      )
      const old = { ...sessionHeaders({ sessionId: id, pluginVersion: "1.0.0" }), "vibest-protocol": "1" }
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            withHeaders(bare["server.hook"]["hook.executionEnd"]({ params: { harness: "pi" }, payload: "{}" }), old),
          ),
        ),
        "ProtocolRejected",
      )
      assert.deepStrictEqual((yield* db.session.getSession(id))?.process?.integration, {
        version: "1.0.0",
        protocol: 1,
      })

      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            withHeaders(
              bare["server.session"]["session.send"]({ params: { id: launch.sessionId }, payload: { message: "x" } }),
              sessionHeaders({ sessionId: "nope" }),
            ),
          ),
        ),
        "NoSuchSession",
      )
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            withHeaders(
              bare["server.session"]["session.send"]({ params: { id: launch.sessionId }, payload: { message: "x" } }),
              sessionHeaders({ sessionId: id }),
            ),
          ),
        ),
        "InvalidCaller",
        "a known session without its project id is refused, as over HTTP",
      )

      const projectId = String((yield* db.session.sessionIdentity(id))!.projectId)

      const as = (harness: string, harnessSessionId: string) =>
        authed(raw, sessionHeaders({ sessionId: id, projectId, harness, harnessSessionId }))

      yield* as("pi", "pi-1")["server.session"]["session.send"]({
        params: { id: launch.sessionId },
        payload: { message: "one" },
      })
      assert.strictEqual((yield* db.session.getSession(id))!.process?.harnessSessionId ?? null, "pi-1")
      yield* as("claude", "other")["server.session"]["session.send"]({
        params: { id: launch.sessionId },
        payload: { message: "two" },
      })
      assert.strictEqual((yield* db.session.getSession(id))!.process?.harnessSessionId ?? null, "pi-1")
      yield* withHeaders(
        raw["server.hook"]["hook.executionEnd"]({ params: { harness: "pi" }, payload: "{}" }),
        sessionHeaders({ sessionId: id, projectId, harness: "pi", harnessSessionId: "pi-2" }),
      )
      assert.strictEqual((yield* db.session.getSession(id))!.process?.harnessSessionId ?? null, "pi-2")
      const w = yield* asSession(yield* client, id)
      yield* w["server.session"]["session.send"]({ params: { id: launch.sessionId }, payload: { message: "half way" } })
      const sent = yield* db.inbox.latestInbox(launch.sessionId, "send")
      assert.match(
        sent!.message,
        /^<vibest-agent-message>\n<session-id>[a-f0-9]{8}<\/session-id>\n<message>\nhalf way\n<\/message>\n<\/vibest-agent-message>$/,
      )
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "open")
      assert.deepStrictEqual(
        yield* c["server.session"]["session.send"]({
          params: { id: launch.sessionId },
          payload: { message: "from the user" },
        }),
        { id: launch.sessionId },
      )
      const fromUser = yield* db.inbox.latestInbox(launch.sessionId, "send")
      assert.deepInclude(fromUser, { message: "from the user", sender: { type: "user" } })
      yield* withHeaders(
        raw["server.hook"]["hook.ready"]({
          payload: { conversation: { harness: "claude", id: "stale" } },
        }),
        sessionHeaders({
          sessionId: launch.sessionId,
          projectId: launch.projectId,
          pluginVersion: "1.2.3",
        }),
      )
      yield* withHeaders(
        raw["server.hook"]["hook.ready"]({
          payload: { conversation: { harness: "claude", id: "s2" } },
        }),
        sessionHeaders({
          sessionId: launch.sessionId,
          projectId: launch.projectId,
          pluginVersion: "1.2.3",
        }),
      )
      yield* withHeaders(
        raw["server.hook"]["hook.ready"]({
          payload: { conversation: { harness: "pi", id: "late-pi-report" } },
        }),
        sessionHeaders({
          sessionId: launch.sessionId,
          projectId: launch.projectId,
          pluginVersion: "1.2.3",
        }),
      )
      assert.strictEqual(
        (yield* c["server.session"]["session.claim"]({
          payload: {
            agent: "coordinator",
            harness: "claude",
            fresh: false,
            terminal: { id: "test/p1" },
          },
        })).harnessSessionId,
        "s2",
        "a conversation reported by another harness than the session's is ignored",
      )
      const worker = (yield* db.session.getSession(id))!
      yield* withHeaders(
        raw["server.hook"]["hook.ready"]({ payload: { conversation: { harness: "pi", id: "worker-report" } } }),
        sessionHeaders({ sessionId: id, projectId: worker.projectId, pluginVersion: "1.2.3" }),
      )
      assert.notStrictEqual(
        (yield* db.session.getSession(id))!.process?.harnessSessionId ?? null,
        "worker-report",
        "a conversation reported by a session that is not its project's entry is ignored",
      )
    }),
  )

  test(
    "an entry session manages only the sessions it spawned, and another project's reads them but does not list them; the command line (the user) manages any",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const repo = yield* makeRepository

      const asEntry = (root: string, paneId: string) =>
        Effect.gen(function* () {
          const raw = yield* client

          const launched = yield* asCli(raw, root)["server.session"]["session.claim"]({
            payload: {
              agent: "coordinator",
              harness: "pi",
              fresh: false,
              terminal: { id: `test/${paneId}` },
            },
          })

          return yield* asSession(raw, launched.sessionId, root)
        })

      const a = yield* asEntry(repo, "p1")
      const b = yield* asEntry(yield* makeRepository, "p2")

      const { id } = yield* a["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* until(
        db.session.getSession(id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )

      const others: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        b["server.session"]["session.send"]({ params: { id }, payload: { message: "x" } }),
        b["server.session"]["session.interrupt"]({ params: { id }, query: {} }),
        b["server.session"]["session.peek"]({ params: { id }, query: {} }),
        b["server.session"]["session.archive"]({ params: { id }, payload: {} }),
      ]

      for (const call of others) {
        const exit = yield* Effect.exit(call)
        assert.strictEqual(failureTag(exit), "Forbidden")
        assert.match(
          String(Exit.isFailure(exit) && Cause.pretty(exit.cause)),
          /belongs to another project|was not started by this session/,
        )
      }

      assert.deepInclude(yield* b["server.session"]["session.get"]({ params: { id }, query: {} }), {
        id,
        agent: "general",
      })
      assert.strictEqual((yield* b["server.session"]["session.list"]({ query: {} })).sessions[0]?.agent, "coordinator")
      assert.deepStrictEqual(
        (yield* b["server.session"]["session.list"]({ query: { stopped: true } })).sessions.filter(
          (s) => s.agent !== "coordinator",
        ),
        [],
      )
      assert.deepStrictEqual(
        (yield* b["server.session"]["session.list"]({ query: {} })).sessions.filter((s) => s.agent !== "coordinator"),
        [],
      )
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            b["server.session"]["session.send"]({
              params: { id: "0e0e0000-0e0e-40e0-80e0-0e0e00000e0e" },
              payload: { message: "x" },
            }),
          ),
        ),
        "NoSuchSession",
      )
      assert.deepStrictEqual(yield* db.inbox.pendingInbox(id), [])
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "open")
      yield* a["server.session"]["session.send"]({ params: { id }, payload: { message: "from its own entry session" } })
      const user = asCli(yield* client, repo)
      yield* user["server.session"]["session.send"]({ params: { id }, payload: { message: "from the user" } })
      assert.deepStrictEqual(
        (yield* db.inbox.pendingInbox(id)).map((r) => unwrapped(r.message)),
        ["from its own entry session", "from the user"],
      )
      assert.strictEqual(
        failureTag(yield* Effect.exit(user["server.session"]["session.archive"]({ params: { id }, payload: {} }))),
        "success",
        "the user's command line archives it even while it works",
      )
    }),
  )

  test(
    "every protected method: no protocol and a session are refused; notifications need protocol only",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const repo = yield* makeRepository

      const asEntry = (root: string, paneId: string) =>
        Effect.gen(function* () {
          const raw = yield* client

          const launched = yield* asCli(raw, root)["server.session"]["session.claim"]({
            payload: {
              agent: "coordinator",
              harness: "pi",
              fresh: false,
              terminal: { id: `test/${paneId}` },
            },
          })

          return yield* asSession(raw, launched.sessionId, root)
        })

      const a = yield* asEntry(repo, "p1")

      const { id } = yield* a["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* until(
        db.session.getSession(id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )

      type Client = Effect.Success<typeof client>

      const protectedCalls = (
        c: Client,
      ): ReadonlyArray<readonly [string, Effect.Effect<unknown, { readonly _tag: string }>]> => [
        [
          "session.spawn",
          c["server.session"]["session.spawn"]({
            payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "more" },
          }),
        ],
        [
          "session.launch",
          c["server.session"]["session.launch"]({ payload: { agent: "coordinator", callerEnv: {}, focus: false } }),
        ],
        ["project.open", c["server.project"]["project.open"]({ payload: {} })],
        ["project.move", c["server.project"]["project.move"]({ payload: { from: "x" } })],
        ["session.attach", c["server.session"]["session.attach"]({ payload: { callerEnv: {} } })],
        ["session.focus", c["server.session"]["session.focus"]({})],
        ["session.list", c["server.session"]["session.list"]({ query: { stopped: true } })],
        [
          "session.link",
          c["server.session"]["session.link"]({ payload: { spec: EdgeMutual.make({ ids: [{ id }, { id }] }) } }),
        ],
        [
          "session.unlink",
          c["server.session"]["session.unlink"]({ payload: { spec: EdgeMutual.make({ ids: [{ id }, { id }] }) } }),
        ],
        ["session.get", c["server.session"]["session.get"]({ params: { id }, query: {} })],
        ["inbox.subscribe", c["server.inbox"]["inbox.subscribe"]({}).pipe(Effect.flatMap(Stream.runDrain))],
        ["inbox.take", c["server.inbox"]["inbox.take"]({})],
        ["watch.subscribe", c["server.watch"]["watch.subscribe"]({}).pipe(Effect.flatMap(Stream.runDrain))],
        ["event.subscribe", c["server.event"]["event.subscribe"]({ query: {} }).pipe(Effect.flatMap(Stream.runDrain))],
        ["session.seen", c["server.session"]["session.seen"]({ params: { id: "x" }, payload: { finished: 0 } })],
        [
          "session.claim",
          c["server.session"]["session.claim"]({
            payload: { agent: "coordinator", harness: "pi", fresh: false, terminal: { id: "test/p1" } },
          }),
        ],
        ["project.create", c["server.project"]["project.create"]({ payload: { directory: "x", from: ["y"] } })],
        ["project.info", c["server.project"]["project.info"]({})],
        ["project.search", c["server.project"]["project.search"]({ query: { query: "x" } })],
        ["session.send", c["server.session"]["session.send"]({ params: { id }, payload: { message: "x" } })],
        ["session.interrupt", c["server.session"]["session.interrupt"]({ params: { id }, query: {} })],
        ["session.stop", c["server.session"]["session.stop"]({ params: { id }, query: {} })],
        ["session.peek", c["server.session"]["session.peek"]({ params: { id }, query: {} })],
        ["session.archive", c["server.session"]["session.archive"]({ params: { id }, payload: {} })],
        ["daemon.stop", c["server.daemon"]["daemon.stop"]({ payload: { instance: "x" } })],
        ["daemon.handoff", c["server.daemon"]["daemon.handoff"]({ payload: { instance: "x", command: ["vibest"] } })],
        ["hook.ready", c["server.hook"]["hook.ready"]({ payload: {} })],
        ["agent.outdated", c["server.agent"]["agent.outdated"]({})],
        ["agent.restart", c["server.agent"]["agent.restart"]({ payload: { ids: [id] } })],
        ["hook.guard", c["server.hook"]["hook.guard"]({ params: { harness: "pi" }, payload: "{}" })],
        ["remote.hello", c["server.remote"]["remote.hello"]({ payload: { id, name: "x", callsMe: "y" } })],
        ["machine.add", c["server.machine"]["machine.add"]({ payload: { name: "m", target: "h" } })],
        ["machine.load", c["server.machine"]["machine.load"]({ query: {} })],
        ["machine.list", c["server.machine"]["machine.list"]({})],
        ["machine.remove", c["server.machine"]["machine.remove"]({ params: { name: "m" } })],
        [
          "remote.spawn",
          c["server.remote"]["remote.spawn"]({
            payload: { agent: "general", repository: "r", commit: "abc1234", prompt: "x", request: "q" },
          }),
        ],
        ["remote.outbox", c["server.remote"]["remote.outbox"]({}).pipe(Effect.flatMap(Stream.runDrain))],
        ["remote.ack", c["server.remote"]["remote.ack"]({ payload: { ids: [] } })],
        ["remote.link", c["server.remote"]["remote.link"]({ payload: { edges: [] } })],
        ["remote.unlink", c["server.remote"]["remote.unlink"]({ payload: { edges: [] } })],
        [
          "project.clone",
          c["server.project"]
            ["project.clone"]({ payload: { url: "git://x/y.git" } })
            .pipe(Effect.flatMap(Stream.runDrain)),
        ],
      ]

      const bare = yield* client

      for (const [method, call] of protectedCalls(bare))
        assert.strictEqual(
          failureTag(yield* Effect.exit(call)),
          method === "daemon.stop" || method === "daemon.handoff" ? "InvalidCaller" : "ProtocolRejected",
          method,
        )
      const w = yield* asSession(yield* client, id)

      for (const [method, call] of protectedCalls(w).filter(
        ([m]) =>
          !([] as ReadonlyArray<string>)
            .concat(ACCESS[m as keyof typeof ACCESS])
            .some((access) => access === "agent" || access === "session" || access === "open"),
      ))
        assert.strictEqual(failureTag(yield* Effect.exit(call)), "Forbidden", method)
      const entryBefore = yield* db.session.latestRoot((yield* db.session.getSession(id))!.projectId)

      const entryCalls: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        w["server.session"]["session.claim"]({
          payload: { agent: "coordinator", harness: "pi", fresh: true, terminal: { id: "test/p1" } },
        }),
        w["server.session"]["session.attach"]({ payload: { callerEnv: {} } }),
        w["server.session"]["session.focus"]({}),
        w["server.session"]["session.launch"]({ payload: { agent: "coordinator", callerEnv: {}, focus: false } }),
      ]

      for (const call of entryCalls) assert.strictEqual(failureTag(yield* Effect.exit(call)), "Forbidden")
      assert.deepStrictEqual(yield* db.session.latestRoot((yield* db.session.getSession(id))!.projectId), entryBefore)

      const child = yield* w["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "from a session" },
      })

      assert.deepStrictEqual(yield* db.session.creatorOf(child.id), { local: id })

      yield* a["server.hook"]["hook.ready"]({ payload: {} })
      yield* w["server.hook"]["hook.ready"]({ payload: { pid: 4242 } })
      assert.isDefined(yield* db.session.readyAt(id))
      assert.strictEqual((yield* db.session.getSession(id))!.process?.pid, 4242)

      yield* withHeaders(bare["server.plugin"]["plugin.list"]({}), protocolHeaders())
      yield* withHeaders(bare["server.daemon"]["daemon.concurrency"]({}), protocolHeaders())
      assert.isArray(
        yield* withHeaders(
          bare["server.runtime"]["runtime.doctor"]({ payload: { harnesses: ["pi"] } }),
          protocolHeaders(),
        ),
      )
      yield* withHeaders(bare["server.subscription"]["subscription.list"]({}), protocolHeaders())
      assert.isArray((yield* withHeaders(bare["server.agent"]["agent.list"]({ query: {} }), protocolHeaders())).agents)
      yield* withHeaders(bare["server.daemon"]["daemon.republish"]({}), protocolHeaders())
      yield* withHeaders(bare["server.hook"]["hook.executionEnd"]({ params: { harness: "pi" }, payload: "{}" }), {
        ...protocolHeaders(),
        "vibest-session-id": id,
      })
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            withHeaders(bare["server.hook"]["hook.executionEnd"]({ params: { harness: "pi" }, payload: "{}" }), {
              "vibest-protocol": "0",
              "vibest-session-id": id,
            }),
          ),
        ),
        "ProtocolRejected",
      )

      const covered = [
        ...protectedCalls(bare).map(([method]) => method),
        "daemon.ping",
        "plugin.list",
        "daemon.concurrency",
        "harness.list",
        "agent.list",
        "worktree.list",
        "runtime.doctor",
        "subscription.list",
        "daemon.republish",
        "hook.executionEnd",
        "hook.prompt",
      ]

      const allEndpoints = Object.values(VibestApi.groups).flatMap((group) => Object.keys(group.endpoints))
      assert.sameMembers(covered, allEndpoints)
    }),
  )

  test(
    "one socket does not keep a caller: sequential and concurrent requests stay on their own headers",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const repo = yield* makeRepository
      const raw = yield* client
      const cli = asCli(raw, repo)
      const spawner = yield* asEntry(raw, repo)

      const { id } = yield* spawner["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* until(
        db.session.getSession(id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )
      const session = yield* asSession(raw, id)
      yield* (yield* FakeRuntime).seedAgent("test/p1")

      const entry = (yield* cli["server.session"]["session.claim"]({
        payload: {
          agent: "coordinator",
          harness: "claude",
          fresh: false,
          terminal: { id: "test/p1" },
        },
      })).sessionId

      yield* session["server.session"]["session.send"]({ params: { id: entry }, payload: { message: "first" } })
      assert.match((yield* db.inbox.latestInbox(entry, "send"))!.message, /first/)
      const listed = (yield* cli["server.session"]["session.list"]({ query: {} })).sessions
      assert.include(
        listed.map((w) => w.id),
        id,
      )

      const [sent, got, stranger] = yield* Effect.all(
        [
          session["server.session"]["session.send"]({ params: { id: entry }, payload: { message: "second" } }),
          cli["server.session"]["session.get"]({ params: { id }, query: {} }),
          Effect.exit(
            Effect.flatMap(asSession(raw, "nope"), (s) =>
              s["server.session"]["session.send"]({ params: { id: entry }, payload: { message: "x" } }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      )

      assert.deepStrictEqual(sent, { id: entry })
      assert.strictEqual(got.id, id)
      assert.strictEqual(failureTag(stranger), "NoSuchSession")
      assert.match((yield* db.inbox.latestInbox(entry, "send"))!.message, /second/)
    }),
  )
})
