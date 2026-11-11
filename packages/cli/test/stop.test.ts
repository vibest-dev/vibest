import net from "node:net"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect, protocolHeaders } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import { Sessions } from "@vibest/core/sessions"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { CALLER_HEADER, PROJECT_HEADER, PROTOCOL, PROTOCOL_HEADER, SESSION_HEADER } from "@vibest/protocol/protocol"
import * as Server from "@vibest/server/server"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, type Scope, Stream } from "effect"

import * as Platform from "#platform"

import { TIMING } from "../src/replace.ts"
import {
  authed,
  FakeRuntime,
  FakeProcesses,
  makeRepository,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  untilVirtual,
  writeEnd,
  replyText,
} from "./fakes.ts"

const INSTANCE = "00000000-0000-4000-8000-000000000001"

const serve = (options: TestOptions = {}) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer({ ...options, identity: { instance: INSTANCE } })),
  )

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>,
  options?: TestOptions,
) => it.effect(name, () => program.pipe(Effect.provide(serve(options))))

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))
const cli = (repo: string) => Effect.map(client, (c) => authed(c, cliHeaders(repo)))

const errorOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
const tagOf = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  errorOf(exit)?._tag ?? (Exit.isSuccess(exit) ? "success" : "defect")

const stopFromCli = (repo: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit((yield* cli(repo))["Daemon.Stop"]({ instance: INSTANCE }))
    if (Exit.isSuccess(exit)) return "accepted" as const
    const e = errorOf(exit)
    return e?._tag === "DaemonBusy" ? e.blockers : (e?._tag ?? "defect")
  })

const shutdownDone = Effect.flatMap(Server.Shutdown, Deferred.isDone)
const draining = Effect.flatMap(Drain, (d) => until(d.phase, (p) => p === "draining"))
const stopOnceIdle = (repo: string) =>
  Effect.gen(function* () {
    yield* until((yield* Drain).pending, (p) => p.length === 0)
    return yield* joinAdvancingClock(yield* Effect.forkScoped(stopFromCli(repo)))
  })
const joinAdvancingClock = <A, E>(stopping: Fiber.Fiber<A, E>) =>
  untilVirtual(
    Effect.sync(() => stopping.pollUnsafe()),
    (exit) => exit !== undefined,
  ).pipe(Effect.andThen(Fiber.join(stopping)))

const idleMainWithWorker = (repo: string, harness: "pi" | "claude") =>
  Effect.gen(function* () {
    const db = yield* Db
    const herdr = yield* FakeRuntime
    yield* herdr.seedAgent("wC:p1")
    const raw = yield* client
    const { sessionId, projectId } = yield* authed(raw, cliHeaders(repo))["Project.CoordinatorSession"]({
      harness,
      fresh: true,
      terminal: "wC:p1",
    })
    if (harness === "claude") yield* db.reportCoordinatorSession(sessionId, "claude", "claude-session")
    const c = authed(raw, sessionHeaders({ sessionId, repositoryRoot: repo, projectId: String(projectId) }))
    const { id: worker } = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: "work" })
    yield* until(db.getSession(worker), (w) => w?.executionState === "open")
    return { db, herdr, c, sessionId, worker, projectId: (yield* db.projectOfSession(sessionId))! }
  })

