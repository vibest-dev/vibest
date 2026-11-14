import net from "node:net"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, incompatibleDaemon, protocolHeaders } from "@vibest/client/client"
import { Db } from "@vibest/core/database/db"
import { executionStateOf } from "@vibest/core/database/db-rows"
import { projectRoot } from "@vibest/core/project/create"
import { unwrapped } from "@vibest/core/replies"
import { Session } from "@vibest/core/session"
import { PRESENT_TIMEOUT } from "@vibest/core/session/entry"
import { Plugin } from "@vibest/plugin/effect"
import { MISMATCH_ACTION, sessionHeaders } from "@vibest/protocol/protocol"
import { ACCESS, VibestRpcs } from "@vibest/protocol/rpc"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import { Cause, Effect, Exit, Fiber, FileSystem, Path, Ref, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { withVibest } from "../src/client.ts"
import { VERSION } from "../src/version.ts"
import { authed, FakeRuntime, makeRepository, tempDirectory, until, writeEnd, projectOf } from "./fakes.ts"
import { served, test, client, asCli, asEntry, asSession, failureTag } from "./rpc-helpers.ts"
import { session as draftSession } from "./unit-helpers.ts"

describe("vibest.sock", () => {
  test(
    "a direct request succeeds without Hello; missing or bad caller is refused and does not become cli",
    Effect.gen(function* () {
      const raw = yield* client
      const repo = yield* makeRepository
      assert.strictEqual((yield* raw.Ping()).protocol, PROTOCOL)
      const newer = yield* Effect.exit(raw.List({}, { headers: { "vibest-protocol": String(PROTOCOL + 1) } }))
      assert.include(
        String(Exit.isFailure(newer) && Cause.pretty(newer.cause)),
        `vibestd is older (${VERSION}); run ${MISMATCH_ACTION}`,
      )
      assert.strictEqual(failureTag(yield* Effect.exit(raw.List({}, { headers: protocolHeaders() }))), "InvalidCaller")
      assert.strictEqual(
        failureTag(yield* Effect.exit(raw.List({}, { headers: { ...protocolHeaders(), "vibest-caller": "cli" } }))),
        "InvalidCaller",
      )
      assert.strictEqual(
        failureTag(yield* Effect.exit(raw.List({}, { headers: { ...cliHeaders(repo), "vibest-session-id": "abc" } }))),
        "InvalidCaller",
      )
      assert.strictEqual(
        failureTag(yield* Effect.exit(raw.List({}, { headers: { ...protocolHeaders(), "vibest-caller": "session" } }))),
        "InvalidCaller",
      )
      assert.deepStrictEqual(yield* raw.List({}, { headers: cliHeaders(repo) }), { sessions: [], machines: [] })
      assert.deepStrictEqual(yield* asCli(raw, repo).List({}), { sessions: [], machines: [] })
    }),
  )

  it.effect(
    "Daemon.Handoff to a vibest whose import check fails (a database it cannot open) refuses before the takeover, and this vibestd keeps serving",
    () =>
      Effect.gen(function* () {
        const raw = yield* client
        const c = asCli(raw, yield* makeRepository)
        const instance = (yield* raw.Ping()).instance!
        const cannotOpen = 'echo "vibest.db is not this vibest\'s schema" >&2; exit 1'
        const refused = yield* Effect.flip(
          c["Daemon.Handoff"]({ instance, command: ["sh", "-c", cannotOpen, "newer-vibest"] }),
        )
        assert.strictEqual(refused._tag, "LaunchFailed")
        assert.include(refused.message, "cannot take over this vibestd (vibest.db is not this vibest's schema)")
        assert.include(refused.message, "it keeps running")
        assert.strictEqual((yield* raw.Ping()).instance, instance)
        assert.deepStrictEqual(yield* c.List({}), { sessions: [], machines: [] })
      }).pipe(Effect.provide(served({ identity: { instance: "vibestd-before" } }))),
  )

  test(
    "a session is named by its full id or a unique prefix of 8 or more characters; the answers name the full id",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const spawner = yield* asEntry(yield* client, repo)
      const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      assert.strictEqual((yield* Effect.flip(c.Get({ id: "nothing!" })))._tag, "NoSuchSession")
      assert.deepStrictEqual(yield* c.Send({ id: id.slice(0, 12), message: "more" }), { id })
      const sharer = yield* spawner.Spawn({
        agent: "general",
        callerEnv: {},
        harness: "pi",
        prompt: "beside it",
        share: id.slice(0, 10),
      })
      assert.strictEqual(
        yield* db.session.sessionDirectory(sharer.id),
        yield* db.session.sessionDirectory(id),
        "--share takes a prefix",
      )
      const twinWithSameFirst8 = `${id.slice(0, 8)}-0000-4000-8000-000000000000`
      const row = (yield* db.session.getSession(id))!
      yield* db.session.insertSession(draftSession(twinWithSameFirst8), row.projectId)
      const ambiguous = yield* Effect.flip(c.Get({ id: id.slice(0, 8) }))
      assert.strictEqual(ambiguous._tag, "AmbiguousSession")
      assert.include(ambiguous.message, id)
      assert.include(ambiguous.message, twinWithSameFirst8)
      assert.strictEqual((yield* c.Get({ id: id.slice(0, 12) })).id, id)
    }),
  )

  test(
    "a Send or Spawn repeated with its request id queues nothing more and answers as the first; a Send repeat still answers once archived",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sql = yield* SqlClient.SqlClient
      const db = yield* Db
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const spawner = yield* asEntry(yield* client, repo)
      const first = yield* spawner.Spawn({
        agent: "general",
        callerEnv: {},
        harness: "pi",
        prompt: "do it",
        request: "spawn-1",
      })
      assert.deepStrictEqual(
        yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it", request: "spawn-1" }),
        first,
      )
      assert.deepStrictEqual(
        (yield* db.session.listSessions()).filter((w) => !w.entry).map((w) => w.id),
        [first.id],
      )
      const worktree = (yield* db.session.sessionDirectory(first.id))!
      assert.deepStrictEqual(
        yield* fs.readDirectory(path.dirname(worktree)),
        [path.basename(worktree)],
        "the repeat's reserved worktree directory went again",
      )
      yield* until(db.session.getSession(first.id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      const queued = (request: string) =>
        sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE type = 'inbox.queued'
          AND json_extract(data, '$.request') = ${request}`.pipe(Effect.map((rows) => rows[0]!.n))
      const sends = sql<{ n: number }>`SELECT count(*) AS n FROM inbox WHERE kind = 'send'`.pipe(
        Effect.map((rows) => rows[0]!.n),
      )
      assert.strictEqual(yield* queued("spawn-1"), 1)
      const sent = yield* c.Send({ id: first.id, message: "more", request: "6f1c2a3e-8b7d-4c5a-9e10-2d3f4a5b6c7d" })
      yield* c.Remove({ id: first.id })
      assert.deepStrictEqual(
        yield* c.Send({ id: first.id, message: "more", request: "6f1c2a3e-8b7d-4c5a-9e10-2d3f4a5b6c7d" }),
        sent,
      )
      assert.strictEqual(yield* sends, 1)
      assert.strictEqual(
        (yield* Effect.flip(c.Send({ id: first.id, message: "more", request: "7a2d3b4f-9c8e-4d6b-8f21-3e4a5b6c7d8e" })))
          ._tag,
        "NoSuchSession",
      )
    }),
  )

  test(
    "a Cursor afterAgentResponse stop ends the execution with its text as execution.reply and as Get's reply",
    Effect.gen(function* () {
      const raw = yield* client
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const c = asCli(raw, yield* makeRepository)
      const spawner = yield* asEntry(raw, yield* makeRepository)
      const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "cursor", prompt: "work" })
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      yield* TestClock.adjust("2 seconds")
      yield* raw.ExecutionEnd(
        {
          sessionId: id,
          harness: "cursor",
          event: JSON.stringify({ hook_event_name: "afterAgentResponse", text: "cursor said this" }),
        },
        { headers: protocolHeaders() },
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
      const reply = (yield* c.Get({ id })).reply
      assert.deepInclude(reply, { status: "completed", text: "cursor said this", failure: null })
    }),
  )

  test(
    "List cuts a task past 500 characters; Get keeps it, and latest is the newest message",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Session.Service
      const db = yield* Db
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const spawner = yield* asEntry(yield* client, repo)
      const exact = "e".repeat(500)
      const prompt = "p".repeat(501)
      const fit = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: exact })
      const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt })
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      yield* until(db.session.getSession(fit.id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      const listed = new Map((yield* c.List({})).sessions.map((w) => [w.id, w]))
      const cut = `${"p".repeat(499)}…`
      const open = { status: "working", summary: "", endedAt: null } as const
      assert.strictEqual(listed.get(fit.id)!.task, exact)
      assert.deepStrictEqual(listed.get(fit.id)!.latest, open)
      assert.strictEqual(listed.get(id)!.task, cut)
      assert.deepStrictEqual(listed.get(id)!.latest, open)
      assert.strictEqual((yield* c.Get({ id })).task, prompt)
      yield* writeEnd(id, "pi", { text: "\nfixed it\nand more" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      const after = (yield* c.List({})).sessions.find((w) => w.id === id)!.latest
      assert.strictEqual(after?.status, "completed")
      assert.strictEqual(after?.summary, "fixed it")
      assert.isNumber(after?.endedAt)
      yield* c.Send({ id, message: "follow up" })
      assert.strictEqual(
        (yield* c.List({})).sessions.find((w) => w.id === id)!.task,
        cut,
        "a follow-up is not the task",
      )
      assert.strictEqual((yield* c.Get({ id })).task, prompt)
    }),
  )

  test(
    "Peek returns the runtime's terminal text and asks for at most 500 lines; an exited session has no terminal to read",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const raw = yield* client
      const c = asCli(raw, repo)
      const spawner = yield* asEntry(raw, repo)
      const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      assert.deepStrictEqual(yield* c.Peek({ id }), { text: "pane tail" })
      yield* c.Peek({ id, lines: 100_000 })
      assert.deepInclude((yield* herdr.callsTo("read")).at(-1), { lines: 500 })
      yield* db.session.endProcess(id, "exited")
      assert.strictEqual(failureTag(yield* Effect.exit(c.Peek({ id }))), "NoSuchSession")
    }),
  )

  test(
    "Project.EntrySession answers and frees the project when the runtime's present never returns",
    Effect.gen(function* () {
      const runtime = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const held = yield* runtime.hold("present")
      const launch = yield* c["Project.EntrySession"]({
        agent: "coordinator",
        harness: "claude",
        fresh: false,
        terminal: "test/p1",
      }).pipe(Effect.forkChild)
      yield* held.reached
      yield* TestClock.adjust(PRESENT_TIMEOUT)
      const saved = yield* Fiber.join(launch)
      assert.isString(saved.sessionId)
      const again = yield* c["Project.EntrySession"]({
        agent: "coordinator",
        harness: "claude",
        fresh: false,
        terminal: "test/p1",
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(PRESENT_TIMEOUT)
      assert.strictEqual((yield* Fiber.join(again)).sessionId, saved.sessionId)
    }),
  )

  test(
    "a session sends only as itself; an unknown session is refused",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const raw = yield* client
      const c = asCli(raw, repo)
      const spawner = yield* asEntry(raw, repo)
      const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      const launch = yield* c["Project.EntrySession"]({
        agent: "coordinator",
        harness: "claude",
        fresh: false,
        terminal: "test/p1",
      })
      yield* raw["Session.Ready"](
        { id: launch.sessionId, conversation: { harness: "claude", id: "s1" } },
        {
          headers: sessionHeaders({
            sessionId: launch.sessionId,
            projectId: launch.projectId,
            pluginVersion: "1.2.3",
          }),
        },
      )

      const bare = yield* client
      yield* bare.ExecutionEnd(
        { sessionId: id, harness: "pi", event: "{}" },
        { headers: sessionHeaders({ sessionId: id, pluginVersion: "1.2.3" }) },
      )
      assert.deepStrictEqual(
        (yield* db.session.getSession(id))?.process?.integration,
        { version: "1.2.3", protocol: PROTOCOL },
        "an integration's version is recorded even when its protocol is refused",
      )
      const old = { ...sessionHeaders({ sessionId: id, pluginVersion: "1.0.0" }), "vibest-protocol": "1" }
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(bare.ExecutionEnd({ sessionId: id, harness: "pi", event: "{}" }, { headers: old })),
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
            bare.Send({ id: launch.sessionId, message: "x" }, { headers: sessionHeaders({ sessionId: "nope" }) }),
          ),
        ),
        "NoSuchSession",
      )
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            bare.Send({ id: launch.sessionId, message: "x" }, { headers: sessionHeaders({ sessionId: id }) }),
          ),
        ),
        "InvalidCaller",
        "a known session without its project id is refused, as over HTTP",
      )

      const projectId = String((yield* db.session.sessionIdentity(id))!.projectId)
      const as = (harness: string, harnessSessionId: string) =>
        authed(raw, sessionHeaders({ sessionId: id, projectId, harness, harnessSessionId }))
      yield* as("pi", "pi-1").Send({ id: launch.sessionId, message: "one" })
      assert.strictEqual((yield* db.session.getSession(id))!.process?.conversation ?? null, "pi-1")
      yield* as("claude", "other").Send({ id: launch.sessionId, message: "two" })
      assert.strictEqual((yield* db.session.getSession(id))!.process?.conversation ?? null, "pi-1")
      yield* raw.ExecutionEnd(
        { sessionId: id, harness: "pi", event: "{}" },
        { headers: sessionHeaders({ sessionId: id, projectId, harness: "pi", harnessSessionId: "pi-2" }) },
      )
      assert.strictEqual((yield* db.session.getSession(id))!.process?.conversation ?? null, "pi-2")
      const w = yield* asSession(yield* client, id)
      yield* w.Send({ id: launch.sessionId, message: "half way" })
      const sent = yield* db.inbox.latestInbox(launch.sessionId, "send")
      assert.match(
        sent!.message,
        /^<agent-message>\n<agent-id>[a-f0-9-]{36}<\/agent-id>\n<title>[^<]*<\/title>\n<message>\nhalf way\n<\/message>\n<\/agent-message>$/,
      )
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "open")
      assert.deepStrictEqual(yield* c.Send({ id: launch.sessionId, message: "from the user" }), {
        id: launch.sessionId,
      })
      const fromUser = yield* db.inbox.latestInbox(launch.sessionId, "send")
      assert.deepInclude(fromUser, { message: "from the user", sender: null })
      yield* raw["Session.Ready"](
        { id: launch.sessionId, conversation: { harness: "claude", id: "stale" } },
        {
          headers: sessionHeaders({
            sessionId: launch.sessionId,
            projectId: launch.projectId,
            pluginVersion: "1.2.3",
          }),
        },
      )
      yield* raw["Session.Ready"](
        { id: launch.sessionId, conversation: { harness: "claude", id: "s2" } },
        {
          headers: sessionHeaders({
            sessionId: launch.sessionId,
            projectId: launch.projectId,
            pluginVersion: "1.2.3",
          }),
        },
      )
      yield* raw["Session.Ready"](
        { id: launch.sessionId, conversation: { harness: "pi", id: "late-pi-report" } },
        {
          headers: sessionHeaders({
            sessionId: launch.sessionId,
            projectId: launch.projectId,
            pluginVersion: "1.2.3",
          }),
        },
      )
      assert.strictEqual(
        (yield* c["Project.EntrySession"]({
          agent: "coordinator",
          harness: "claude",
          fresh: false,
          terminal: "test/p1",
        })).harnessSessionId,
        "s2",
        "a conversation reported by another harness than the session's is ignored",
      )
      const worker = (yield* db.session.getSession(id))!
      yield* raw["Session.Ready"](
        { id, conversation: { harness: "pi", id: "worker-report" } },
        { headers: sessionHeaders({ sessionId: id, projectId: worker.projectId, pluginVersion: "1.2.3" }) },
      )
      assert.notStrictEqual(
        (yield* db.session.getSession(id))!.process?.conversation ?? null,
        "worker-report",
        "a conversation reported by a session that is not its project's entry is ignored",
      )
    }),
  )

  test(
    "an entry session manages only the sessions it spawned, and another project's reads them but does not list them; the command line (the user) manages any",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const asEntry = (root: string, paneId: string) =>
        Effect.gen(function* () {
          const raw = yield* client
          const launched = yield* asCli(raw, root)["Project.EntrySession"]({
            agent: "coordinator",
            harness: "pi",
            fresh: false,
            terminal: `test/${paneId}`,
          })
          return yield* asSession(raw, launched.sessionId, root)
        })
      const a = yield* asEntry(repo, "p1")
      const b = yield* asEntry(yield* makeRepository, "p2")
      const { id } = yield* a.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      const others: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        b.Send({ id, message: "x" }),
        b.Interrupt({ id }),
        b.Peek({ id }),
        b.Remove({ id }),
      ]
      for (const call of others) {
        const exit = yield* Effect.exit(call)
        assert.strictEqual(failureTag(exit), "Forbidden")
        assert.match(
          String(Exit.isFailure(exit) && Cause.pretty(exit.cause)),
          /belongs to another entry session's project|was not started by this session/,
        )
      }
      assert.deepInclude(yield* b.Get({ id }), { id, agent: "general" })
      assert.strictEqual((yield* b.List({})).sessions[0]?.agent, "coordinator")
      assert.deepStrictEqual(
        (yield* b.List({ stopped: true })).sessions.filter((s) => s.agent !== "coordinator"),
        [],
      )
      assert.deepStrictEqual(
        (yield* b.List({})).sessions.filter((s) => s.agent !== "coordinator"),
        [],
      )
      assert.strictEqual(
        failureTag(yield* Effect.exit(b.Send({ id: "0e0e0000-0e0e-40e0-80e0-0e0e00000e0e", message: "x" }))),
        "NoSuchSession",
      )
      assert.deepStrictEqual(yield* db.inbox.pendingInbox(id), [])
      assert.strictEqual(executionStateOf((yield* db.session.getSession(id))!), "open")
      yield* a.Send({ id, message: "from its own entry session" })
      const user = asCli(yield* client, repo)
      yield* user.Send({ id, message: "from the user" })
      assert.deepStrictEqual(
        (yield* db.inbox.pendingInbox(id)).map((r) => unwrapped(r.message)),
        ["from its own entry session", "from the user"],
      )
      assert.strictEqual(
        failureTag(yield* Effect.exit(user.Remove({ id }))),
        "success",
        "the user's command line archives it even while it works",
      )
    }),
  )

  test(
    "every protected method: no protocol and a session are refused; notifications need protocol only",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const asEntry = (root: string, paneId: string) =>
        Effect.gen(function* () {
          const raw = yield* client
          const launched = yield* asCli(raw, root)["Project.EntrySession"]({
            agent: "coordinator",
            harness: "pi",
            fresh: false,
            terminal: `test/${paneId}`,
          })
          return yield* asSession(raw, launched.sessionId, root)
        })
      const a = yield* asEntry(repo, "p1")
      const { id } = yield* a.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      type Client = Effect.Success<typeof client>
      const protectedCalls = (
        c: Client,
      ): ReadonlyArray<readonly [string, Effect.Effect<unknown, { readonly _tag: string }>]> => [
        ["Spawn", c.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "more" })],
        ["Launch", c.Launch({ agent: "coordinator", callerEnv: {}, argv: [], focus: false })],
        ["Project.StartEntry", c["Project.StartEntry"]({ agent: "general", runtime: "herdr" })],
        ["Project.Open", c["Project.Open"]({})],
        ["Project.EntryPlace", c["Project.EntryPlace"]({ callerEnv: {} })],
        ["List", c.List({ stopped: true })],
        ["Get", c.Get({ id })],
        ["Inbox.Subscribe", Stream.runDrain(c["Inbox.Subscribe"](undefined))],
        ["Inbox.Take", c["Inbox.Take"](undefined)],
        ["Watch", Stream.runDrain(c.Watch(undefined))],
        ["Events", Stream.runDrain(c.Events({}))],
        ["Session.Seen", c["Session.Seen"]({ id: "x", finished: 0 })],
        [
          "Project.EntrySession",
          c["Project.EntrySession"]({ agent: "coordinator", harness: "pi", fresh: false, terminal: "test/p1" }),
        ],
        ["Project.Create", c["Project.Create"]({ directory: "x", from: ["y"] })],
        ["Project.FocusEntry", c["Project.FocusEntry"]({})],
        ["Project.RunningEntry", c["Project.RunningEntry"]({ terminal: "test/p1" })],
        ["Project.StopEntry", c["Project.StopEntry"]({ runtime: "herdr", address: "{}" })],
        ["Project.Info", c["Project.Info"]()],
        ["Project.Search", c["Project.Search"]({ query: "x" })],
        ["Send", c.Send({ id, message: "x" })],
        ["Interrupt", c.Interrupt({ id })],
        ["Peek", c.Peek({ id })],
        ["Remove", c.Remove({ id })],
        ["Daemon.Stop", c["Daemon.Stop"]({ instance: "x" })],
        ["Daemon.Handoff", c["Daemon.Handoff"]({ instance: "x", command: ["vibest"] })],
        ["Session.Ready", c["Session.Ready"]({ id: "07e40000-07e4-407e-807e-07e4000007e4" })],
        ["Agents.Outdated", c["Agents.Outdated"]()],
        ["Agents.Restart", c["Agents.Restart"]({ ids: [id] })],
        ["Integration.Guard", c["Integration.Guard"]({ harness: "pi", input: "{}" })],
        ["Peer.Hello", c["Peer.Hello"]({ id, name: "x", callsMe: "y" })],
        ["Machine.Add", c["Machine.Add"]({ name: "m", target: "h" })],
        ["Machine.List", c["Machine.List"]()],
        ["Machine.Remove", c["Machine.Remove"]({ name: "m" })],
        [
          "Peer.Spawn",
          c["Peer.Spawn"]({ agent: "general", repository: "r", commit: "abc1234", prompt: "x", request: "q" }),
        ],
        ["Peer.Outbox", Stream.runDrain(c["Peer.Outbox"](undefined))],
        ["Peer.Ack", c["Peer.Ack"]({ ids: [] })],
      ]
      const bare = yield* client
      for (const [method, call] of protectedCalls(bare))
        assert.strictEqual(failureTag(yield* Effect.exit(call)), "ProtocolRejected", method)
      const w = yield* asSession(yield* client, id)
      for (const [method, call] of protectedCalls(w).filter(
        ([m]) =>
          !([] as ReadonlyArray<string>)
            .concat(ACCESS[m as keyof typeof ACCESS])
            .some((access) => access === "agent" || access === "session" || access === "open"),
      ))
        assert.strictEqual(failureTag(yield* Effect.exit(call)), "Forbidden", method)
      const entryBefore = yield* db.session.entryOf((yield* db.session.getSession(id))!.projectId)
      const entryCalls: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        w["Project.StopEntry"]({ runtime: "herdr", address: "{}" }),
        w["Project.EntrySession"]({ agent: "coordinator", harness: "pi", fresh: true, terminal: "test/p1" }),
        w["Project.StartEntry"]({ agent: "coordinator", runtime: "herdr" }),
        w.Launch({ agent: "coordinator", callerEnv: {}, argv: [], focus: false }),
      ]
      for (const call of entryCalls) assert.strictEqual(failureTag(yield* Effect.exit(call)), "Forbidden")
      assert.deepStrictEqual(yield* db.session.entryOf((yield* db.session.getSession(id))!.projectId), entryBefore)
      const child = yield* w.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "from a session" })
      assert.deepStrictEqual(yield* db.session.creatorOf(child.id), { local: id })

      yield* a["Session.Ready"]({ id: (yield* db.session.entryOf((yield* db.session.getSession(id))!.projectId))!.id })
      yield* w["Session.Ready"]({ id, pid: 4242 })
      assert.isDefined(yield* db.session.readyAt(id))
      assert.strictEqual((yield* db.session.getSession(id))!.process?.pid, 4242)

      yield* bare.Plugins(undefined, { headers: protocolHeaders() })
      assert.isArray(yield* bare["Runtimes.Doctor"]({ harnesses: ["pi"] }, { headers: protocolHeaders() }))
      yield* bare.Subscriptions(undefined, { headers: protocolHeaders() })
      yield* bare.Republish(undefined, { headers: protocolHeaders() })
      yield* bare.ExecutionEnd({ sessionId: id, harness: "pi", event: "{}" }, { headers: protocolHeaders() })
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            bare.ExecutionEnd({ sessionId: id, harness: "pi", event: "{}" }, { headers: { "vibest-protocol": "0" } }),
          ),
        ),
        "ProtocolRejected",
      )

      const covered = [
        ...protectedCalls(bare).map(([method]) => method),
        "Ping",
        "Plugins",
        "Harnesses.List",
        "Runtimes.Doctor",
        "Subscriptions",
        "Republish",
        "ExecutionEnd",
        "Prompt",
      ]
      assert.sameMembers(covered, [...VibestRpcs.requests.keys()])
    }),
  )

  test(
    "one socket does not keep a caller: sequential and concurrent requests stay on their own headers",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const raw = yield* client
      const cli = asCli(raw, repo)
      const spawner = yield* asEntry(raw, repo)
      const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      const session = yield* asSession(raw, id)
      const entry = (yield* cli["Project.EntrySession"]({
        agent: "coordinator",
        harness: "claude",
        fresh: false,
        terminal: "test/p1",
      })).sessionId
      yield* session.Send({ id: entry, message: "first" })
      assert.match((yield* db.inbox.latestInbox(entry, "send"))!.message, /first/)
      const listed = (yield* cli.List({})).sessions
      assert.include(
        listed.map((w) => w.id),
        id,
      )
      const [sent, got, stranger] = yield* Effect.all(
        [
          session.Send({ id: entry, message: "second" }),
          cli.Get({ id }),
          Effect.exit(Effect.flatMap(asSession(raw, "nope"), (s) => s.Send({ id: entry, message: "x" }))),
        ],
        { concurrency: "unbounded" },
      )
      assert.deepStrictEqual(sent, { id: entry })
      assert.strictEqual(got.id, id)
      assert.strictEqual(failureTag(stranger), "NoSuchSession")
      assert.match((yield* db.inbox.latestInbox(entry, "send"))!.message, /second/)
    }),
  )

  test(
    "a legacy Ping fails closed; a different package version does not",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const serve = (result: object) =>
        Effect.gen(function* () {
          const home = yield* tempDirectory("vibest-ping-")
          const layout = yield* Layout.make(home)
          const server = yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<net.Server>((resolve) => {
                  const listening = net.createServer((sock) => {
                    let buf = ""
                    sock.on("data", (chunk) => {
                      buf += chunk.toString()
                      const nl = buf.indexOf("\n")
                      if (nl < 0) return
                      const req = JSON.parse(buf.slice(0, nl)) as { id?: string; method?: string }
                      if (req.method === "Ping")
                        sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n")
                    })
                  })
                  listening.listen(layout.socket, () => resolve(listening))
                }),
            ),
            (listening) => Effect.sync(() => listening.close()),
          )
          return { layout, server }
        })
      const legacy = yield* serve({ version: "0.0.0", runtimes: [] })
      const refused = yield* Effect.exit(
        withVibest({ _tag: "cli", repositoryRoot: repo }, () => Effect.die("must not call"), { start: false }).pipe(
          Effect.provideService(Layout, legacy.layout),
        ),
      )
      assert.strictEqual(failureTag(refused), "IncompatibleDaemon")
      assert.match(String(Exit.isFailure(refused) && Cause.pretty(refused.cause)), new RegExp(`protocol ${PROTOCOL}`))
      assert.match(String(Exit.isFailure(refused) && Cause.pretty(refused.cause)), /vibest daemon/)
      const said = String(Exit.isFailure(refused) && Cause.pretty(refused.cause))
      assert.include(
        said,
        "vibestd 0.0.0 (pid unknown, command unknown)",
        "a legacy pid is never guessed from vibestd.pid",
      )
      assert.include(said, `vibest ${VERSION} (`)
      assert.include(said, "kill -TERM <pid>")
      assert.include(said, "vibestd is older (0.0.0); run vibest update")
      const olderBuildWithoutRuntimes = yield* serve({ protocol: 2, version: VERSION, runtimeSessions: [] })
      const olderRefused = yield* Effect.exit(
        withVibest({ _tag: "cli", repositoryRoot: repo }, () => Effect.die("must not call"), { start: false }).pipe(
          Effect.provideService(Layout, olderBuildWithoutRuntimes.layout),
        ),
      )
      assert.strictEqual(failureTag(olderRefused), "IncompatibleDaemon")
      const newer = yield* serve({ protocol: PROTOCOL, version: "9.9.9", runtimes: [] })
      assert.strictEqual(
        yield* withVibest({ _tag: "cli", repositoryRoot: repo }, () => Effect.succeed("ok"), { start: false }).pipe(
          Effect.provideService(Layout, newer.layout),
        ),
        "ok",
      )
      assert.strictEqual(
        incompatibleDaemon(
          newer.layout.socket,
          { protocol: PROTOCOL, version: "9.9.9", runtimes: [] },
          { version: VERSION, command: ["vibest"] },
        ),
        undefined,
      )
      const olderClient = incompatibleDaemon(
        newer.layout.socket,
        { protocol: PROTOCOL + 1, version: "9.9.9", runtimes: [] },
        { version: VERSION, command: ["vibest"] },
      )?.message
      assert.include(
        olderClient,
        `older than vibestd 9.9.9 (pid unknown, command unknown) on ${newer.layout.socket}, which speaks protocol ${PROTOCOL + 1}. Run vibest update (again, if this was vibest update)`,
      )
      assert.include(olderClient, `To keep vibest ${VERSION} instead`)
      assert.include(olderClient, "kill -TERM <pid>")
      const needs = { capability: "harnesses", method: "Harnesses.List" }
      const lacking = yield* serve({ protocol: PROTOCOL, version: "0.9.0", runtimes: [], capabilities: {} })
      const lackRefused = yield* Effect.exit(
        withVibest({ _tag: "cli", repositoryRoot: repo }, () => Effect.die("must not call"), {
          start: false,
          needs,
        }).pipe(Effect.provideService(Layout, lacking.layout)),
      )
      assert.strictEqual(failureTag(lackRefused), "IncompatibleDaemon")
      const lackSaid = String(Exit.isFailure(lackRefused) && Cause.pretty(lackRefused.cause))
      assert.include(lackSaid, "vibestd is older (0.9.0); run vibest update")
      assert.include(lackSaid, "has no Harnesses.List")
      assert.include(lackSaid, "vibest daemon restart")
      assert.strictEqual(
        yield* withVibest({ _tag: "cli", repositoryRoot: repo }, () => Effect.succeed("no need"), {
          start: false,
        }).pipe(Effect.provideService(Layout, lacking.layout)),
        "no need",
      )
      const having = yield* serve({
        protocol: PROTOCOL,
        version: "0.9.0",
        runtimes: [],
        capabilities: { harnesses: true },
      })
      assert.strictEqual(
        yield* withVibest({ _tag: "cli", repositoryRoot: repo }, () => Effect.succeed("ok"), {
          start: false,
          needs,
        }).pipe(Effect.provideService(Layout, having.layout)),
        "ok",
      )
    }),
  )

  const seenDirectory = { project: "" }
  test(
    "Project.StartEntry schedules with the project directory, not its key; with no harness it fails until an entry session exists, then takes its harness",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const first = yield* Effect.flip(c["Project.StartEntry"]({ agent: "general", runtime: "herdr" }))
      assert.strictEqual(first._tag, "LaunchFailed")
      assert.match(first.message, /no harness to inherit/)
      assert.strictEqual(
        (yield* c["Project.StartEntry"]({ agent: "general", runtime: "herdr", harness: "pi" })).harness,
        "pi",
      )
      assert.strictEqual(seenDirectory.project, (yield* projectRoot(repo)).root)
      assert.notStrictEqual(seenDirectory.project, yield* projectOf(repo))
      yield* c["Project.EntrySession"]({ agent: "coordinator", harness: "claude", fresh: false, terminal: "test/p1" })
      assert.strictEqual((yield* c["Project.StartEntry"]({ agent: "general", runtime: "herdr" })).harness, "claude")
    }),
    {
      plugins: [
        Plugin.define({
          id: "see",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                seenDirectory.project = e.project
              }),
            ),
        }),
      ],
    },
  )

  test(
    "List shows the entry session's live status from its pane, not a stored unknown",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const pane = "w1:coord"
      yield* herdr.seedAgent(pane)
      yield* c["Project.EntrySession"]({ agent: "coordinator", harness: "pi", fresh: false, terminal: pane })
      yield* herdr.updateAgent(pane, (a) => ({ ...a, status: "working" }))
      yield* until(c.List({}), (list) => list.sessions[0]?.status === "working")
      assert.deepInclude((yield* c.List({})).sessions[0], { agent: "coordinator", status: "working" })
      yield* herdr.updateAgent(pane, (a) => ({ ...a, status: "idle" }))
      yield* until(c.List({}), (list) => list.sessions[0]?.status === "idle")
      assert.deepInclude((yield* c.List({})).sessions[0], { agent: "coordinator", status: "idle" })
    }),
    { statusEvents: true },
  )

  test(
    "Remove names the resolved session when the runtime is unreachable, not the prefix typed",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const spawner = yield* asEntry(yield* client, repo)
      const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
      yield* Ref.set(herdr.reachable, false)
      const failed = yield* Effect.flip(c.Remove({ id: id.slice(0, 8) }))
      assert.strictEqual(failed._tag, "RuntimeUnreachable")
      assert.strictEqual("session" in failed ? failed.session : failed._tag, id)
    }),
  )

  test(
    "archive refuses an entry session and names its project",
    Effect.gen(function* () {
      const db = yield* Db
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* db.session.startEntry(
        projectId,
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "test/main" },
        },
        { agent: "coordinator" },
      )
      const entry = (yield* db.session.entryOf(projectId))!
      const failed = yield* Effect.flip(asCli(yield* client, repo).Remove({ id: entry.id }))
      assert.strictEqual(failed._tag, "NoSuchSession")
      assert.strictEqual(
        "message" in failed ? failed.message : "",
        `${entry.id} is the session you opened in a terminal (project ${path.basename(repo)}); stop it in that terminal.`,
      )
    }),
  )

  test(
    "FocusEntry reports a runtime that cannot focus",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* db.session.startEntry(
        projectId,
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "test/main" },
        },
        { agent: "coordinator" },
      )
      yield* herdr.seedAgent("test/main")
      const focused = yield* asCli(yield* client, repo)["Project.FocusEntry"]({})
      assert.strictEqual(focused?.focused, false)
      assert.strictEqual((yield* herdr.callsTo("focus")).length, 0)
    }),
    { noFocus: true },
  )

  test(
    "--new with a missing harness does not archive the current entry session",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* db.session.startEntry(
        projectId,
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "test/main" },
        },
        { agent: "coordinator" },
      )
      const before = (yield* db.session.entryOf(projectId))!.id
      const failed = yield* Effect.flip(
        asCli(yield* client, repo).Launch({
          agent: "coordinator",
          callerEnv: {},
          argv: ["/bin/vibest", "--harness", "cursor", "--new"],
          focus: false,
          runtime: "herdr",
        }),
      )
      assert.ok(failed._tag === "LaunchFailed" || failed._tag === "AgentRefused", failed._tag)
      assert.strictEqual((yield* db.session.entryOf(projectId))!.id, before)
    }),
    { missingBinary: ["cursor"] },
  )
})
