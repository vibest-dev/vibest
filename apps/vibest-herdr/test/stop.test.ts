// Daemon.Stop (issue #80): a planned replacement over the RPC server on a real unix socket and the fake runtime. Only
// vibestd's own operations block it (core/drain.ts); agents keep running and queued Messages stay for the next vibestd.
import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import { Sessions } from "@vibest/core/sessions"
import { sessionHeaders } from "@vibest/protocol/protocol"
import * as Http from "@vibest/server/http"
import * as Server from "@vibest/server/server"
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schedule,
  type Scope,
} from "effect"
import * as Headers from "effect/http/Headers"

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
  writeResult,
} from "./fakes.ts"

const INSTANCE = "00000000-0000-4000-8000-000000000001"

const serve = (options: TestOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const shutdown = yield* Deferred.make<void>()
      return Server.layer.pipe(
        Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(Server.Identity, { instance: INSTANCE }),
            Layer.succeed(Server.Shutdown, shutdown),
          ),
        ),
        Layer.provideMerge(Project.layer),
        Layer.provideMerge(testLayer(options)),
      )
    }),
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

/** One Stop from the command line: "accepted", or what blocks it, or the refusal's tag. */
const stop = (repo: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit((yield* cli(repo))["Daemon.Stop"]({ instance: INSTANCE }))
    if (Exit.isSuccess(exit)) return "accepted" as const
    const e = errorOf(exit)
    return e?._tag === "DaemonBusy" ? e.blockers : (e?._tag ?? "defect")
  })

const shutdownDone = Effect.flatMap(Server.Shutdown, Deferred.isDone)
const draining = Effect.flatMap(Drain, (d) => until(d.phase, (p) => p === "draining"))
/** Once nothing is pending, one Stop on a moving clock (its drain polls on the clock). */
const stopOnceIdle = (repo: string) =>
  Effect.gen(function* () {
    yield* until((yield* Drain).pending, (p) => p.length === 0)
    return yield* settled(yield* Effect.forkScoped(stop(repo)))
  })
/** A forked Stop's answer, moving virtual time (its drain polls and times out on the clock) until it has one. */
const settled = <A, E>(stopping: Fiber.Fiber<A, E>) =>
  untilVirtual(
    Effect.sync(() => stopping.pollUnsafe()),
    (exit) => exit !== undefined,
  ).pipe(Effect.andThen(Fiber.join(stopping)))

/** A main agent of `harness` registered at terminal wC:p1 (idle), its session client, and a working worker in its project. */
const receiver = (repo: string, harness: "pi" | "claude") =>
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
    const { id: worker } = yield* c.Spawn({ harness: "pi", prompt: "work" })
    yield* until(db.getSession(worker), (w) => w?.turnState === "open")
    return { db, herdr, c, sessionId, worker, projectId: (yield* db.projectOfSession(sessionId))! }
  })