describe("Daemon.Stop over a real unix socket: only vibestd's own operations block it; agents keep running and queued messages stay for the next vibestd", () => {
  it("the client waits for Stop's reply longer than vibestd's bounded drain", () => {
    assert.isTrue(Duration.isGreaterThan(TIMING.reply, Server.DRAIN_TIMEOUT))
  })

  test(
    "the command line only, for this vibestd's instance; once accepted, no change is admitted, settlement included",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { c } = yield* idleMainWithWorker(repo, "claude")
      const raw = yield* client
      assert.strictEqual(
        tagOf(yield* Effect.exit(authed(raw, cliHeaders(repo))["Daemon.Stop"]({ instance: "another" }))),
        "WrongInstance",
      )
      assert.strictEqual(tagOf(yield* Effect.exit(c["Daemon.Stop"]({ instance: INSTANCE }))), "Forbidden")
      assert.isFalse(yield* shutdownDone)

      assert.strictEqual(yield* stopOnceIdle(repo), "accepted")
      assert.isTrue(yield* shutdownDone)
      const user = yield* cli(repo)
      assert.strictEqual(
        tagOf(yield* Effect.exit(user.Spawn({ callerEnv: {}, harness: "pi", prompt: "x" }))),
        "DaemonStopping",
      )
      assert.strictEqual(
        tagOf(
          yield* Effect.exit(
            user["Project.CoordinatorSession"]({ harness: "claude", fresh: true, terminal: "test/late" }),
          ),
        ),
        "DaemonStopping",
      )
      assert.strictEqual(
        tagOf(
          yield* Effect.exit(
            raw.ExecutionEnd({ sessionId: "x", harness: "pi", event: "{}" }, { headers: protocolHeaders() }),
          ),
        ),
        "DaemonStopping",
      )
      assert.strictEqual(yield* stopFromCli(repo), "DaemonStopping")
      assert.isAbove((yield* user.List({})).sessions.length, 0, "reads still answer")
    }),
  )

  test(
    "working agents, a busy main agent, an open subscription and queued messages neither block nor change",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { db, herdr, c, worker } = yield* idleMainWithWorker(repo, "pi")
      yield* herdr.updateAgent("wC:p1", (a) => ({ ...a, status: "working" }))
      const user = yield* cli(repo)
      yield* user.Send({ id: worker, message: "keep the exact task" })
      const pending = yield* db.pendingInbox(worker)
      const session = yield* db.getSession(worker)
      const closed = yield* herdr.callsTo("close")
      const sub = yield* Effect.forkScoped(Stream.runDrain(c["Inbox.Subscribe"](undefined)))
      assert.strictEqual(yield* stopOnceIdle(repo), "accepted")
      yield* Fiber.interrupt(sub)
      assert.lengthOf(pending, 1)
      assert.strictEqual(pending[0]!.message, "keep the exact task")
      assert.deepStrictEqual(yield* db.pendingInbox(worker), pending)
      assert.deepStrictEqual(yield* db.getSession(worker), session)
      assert.deepStrictEqual(yield* herdr.callsTo("close"), closed)
    }),
  )

  test(
    "a spawn still opening its terminal blocks until the drain times out; reopening does not cancel it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const repo = yield* makeRepository
      const user = yield* cli(repo)
      const held = yield* herdr.hold("open")
      const { id } = yield* user.Spawn({ callerEnv: {}, harness: "pi", prompt: "work" })
      yield* held.reached
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      assert.strictEqual(
        tagOf(yield* Effect.exit(user.Send({ id: "00000000-0000-4000-8000-000000000000", message: "x" }))),
        "DaemonStopping",
      )
      const refused = yield* joinAdvancingClock(stopping)
      assert.include(JSON.stringify(refused), `spawn ${id}`)
      assert.strictEqual(yield* (yield* Drain).phase, "open")
      assert.isFalse(yield* shutdownDone)
      yield* held.release()
      yield* until(db.getSession(id), (s) => s?.executionState === "open")
      assert.strictEqual(yield* stopOnceIdle(repo), "accepted")
    }),
  )

  test(
    "a Stop is accepted as the last operation leaves, with no clock advance",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const held = yield* herdr.hold("open")
      yield* (yield* cli(repo)).Spawn({ callerEnv: {}, harness: "pi", prompt: "work" })
      yield* held.reached
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      yield* held.release()
      assert.strictEqual(yield* Fiber.join(stopping), "accepted")
    }),
  )

  test(
    "a spawn's execution start and end from its harness hook settle while draining (a fast execution the runtime never shows working): the end first keeps the drain open for the unconfirmed launch, then the launch confirms and the Stop is accepted",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const raw = yield* client
      const { id } = yield* (yield* cli(repo)).Spawn({ callerEnv: {}, harness: "pi", prompt: "work" })
      yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text?.includes("work") === true))
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      const piExtensionHook = (call: "Prompt" | "ExecutionEnd", event: object) =>
        Effect.forkScoped(
          Effect.exit(
            raw[call]({ sessionId: id, harness: "pi", event: JSON.stringify(event) }, { headers: protocolHeaders() }),
          ),
        )
      const ended = yield* piExtensionHook("ExecutionEnd", {
        type: "agent_settled",
        text: "done",
        error: "",
        aborted: false,
      })
      assert.strictEqual(tagOf(yield* Fiber.join(ended)), "success")
      const prompted = yield* piExtensionHook("Prompt", { type: "input", text: "work", source: "interactive" })
      assert.strictEqual(yield* joinAdvancingClock(stopping), "accepted")
      assert.strictEqual(tagOf(yield* Fiber.join(prompted)), "success")
      assert.include(yield* replyText(id), "done")
    }),
    { promptsIgnored: true },
  )

  test(
    "a Send and a Pi arrival deferred by the drain wake after a refused Stop, with nothing failed",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { db, herdr, c, worker } = yield* idleMainWithWorker(repo, "pi")
      const sessions = yield* Sessions
      const drain = yield* Drain
      yield* herdr.endExecution(worker)
      yield* writeEnd(worker, "pi", { text: "status: completed" })
      yield* sessions.check(worker)
      const got: Array<string> = []
      const subscribed = yield* Effect.forkScoped(
        c["Inbox.Subscribe"](undefined).pipe(
          Stream.runForEach((body) =>
            Effect.sync(() => {
              got.push(body)
            }),
          ),
        ),
      )
      yield* until(db.getSession(worker), (w) => w?.executionState === "completed")
      const leave = drain.track("held short operation")
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      yield* sessions.send(worker, "after reopen")
      yield* (yield* Inbox).enqueue({
        sessionId: worker,
        message: "arrival while draining",
      })
      assert.isArray(yield* joinAdvancingClock(stopping))
      yield* leave
      yield* until(db.inboxWithStatus(worker, "delivered"), (rows) => rows.some((r) => r.message === "after reopen"))
      yield* until(
        Effect.sync(() => got),
        (bodies) => bodies.some((b) => b.includes("arrival while draining")),
      )
      assert.deepStrictEqual(yield* db.inboxWithStatus(worker, "failed"), [])
      yield* Fiber.interrupt(subscribed)
    }),
  )

  test(
    "an archive running inside vibestd is counted past its terminal's close; a refusal leaves it running",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const { id } = yield* (yield* cli(repo)).Spawn({ callerEnv: {}, harness: "pi", prompt: "work" })
      yield* until(db.getSession(id), (w) => w?.executionState === "open")
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      const held = yield* (yield* FakeProcesses).holdCwd()
      const removing = yield* Effect.forkScoped(sessions.remove(id))
      yield* held.reached
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      assert.include(JSON.stringify(yield* joinAdvancingClock(stopping)), `session ${id}`)
      assert.isUndefined(removing.pollUnsafe())
      yield* held.release()
      yield* Fiber.join(removing)
      assert.strictEqual(yield* stopOnceIdle(repo), "accepted")
    }),
  )

  test(
    "a Pi batch on the wire blocks until its ACK; the drained close fails nothing",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { db, sessionId, worker, projectId } = yield* idleMainWithWorker(repo, "pi")
      const layout = yield* Layout
      const socket = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<net.Socket>((resolve, reject) => {
              const s = net.connect(layout.socket)
              s.on("error", reject)
              s.once("connect", () => resolve(s))
            }),
        ),
        (s) =>
          Effect.sync(() => {
            s.destroy()
          }),
      )
      const headers = [
        [PROTOCOL_HEADER, String(PROTOCOL)],
        [CALLER_HEADER, "session"],
        [SESSION_HEADER, sessionId],
        [PROJECT_HEADER, String(projectId)],
      ]
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: "s", method: "Inbox.Subscribe", params: null, headers }) + "\n")
      yield* (yield* Inbox).enqueue({ sessionId: worker, message: "held" })
      yield* until(db.latestInbox(worker, "notice"), (r) => r?.status === "sending")
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      assert.isFalse(yield* shutdownDone)
      socket.write(JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Ack", params: { requestId: "s" } }) + "\n")
      yield* until(db.latestInbox(worker, "notice"), (r) => r?.status === "delivered")
      assert.strictEqual(yield* joinAdvancingClock(stopping), "accepted")
      socket.destroy()
      assert.strictEqual((yield* db.latestInbox(worker, "notice"))?.status, "delivered")
    }),
  )

  test(
    "a Claude ack settles a batch already leased while the Stop drains",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { db, worker, projectId } = yield* idleMainWithWorker(repo, "claude")
      const inbox = yield* Inbox
      yield* inbox.enqueue({ sessionId: worker, message: "ack" })
      const polled = yield* until(inbox.poll(projectId), (r) => r.ids.length > 0)
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, [], "a poll while draining hands out nothing new")
      assert.deepStrictEqual(yield* inbox.ack(projectId, polled.ids), polled.ids)
      assert.strictEqual((yield* db.latestInbox(worker, "notice"))?.status, "delivered")
      assert.strictEqual(yield* joinAdvancingClock(stopping), "accepted")
    }),
  )

  test(
    "a client that stops waiting for its Stop cancels it: the drain ends and changes are admitted again, its operation untouched",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const drain = yield* Drain
      const leave = drain.track("still running")
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      yield* Fiber.interrupt(stopping)
      yield* until(drain.phase, (phase) => phase === "open")
      assert.include(yield* drain.pending, "still running")
      const user = yield* cli(repo)
      assert.strictEqual(
        tagOf(yield* Effect.exit(user.Send({ id: "00000000-0000-4000-8000-000000000000", message: "x" }))),
        "NoSuchSession",
      )
      yield* leave
      assert.isFalse(yield* shutdownDone)
    }),
  )
})
