import net from "node:net"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect, incompatibleDaemon, protocolHeaders, withVibest } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import { projectRoot } from "@vibest/core/project-create"
import { Sessions } from "@vibest/core/sessions"
import { Plugin } from "@vibest/plugin"
import { MISMATCH_ACTION, PROTOCOL, sessionHeaders } from "@vibest/protocol/protocol"
import { VibestRpcs, VERSION } from "@vibest/protocol/rpc"
import * as Server from "@vibest/server/server"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Path, Ref, type Scope, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import {
  authed,
  FakeRuntime,
  makeRepository,
  settled,
  sh,
  tempDirectory,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  writeResult,
  projectOf,
  systemPromptFile,
} from "./fakes.ts"

const served = (options?: TestOptions) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer(options)),
  )

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>,
  options?: TestOptions,
  timeout?: number,
) => it.effect(name, () => program.pipe(Effect.provide(served(options))), timeout)

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))
const asCli = (raw: Effect.Success<typeof client>, repositoryRoot: string) => authed(raw, cliHeaders(repositoryRoot))
const asSession = (raw: Effect.Success<typeof client>, sessionId: string, repositoryRoot?: string) =>
  Effect.gen(function* () {
    const row = yield* (yield* Db).sessionIdentity(sessionId)
    return authed(raw, sessionHeaders({ sessionId, repositoryRoot, projectId: row && String(row.projectId) }))
  })

const failureTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.match(Cause.findErrorOption(exit.cause), { onNone: () => "defect", onSome: (e) => e._tag })
    : "success"

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
      assert.deepStrictEqual(yield* raw.List({}, { headers: cliHeaders(repo) }), [])
      assert.deepStrictEqual(yield* asCli(raw, repo).List({}), [])
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
        assert.deepStrictEqual(yield* c.List({}), [])
      }).pipe(Effect.provide(served()), Effect.provideService(Server.Identity, { instance: "vibestd-before" })),
  )

  test(
    "a session is named by its full id or a unique prefix of 8 or more characters; the answers name the full id",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const { id } = yield* c.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      assert.strictEqual((yield* Effect.flip(c.Get({ id: "nothing!" })))._tag, "NoSuchSession")
      assert.deepStrictEqual(yield* c.Send({ id: id.slice(0, 12), message: "more" }), { id })
      const peer = yield* c.Spawn({ harness: "pi", prompt: "beside it", peer: id.slice(0, 10) })
      assert.strictEqual(yield* db.sessionDirectory(peer.id), yield* db.sessionDirectory(id), "--peer takes a prefix")
      const twinWithSameFirst8 = `${id.slice(0, 8)}-0000-4000-8000-000000000000`
      const row = (yield* db.getSession(id))!
      yield* db.insertSession({ ...row, id: twinWithSameFirst8 }, row.projectId)
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
      const first = yield* c.Spawn({ harness: "pi", prompt: "do it", request: "spawn-1" })
      assert.deepStrictEqual(yield* c.Spawn({ harness: "pi", prompt: "do it", request: "spawn-1" }), first)
      assert.deepStrictEqual(
        (yield* db.listSessions()).map((w) => w.id),
        [first.id],
      )
      const worktree = (yield* db.sessionDirectory(first.id))!
      assert.deepStrictEqual(
        yield* fs.readDirectory(path.dirname(worktree)),
        [path.basename(worktree)],
        "the repeat's reserved worktree directory went again",
      )
      yield* until(db.getSession(first.id), (w) => w?.turnState === "open")
      const queued = (request: string) =>
        sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE type = 'inbox.queued'
          AND json_extract(data, '$.request') = ${request}`.pipe(Effect.map((rows) => rows[0]!.n))
      const sends = sql<{ n: number }>`SELECT count(*) AS n FROM inbox WHERE kind = 'send'`.pipe(
        Effect.map((rows) => rows[0]!.n),
      )
      assert.strictEqual(yield* queued("spawn-1"), 1)
      const sent = yield* c.Send({ id: first.id, message: "more", request: "send-1" })
      yield* c.Remove({ id: first.id })
      assert.deepStrictEqual(yield* c.Send({ id: first.id, message: "more", request: "send-1" }), sent)
      assert.strictEqual(yield* sends, 1)
      assert.strictEqual(
        (yield* Effect.flip(c.Send({ id: first.id, message: "more", request: "send-2" })))._tag,
        "NoSuchSession",
      )
    }),
  )

  test(
    "List cuts a task past 500 characters; Get keeps it, and latest is the newest message",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const exact = "e".repeat(500)
      const prompt = "p".repeat(501)
      const fit = yield* c.Spawn({ harness: "pi", prompt: exact })
      const { id } = yield* c.Spawn({ harness: "pi", prompt })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      yield* until(db.getSession(fit.id), (w) => w?.turnState === "open")
      const listed = new Map((yield* c.List({})).map((w) => [w.id, w]))
      const cut = `${"p".repeat(499)}…`
      const open = { status: "working", summary: "", endedAt: null } as const
      assert.strictEqual(listed.get(fit.id)!.task, exact)
      assert.deepStrictEqual(listed.get(fit.id)!.latest, open)
      assert.strictEqual(listed.get(id)!.task, cut)
      assert.deepStrictEqual(listed.get(id)!.latest, open)
      assert.strictEqual((yield* c.Get({ id })).task, prompt)
      yield* writeResult(id, "pi", { text: "\nfixed it\nand more" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const after = (yield* c.List({})).find((w) => w.id === id)!.latest
      assert.strictEqual(after?.status, "completed")
      assert.strictEqual(after?.summary, "fixed it")
      assert.isNumber(after?.endedAt)
      yield* c.Send({ id, message: "follow up" })
      assert.strictEqual((yield* c.List({})).find((w) => w.id === id)!.task, cut, "a follow-up is not the task")
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
      const { id } = yield* c.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      assert.deepStrictEqual(yield* c.Peek({ id }), { text: "pane tail" })
      yield* c.Peek({ id, lines: 100_000 })
      assert.deepInclude((yield* herdr.callsTo("read")).at(-1), { lines: 500 })
      yield* db.updateSession(id, { exitedAt: 1 })
      assert.strictEqual(failureTag(yield* Effect.exit(c.Peek({ id }))), "NoSuchSession")
    }),
  )

  test(
    "Project.CoordinatorSession answers and frees the project when the runtime's present never returns",
    Effect.gen(function* () {
      const runtime = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const held = yield* runtime.hold("present")
      const launch = yield* c["Project.CoordinatorSession"]({
        harness: "claude",
        fresh: false,
        terminal: "test/p1",
      }).pipe(Effect.forkChild)
      yield* held.reached
      yield* TestClock.adjust(Server.PRESENT_TIMEOUT)
      const saved = yield* Fiber.join(launch)
      assert.isString(saved.sessionId)
      const again = yield* c["Project.CoordinatorSession"]({
        harness: "claude",
        fresh: false,
        terminal: "test/p1",
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(Server.PRESENT_TIMEOUT)
      assert.strictEqual((yield* Fiber.join(again)).sessionId, saved.sessionId)
    }),
  )

  test(
    "a session reports only as itself; an unknown session is refused; a coordinator cannot report",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const raw = yield* client
      const c = asCli(raw, repo)
      const { id } = yield* c.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      const launch = yield* c["Project.CoordinatorSession"]({ harness: "claude", fresh: false, terminal: "test/p1" })
      yield* raw.CoordinatorSessionReady(
        { sessionId: launch.sessionId, harness: "claude", harnessSessionId: "s1" },
        { headers: protocolHeaders() },
      )

      const bare = yield* client
      yield* bare.TurnEnd(
        { sessionId: id, harness: "pi", event: "{}" },
        { headers: sessionHeaders({ sessionId: id, pluginVersion: "1.2.3" }) },
      )
      assert.deepStrictEqual(
        (yield* db.getSession(id))?.metadata.integration,
        { version: "1.2.3", protocol: PROTOCOL },
        "an integration's version is recorded even when its protocol is refused",
      )
      const old = { ...sessionHeaders({ sessionId: id, pluginVersion: "1.0.0" }), "vibest-protocol": "1" }
      assert.strictEqual(
        failureTag(yield* Effect.exit(bare.TurnEnd({ sessionId: id, harness: "pi", event: "{}" }, { headers: old }))),
        "ProtocolRejected",
      )
      assert.deepStrictEqual((yield* db.getSession(id))?.metadata.integration, { version: "1.0.0", protocol: 1 })

      assert.strictEqual(
        failureTag(
          yield* Effect.exit(bare.Report({ message: "x" }, { headers: sessionHeaders({ sessionId: "nope" }) })),
        ),
        "NoSuchSession",
      )
      assert.strictEqual(
        failureTag(yield* Effect.exit(bare.Report({ message: "x" }, { headers: sessionHeaders({ sessionId: id }) }))),
        "InvalidCaller",
        "a known session without its project id is refused, as over HTTP",
      )

      const projectId = String((yield* db.sessionIdentity(id))!.projectId)
      const as = (harness: string, harnessSessionId: string) =>
        authed(raw, sessionHeaders({ sessionId: id, projectId, harness, harnessSessionId }))
      yield* as("pi", "pi-1").Report({ message: "one" })
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "pi-1")
      yield* as("claude", "other").Report({ message: "two" })
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "pi-1")
      yield* raw.TurnEnd(
        { sessionId: id, harness: "pi", event: "{}" },
        { headers: sessionHeaders({ sessionId: id, projectId, harness: "pi", harnessSessionId: "pi-2" }) },
      )
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "pi-2")
      const w = yield* asSession(yield* client, id)
      yield* w.Report({ message: "half way" })
      const reported = yield* db.latestInbox(id, "report")
      assert.match(
        reported!.message,
        /^<agent-message>\n<agent-id>[a-f0-9-]{36}<\/agent-id>\n<summary>Agent "do it" sent a message before finishing<\/summary>\n<message>\nhalf way\n<\/message>\n<\/agent-message>$/,
      )
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      yield* raw.CoordinatorSessionReady(
        { sessionId: launch.sessionId, harness: "claude", harnessSessionId: "stale" },
        { headers: protocolHeaders() },
      )
      yield* raw.CoordinatorSessionReady(
        { sessionId: launch.sessionId, harness: "claude", harnessSessionId: "s2" },
        { headers: protocolHeaders() },
      )
      assert.strictEqual(
        (yield* c["Project.CoordinatorSession"]({ harness: "claude", fresh: false, terminal: "test/p1" }))
          .harnessSessionId,
        "s2",
      )

      assert.strictEqual(failureTag(yield* Effect.exit(c.Report({ message: "x" }))), "Forbidden")
      const coord = yield* asSession(raw, launch.sessionId, repo)
      assert.strictEqual(failureTag(yield* Effect.exit(coord.Report({ message: "x" }))), "Forbidden")
    }),
  )

  test(
    "a Coordinator manages only the sessions it spawned, and another project's reads them but does not list them; the command line (the user) manages any",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const asCoordinator = (root: string, paneId: string) =>
        Effect.gen(function* () {
          const raw = yield* client
          const launched = yield* asCli(raw, root)["Project.CoordinatorSession"]({
            harness: "pi",
            fresh: false,
            terminal: `test/${paneId}`,
          })
          return yield* asSession(raw, launched.sessionId, root)
        })
      const a = yield* asCoordinator(repo, "p1")
      const b = yield* asCoordinator(yield* makeRepository, "p2")
      const { id } = yield* a.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      const others: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        b.Send({ id, message: "x" }),
        b.Interrupt({ id }),
        b.Peek({ id }),
        b.Remove({ id }),
      ]
      for (const call of others) {
        const exit = yield* Effect.exit(call)
        assert.strictEqual(failureTag(exit), "Forbidden")
        assert.match(String(Exit.isFailure(exit) && Cause.pretty(exit.cause)), /belongs to another coordinator/)
      }
      assert.deepInclude(yield* b.Get({ id }), { id, agent: "general" })
      assert.strictEqual((yield* b.List({}))[0]?.agent, "main")
      assert.deepStrictEqual(
        (yield* b.List({ stopped: true })).filter((s) => s.agent !== "main"),
        [],
      )
      assert.deepStrictEqual(
        (yield* b.List({})).filter((s) => s.agent !== "main"),
        [],
      )
      assert.strictEqual(
        failureTag(yield* Effect.exit(b.Send({ id: "0e0e0000-0e0e-40e0-80e0-0e0e00000e0e", message: "x" }))),
        "NoSuchSession",
      )
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      yield* a.Send({ id, message: "from its own Coordinator" })
      const user = asCli(yield* client, repo)
      yield* user.Send({ id, message: "from the user" })
      assert.deepStrictEqual(
        (yield* db.pendingInbox(id)).map((r) => r.message),
        ["from its own Coordinator", "from the user"],
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
      const asCoordinator = (root: string, paneId: string) =>
        Effect.gen(function* () {
          const raw = yield* client
          const launched = yield* asCli(raw, root)["Project.CoordinatorSession"]({
            harness: "pi",
            fresh: false,
            terminal: `test/${paneId}`,
          })
          return yield* asSession(raw, launched.sessionId, root)
        })
      const a = yield* asCoordinator(repo, "p1")
      const { id } = yield* a.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      type Client = Effect.Success<typeof client>
      const protectedCalls = (
        c: Client,
      ): ReadonlyArray<readonly [string, Effect.Effect<unknown, { readonly _tag: string }>]> => [
        ["Spawn", c.Spawn({ harness: "pi", prompt: "more" })],
        ["Launch", c.Launch({ argv: [], focus: false })],
        ["Project.StartMain", c["Project.StartMain"]({ runtime: "herdr" })],
        ["Project.Open", c["Project.Open"]({})],
        ["Project.MainPlace", c["Project.MainPlace"]({ callerEnv: {} })],
        ["List", c.List({ stopped: true })],
        ["Get", c.Get({ id })],
        ["Inbox.Subscribe", Stream.runDrain(c["Inbox.Subscribe"](undefined))],
        ["Watch", Stream.runDrain(c.Watch(undefined))],
        ["Session.Seen", c["Session.Seen"]({ id: "x", turn: 0 })],
        [
          "Project.CoordinatorSession",
          c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p1" }),
        ],
        ["Project.RunningCoordinator", c["Project.RunningCoordinator"]({ terminal: "test/p1" })],
        ["Project.StopCoordinator", c["Project.StopCoordinator"]({ runtime: "herdr", address: "{}" })],
        ["Project.Info", c["Project.Info"]()],
        ["Project.Search", c["Project.Search"]({ query: "x" })],
        ["Send", c.Send({ id, message: "x" })],
        ["Interrupt", c.Interrupt({ id })],
        ["Peek", c.Peek({ id })],
        ["Remove", c.Remove({ id })],
        ["Report", c.Report({ message: "x" })],
        ["Daemon.Stop", c["Daemon.Stop"]({ instance: "x" })],
        ["Daemon.Handoff", c["Daemon.Handoff"]({ instance: "x", command: ["vibest"] })],
        ["Session.Start", c["Session.Start"]({ id: "07e40000-07e4-407e-807e-07e4000007e4" })],
        ["Session.Ready", c["Session.Ready"]({ id: "07e40000-07e4-407e-807e-07e4000007e4" })],
        ["Agents.Outdated", c["Agents.Outdated"]()],
        ["Agents.Restart", c["Agents.Restart"]({ ids: [id] })],
      ]
      const bare = yield* client
      for (const [method, call] of protectedCalls(bare))
        assert.strictEqual(failureTag(yield* Effect.exit(call)), "ProtocolRejected", method)
      const w = yield* asSession(yield* client, id)
      for (const [method, call] of protectedCalls(w).filter(([m]) => m !== "Report"))
        assert.strictEqual(failureTag(yield* Effect.exit(call)), "Forbidden", method)

      yield* a["Session.Ready"]({ id: (yield* db.coordinatorOf((yield* db.getSession(id))!.projectId))!.id })
      yield* w["Session.Ready"]({ id, pid: 4242 })
      assert.isDefined(yield* db.readyAt(id))
      assert.strictEqual((yield* db.getSession(id))!.metadata.pid, 4242)

      yield* bare.Plugins(undefined, { headers: protocolHeaders() })
      assert.isArray(yield* bare["Runtimes.Doctor"]({ harnesses: ["pi"] }, { headers: protocolHeaders() }))
      yield* bare.Subscriptions(undefined, { headers: protocolHeaders() })
      yield* bare.Republish(undefined, { headers: protocolHeaders() })
      yield* bare.TurnEnd({ sessionId: id, harness: "pi", event: "{}" }, { headers: protocolHeaders() })
      yield* bare.CoordinatorSessionReady(
        { sessionId: "unknown", harness: "pi", harnessSessionId: "s1" },
        { headers: protocolHeaders() },
      )
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            bare.TurnEnd({ sessionId: id, harness: "pi", event: "{}" }, { headers: { "vibest-protocol": "0" } }),
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
        "TurnEnd",
        "Prompt",
        "CoordinatorSessionReady",
      ]
      assert.sameMembers(covered, [...VibestRpcs.requests.keys()])
    }),
  )

  test(
    "Launch opens a terminal at the repository root running the command in its shell; no session, no worktree",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const layout = yield* Layout
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const opened = yield* c.Launch({
        argv: ["/bin/vibest", "--harness", "pi", "--model", "it's"],
        focus: true,
        runtime: "herdr",
      })
      const root = yield* sh(repo, "rev-parse", "--show-toplevel")
      assert.deepStrictEqual(opened, {
        runtime: "herdr",
        terminal: opened.terminal,
        place: `herdr terminal ${opened.terminal}`,
        attach: ["fake", "attach"],
      })
      assert.deepStrictEqual(yield* herdr.callsTo("open"), [
        {
          project: root,
          cwd: root,
          argv: ["sh", "-c", '"$@"; exec "${SHELL:-/bin/sh}"', "sh"],
          env: { VIBEST_HOME: layout.home },
          label: "vibest",
          near: undefined,
          split: undefined,
          focus: true,
        },
      ])
      assert.deepStrictEqual(yield* herdr.callsTo("run"), [
        {
          terminal: opened.terminal,
          argv: ["/bin/vibest", "--harness", "pi", "--model", "it's", "--runtime", "herdr", "--in-parent", root],
        },
      ])
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
      assert.deepStrictEqual(yield* c.List({}), [])
    }),
  )

  test(
    "Project.MainPlace names the detected terminal, launches a named runtime that is not here, and a marked root only when it matches",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const opened = yield* c["Project.Open"]({})
      const here = yield* c["Project.MainPlace"]({ callerEnv: { HC_ID: "t1", HERDR_ID: "p1" } })
      assert.strictEqual(here.directory, opened.directory)
      assert.deepStrictEqual(here.place, { in: "terminal", runtime: "hc", terminal: "t1" })
      assert.deepStrictEqual((yield* c["Project.MainPlace"]({ callerEnv: { HC_ID: "t1" }, runtime: "herdr" })).place, {
        in: "launch",
        runtime: "herdr",
      })
      assert.deepStrictEqual(
        (yield* c["Project.MainPlace"]({
          callerEnv: { HC_ID: "t1", HERDR_ID: "p1" },
          runtime: "herdr",
          inParent: opened.directory,
        })).place,
        { in: "terminal", runtime: "herdr", terminal: "p1" },
      )
      assert.deepStrictEqual(
        (yield* c["Project.MainPlace"]({
          callerEnv: { HC_ID: "t1" },
          runtime: "herdr",
          inParent: "/not-the-root",
        })).place,
        { in: "launch", runtime: "herdr" },
      )
    }),
    {
      plugins: [
        Plugin.define({
          id: "runtime-hc",
          caller: {
            kind: "hc",
            env: ["HC_ID"],
            terminal: (env) => Effect.succeed(env.HC_ID),
          },
          effect: () => Effect.void,
        }),
        Plugin.define({
          id: "runtime-herdr-caller",
          caller: {
            kind: "herdr",
            env: ["HERDR_ID"],
            terminal: (env) => Effect.succeed(env.HERDR_ID),
          },
          effect: () => Effect.void,
        }),
      ],
    },
  )

  test(
    "a runtime that is not ready is LaunchFailed with the plugin's missing message",
    Effect.gen(function* () {
      const c = asCli(yield* client, yield* makeRepository)
      const refused = yield* Effect.flip(c["Project.MainPlace"]({ callerEnv: { HC_ID: "t1" } }))
      assert.strictEqual(refused._tag, "LaunchFailed")
      assert.strictEqual(refused.message, "hc socket is down")
    }),
    {
      plugins: [
        Plugin.define({
          id: "runtime-hc",
          caller: {
            kind: "hc",
            env: ["HC_ID"],
            terminal: (env) => Effect.succeed(env.HC_ID),
            ready: () => Effect.succeed(false),
            missing: "hc socket is down",
          },
          effect: () => Effect.void,
        }),
      ],
    },
  )

  test(
    "Project.CoordinatorSession returns the harness command and writes the system prompt before the claim is used",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const c = asCli(yield* client, repo)
      const started = yield* c["Project.CoordinatorSession"]({
        harness: "pi",
        fresh: true,
        terminal: "test/p1",
        runtime: "herdr",
      })
      assert.strictEqual(started.command.file, "pi")
      assert.strictEqual(started.command.env.VIBEST_SESSION_ID, started.sessionId)
      assert.strictEqual(started.command.env.VIBEST_PROJECT_DIR, layout.project(started.projectId))
      assert.strictEqual(yield* fs.exists(yield* systemPromptFile(started.sessionId)), true)
      assert.strictEqual(yield* fs.exists(layout.artifacts(started.projectId)), true)
    }),
  )

  test(
    "a harness not on PATH fails before any row is claimed",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const db = yield* Db
      const c = asCli(yield* client, repo)
      const failed = yield* Effect.flip(
        c["Project.CoordinatorSession"]({ harness: "pi", fresh: true, terminal: "test/p9", runtime: "herdr" }),
      )
      assert.strictEqual(failed._tag, "HarnessUnavailable")
      assert.deepStrictEqual(yield* db.listSessions(), [])
    }),
    { missingBinary: ["pi"] },
  )

  test(
    "Spawn and Launch open at the caller target, and runtimeSession wins",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const herdr = yield* FakeRuntime
      const socket = JSON.stringify({ socketPath: "/h.sock" })
      const named = JSON.stringify({ session: "other" })
      yield* c.Spawn({
        harness: "pi",
        prompt: "do it",
        callerEnv: { HERDR_SOCKET_PATH: "/h.sock", SECRET: "no" },
      })
      yield* until(herdr.callsTo("open"), (calls) => calls.length > 0)
      assert.strictEqual((yield* herdr.callsTo("open"))[0]?.target, socket)
      yield* c.Launch({
        argv: ["/bin/vibest"],
        focus: false,
        runtime: "herdr",
        callerEnv: { HERDR_SOCKET_PATH: "/h.sock" },
        runtimeSession: "other",
      })
      assert.strictEqual((yield* herdr.callsTo("open")).at(-1)?.target, named)
    }),
    {
      plugins: [
        Plugin.define({
          id: "runtime-herdr-caller",
          caller: {
            kind: "herdr",
            env: ["HERDR_SOCKET_PATH"],
            terminal: () => Effect.succeed("pane"),
            target: (env, named) =>
              named !== undefined
                ? JSON.stringify({ session: named })
                : env.HERDR_SOCKET_PATH === undefined
                  ? undefined
                  : JSON.stringify({ socketPath: env.HERDR_SOCKET_PATH }),
          },
          effect: () => Effect.void,
        }),
      ],
    },
  )

  test(
    "the vibest Launch typed passes the pane's VIBEST_MAIN_ENV on, and a restart reads it back; a start without it passes none",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const herdr = yield* FakeRuntime
      const secret = "probe-value-9f3c"
      yield* c.Launch({ argv: ["/bin/vibest", "--env", "MAIN_PROBE=" + secret], focus: false, runtime: "herdr" })
      const pane = JSON.parse((yield* herdr.callsTo("open"))[0]!.env.VIBEST_MAIN_ENV!) as Record<string, string>
      const started = yield* c["Project.CoordinatorSession"]({
        harness: "pi",
        fresh: false,
        terminal: "pane-a",
        env: pane,
      })
      const again = yield* c["Session.Start"]({ id: started.sessionId })
      assert.strictEqual(again.env?.MAIN_PROBE, secret)
      const plain = yield* c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "pane-a" })
      assert.isUndefined((yield* c["Session.Start"]({ id: plain.sessionId })).env?.MAIN_PROBE)
    }),
  )

  test(
    "Launch from a linked worktree opens at the repository's root, not a second parent",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const linked = `${yield* tempDirectory("vibest-linked-")}/wt`
      yield* sh(repo, "worktree", "add", "-q", "--detach", linked)
      yield* asCli(yield* client, linked).Launch({
        argv: ["/bin/vibest", "--harness", "pi"],
        focus: false,
        runtime: "herdr",
      })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((p) => [p.project, p.cwd]),
        [[repo, repo]],
      )
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
    }),
  )

  test(
    "a Pi pane never gets agent.prompt; its subscription takes pending rows first, then new ones as they arrive",
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
        exitedAt: null,
        turnState: "none" as const,
        turnPromptedAt: 0,
        metadata: {},
        createdAt: 1,
        lastActive: 1,
      }
      yield* db.insertSession({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...general }, yield* projectOf("r"))
      yield* db.insertSession({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ...general }, yield* projectOf("r"))
      yield* db.insertSession({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ...general }, yield* projectOf("r"))
      yield* herdr.addPane("w1:p8", "ws", "/")
      yield* herdr.seedAgent("w1:p8")
      const coord = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p8" },
      })
      const project = (yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.projectId
      const row = (sessionId: string, message: string) => ({ sessionId, kind: "result" as const, message, details: {} })
      yield* inbox.enqueue(row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "one"))
      yield* inbox.enqueue(row("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "two"))
      yield* inbox.enqueue(row("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "three"))
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).filter((p) => p.terminal === "w1:p8"),
        [],
      )
      assert.lengthOf(yield* db.coordinatorPending(project), 3)

      const c = yield* asSession(yield* client, coord.sessionId)
      const received = yield* c["Inbox.Subscribe"](undefined).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
      yield* until(db.coordinatorPending(project), (rows) => rows.length === 0)
      yield* inbox.enqueue(row("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "four"))
      assert.deepStrictEqual(Array.from(yield* Fiber.join(received)), ["one\n\ntwo", "three", "four"])
      assert.deepStrictEqual(yield* db.coordinatorPending(project), [])
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).filter((p) => p.terminal === "w1:p8"),
        [],
      )
    }),
  )

  test(
    "a Pi subscription wakes when a row for its main agent goes back to pending (a released lease)",
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
          exitedAt: null,
          turnState: "none",
          turnPromptedAt: 0,
          metadata: {},
          createdAt: 1,
          lastActive: 1,
        },
        yield* projectOf("r"),
      )
      yield* herdr.seedAgent("w1:p8")
      const coord = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p8" },
      })
      const project = yield* projectOf("r")
      const row = yield* inbox.enqueue({
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "result",
        message: "back",
        details: {},
      })
      const claimedElsewhereBeforeSubscribe = yield* db.claim([row.id])
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
      const inbox = yield* Inbox
      const db = yield* Db
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
        exitedAt: null,
        turnState: "none" as const,
        turnPromptedAt: 0,
        metadata: {},
        createdAt: 1,
        lastActive: 1,
      }
      yield* db.insertSession({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...general }, yield* projectOf("r"))
      yield* db.insertSession({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ...general }, yield* projectOf("r"))
      yield* herdr.addPane("w1:p7", "ws", "/")
      yield* herdr.seedAgent("w1:p7")
      const coord = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p7" },
      })
      yield* inbox.enqueue({
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "result",
        message: "one",
        details: {},
      })
      yield* inbox.enqueue({
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        kind: "result",
        message: "two",
        details: {},
      })
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
      const claimed = yield* until(
        db.latestInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "result"),
        (row) => row?.status !== "pending",
      )
      assert.strictEqual(claimed?.status, "sending")
      assert.strictEqual((yield* db.latestInbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "result"))?.status, "pending")
      sock.destroy()
      const closed = yield* until(
        db.latestInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "result"),
        (row) => row?.status === "failed" || row?.status === "delivered",
      )
      assert.strictEqual(closed?.status, "failed")
      assert.strictEqual((yield* db.latestInbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "result"))?.status, "pending")
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
        exitedAt: null,
        turnState: "none" as const,
        turnPromptedAt: 0,
        metadata: {},
        createdAt: 1,
        lastActive: 1,
      }
      yield* db.insertSession({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...general }, yield* projectOf("r"))
      yield* herdr.addPane("w1:p6", "ws", "/")
      yield* herdr.seedAgent("w1:p6")
      const coord = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p6" },
      })
      yield* inbox.enqueue({
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "result",
        message: "one",
        details: {},
      })
      const c = yield* asSession(yield* client, coord.sessionId)
      const got = yield* Deferred.make<string>()
      const fiber = yield* c["Inbox.Subscribe"](undefined).pipe(
        Stream.runForEach((text) => Deferred.succeed(got, text).pipe(Effect.asVoid)),
        Effect.forkChild,
      )
      assert.strictEqual(yield* Deferred.await(got), "one")
      yield* until(
        db.latestInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "result"),
        (row) => row?.status === "delivered",
      )
      yield* Fiber.interrupt(fiber)
      yield* TestClock.withLive(Effect.sleep("50 millis"))
      assert.strictEqual((yield* db.latestInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "result"))?.status, "delivered")
    }),
    undefined,
    15_000,
  )

  test(
    "one socket does not keep a caller: sequential and concurrent requests stay on their own headers",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const raw = yield* client
      const cli = asCli(raw, repo)
      const { id } = yield* cli.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      const session = yield* asSession(raw, id)
      yield* session.Report({ message: "first" })
      assert.match((yield* db.latestInbox(id, "report"))!.message, /first/)
      const listed = yield* cli.List({})
      assert.deepStrictEqual(
        listed.map((w) => w.id),
        [id],
      )
      const [report, got, stranger] = yield* Effect.all(
        [
          session.Report({ message: "second" }),
          cli.Get({ id }),
          Effect.exit(Effect.flatMap(asSession(raw, "nope"), (s) => s.Report({ message: "x" }))),
        ],
        { concurrency: "unbounded" },
      )
      assert.strictEqual(report, undefined)
      assert.strictEqual(got.id, id)
      assert.strictEqual(failureTag(stranger), "NoSuchSession")
      assert.match((yield* db.latestInbox(id, "report"))!.message, /second/)
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
        incompatibleDaemon(newer.layout.socket, { protocol: PROTOCOL, version: "9.9.9", runtimes: [] }, ["vibest"]),
        undefined,
      )
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
    "Project.StartMain schedules with the project directory, not its key; with no harness it takes the builtin default until a main agent exists",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      assert.strictEqual((yield* c["Project.StartMain"]({ runtime: "herdr" })).harness, "pi")
      assert.strictEqual(seenDirectory.project, (yield* projectRoot(repo)).root)
      assert.notStrictEqual(seenDirectory.project, yield* projectOf(repo))
      yield* c["Project.CoordinatorSession"]({ harness: "claude", fresh: false, terminal: "test/p1" })
      assert.strictEqual((yield* c["Project.StartMain"]({ runtime: "herdr" })).harness, "claude")
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
    "List shows the main agent's live status from its pane, not a stored unknown",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const pane = "w1:coord"
      yield* herdr.seedAgent(pane)
      yield* c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: pane })
      yield* herdr.updateAgent(pane, (a) => ({ ...a, status: "working" }))
      assert.deepInclude((yield* c.List({}))[0], { agent: "main", status: "working" })
      yield* herdr.updateAgent(pane, (a) => ({ ...a, status: "idle" }))
      assert.deepInclude((yield* c.List({}))[0], { agent: "main", status: "idle" })
    }),
  )

  test(
    "Remove names the resolved session when the runtime is unreachable, not the prefix typed",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const { id } = yield* c.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      yield* Ref.set(herdr.reachable, false)
      const failed = yield* Effect.flip(c.Remove({ id: id.slice(0, 8) }))
      assert.strictEqual(failed._tag, "RuntimeUnreachable")
      assert.strictEqual("session" in failed ? failed.session : failed._tag, id)
    }),
  )
})
