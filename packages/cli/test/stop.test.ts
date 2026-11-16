import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect, protocolHeaders } from "@vibest/client/client"
import { Db } from "@vibest/core/database/db"
import { executionStateOf } from "@vibest/core/database/db-rows"
import { Drain } from "@vibest/core/drain"
import { Inbox } from "@vibest/core/inbox"
import { Project } from "@vibest/core/project"
import { Session } from "@vibest/core/session"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { Layout } from "@vibest/schema/layout"
import { DaemonHandlers } from "@vibest/server/handlers/daemon"
import * as Server from "@vibest/server/server"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, type Scope, Stream } from "effect"

import * as Platform from "#platform"

import {
  authed,
  CLAUDE,
  CURSOR,
  FakeRuntime,
  PI,
  FakeProcesses,
  makeRepository,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  untilVirtual,
  writeEnd,
} from "./fakes.ts"
import { asEntry } from "./rpc-helpers.ts"

const INSTANCE = "00000000-0000-4000-8000-000000000001"

const serve = (options: TestOptions = {}) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer({ ...options, identity: { instance: INSTANCE } })),
  )

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Project.Service | Scope.Scope>,
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

const shutdownDone = Effect.flatMap(DaemonHandlers.Shutdown, Deferred.isDone)
const draining = Effect.flatMap(Drain.Service, (d) => until(d.phase, (p) => p === "draining"))
const stopOnceIdle = (repo: string) =>
  Effect.gen(function* () {
    yield* until((yield* Drain.Service).pending, (p) => p.length === 0)
    return yield* joinAdvancingClock(yield* Effect.forkScoped(stopFromCli(repo)))
  })
const joinAdvancingClock = <A, E>(stopping: Fiber.Fiber<A, E>) =>
  untilVirtual(
    Effect.sync(() => stopping.pollUnsafe()),
    (exit) => exit !== undefined,
  ).pipe(Effect.andThen(Fiber.join(stopping)))

const idleMainWithWorker = (repo: string, harness: "pi" | "claude") =>
  Effect.gen(function* () {
    const db = yield* Db.Service
    const herdr = yield* FakeRuntime
    yield* herdr.seedAgent("wC:p1")
    const raw = yield* client
    const { sessionId, projectId } = yield* authed(raw, cliHeaders(repo))["Project.EntrySession"]({
      agent: "coordinator",
      harness,
      fresh: true,
      terminal: "wC:p1",
    })
    if (harness === "claude") yield* db.session.noteConversation(sessionId, "claude-session")
    const c = authed(raw, sessionHeaders({ sessionId, repositoryRoot: repo, projectId: String(projectId) }))
    const { id: worker } = yield* c.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "work" })
    yield* until(db.session.getSession(worker), (w) => (w ? executionStateOf(w) : undefined) === "open")
    return { db, herdr, c, sessionId, worker, projectId: (yield* db.session.projectOfSession(sessionId))! }
  })