describe("Daemon.Stop", () => {
  it("the client waits for Stop's reply longer than vibestd's bounded drain", () => {
    assert.isTrue(Duration.isGreaterThan(TIMING.reply, Server.DRAIN_TIMEOUT))
  })

  test(
    "the command line only, for this vibestd's instance; once accepted, no change is admitted, settlement included",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { c } = yield* receiver(repo, "claude")
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
      assert.strictEqual(tagOf(yield* Effect.exit(user.Spawn({ harness: "pi", prompt: "x" }))), "DaemonStopping")
      assert.strictEqual(
        tagOf(
          yield* Effect.exit(
            user["Project.CoordinatorSession"]({ harness: "claude", fresh: true, terminal: "test/late" }),
          ),
        ),
        "DaemonStopping",
      )
      assert.strictEqual(yield* stop(repo), "DaemonStopping")
      // Reads still answer.
      assert.isAbove((yield* user.List({})).length, 0)
    }),
  )

  test(
    "working agents, a busy main agent and queued messages neither block nor change",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { db, herdr, worker } = yield* receiver(repo, "pi")
      yield* herdr.updateAgent("wC:p1", (a) => ({ ...a, status: "working" }))
      const user = yield* cli(repo)
      yield* user.Send({ id: worker, message: "keep the exact task" })
      const pending = yield* db.pendingInbox(worker)
      const session = yield* db.getSession(worker)
      const closed = yield* herdr.callsTo("close")
      assert.strictEqual(yield* stopOnceIdle(repo), "accepted")
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
      const { id } = yield* user.Spawn({ harness: "pi", prompt: "work" })
      yield* held.reached
      const stopping = yield* Effect.forkScoped(stop(repo))
      yield* draining
      assert.strictEqual(
        tagOf(
          yield* Effect.exit(user["Project.Write"]({ kind: "memory", path: "a.md", content: "x", ifVersion: "new" })),
        ),
        "DaemonStopping",
      )
      const refused = yield* settled(stopping)
      assert.include(JSON.stringify(refused), `spawn ${id}`)
      assert.strictEqual(yield* (yield* Drain).phase, "open")
      assert.isFalse(yield* shutdownDone)
      yield* held.release()
      yield* until(db.getSession(id), (s) => s?.turnState === "open")
      assert.strictEqual(yield* stopOnceIdle(repo), "accepted")
    }),
  )

  test(
    "a spawn's turn start and end from its harness hook settle while draining: the launch confirms and the Stop is accepted",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const layout = yield* Layout
      const repo = yield* makeRepository
      // The runtime never shows the turn working (a fast turn), so the hook's start line is the launch's only pickup proof.
      const { id } = yield* (yield* cli(repo)).Spawn({ harness: "pi", prompt: "work" })
      yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text?.includes("work") === true))
      const stopping = yield* Effect.forkScoped(stop(repo))
      yield* draining
      // What the Pi extension sends to /events for that turn's `input` and `agent_settled`.
      const handle = yield* Http.make
      const projectId = String((yield* (yield* Db).sessionIdentity(id))!.projectId)
      const hook = (event: object) =>
        Effect.forkScoped(
          handle({
            path: "/events",
            headers: Headers.fromInput(sessionHeaders({ sessionId: id, projectId, harness: "pi" })),
            body: JSON.stringify(event),
          }),
        )
      const prompted = yield* hook({ type: "turn.start", origin: "typed", text: "work" })
      const ended = yield* hook({ type: "turn.end", outcome: "completed", text: "done" })
      assert.strictEqual(yield* settled(stopping), "accepted")
      assert.strictEqual((yield* Fiber.join(prompted)).status, 204)
      assert.strictEqual((yield* Fiber.join(ended)).status, 204)
      assert.include(yield* (yield* FileSystem.FileSystem).readFileString(layout.resultFile(id)), "done")
    }),
    { promptsIgnored: true },
  )

  test(
    "a Send and a Pi arrival deferred by the drain wake after a refused Stop, with nothing failed",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { db, herdr, worker, projectId } = yield* receiver(repo, "pi")
      const sessions = yield* Sessions
      const drain = yield* Drain
      yield* herdr.endTurn(worker)
      yield* writeResult(worker, "pi", { text: "status: completed" })
      yield* sessions.check(worker)
      // What the Pi extension does: poll, take the batch, ack it.
      const inbox = yield* Inbox
      const got: Array<string> = []
      const polling = yield* Effect.forkScoped(
        Effect.gen(function* () {
          const batch = yield* inbox.poll(projectId)
          if (batch.ids.length === 0) return
          got.push(batch.text)
          yield* inbox.ack(projectId, batch.ids)
        }).pipe(Effect.repeat(Schedule.spaced("20 millis"))),
      )
      yield* until(db.latestInbox(worker, "result"), (r) => r?.status === "delivered")
      const leave = drain.track("held short operation")
      const stopping = yield* Effect.forkScoped(stop(repo))
      yield* draining
      // An already-admitted Send whose fork reaches the session lock after the cut.
      yield* sessions.send(worker, "after reopen")
      yield* inbox.enqueue({
        sessionId: worker,
        kind: "report",
        message: "arrival while draining",
        details: {},
      })
      assert.isArray(yield* settled(stopping))
      yield* leave
      yield* until(db.inboxWithStatus(worker, "delivered"), (rows) => rows.some((r) => r.message === "after reopen"))
      yield* until(
        Effect.sync(() => got),
        (bodies) => bodies.some((b) => b.includes("arrival while draining")),
      )
      assert.deepStrictEqual(yield* db.inboxWithStatus(worker, "failed"), [])
      yield* Fiber.interrupt(polling)
    }),
  )

  test(
    "a delivered row stays counted until its completion work is done",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { db, worker, projectId } = yield* receiver(repo, "pi")
      // A second Inbox with no taker, to stop at the queue-to-consumer seam.
      const inbox = Context.get(yield* Layer.build(Layer.fresh(Inbox.layer)), Inbox)
      const row = yield* inbox.enqueue({ sessionId: worker, kind: "report", message: "completion", details: {} })
      const polled = yield* until(inbox.poll(projectId), (r) => r.ids.length > 0)
      yield* inbox.ack(projectId, polled.ids)
      yield* until(db.latestInbox(worker, "report"), (r) => r?.status === "delivered")
      const stopping = yield* Effect.forkScoped(stop(repo))
      yield* draining
      assert.include(yield* (yield* Drain).pending, `completion inbox ${row.id}`)
      assert.isFalse(yield* shutdownDone)
      const consequence = yield* inbox.delivered
      assert.strictEqual(consequence.row.id, row.id)
      yield* consequence.done
      assert.strictEqual(yield* settled(stopping), "accepted")
    }),
  )

  test(
    "an archive running inside vibestd is counted past its terminal's close; a refusal leaves it running",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const { id } = yield* (yield* cli(repo)).Spawn({ harness: "pi", prompt: "work" })
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const held = yield* (yield* FakeProcesses).holdCwd()
      const removing = yield* Effect.forkScoped(sessions.remove(id))
      yield* held.reached
      const stopping = yield* Effect.forkScoped(stop(repo))
      yield* draining
      assert.include(JSON.stringify(yield* settled(stopping)), `session ${id}`)
      assert.isUndefined(removing.pollUnsafe())
      yield* held.release()
      yield* Fiber.join(removing)
      assert.strictEqual(yield* stopOnceIdle(repo), "accepted")
    }),
  )

  test(
    "a Claude ack settles a batch already leased while the Stop drains",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const { db, worker, projectId } = yield* receiver(repo, "claude")
      const inbox = yield* Inbox
      yield* inbox.enqueue({ sessionId: worker, kind: "report", message: "ack", details: {} })
      const polled = yield* until(inbox.poll(projectId), (r) => r.ids.length > 0)
      const stopping = yield* Effect.forkScoped(stop(repo))
      yield* draining
      // A poll while draining hands out nothing new.
      assert.deepStrictEqual((yield* inbox.poll(projectId)).ids, [])
      assert.deepStrictEqual(yield* inbox.ack(projectId, polled.ids), polled.ids)
      assert.strictEqual((yield* db.latestInbox(worker, "report"))?.status, "delivered")
      assert.strictEqual(yield* settled(stopping), "accepted")
    }),
  )

  test(
    "a client that stops waiting for its Stop cancels it: the drain ends and changes are admitted again, its operation untouched",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const drain = yield* Drain
      const leave = drain.track("still running")
      const stopping = yield* Effect.forkScoped(stop(repo))
      yield* draining
      yield* Fiber.interrupt(stopping)
      yield* until(drain.phase, (phase) => phase === "open")
      assert.include(yield* drain.pending, "still running")
      const user = yield* cli(repo)
      assert.strictEqual(
        tagOf(
          yield* Effect.exit(user["Project.Write"]({ kind: "memory", path: "b.md", content: "x", ifVersion: "new" })),
        ),
        "success",
      )
      yield* leave
      assert.isFalse(yield* shutdownDone)
    }),
  )
})
