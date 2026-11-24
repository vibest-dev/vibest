import { ExecutionFailed, InboxDelivered, InboxEnqueued, ProcessEnded } from "@vibest/schema/event"
import { sessionLabel } from "@vibest/schema/id"
import { Clock, Context, Duration, Effect, Layer, Option, Predicate, Ref } from "effect"

import { type BoundProcess, Bus, RuntimeReset, TerminalExited, TerminalState } from "../bus.ts"
import {
  type SessionRow,
  sessionEnded,
  harnessIdOf,
  runtimeOf,
  terminalOf,
  exitedAt,
  executionStateOf,
  executionStartedAt,
  archived,
} from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { Harnesses } from "../harnesses.ts"
import { Inbox } from "../inbox.ts"
import { Processes } from "../processes.ts"
import * as Reactor from "../reactor.ts"
import { agentState, alive, paneTail, reportedWhenUnknown, Runtimes, stateOf } from "../runtimes.ts"
import { Archive } from "./archive.ts"
import { Delivery } from "./delivery.ts"
import { CONFIRM_TIMEOUT, HOOK_GRACE } from "./executions.ts"
import { Exits } from "./exits.ts"
import { SessionLive } from "./live.ts"
import { SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"
import { RunCoordinator } from "./run-coordinator.ts"
import { Starts } from "./starts.ts"

export * as Reconcile from "./reconcile.ts"

export { HOOK_GRACE }

export const START_TIMEOUT = Duration.seconds(120)

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const runtimes = yield* Runtimes.Service
  const harnesses = yield* Harnesses.Service
  const inbox = yield* Inbox.Service
  const processes = yield* Processes.Service
  const sessionLive = yield* SessionLive.Service
  const { restarting, track } = sessionLive
  const locks = yield* SessionLocks.Service
  const { deliverQueued } = yield* Delivery.Service
  const exits = yield* Exits.Service
  const { finishArchive } = yield* Archive.Service
  const { notice, republish } = yield* Placement.Service
  const starts = yield* Starts.Service
  const scope = yield* Effect.scope
  const reactor = yield* Reactor.make
  const { locked } = locks
  const logged = Reactor.logFailure

  const live = (session: SessionRow) => runtimes.route(runtimeOf(session))

  const forgetIfDone = (id: string) =>
    locks.withLock(id)(
      Effect.gen(function* () {
        if (!sessionEnded(yield* db.session.getSession(id))) return
        yield* reactor.cancel(`grace:${id}`)
        yield* reactor.cancel(`miss:${id}`)
        yield* sessionLive.forget(id)
      }),
    )

  const check = Effect.fn("Reconcile.check")(function* (id: string, bound?: number) {
    const session = yield* db.session.getSession(id)

    if (!session || archived(session) || (bound !== undefined && session.process?.id !== bound)) return

    if (yield* db.session.sessionMoving(session.id)) return
    const open = executionStateOf(session) === "open"

    if (!open && exitedAt(session) !== null) return

    if (yield* restarting.has(id)) return
    const routed = yield* live(session).pipe(Effect.option)

    if (Option.isNone(routed)) return yield* live(session)
    const h = routed.value
    const terminal = terminalOf(session)
    const execution = open ? yield* db.session.openExecution(id) : undefined
    const r = yield* track(id)
    const maybe = yield* agentState(h, terminal).pipe(Effect.option)

    if (Option.isNone(maybe)) return
    const seen = maybe.value
    const state = stateOf(seen) === "unknown" ? undefined : stateOf(seen)

    if (state !== undefined && session.status !== state) yield* db.session.setStatus(session.id, state)

    const exited =
      state === undefined &&
      (yield* Effect.gen(function* () {
        const terminalRunning = yield* alive(h, terminal)
        const reportedPid = session.process?.pid

        return (
          !terminalRunning || (Predicate.isNumber(reportedPid) && (yield* processes.liveness(reportedPid)) === "exited")
        )
      }))

    if (state === undefined) {
      if (exited) return yield* exits.recordExit(h, session, execution)

      if (!(yield* Ref.getAndSet(r.launchRechecked, true)))
        yield* reactor.arm(`launch:${id}`, START_TIMEOUT, checkSession(id))
    } else yield* Ref.set(r.launchRechecked, false)

    const adapter = yield* harnesses.get(harnessIdOf(session))

    if (!adapter.ownSessionId && h.session !== undefined) {
      const sessionId = yield* h.session(terminal).pipe(Effect.catch(() => Effect.succeed(null)))

      if (sessionId !== null && sessionId !== (session.process?.harnessSessionId ?? null))
        yield* db.session.noteConversation(id, sessionId)
    }

    const s = stateOf(reportedWhenUnknown(state ?? "unknown", session.status)) ?? "unknown"

    if (!open) {
      if (s !== "working" && s !== "blocked") yield* deliverQueued(h, session, terminal)

      return
    }

    const worked = yield* db.session.executionTaken(id)
    const idle = s === "idle"
    const ended = idle && worked
    const now = yield* Clock.currentTimeMillis
    const readyAt = session.process?.readyAt ?? null
    const awaitingReady = adapter.ready === "integration" && readyAt === null
    const unconfirmed = Duration.toMillis(CONFIRM_TIMEOUT) - (now - Math.max(executionStartedAt(session), readyAt ?? 0))

    const pulledUnaccepted =
      !worked &&
      execution !== undefined &&
      inbox.pulls(harnessIdOf(session)) &&
      (yield* db.inbox.hasUnacceptedPulledBatch(id, execution))

    const unstarted = !worked && ((idle && !awaitingReady) || pulledUnaccepted)

    if (unstarted && unconfirmed <= 0) {
      const closed =
        execution !== undefined &&
        (yield* db.session.closeExecution(id, execution, "not_started", {
          notice: `${sessionLabel(session)} did not start the execution it was sent; it is idle and takes queued messages again (if it starts late, that reply is not collected)`,
        }))

      if (closed) yield* deliverQueued(h, { ...session, openExecution: null }, terminal)

      return
    }

    if (unstarted) yield* reactor.arm(`miss:${id}`, Duration.millis(unconfirmed), checkSession(id))

    if (s === "blocked") {
      if (!(yield* Ref.getAndSet(r.blockedNotified, true)) && (yield* db.session.creatorOf(session.id)) !== undefined) {
        const since = new Date(yield* Clock.currentTimeMillis)
        const hhmm = [since.getHours(), since.getMinutes()].map((n) => String(n).padStart(2, "0")).join(":")
        yield* notice(
          session,
          `${sessionLabel(session)} (${harnessIdOf(session)}) is waiting for a permission decision since ${hhmm}`,
        )
      }

      return
    }

    yield* Ref.set(r.blockedNotified, false)

    if (!ended) return yield* Ref.set(r.endedAt, undefined)
    const endedAt = yield* Ref.updateAndGet(r.endedAt, (e) => e ?? now)
    const grace = Duration.toMillis(HOOK_GRACE) - (now - endedAt!)

    if (grace > 0) return yield* reactor.arm(`grace:${id}`, Duration.millis(grace), checkSession(id))

    if (execution === undefined) return
    yield* Effect.logInfo(`lost ${id}: terminal tail\n${yield* paneTail(h, terminal)}`)
    const failure = `the harness stopped without its end hook (a usage limit?)`
    yield* db.session.closeExecution(id, execution, "lost", {
      failure: { message: failure },
      notice: `${sessionLabel(session)} ended its execution with an error: ${failure}`,
    })
  })

  const checkSession = (id: string, bound?: number): Effect.Effect<unknown, unknown> => locked(id)(check(id, bound))

  const checkLocked = Effect.fn("Reconcile.check")((id: string, bound?: number): Effect.Effect<void> =>
    Effect.flatMap(starts.isWaiting(id), (waiting) =>
      waiting ? Effect.void : logged(`check ${id}`)(checkSession(id, bound)),
    ),
  )

  const wakes = yield* RunCoordinator.make<string, number | undefined>({
    drain: checkLocked,
    merge: (pending, next) => (pending === undefined || next === undefined ? undefined : Math.max(pending, next)),
  })

  const onTerminal = (processes: ReadonlyArray<BoundProcess>, _working: boolean) =>
    Effect.forEach(
      processes,
      ({ sessionId, process }) =>
        Effect.gen(function* () {
          yield* wakes.wake(sessionId, process)
        }),
      { discard: true },
    )

  let reconciles = 0

  const reconcile = (where: "all" | { readonly runtime: string; readonly machine?: string }) =>
    Effect.gen(function* () {
      const here = (yield* db.session.listSessions()).filter(
        (row) =>
          where === "all" ||
          (runtimeOf(row) === where.runtime &&
            (where.machine === undefined || terminalOf(row).machine === where.machine)),
      )

      const rows = here.filter((row) => !archived(row) && (exitedAt(row) === null || executionStateOf(row) === "open"))

      const archiving = here.filter((row) => archived(row) && exitedAt(row) === null && terminalOf(row).id !== "")
      yield* Effect.forEach(archiving, (row) => finishArchive(row.id), { concurrency: 8, discard: true })
      yield* Effect.log(
        `reconcile ${where === "all" ? "all" : `${where.runtime}${where.machine ? ` on ${where.machine}` : ""}`}: ${rows.length} live sessions`,
      )
      yield* Effect.forEach(
        rows.map((row) => row.id),
        (id) => checkLocked(id),
        {
          concurrency: 8,
          discard: true,
        },
      )
      reconciles++
    })

  const checkFailed = (id: string) =>
    Effect.forkIn(locked(id, true)(check(id)).pipe(logged(`check ${id}`)), scope).pipe(Effect.asVoid)

  yield* reactor.on([ExecutionFailed], (event) => checkFailed(event.sessionId!))
  yield* reactor.on([InboxDelivered], (event) =>
    reactor.arm(`miss:${event.sessionId!}`, CONFIRM_TIMEOUT, checkSession(event.sessionId!)),
  )
  yield* reactor.on([InboxEnqueued], (event) =>
    Effect.gen(function* () {
      const id = event.sessionId!

      if (id === undefined) return
      const session = yield* db.session.getSession(id)

      if (session === undefined || executionStateOf(session) !== "open" || (yield* db.session.executionTaken(id)))
        return

      if ((yield* db.inbox.pendingInbox(id)).length === 0) return

      const left = Duration.toMillis(CONFIRM_TIMEOUT) - ((yield* Clock.currentTimeMillis) - executionStartedAt(session))
      yield* reactor.arm(`miss:${id}`, Duration.millis(Math.max(left, 0)), checkSession(id))
    }),
  )
  yield* reactor.on([TerminalState], (event) => onTerminal(event.processes, event.state === "working"))
  yield* reactor.on([TerminalExited], (event) => onTerminal(event.processes, false))
  yield* reactor.on([ProcessEnded], (event) => forgetIfDone(event.sessionId!))
  yield* reactor.on([RuntimeReset], (event) =>
    republish().pipe(Effect.andThen(reconcile({ runtime: event.runtime, machine: event.machine }))),
  )

  yield* Effect.forkIn(republish().pipe(Effect.andThen(reconcile("all")), logged("reconcile")), scope)

  return { check: checkLocked, reconciles: Effect.sync(() => reconciles) }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Reconcile") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
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
    Starts.node,
  ],
})
