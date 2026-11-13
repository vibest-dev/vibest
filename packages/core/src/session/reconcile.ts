import { shortId } from "@vibest/schema/id"
import { Clock, Context, Duration, Effect, Layer, Option, Ref } from "effect"

import { Bus, type EngineEvent } from "../bus.ts"
import {
  Db,
  type SessionRow,
  sessionEnded,
  harnessIdOf,
  runtimeOf,
  terminalOf,
  exitedAt,
  executionStateOf,
  executionStartedAt,
  archived,
} from "../db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import * as Engine from "../engine.ts"
import { Harnesses } from "../harness.ts"
import { Inbox } from "../inbox.ts"
import { Processes } from "../processes.ts"
import { agentState, alive, paneTail, peekHint, Runtimes, stateOf, type Terminal } from "../runtimes.ts"
import { Archive } from "./archive.ts"
import { Delivery } from "./delivery.ts"
import { CONFIRM_TIMEOUT } from "./executions.ts"
import { Exits } from "./exits.ts"
import { SessionLive } from "./live.ts"
import { SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"

export const START_TIMEOUT = Duration.seconds(120)
export const HOOK_GRACE = Duration.seconds(10)

const make = Effect.gen(function* () {
  const db = yield* Db
  const runtimes = yield* Runtimes
  const harnesses = yield* Harnesses
  const inbox = yield* Inbox
  const processes = yield* Processes
  const sessionLive = yield* SessionLive
  const { restarting, track } = sessionLive
  const locks = yield* SessionLocks
  const { deliverQueued } = yield* Delivery
  const exits = yield* Exits
  const { finishArchive } = yield* Archive
  const { notice, republish } = yield* Placement
  const scope = yield* Effect.scope
  const engine = yield* Engine.make
  const { locked } = locks
  const logged = Engine.logFailure

  const live = (session: SessionRow) => runtimes.route(runtimeOf(session))

  const forgetIfDone = (id: string) =>
    locks.withLock(id)(
      Effect.gen(function* () {
        if (!sessionEnded(yield* db.getSession(id))) return
        yield* engine.cancel(`grace:${id}`)
        yield* engine.cancel(`miss:${id}`)
        yield* sessionLive.forget(id)
      }),
    )
  const check = Effect.fn("Reconcile.check")(function* (id: string) {
    const session = yield* db.getSession(id)
    if (!session || archived(session)) return
    const open = executionStateOf(session) === "open"
    const limited = yield* exits.limitOf(session)
    if (!open && exitedAt(session) !== null && limited === undefined) return
    if (yield* restarting.has(id)) return
    const routed = yield* live(session).pipe(Effect.option)
    if (Option.isNone(routed)) return yield* live(session)
    const h = routed.value
    if (limited !== undefined && exitedAt(session) !== null) return yield* exits.afterLimit(h, session, limited, true)
    const terminal = terminalOf(session)
    const execution = open ? yield* db.openExecution(id) : undefined
    const r = yield* track(id)
    const maybe = yield* agentState(h, terminal).pipe(Effect.option)
    if (Option.isNone(maybe)) return
    const seen = maybe.value
    const state = stateOf(seen) === "unknown" ? undefined : stateOf(seen)
    if (state !== undefined && session.status !== state) yield* db.setStatus(session.id, state)
    if ((state === "working" || state === "blocked") && execution !== undefined && !inbox.pulls(harnessIdOf(session)))
      yield* db.acceptExecution(id, execution)
    const exited =
      state === undefined &&
      (yield* Effect.gen(function* () {
        const terminalRunning = yield* alive(h, terminal)
        const reportedPid = session.process?.pid
        return (
          !terminalRunning || (typeof reportedPid === "number" && (yield* processes.liveness(reportedPid)) === "exited")
        )
      }))
    if (limited !== undefined && (yield* exits.afterLimit(h, session, limited, exited))) return
    if (state === undefined) {
      if (exited) return yield* exits.recordExit(h, session, execution)
      if (!(yield* Ref.getAndSet(r.launchRechecked, true)))
        yield* engine.arm(`launch:${id}`, START_TIMEOUT, checkSession(id))
    } else yield* Ref.set(r.launchRechecked, false)
    if (!(yield* harnesses.get(harnessIdOf(session))).ownSessionId && h.session !== undefined) {
      const sessionId = yield* h.session(terminal).pipe(Effect.catch(() => Effect.succeed(null)))
      if (sessionId !== null && sessionId !== (session.process?.conversation ?? null))
        yield* db.noteConversation(id, sessionId)
    }

    const s = state ?? "unknown"
    if (!open) {
      if (s !== "working" && s !== "blocked") yield* deliverQueued(h, session, terminal)
      return
    }
    const worked = yield* db.executionTaken(id)
    const idle = s === "idle"
    const ended = idle && worked
    const now = yield* Clock.currentTimeMillis
    const unconfirmed = Duration.toMillis(CONFIRM_TIMEOUT) - (now - executionStartedAt(session))
    const unstarted = !worked && (idle || inbox.pulls(harnessIdOf(session)))
    if (unstarted && unconfirmed <= 0) {
      const reason = `vibest did not see ${id} start the execution it was sent (if it starts it late, that execution's reply is not collected)`
      const closed =
        execution !== undefined &&
        (yield* db.closeExecution(id, execution, "not_started", {
          notice: `task_not_started: ${reason}; it is idle and takes queued messages again.`,
        }))
      if (closed && execution !== undefined)
        yield* inbox.undelivered(session, yield* db.deliveredIn(id, execution), reason)
      if (closed) yield* deliverQueued(h, { ...session, openExecution: null }, terminal)
      return
    }
    if (unstarted) yield* engine.arm(`miss:${id}`, Duration.millis(unconfirmed), checkSession(id))
    if (s === "blocked") {
      if (!(yield* Ref.getAndSet(r.blockedNotified, true)) && !session.entry) {
        const since = new Date(yield* Clock.currentTimeMillis)
        const hhmm = [since.getHours(), since.getMinutes()].map((n) => String(n).padStart(2, "0")).join(":")
        yield* notice(
          session,
          `${shortId(id)} (${harnessIdOf(session)}) has been waiting for a permission decision since ${hhmm}. Run vibest peek ${shortId(id)} to see the request.`,
        )
      }
      return
    }
    yield* Ref.set(r.blockedNotified, false)
    if (!ended) return yield* Ref.set(r.endedAt, undefined)
    const endedAt = yield* Ref.updateAndGet(r.endedAt, (e) => e ?? now)
    const grace = Duration.toMillis(HOOK_GRACE) - (now - endedAt!)
    if (grace > 0) return yield* engine.arm(`grace:${id}`, Duration.millis(grace), checkSession(id))
    if (execution === undefined) return
    yield* Effect.logInfo(`lost ${id}: terminal tail\n${yield* paneTail(h, terminal)}`)
    const failure = `the execution ended without a reply: the harness stopped without firing its execution-end hook (an error it has no hook for, such as a usage limit?); ${peekHint(id)}`
    yield* db.closeExecution(id, execution, "lost", {
      failure,
      notice: `${id}'s execution ended with an error: ${failure}`,
    })
  })

  const checkSession = (id: string): Effect.Effect<unknown, unknown> => locked(id)(check(id))

  const checkLocked = (id: string): Effect.Effect<void> => logged(`check ${id}`)(checkSession(id))

  const onTerminal = (runtime: string, terminal: Terminal, working: boolean) =>
    Effect.gen(function* () {
      const id = yield* db.sessionAt(runtime, terminal)
      if (id === undefined) return
      const session = working ? yield* db.getSession(id) : undefined
      const execution = session && !inbox.pulls(harnessIdOf(session)) ? yield* db.openExecution(id) : undefined
      if (execution !== undefined) yield* db.acceptExecution(id, execution)
      yield* checkSession(id)
    })

  const handle = (event: EngineEvent): Effect.Effect<unknown, unknown> => {
    switch (event.type) {
      case "execution.ended":
        return event.data.outcome === "failed" ? checkFailed(event.sessionId!) : Effect.void
      case "inbox.moved":
        return event.data.to === "delivered"
          ? engine.arm(`miss:${event.sessionId!}`, CONFIRM_TIMEOUT, checkSession(event.sessionId!))
          : Effect.void
      case "live.state":
        return onTerminal(event.runtime, event.terminal, event.state === "working")
      case "live.exited":
        return onTerminal(event.runtime, event.terminal, false)
      case "process.ended":
        return forgetIfDone(event.sessionId!)
      case "live.reset":
        return republish().pipe(Effect.andThen(reconcile({ runtime: event.runtime, machine: event.machine })))
      default:
        return Effect.void
    }
  }

  let reconciles = 0
  const reconcile = (where: "all" | { readonly runtime: string; readonly machine?: string }) =>
    Effect.gen(function* () {
      const here = (yield* db.listSessions()).filter(
        (row) =>
          where === "all" ||
          (runtimeOf(row) === where.runtime &&
            (where.machine === undefined || terminalOf(row).machine === where.machine)),
      )
      const rows = here.filter((row) => !archived(row) && (exitedAt(row) === null || executionStateOf(row) === "open"))
      const ended = (yield* db.endedAtLimit)
        .filter((row) => where === "all" || row.runtime === where.runtime)
        .map((row) => row.id)
      const archiving = here.filter((row) => archived(row) && exitedAt(row) === null && terminalOf(row).id !== "")
      yield* Effect.forEach(archiving, (row) => finishArchive(row.id), { concurrency: 8, discard: true })
      yield* Effect.log(
        `reconcile ${where === "all" ? "all" : `${where.runtime}${where.machine ? ` on ${where.machine}` : ""}`}: ${rows.length} live sessions`,
      )
      yield* Effect.forEach([...rows.map((row) => row.id), ...ended], checkLocked, {
        concurrency: 8,
        discard: true,
      })
      reconciles++
    })

  const checkFailed = (id: string) =>
    Effect.forkIn(locked(id, true)(check(id)).pipe(logged(`check ${id}`)), scope).pipe(Effect.asVoid)

  yield* engine.on(handle)

  yield* republish()
  yield* Effect.forkIn(reconcile("all").pipe(logged("reconcile")), scope)

  return { check: checkLocked, reconciles: Effect.sync(() => reconciles) }
})

export class Reconcile extends Context.Service<Reconcile, Effect.Success<typeof make>>()("vibest/Reconcile") {
  static readonly make = make

  static readonly layer = Layer.effect(Reconcile, make)

  static readonly node = LayerNode.make({
    service: Reconcile,
    layer: Reconcile.layer,
    deps: [
      Archive.node,
      Bus.node,
      Db.node,
      Delivery.node,
      Exits.node,
      Harnesses.node,
      Inbox.node,
      Placement.node,
      Processes.node,
      Runtimes.node,
      SessionLive.node,
      SessionLocks.node,
    ],
  })
}
