import { assert, describe } from "@effect/vitest"
import { protocolHeaders } from "@vibest/client/client"
import { withHeaders } from "@vibest/client/unix-http"
import { InboxStore } from "@vibest/core/inbox/store"
import { SessionStore } from "@vibest/core/session/store"
import { ACCESS } from "@vibest/protocol/access"
import { VibestApi } from "@vibest/protocol/api"
import { EdgeMutual } from "@vibest/protocol/schemas"
import { FakeRuntime, makeRepository, until } from "@vibest/testkit/fakes"
import { asCli, asEntry, asSession, client, failureTag, test } from "@vibest/testkit/rpc-helpers"
import { Effect, Stream } from "effect"

describe("vibest.sock access and endpoint coverage", () => {
  test(
    "every protected method: no protocol and a session are refused; notifications need protocol only",
    Effect.gen(function* () {
      const sessionStore = yield* SessionStore.Service
      const repo = yield* makeRepository

      const asEntryPane = (root: string, paneId: string) =>
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

      const a = yield* asEntryPane(repo, "p1")

      const { id } = yield* a["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* until(
        sessionStore.getSession(id),
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
        ["mcp.list", c["server.mcp"]["mcp.list"]({ query: {} })],
        [
          "mcp.add",
          c["server.mcp"]["mcp.add"]({
            params: { server: "demo" },
            payload: { type: "local", command: ["echo"] },
          }),
        ],
        ["mcp.remove", c["server.mcp"]["mcp.remove"]({ params: { server: "demo" } })],
        ["mcp.connect", c["server.mcp"]["mcp.connect"]({ params: { server: "demo" }, payload: {} })],
        ["mcp.disconnect", c["server.mcp"]["mcp.disconnect"]({ params: { server: "demo" } })],
        ["mcp.tools", c["server.mcp"]["mcp.tools"]({ query: {} })],
        ["mcp.search", c["server.mcp"]["mcp.search"]({ query: { q: "x" } })],
        ["mcp.describe", c["server.mcp"]["mcp.describe"]({ params: { server: "demo", tool: "t" }, query: {} })],
        ["mcp.call", c["server.mcp"]["mcp.call"]({ params: { server: "demo", tool: "t" }, payload: {} })],
        ["mcp.events", c["server.mcp"]["mcp.events"]({ params: { server: "demo" }, query: {} })],
        ["mcp.skills", c["server.mcp"]["mcp.skills"]({ params: { server: "demo" }, query: {} })],
        ["mcp.read", c["server.mcp"]["mcp.read"]({ params: { server: "demo" }, payload: { uri: "skill://a" } })],
        ["mcp.authStart", c["server.mcp"]["mcp.authStart"]({ params: { server: "demo" } })],
        [
          "mcp.authComplete",
          c["server.mcp"]["mcp.authComplete"]({ params: { server: "demo" }, payload: { redirectUrlOrCode: "c" } }),
        ],
        [
          "mcp.authSetToken",
          c["server.mcp"]["mcp.authSetToken"]({ params: { server: "demo" }, payload: { accessToken: "t" } }),
        ],
        ["mcp.authLogout", c["server.mcp"]["mcp.authLogout"]({ params: { server: "demo" } })],
        ["codemode.execute", c["server.codemode"]["codemode.execute"]({ payload: { code: "return 1;" } })],
        ["codemode.declarations", c["server.codemode"]["codemode.declarations"]({ query: {} })],
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
      const entryBefore = yield* sessionStore.latestRoot((yield* sessionStore.getSession(id))!.projectId)

      const entryCalls: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        w["server.session"]["session.claim"]({
          payload: { agent: "coordinator", harness: "pi", fresh: true, terminal: { id: "test/p1" } },
        }),
        w["server.session"]["session.attach"]({ payload: { callerEnv: {} } }),
        w["server.session"]["session.focus"]({}),
        w["server.session"]["session.launch"]({ payload: { agent: "coordinator", callerEnv: {}, focus: false } }),
      ]

      for (const call of entryCalls) assert.strictEqual(failureTag(yield* Effect.exit(call)), "Forbidden")
      assert.deepStrictEqual(
        yield* sessionStore.latestRoot((yield* sessionStore.getSession(id))!.projectId),
        entryBefore,
      )

      const child = yield* w["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "from a session" },
      })

      assert.deepStrictEqual(yield* sessionStore.creatorOf(child.id), { local: id })

      yield* a["server.hook"]["hook.ready"]({ payload: {} })
      yield* w["server.hook"]["hook.ready"]({ payload: { pid: 4242 } })
      assert.isDefined(yield* sessionStore.readyAt(id))
      assert.strictEqual((yield* sessionStore.getSession(id))!.process?.pid, 4242)

      yield* withHeaders(bare["server.plugin"]["plugin.list"]({}), protocolHeaders())
      assert.isArray(yield* w["server.mcp"]["mcp.list"]({ query: {} }))
      assert.isString((yield* w["server.codemode"]["codemode.declarations"]({ query: {} })).declarations)
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
      const sessionStore = yield* SessionStore.Service
      const inboxStore = yield* InboxStore.Service
      const repo = yield* makeRepository
      const raw = yield* client
      const cli = asCli(raw, repo)
      const spawner = yield* asEntry(raw, repo)

      const { id } = yield* spawner["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* until(
        sessionStore.getSession(id),
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
      assert.match((yield* inboxStore.latestInbox(entry, "send"))!.message, /first/)
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
      assert.match((yield* inboxStore.latestInbox(entry, "send"))!.message, /second/)
    }),
  )
})