describe("Daemon.Stop over a real unix socket: only vibestd's own operations block it; agents keep running and queued messages stay for the next vibestd", () => {
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
        tagOf(yield* Effect.exit(user.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "x" }))),
        "DaemonStopping",
      )
      assert.strictEqual(
        tagOf(
          yield* Effect.exit(
            user["Project.EntrySession"]({
              agent: "coordinator",
              harness: "claude",
              fresh: true,
              terminal: "test/late",
            }),
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
    "working agents, a busy entry session, an open subscription and queued messages neither block nor change",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { db, herdr, c, worker } = yield* idleMainWithWorker(repo, "pi")
      yield* herdr.updateAgent("wC:p1", (a) => ({ ...a, status: "working" }))
      const user = yield* cli(repo)
      yield* user.Send({ id: worker, message: "keep the exact task" })
      const pending = yield* db.inbox.pendingInbox(worker)
      const session = yield* db.session.getSession(worker)
      const closed = yield* herdr.callsTo("close")
      const sub = yield* Effect.forkScoped(Stream.runDrain(c["Inbox.Subscribe"](undefined)))
      assert.strictEqual(yield* stopOnceIdle(repo), "accepted")
      yield* Fiber.interrupt(sub)
      assert.lengthOf(pending, 1)
      assert.strictEqual(pending[0]!.message, "keep the exact task")
      assert.deepStrictEqual(yield* db.inbox.pendingInbox(worker), pending)
      assert.deepStrictEqual(yield* db.session.getSession(worker), session)
      assert.deepStrictEqual(yield* herdr.callsTo("close"), closed)
    }),
  )

  test(
    "a spawn still opening its terminal blocks until the drain times out; reopening does not cancel it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const repo = yield* makeRepository
      const user = yield* cli(repo)
      const spawner = yield* asEntry(yield* client, repo)
      const held = yield* herdr.hold("open")
      const { id } = yield* spawner.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "work" })
      yield* held.reached
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      assert.strictEqual(
        tagOf(yield* Effect.exit(user.Send({ id: "00000000-0000-4000-8000-000000000000", message: "x" }))),
        "DaemonStopping",
      )
      const refused = yield* joinAdvancingClock(stopping)
      assert.include(JSON.stringify(refused), `spawn ${id}`)
      assert.strictEqual(yield* (yield* Drain.Service).phase, "open")
      assert.isFalse(yield* shutdownDone)
      yield* held.release()
      yield* until(db.session.getSession(id), (s) => (s ? executionStateOf(s) : undefined) === "open")
      assert.strictEqual(yield* stopOnceIdle(repo), "accepted")
    }),
  )

  test(
    "a Stop is accepted as the last operation leaves, with no clock advance",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const held = yield* herdr.hold("open")
      yield* (yield* asEntry(yield* client, repo)).Spawn({
        agent: "general",
        callerEnv: {},
        harness: "pi",
        prompt: "work",
      })
      yield* held.reached
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      yield* held.release()
      assert.strictEqual(yield* Fiber.join(stopping), "accepted")
    }),
  )

  test(
    "a spawn's start report from its harness hook settles while draining (a fast execution the runtime never shows working): it confirms the launch and the Stop is accepted",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const raw = yield* client
      const { id } = yield* (yield* asEntry(yield* client, repo)).Spawn({
        agent: "general",
        callerEnv: {},
        harness: "pi",
        prompt: "work",
      })
      yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text?.includes("work") === true))
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      const piExtensionHook = (call: "Prompt", event: object) =>
        Effect.forkScoped(
          Effect.exit(
            raw[call]({ sessionId: id, harness: "pi", event: JSON.stringify(event) }, { headers: protocolHeaders() }),
          ),
        )
      const prompted = yield* piExtensionHook("Prompt", { type: "input", text: "work", source: "interactive" })
      assert.strictEqual(tagOf(yield* Fiber.join(prompted)), "success")
      assert.strictEqual(yield* joinAdvancingClock(stopping), "accepted")
      assert.isTrue(yield* (yield* Db.Service).session.executionAccepted(id))
    }),
    { promptsIgnored: true },
  )

  test(
    "a Send deferred by the drain wakes after a refused Stop, with nothing failed",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { db, herdr, worker } = yield* idleMainWithWorker(repo, "pi")
      const sessions = yield* Session.Service
      const drain = yield* Drain.Service
      yield* herdr.endExecution(worker)
      yield* writeEnd(worker, "pi", { text: "status: completed" })
      yield* sessions.check(worker)
      yield* until(db.session.getSession(worker), (w) => (w ? executionStateOf(w) : undefined) === "completed")
      const leave = drain.track("held short operation")
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      yield* sessions.send(worker, "after reopen")
      assert.isArray(yield* joinAdvancingClock(stopping))
      yield* leave
      yield* until(db.inbox.inboxWithStatus(worker, "delivered"), (rows) =>
        rows.some((r) => r.message === "after reopen"),
      )
      assert.deepStrictEqual(yield* db.inbox.inboxWithStatus(worker, "failed"), [])
    }),
  )

  test(
    "an archive running inside vibestd is counted past its terminal's close; a refusal leaves it running",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      const { id } = yield* (yield* asEntry(yield* client, repo)).Spawn({
        agent: "general",
        callerEnv: {},
        harness: "pi",
        prompt: "work",
      })
      yield* until(db.session.getSession(id), (w) => (w ? executionStateOf(w) : undefined) === "open")
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
    "a take while the Stop drains hands out nothing; after a refused Stop it hands out the batch",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { sessionId } = yield* idleMainWithWorker(repo, "claude")
      const inbox = yield* Inbox.Service
      const drain = yield* Drain.Service
      yield* (yield* Db.Service).inbox.insertNoticeTo(sessionId, "wait")
      const leave = drain.track("held short operation")
      const stopping = yield* Effect.forkScoped(stopFromCli(repo))
      yield* draining
      assert.isUndefined(yield* inbox.take(sessionId, undefined))
      assert.isArray(yield* joinAdvancingClock(stopping))
      yield* leave
      assert.lengthOf((yield* inbox.take(sessionId, undefined))!.ids, 1)
    }),
    { harnesses: [{ ...CLAUDE, inbox: "poll" }, PI, CURSOR] },
  )

  test(
    "a client that stops waiting for its Stop cancels it: the drain ends and changes are admitted again, its operation untouched",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const drain = yield* Drain.Service
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
