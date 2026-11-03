import net from "node:net"

// vibest.sock end to end (SPEC §7, §11): the RPC server on a real unix socket over the fake herdr, driven by the real
// client and by a raw JSON-RPC line the way a hook sends it.
import { assert, describe, it } from "@effect/vitest"
import { SocketConnector } from "@vibest/client/client"
import { cliHeaders, connect, incompatibleDaemon, protocolHeaders, withVibest } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Harness, type HarnessId, HarnessUnavailable } from "@vibest/core/harness"
import { Inbox } from "@vibest/core/inbox"
import * as Launch from "@vibest/core/launch"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import { projectRoot } from "@vibest/core/project-create"
import { Sessions } from "@vibest/core/sessions"
import { repositoryKey } from "@vibest/core/worktree"
import { AgentRefused, Plugin } from "@vibest/plugin"
import { MISMATCH_ACTION, PROTOCOL, sessionHeaders } from "@vibest/protocol/protocol"
import { VibestRpcs, VERSION } from "@vibest/protocol/rpc"
import { CALLER_ENV } from "@vibest/runtime-herdr/caller"
import * as Server from "@vibest/server/server"
import { Cause, Effect, Exit, Layer, Option, type Scope, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import {
  authed,
  FakeRuntime,
  makeRepository,
  savedSession,
  sh,
  tempDirectory,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  writeResult,
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
/** A session as its environment names it: with its project id (VIBEST_PROJECT_ID), which vibestd requires. */
const asSession = (raw: Effect.Success<typeof client>, sessionId: string, repositoryRoot?: string) =>
  Effect.gen(function* () {
    const row = yield* (yield* Db).sessionIdentity(sessionId)
    return authed(raw, sessionHeaders({ sessionId, repositoryRoot, projectId: row && String(row.projectId) }))
  })

const failureTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.match(Cause.findErrorOption(exit.cause), { onNone: () => "defect", onSome: (e) => e._tag })
    : "success"

/** What a main agent's integration's `conversation` event does (HTTP /events): kept from the session's own harness only. */
const conversationReport = (sessionId: string, harness: string, conversation: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    if ((yield* db.sessionIdentity(sessionId))?.harness === harness)
      yield* db.noteHarnessSession(sessionId, conversation)
  })

describe("vibest.sock", () => {
  test(
    "a direct request succeeds without Hello; missing or bad caller is refused and does not become cli",
    Effect.gen(function* () {
      const raw = yield* client
      const repo = yield* makeRepository
      const ping = yield* raw.Ping()
      assert.strictEqual(ping.protocol, PROTOCOL)
      assert.strictEqual(ping.version, VERSION)
      assert.deepStrictEqual(ping.capabilities, { http: true, handoff: true })
      const rejected = yield* Effect.exit(raw.List({}))
      assert.strictEqual(failureTag(rejected), "ProtocolRejected")
      // Says what happened and what to run: a caller without the header predates it, so it is told to restart.
      const said = String(Exit.isFailure(rejected) && Cause.pretty(rejected.cause))
      assert.include(
        said,
        `this agent runs an older vibest (protocol none), vibestd runs ${VERSION} (protocol ${PROTOCOL}); run ${MISMATCH_ACTION} to restart this agent on it`,
      )
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

  test(
    "Spawn returns at once; Get shows the latest result without waiting",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const { id } = yield* c.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      assert.deepInclude(yield* c.Get({ id }), { id, turnState: "open", result: null })
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const { result } = yield* c.Get({ id })
      assert.deepInclude(result, { kind: "result", sessionId: id })
      const listed = yield* c.List({})
      assert.deepStrictEqual(
        listed.map((w) => [w.id, w.name, w.agent]),
        [[id, "do it", "general"]],
      )
      assert.isUndefined((yield* db.getSession(id))!.metadata.archive)
      const archiving = yield* c.Spawn({ harness: "pi", prompt: "look", archive: true })
      assert.isTrue((yield* db.getSession(archiving.id))!.metadata.archive)
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
      for (const row of listed.values()) assert.include(["idle", "working", "blocked", "done", "unknown"], row.status)
      assert.strictEqual((yield* c.Get({ id })).task, prompt)
      yield* c.Send({ id, message: "follow up" })
      assert.strictEqual((yield* c.List({})).find((w) => w.id === id)!.task, cut)
      yield* writeResult(id, "pi", { text: "\nfixed it\nand more" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const after = (yield* c.List({})).find((w) => w.id === id)!.latest
      assert.strictEqual(after?.status, "completed")
      assert.strictEqual(after?.summary, "fixed it")
      assert.isNumber(after?.endedAt)
      assert.strictEqual((yield* c.Get({ id })).task, prompt)
    }),
  )

  test(
    "Peek: the command line and the session's coordinator read its terminal on demand; an unknown or exited session has none",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const raw = yield* client
      const c = asCli(raw, repo)
      const { id } = yield* c.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      assert.deepStrictEqual(yield* c.Peek({ id }), { text: "pane tail" })
      yield* c.Peek({ id, lines: 5 })
      assert.deepInclude((yield* herdr.callsTo("read")).at(-1), { lines: 5 })
      yield* c.Peek({ id, lines: 100_000 })
      assert.deepInclude((yield* herdr.callsTo("read")).at(-1), { lines: 500 })
      assert.strictEqual(failureTag(yield* Effect.exit(c.Peek({ id: "nope" }))), "NoSuchSession")
      yield* db.updateSession(id, { exitedAt: 1 })
      assert.strictEqual(failureTag(yield* Effect.exit(c.Peek({ id }))), "NoSuchSession")
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
      yield* conversationReport(launch.sessionId, "claude", "s1")

      const bare = yield* client
      const calls: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        bare.Send({ id, message: "x" }),
        bare.Get({ id }),
        bare.Interrupt({ id }),
        bare.Remove({ id }),
        bare.Report({ message: "x" }),
      ]
      for (const call of calls) assert.strictEqual(failureTag(yield* Effect.exit(call)), "ProtocolRejected")
      yield* bare.Republish(undefined, { headers: protocolHeaders() })
      assert.strictEqual(failureTag(yield* Effect.exit(bare.Republish(undefined))), "ProtocolRejected")
      // An integration's call names its version, which is recorded even when its protocol is refused.
      yield* bare.Republish(undefined, { headers: sessionHeaders({ sessionId: id, pluginVersion: "1.2.3" }) })
      assert.deepStrictEqual((yield* db.getSession(id))?.metadata.integration, { version: "1.2.3", protocol: PROTOCOL })
      const old = { ...sessionHeaders({ sessionId: id, pluginVersion: "1.0.0" }), "vibest-protocol": "1" }
      assert.strictEqual(
        failureTag(yield* Effect.exit(bare.Republish(undefined, { headers: old }))),
        "ProtocolRejected",
      )
      assert.deepStrictEqual((yield* db.getSession(id))?.metadata.integration, { version: "1.0.0", protocol: 1 })

      assert.strictEqual(
        failureTag(
          yield* Effect.exit(bare.Report({ message: "x" }, { headers: sessionHeaders({ sessionId: "nope" }) })),
        ),
        "NoSuchSession",
      )
      // A known session without its project id is refused, as over HTTP.
      assert.strictEqual(
        failureTag(yield* Effect.exit(bare.Report({ message: "x" }, { headers: sessionHeaders({ sessionId: id }) }))),
        "InvalidCaller",
      )

      // The harness's conversation id rides on a session's calls: kept from the session's own harness (pi) alone.
      const projectId = String((yield* db.sessionIdentity(id))!.projectId)
      const as = (harness: string, harnessSessionId: string) =>
        authed(raw, sessionHeaders({ sessionId: id, projectId, harness, harnessSessionId }))
      yield* as("pi", "pi-1").Report({ message: "one" })
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "pi-1")
      yield* as("claude", "other").Report({ message: "two" })
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "pi-1")
      const w = yield* asSession(yield* client, id)
      yield* w.Report({ message: "half way" })
      const reported = yield* db.latestInbox(id, "report")
      assert.match(
        reported!.message,
        /^<agent-message>\n<agent-id>[a-f0-9]{8}<\/agent-id>\n<summary>Agent "do it" sent a message before finishing<\/summary>\n<message>\nhalf way\n<\/message>\n<\/agent-message>$/,
      )
      const refused: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        w.Spawn({ harness: "pi", prompt: "more" }),
        w.List({ stopped: true }),
        w.Send({ id, message: "x" }),
        w.Get({ id }),
        w.Interrupt({ id }),
        w.Remove({ id }),
        w["Project.Info"](),
        w["Project.Read"]({ kind: "docs", path: "a.md" }),
        w["Project.Write"]({ kind: "memory", path: "a.md", content: "x", ifVersion: "new" }),
        w.Launch({ argv: [], focus: false }),
        w["Project.CoordinatorSession"]({ harness: "claude", fresh: true, terminal: "test/p1" }),
      ]
      for (const call of refused) assert.strictEqual(failureTag(yield* Effect.exit(call)), "Forbidden")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      // The refused launch rotated nothing: the Coordinator's launch id and report watermark still hold.
      yield* conversationReport(launch.sessionId, "claude", "stale")
      yield* conversationReport(launch.sessionId, "claude", "s2")
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
    "a Coordinator manages only the sessions it spawned; the command line (the user) manages any",
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
        assert.match(String(Exit.isFailure(exit) && Cause.pretty(exit.cause)), /is not yours to manage/)
      }
      assert.strictEqual(failureTag(yield* Effect.exit(b.Send({ id: "nope0000", message: "x" }))), "NoSuchSession")
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      yield* a.Send({ id, message: "from its own Coordinator" })
      const user = asCli(yield* client, repo)
      yield* user.Send({ id, message: "from the user" })
      assert.deepStrictEqual(
        (yield* db.pendingInbox(id)).map((r) => r.message),
        ["from its own Coordinator", "from the user"],
      )
      // Past the ownership check, the user's command line archives it even while it works.
      assert.strictEqual(failureTag(yield* Effect.exit(user.Remove({ id }))), "success")
    }),
  )

  test(
    "every protected method: no protocol and a session are refused, other coordinators read but do not manage, notifications need protocol only",
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
      // Every method but Hello and the open ones, called the same way by each caller.
      const protectedCalls = (
        c: Client,
      ): ReadonlyArray<readonly [string, Effect.Effect<unknown, { readonly _tag: string }>]> => [
        ["Spawn", c.Spawn({ harness: "pi", prompt: "more" })],
        ["Launch", c.Launch({ argv: [], focus: false })],
        ["Project.StartMain", c["Project.StartMain"]({})],
        ["List", c.List({ stopped: true })],
        ["Get", c.Get({ id })],
        [
          "Project.CoordinatorSession",
          c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p1" }),
        ],
        ["Project.RunningCoordinator", c["Project.RunningCoordinator"]({ terminal: "test/p1" })],
        ["Project.StopCoordinator", c["Project.StopCoordinator"]({ runtime: "herdr", address: "{}" })],
        ["Project.Info", c["Project.Info"]()],
        ["Project.List", c["Project.List"]({ kind: "docs" })],
        ["Project.Read", c["Project.Read"]({ kind: "docs", path: "a.md" })],
        ["Project.Search", c["Project.Search"]({ query: "x" })],
        ["Project.Write", c["Project.Write"]({ kind: "memory", path: "a.md", content: "x", ifVersion: "new" })],
        ["Project.Delete", c["Project.Delete"]({ kind: "memory", path: "a.md", ifVersion: "new" })],
        ["Send", c.Send({ id, message: "x" })],
        ["Interrupt", c.Interrupt({ id })],
        ["Peek", c.Peek({ id })],
        ["Remove", c.Remove({ id })],
        ["Report", c.Report({ message: "x" })],
        ["Daemon.Stop", c["Daemon.Stop"]({ instance: "x" })],
        ["Daemon.Handoff", c["Daemon.Handoff"]({ instance: "x", command: ["vibest"] })],
        // Another session's start or report: a session speaks only for itself.
        ["Session.Start", c["Session.Start"]({ id: "other000" })],
        ["Agents.Outdated", c["Agents.Outdated"]()],
        ["Agents.Restart", c["Agents.Restart"]({ ids: [id] })],
        ["Inbox.Read", c["Inbox.Read"]({})],
      ]
      const bare = yield* client
      for (const [method, call] of protectedCalls(bare))
        assert.strictEqual(failureTag(yield* Effect.exit(call)), "ProtocolRejected", method)
      const w = yield* asSession(yield* client, id)
      for (const [method, call] of protectedCalls(w).filter(([m]) => m !== "Report"))
        assert.strictEqual(failureTag(yield* Effect.exit(call)), "Forbidden", method)

      // Another project's coordinator can read a session, not manage it, and does not list it.
      const b = yield* asCoordinator(yield* makeRepository, "p2")
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
      const again: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        b.Send({ id, message: "x" }),
        b.Interrupt({ id }),
        b.Remove({ id }),
      ]
      for (const call of again) assert.strictEqual(failureTag(yield* Effect.exit(call)), "Forbidden")
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")

      // Ping is exempt. The other caller-less methods need protocol and ignore caller headers.
      assert.strictEqual((yield* bare.Ping()).version, VERSION)
      assert.strictEqual((yield* bare.Ping()).protocol, PROTOCOL)
      yield* bare.Plugins(undefined, { headers: protocolHeaders() })
      assert.isArray(yield* bare["Runtimes.Doctor"]({ harnesses: ["pi"] }, { headers: protocolHeaders() }))
      yield* bare.Subscriptions(undefined, { headers: protocolHeaders() })
      yield* bare.Republish(undefined, { headers: protocolHeaders() })
      yield* bare.Republish(undefined, { headers: protocolHeaders() })
      yield* conversationReport("unknown", "pi", "s1")
      assert.strictEqual(
        failureTag(yield* Effect.exit(bare.Republish(undefined, { headers: { "vibest-protocol": "0" } }))),
        "ProtocolRejected",
      )

      const covered = [
        ...protectedCalls(bare).map(([method]) => method),
        "Ping",
        "Plugins",
        "Runtimes.Doctor",
        "Subscriptions",
        "Republish",
      ]
      assert.sameMembers(covered, [...VibestRpcs.requests.keys()])
    }),
  )

  test(
    "Send is stored before it returns and delivered by vibestd after the caller is gone; a busy session gets it once idle",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const { id } = yield* c.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      const sendAndHangUp = (message: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const s = asCli(yield* client, repo)
            yield* s.Send({ id, message })
          }),
        )

      // Busy: queued, nothing typed into the running turn.
      yield* sendAndHangUp("while busy")
      assert.deepStrictEqual(
        (yield* db.pendingInbox(id)).map((r) => r.message),
        ["while busy"],
      )
      assert.lengthOf(yield* herdr.callsTo("send"), 1)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* herdr.callsTo("send")).at(-1)!.text, "while busy")

      // Idle: delivered by vibestd although the connection that sent it is already closed.
      yield* writeResult(id, "pi", { text: "status: completed" }, 2000)
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* sendAndHangUp("after hang-up")
      yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)!.text === "after hang-up")
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
    }),
    { hooked: ["pi"] },
  )

  test(
    "a message vibestd cannot deliver fails and tells the session's owner",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      // Cursor reports its session only through herdr; this one exits before it did, so it cannot be resumed.
      const { id } = yield* c.Spawn({ harness: "cursor", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      yield* writeResult(id, "cursor", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      yield* c.Send({ id, message: "more" })
      const notice = yield* until(db.latestInbox(id, "notice"), (row) => !!row)
      assert.include(
        notice!.message,
        `A message to ${id} was not delivered: ${id} exited before the runtime reported its session id`,
      )
      assert.deepStrictEqual(yield* db.pendingInbox(id), [])
    }),
  )

  test(
    "Launch opens a terminal at the repository root running the command in its shell; no session, no worktree",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const layout = yield* Layout
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const opened = yield* c.Launch({ argv: ["/bin/vibest", "--harness", "pi", "--model", "it's"], focus: true })
      const root = yield* sh(repo, "rev-parse", "--show-toplevel")
      assert.deepStrictEqual(opened, {
        runtime: "herdr",
        terminal: opened.terminal,
        place: `herdr terminal ${opened.terminal}`,
        attach: ["fake", "attach"],
      })
      // The command runs with the pane's shell kept behind it: a failing `vibest` shows its error and the pane stays.
      assert.deepStrictEqual(yield* herdr.callsTo("open"), [
        {
          project: root,
          cwd: root,
          argv: [
            "sh",
            "-c",
            '"$@"; exec "${SHELL:-/bin/sh}"',
            "sh",
            "/bin/vibest",
            "--harness",
            "pi",
            "--model",
            "it's",
            "--in-parent",
            root,
          ],
          env: { VIBEST_HOME: layout.home },
          label: "vibest",
          near: undefined,
          split: undefined,
          focus: true,
        },
      ])
      // The runtime's terminal runs the command itself: vibestd never types into it.
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
      assert.deepStrictEqual(yield* c.List({}), [])
    }),
  )

  test(
    "Launch from a linked worktree opens at the repository's root, not a second parent",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const linked = `${yield* tempDirectory("vibest-linked-")}/wt`
      yield* sh(repo, "worktree", "add", "-q", "--detach", linked)
      yield* asCli(yield* client, linked).Launch({ argv: ["/bin/vibest", "--harness", "pi"], focus: false })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((p) => [p.project, p.cwd]),
        [[repo, repo]],
      )
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
    }),
  )

  test(
    "Launch hands the runtime the repository root as the project, so it can open in its own parent workspace",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      yield* c.Launch({ argv: ["/bin/vibest"], focus: false })
      const open = (yield* herdr.callsTo("open"))[0]!
      assert.strictEqual(open.project, yield* sh(repo, "rev-parse", "--show-toplevel"))
    }),
  )

  test(
    "a plugin's JSON-RPC line with the protocol header is accepted; params stay the same; a missing protocol is refused",
    Effect.gen(function* () {
      const layout = yield* Layout
      const dial = yield* SocketConnector
      const ask = (line: string) =>
        Effect.gen(function* () {
          const socket = yield* dial(layout.socket)
          const pull = yield* Socket.readerString(socket)
          yield* (yield* socket.writer).write(line)
          return Option.getOrUndefined(
            yield* Stream.fromPull(Effect.succeed(pull)).pipe(Stream.splitLines, Stream.runHead),
          )
        })
      assert.deepStrictEqual(
        yield* ask(
          `{"jsonrpc":"2.0","id":"hook:1","method":"Republish","params":null,"headers":[["vibest-protocol","${PROTOCOL}"]]}\n`,
        ),
        '{"jsonrpc":"2.0","id":"hook:1","result":0}',
      )
      assert.include(
        yield* ask('{"jsonrpc":"2.0","id":"hook:2","method":"Republish","params":null}\n') ?? "",
        "ProtocolRejected",
      )
    }),
  )

  test(
    "Coordinator launches: the turn-end report sets the session for the latest launch only",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const first = yield* c["Project.CoordinatorSession"]({ harness: "claude", fresh: false, terminal: "test/p1" })
      assert.isNull(first.harnessSessionId)
      yield* conversationReport(first.sessionId, "claude", "c1")
      yield* until(savedSession(first.sessionId), (id) => id === "c1")
      // Another harness's report does not count. The same id is reused on relaunch.
      yield* conversationReport(first.sessionId, "pi", "x0")
      const second = yield* c["Project.CoordinatorSession"]({ harness: "claude", fresh: false, terminal: "test/p1" })
      assert.strictEqual(second.sessionId, first.sessionId)
      assert.strictEqual(second.harnessSessionId, "c1")
      // `--new` ends this conversation and starts another. The last report wins on the new one.
      const fresh = yield* c["Project.CoordinatorSession"]({ harness: "claude", fresh: true, terminal: "test/p1" })
      assert.notStrictEqual(fresh.sessionId, first.sessionId)
      assert.isNull(fresh.harnessSessionId)
      yield* conversationReport(fresh.sessionId, "claude", "c3")
      assert.strictEqual(yield* savedSession(fresh.sessionId), "c3")
    }),
  )

  test(
    "one main agent per project: a start in another terminal while it runs is refused and changes nothing; once it exited the start goes ahead",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const first = yield* c["Project.CoordinatorSession"]({ harness: "claude", fresh: false, terminal: "test/p1" })
      yield* herdr.seedAgent("test/p1")
      const running = yield* c["Project.RunningCoordinator"]({ terminal: "test/p2" })
      assert.strictEqual(running?.harness, "claude")
      const refused = yield* Effect.exit(
        c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p2" }),
      )
      assert.strictEqual(failureTag(refused), "Forbidden")
      assert.include(String(Cause.squash((refused as Exit.Failure<unknown, unknown>).cause)), "still running in")
      const project = yield* db.projectId(yield* repositoryKey(repo))
      const row = (yield* db.coordinatorOf(project))!
      assert.strictEqual(row.address?.id, "test/p1")
      assert.strictEqual(row.harnessId, "claude")
      // Its own terminal may start it again; another one may once it exited.
      yield* c["Project.CoordinatorSession"]({ harness: "claude", fresh: false, terminal: "test/p1" })
      yield* herdr.updateAgent("test/p1", (a) => ({ ...a, alive: false }))
      const moved = yield* c["Project.CoordinatorSession"]({ harness: "claude", fresh: false, terminal: "test/p2" })
      assert.strictEqual(moved.sessionId, first.sessionId)
      assert.strictEqual((yield* db.coordinatorOf(project))!.address?.id, "test/p2")
    }),
  )

  test(
    "vibest refused before exec (binary, plugin, provider, harness) leaves the running main agent's conversation alone",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const claude = yield* c["Project.CoordinatorSession"]({ harness: "claude", fresh: false, terminal: "test/p1" })
      yield* conversationReport(claude.sessionId, "claude", "c1")
      const pi = yield* c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p1" })
      assert.strictEqual(pi.sessionId, claude.sessionId)
      yield* conversationReport(pi.sessionId, "pi", "x1")
      const refused = (
        harness: HarnessId,
        fresh: boolean,
        provider: string | null,
        available: boolean,
        plugin: boolean,
      ) =>
        Launch.coordinatorCommand({
          harness,
          root: repo,
          provider,
          model: null,
          passEnv: CALLER_ENV,
          session: c["Project.CoordinatorSession"]({ harness, fresh, terminal: "test/p1" }),
        }).pipe(
          Effect.provide(
            Layer.succeed(Harness, {
              available: () => Effect.succeed(available),
              plugin: (id) =>
                plugin
                  ? Effect.succeed(`/vibest/harnesses/${id}`)
                  : Effect.fail(new HarnessUnavailable({ harness: id, message: "missing" })),
              models: () => Effect.succeed([]),
            }),
          ),
          Effect.provideService(VibestCommand, ["/bin/vibest"]),
          Effect.flip,
        )
      for (const fresh of [false, true]) {
        for (const [harness, provider, available, plugin] of [
          ["claude", null, false, true],
          ["claude", null, true, false],
          ["pi", null, true, false],
          ["claude", "openai", true, true],
          ["cursor", null, true, true],
        ] as const)
          assert.strictEqual((yield* refused(harness, fresh, provider, available, plugin))._tag, "HarnessUnavailable")
      }
      // A refused launch does not call CoordinatorSession, so the saved conversation stands. A claude report no longer matches.
      assert.strictEqual(yield* savedSession(pi.sessionId), "x1")
      yield* conversationReport(pi.sessionId, "claude", "c2")
      yield* conversationReport(pi.sessionId, "pi", "x2")
      assert.strictEqual(yield* savedSession(pi.sessionId), "x2")
    }),
  )

  test(
    "a pane-type owner gets one sender's rows merged when idle; a busy pane keeps the rest",
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
      yield* db.insertSession({ id: "aaaaaaaa", ...general }, "r")
      yield* db.insertSession({ id: "bbbbbbbb", ...general }, "r")
      yield* db.coordinatorLaunch("r", "cursor", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p9" },
      })
      yield* herdr.seedAgent("w1:p9")
      const project = (yield* db.getSession("aaaaaaaa"))!.projectId
      const row = (sessionId: string, message: string) => ({ sessionId, kind: "result" as const, message, details: {} })
      yield* inbox.enqueue(row("aaaaaaaa", "one"))
      yield* inbox.enqueue(row("aaaaaaaa", "two"))
      yield* inbox.enqueue(row("bbbbbbbb", "three"))
      yield* until(db.coordinatorPending(project), (rows) => rows.length === 1)
      const prompts = (yield* herdr.callsTo("send")).filter((p) => p.terminal === "w1:p9")
      assert.deepStrictEqual(
        prompts.map((p) => p.text),
        ["one\n\ntwo"],
      )

      // The prompt made the pane busy: nothing more until it is idle again.
      yield* Effect.void
      assert.strictEqual((yield* db.coordinatorPending(project)).length, 1)
      yield* herdr.endTurn("w1:p9")
      yield* inbox.deliver(project)
      assert.deepStrictEqual(yield* db.coordinatorPending(project), [])
      assert.strictEqual((yield* herdr.callsTo("send")).filter((p) => p.terminal === "w1:p9").at(-1)!.text, "three")
    }),
  )

  test(
    "a Pi pane never gets agent.prompt; its integration polls pending rows first, then new ones as they arrive",
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
      yield* db.insertSession({ id: "aaaaaaaa", ...general }, "r")
      yield* db.insertSession({ id: "bbbbbbbb", ...general }, "r")
      yield* db.insertSession({ id: "cccccccc", ...general }, "r")
      yield* herdr.addPane("w1:p8", "ws", "/")
      yield* herdr.seedAgent("w1:p8")
      const coord = yield* db.coordinatorLaunch("r", "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p8" },
      })
      const project = (yield* db.getSession("aaaaaaaa"))!.projectId
      const row = (sessionId: string, message: string) => ({ sessionId, kind: "result" as const, message, details: {} })
      yield* inbox.enqueue(row("aaaaaaaa", "one"))
      yield* inbox.enqueue(row("aaaaaaaa", "two"))
      yield* inbox.enqueue(row("bbbbbbbb", "three"))
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).filter((p) => p.terminal === "w1:p8"),
        [],
      )
      assert.lengthOf(yield* db.coordinatorPending(project), 3)

      const received: Array<string> = []
      const take = Effect.gen(function* () {
        const batch = yield* inbox.poll(coord.projectId)
        received.push(batch.text)
        yield* inbox.ack(coord.projectId, batch.ids)
      })
      yield* take
      yield* take
      yield* inbox.enqueue(row("cccccccc", "four"))
      yield* take
      assert.deepStrictEqual(received, ["one\n\ntwo", "three", "four"])
      assert.deepStrictEqual(yield* db.coordinatorPending(project), [])
      assert.deepStrictEqual(
        (yield* herdr.callsTo("send")).filter((p) => p.terminal === "w1:p8"),
        [],
      )
    }),
  )

  test(
    "P7: Spawn routes through plugins over the wire; refusals arrive tagged with the plugin; Plugins lists counters",
    Effect.gen(function* () {
      const c = asCli(yield* client, yield* makeRepository)
      const s = yield* c.Spawn({ prompt: "research: look around" })
      assert.deepInclude(s, {
        harness: "claude",
        model: "claude-haiku-5-5",
        decidedBy: { harness: "route", runtime: "runtime-choice", model: "route" },
      })
      assert.deepStrictEqual((yield* c.Get({ id: s.id })).routing?.decidedBy, {
        harness: "route",
        runtime: "runtime-choice",
        model: "route",
      })
      const rejected = yield* Effect.flip(c.Spawn({ prompt: "x", harness: "claude", model: "claude-opus-5-5" }))
      assert.deepInclude(rejected, { _tag: "AgentRefused", plugin: "budget", reason: "no opus" })
      assert.deepStrictEqual(
        (yield* c.Plugins()).map((p) => [p.id, p.status, p.calls, p.changed, p.refused]),
        [
          ["coordinator", "active", 0, 0, 0],
          ["harness-choice", "active", 2, 1, 0],
          ["runtime-choice", "active", 2, 2, 0],
          ["route", "active", 2, 1, 0],
          ["budget", "active", 2, 0, 1],
        ],
      )
    }),
    {
      models: ["claude-haiku-5-5"],
      plugins: [
        Plugin.define({
          id: "route",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                if (!e.prompt.startsWith("research:")) return
                e.harness = "claude"
                e.model = "claude-haiku-5-5"
              }),
            ),
        }),
        Plugin.define({
          id: "budget",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              e.model?.includes("opus") ? Effect.fail(new AgentRefused({ reason: "no opus" })) : Effect.void,
            ),
        }),
      ],
    },
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
    "a missing protocol does not spawn; a legacy Ping fails closed; a different package version does not",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const raw = yield* client
      const { "vibest-protocol": _dropped, ...callerOnly } = cliHeaders(repo)
      assert.strictEqual(
        failureTag(yield* Effect.exit(raw.Spawn({ harness: "pi", prompt: "nope" }, { headers: callerOnly }))),
        "ProtocolRejected",
      )
      assert.deepStrictEqual(yield* db.listSessions(), [])
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
      // Both sides, as far as each is known; the legacy vibestd's PID is not, and is never guessed from vibestd.pid.
      const said = String(Exit.isFailure(refused) && Cause.pretty(refused.cause))
      assert.include(said, "vibestd 0.0.0 (pid unknown, command unknown)")
      assert.include(said, `vibest ${VERSION} (`)
      assert.include(said, "kill -TERM <pid>")
      assert.include(said, "vibestd is older (0.0.0); run vibest update")
      // An older build of the same package version (protocol 2, its Ping without `runtimes`): told plainly, never a SchemaError.
      const older = yield* serve({ protocol: 2, version: VERSION, runtimeSessions: [] })
      const olderRefused = yield* Effect.exit(
        withVibest({ _tag: "cli", repositoryRoot: repo }, () => Effect.die("must not call"), { start: false }).pipe(
          Effect.provideService(Layout, older.layout),
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
    }),
  )

  test(
    "Project.StartMain runs agent.start.before and returns the trace",
    Effect.gen(function* () {
      const c = asCli(yield* client, yield* makeRepository)
      const d = yield* c["Project.StartMain"]({ harness: "pi" })
      assert.deepStrictEqual([d.harness, d.provider, d.model], ["pi", "zai", "glm"])
      assert.deepStrictEqual(d.decidedBy, { runtime: "runtime-choice", provider: "pick", model: "pick" })
      assert.deepStrictEqual(
        d.trace.map((t) => [t.plugin, t.hook]),
        [
          ["harness-choice", "agent.start.before"],
          ["runtime-choice", "agent.start.before"],
          ["pick", "agent.start.before"],
        ],
      )
    }),
    {
      plugins: [
        Plugin.define({
          id: "pick",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                e.provider = "zai"
                e.model = "glm"
              }),
            ),
        }),
      ],
    },
  )

  const seenDirectory = { project: "" }
  test(
    "Project.StartMain schedules with the project directory, not its key",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      assert.strictEqual((yield* c["Project.StartMain"]({ harness: "pi" })).harness, "pi")
      assert.strictEqual(seenDirectory.project, (yield* projectRoot(repo)).root)
      assert.notStrictEqual(seenDirectory.project, yield* repositoryKey(repo))
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
    "Project.StartMain with no harness takes the builtin default until a main agent exists",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      assert.strictEqual((yield* c["Project.StartMain"]({})).harness, "pi")
      yield* c["Project.CoordinatorSession"]({ harness: "cursor", fresh: false, terminal: "test/p1" })
      assert.strictEqual((yield* c["Project.StartMain"]({})).harness, "cursor")
    }),
  )

  test(
    "Spawn by the main agent stores its id as parent; List returns that main agent first with its routing",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const raw = yield* client
      const cli = asCli(raw, repo)
      const routing = { decidedBy: { harness: "pick" }, trace: [] }
      const launched = yield* cli["Project.CoordinatorSession"]({
        harness: "pi",
        fresh: false,
        terminal: "test/p1",
        provider: "anthropic",
        model: "m",
        routing,
      })
      const main = yield* asSession(raw, launched.sessionId, repo)
      const { id } = yield* main.Spawn({ harness: "pi", prompt: "do it" })
      const { id: fromUser } = yield* cli.Spawn({ harness: "pi", prompt: "from the user" })
      const sql = yield* SqlClient.SqlClient
      const parentOf = (sessionId: string) =>
        sql<{ parentSessionId: string | null }>`SELECT parent_session_id FROM session WHERE id = ${sessionId}`.pipe(
          Effect.map((rows) => rows[0]!.parentSessionId),
        )
      assert.strictEqual(yield* parentOf(id), launched.sessionId)
      assert.isNull(yield* parentOf(fromUser))
      const listed = yield* main.List({})
      assert.deepInclude(listed[0], {
        id: launched.sessionId,
        name: "main",
        agent: "main",
        harness: "pi",
        provider: "anthropic",
        model: "m",
        status: "unknown",
      })
      assert.deepStrictEqual(listed[0]!.routing, routing)
      assert.deepStrictEqual(
        listed
          .slice(1)
          .map((row) => row.id)
          .sort(),
        [id, fromUser].sort(),
      )
    }),
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
      // Something else in the foreground of its shell: the runtime reports the main agent busy.
      yield* herdr.updateAgent(pane, (a) => ({ ...a, status: "working" }))
      assert.deepInclude((yield* c.List({}))[0], { agent: "main", status: "working" })
      // Back at its shell: `state` reports idle now (§3), a live status of its own.
      yield* herdr.updateAgent(pane, (a) => ({ ...a, status: "idle" }))
      assert.deepInclude((yield* c.List({}))[0], { agent: "main", status: "idle" })
    }),
  )
})
