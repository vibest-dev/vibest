import net from "node:net"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, incompatibleDaemon, protocolHeaders, withVibest } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { projectRoot } from "@vibest/core/project-create"
import { Sessions } from "@vibest/core/sessions"
import { Plugin } from "@vibest/plugin"
import { MISMATCH_ACTION, PROTOCOL, sessionHeaders } from "@vibest/protocol/protocol"
import { VibestRpcs, VERSION } from "@vibest/protocol/rpc"
import * as Server from "@vibest/server/server"
import { Cause, Effect, Exit, Fiber, FileSystem, Path, Ref, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { FakeGit, authed, FakeRuntime, makeRepository, tempDirectory, until, writeResult, projectOf } from "./fakes.ts"
import { served, test, client, asCli, asSession, failureTag } from "./rpc-helpers.ts"

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
      const { id } = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      assert.strictEqual((yield* Effect.flip(c.Get({ id: "nothing!" })))._tag, "NoSuchSession")
      assert.deepStrictEqual(yield* c.Send({ id: id.slice(0, 12), message: "more" }), { id })
      const peer = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: "beside it", peer: id.slice(0, 10) })
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
      const first = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: "do it", request: "spawn-1" })
      assert.deepStrictEqual(
        yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: "do it", request: "spawn-1" }),
        first,
      )
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
      const fit = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: exact })
      const { id } = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt })
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
      const { id } = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: "do it" })
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
      const { id } = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: "do it" })
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
      const { id } = yield* a.Spawn({ callerEnv: {}, harness: "pi", prompt: "do it" })
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
      const { id } = yield* a.Spawn({ callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      type Client = Effect.Success<typeof client>
      const protectedCalls = (
        c: Client,
      ): ReadonlyArray<readonly [string, Effect.Effect<unknown, { readonly _tag: string }>]> => [
        ["Spawn", c.Spawn({ callerEnv: {}, harness: "pi", prompt: "more" })],
        ["Launch", c.Launch({ callerEnv: {}, argv: [], focus: false })],
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
        ["Project.Create", c["Project.Create"]({ directory: "x", from: ["y"] })],
        ["Project.FocusCoordinator", c["Project.FocusCoordinator"]({})],
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
        ["Session.Ready", c["Session.Ready"]({ id: "07e40000-07e4-407e-807e-07e4000007e4" })],
        ["Agents.Outdated", c["Agents.Outdated"]()],
        ["Agents.Restart", c["Agents.Restart"]({ ids: [id] })],
        ["Integration.Guard", c["Integration.Guard"]({ harness: "pi", agent: "general", input: "{}" })],
      ]
      const bare = yield* client
      for (const [method, call] of protectedCalls(bare))
        assert.strictEqual(failureTag(yield* Effect.exit(call)), "ProtocolRejected", method)
      const w = yield* asSession(yield* client, id)
      for (const [method, call] of protectedCalls(w).filter(([m]) => m !== "Report" && m !== "Integration.Guard"))
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
    "one socket does not keep a caller: sequential and concurrent requests stay on their own headers",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const raw = yield* client
      const cli = asCli(raw, repo)
      const { id } = yield* cli.Spawn({ callerEnv: {}, harness: "pi", prompt: "do it" })
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
    "Project.StartMain schedules with the project directory, not its key; with no harness it fails until a main agent exists, then takes its harness",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const first = yield* Effect.flip(c["Project.StartMain"]({ runtime: "herdr" }))
      assert.strictEqual(first._tag, "LaunchFailed")
      assert.match(first.message, /no harness to inherit/)
      assert.strictEqual((yield* c["Project.StartMain"]({ runtime: "herdr", harness: "pi" })).harness, "pi")
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
      const { id } = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      yield* Ref.set(herdr.reachable, false)
      const failed = yield* Effect.flip(c.Remove({ id: id.slice(0, 8) }))
      assert.strictEqual(failed._tag, "RuntimeUnreachable")
      assert.strictEqual("session" in failed ? failed.session : failed._tag, id)
    }),
  )

  test(
    "archive refuses a main agent and names its project",
    Effect.gen(function* () {
      const db = yield* Db
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* db.coordinatorLaunch(projectId, "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "test/main" },
      })
      const main = (yield* db.coordinatorOf(projectId))!
      const failed = yield* Effect.flip(asCli(yield* client, repo).Remove({ id: main.id }))
      assert.strictEqual(failed._tag, "NoSuchSession")
      assert.strictEqual(
        "message" in failed ? failed.message : "",
        `${main.id} is the main agent of project ${path.basename(repo)}. Stop it in its terminal.`,
      )
    }),
  )

  test(
    "FocusCoordinator is null without a running main, and focuses one that is running",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      assert.strictEqual(yield* c["Project.FocusCoordinator"]({}), null)
      const projectId = yield* projectOf(repo)
      yield* db.coordinatorLaunch(projectId, "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "test/main" },
      })
      assert.strictEqual(yield* c["Project.FocusCoordinator"]({}), null)
      yield* herdr.seedAgent("test/main")
      const focused = yield* c["Project.FocusCoordinator"]({})
      assert.strictEqual(focused?.focused, true)
      assert.strictEqual((yield* herdr.callsTo("focus"))[0]?.terminal, "test/main")
    }),
  )

  test(
    "FocusCoordinator reports a runtime that cannot focus",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* db.coordinatorLaunch(projectId, "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "test/main" },
      })
      yield* herdr.seedAgent("test/main")
      const focused = yield* asCli(yield* client, repo)["Project.FocusCoordinator"]({})
      assert.strictEqual(focused?.focused, false)
      assert.strictEqual((yield* herdr.callsTo("focus")).length, 0)
    }),
    { noFocus: true },
  )

  test(
    "List outside any repository shows every project, and a repository with no project is empty",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const a = yield* makeRepository
      const b = yield* makeRepository
      const one = yield* asCli(yield* client, a).Spawn({ callerEnv: {}, harness: "pi", prompt: "one" })
      const two = yield* asCli(yield* client, b).Spawn({ callerEnv: {}, harness: "pi", prompt: "two" })
      const outside = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "vibest-outside-" }))
      const listed = yield* asCli(yield* client, outside).List({})
      assert.deepStrictEqual(listed.map((row) => row.id).sort(), [one.id, two.id].sort())
      const bare = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "vibest-bare-" }))
      yield* (yield* FakeGit).repository(bare, { branch: "main" })
      assert.deepStrictEqual(yield* asCli(yield* client, bare).List({}), [])
    }),
  )

  test(
    "--new with a missing harness does not archive the current main agent",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      yield* db.coordinatorLaunch(projectId, "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "test/main" },
      })
      const before = (yield* db.coordinatorOf(projectId))!.id
      const failed = yield* Effect.flip(
        asCli(yield* client, repo).Launch({
          callerEnv: {},
          argv: ["/bin/vibest", "--harness", "cursor", "--new"],
          focus: false,
          runtime: "herdr",
        }),
      )
      assert.ok(failed._tag === "LaunchFailed" || failed._tag === "AgentRefused", failed._tag)
      assert.strictEqual((yield* db.coordinatorOf(projectId))!.id, before)
    }),
    { missingBinary: ["cursor"] },
  )
})
