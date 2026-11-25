import { sessionLabel } from "@vibest/schema/id"
import { NotReady } from "@vibest/schema/session"
import { canonicalTarget } from "@vibest/schema/terminal"
import { LayerNode } from "@vibest/util/layer-node"
import { Clock, Context, Data, Duration, Effect, Layer, Option, Predicate, Ref, Schedule, Schema } from "effect"

import { awaitEvent, awaitOn, Bus, type BusEvent, TerminalExited } from "../bus.ts"
import { type SessionRow, harnessIdOf } from "../database/rows.ts"
import { Harnesses } from "../harness/registry.ts"
import type { HarnessDefinition } from "../plugin/domains.ts"
import {
  agentState,
  alive,
  sessionState,
  type AgentState,
  paneTail,
  type Runtime,
  RuntimeError,
  stateOf,
  type Terminal,
  type AgentSeen,
} from "../runtime/registry.ts"
import { SessionLive } from "./live.ts"
import { SessionStore } from "./store.ts"

export * as Executions from "./executions.ts"

export const HANDOFF_UNPROVED = "unproved"

export class HandoffRejected extends Schema.TaggedError<HandoffRejected>()("HandoffRejected", {
  message: Schema.String,
}) {}

export const READY_TIMEOUT = Duration.seconds(60)
export const CONFIRM_TIMEOUT = Duration.seconds(8)
export const STOP_WAIT = Duration.seconds(10)
export const HOOK_GRACE = Duration.seconds(10)
const STARTUP_DIALOG_POLL = Schedule.spaced("500 millis")

export type Pickup = Data.TaggedEnum<{
  Taken: {}
  Exited: {}
  NotStarted: { readonly message: string }
}>

export const Pickup = Data.taggedEnum<Pickup>()

export const notStartedMessage = (pickup: Pickup) =>
  Predicate.isTagged(pickup, "NotStarted") ? pickup.message : undefined

export const busy = (state: AgentState) => state === "working" || state === "blocked"

export const busyOf = (seen: AgentSeen) => {
  const state = stateOf(seen)

  return state !== undefined && busy(state)
}

const settled = (seen: AgentSeen) => seen !== "absent" && seen !== "unknown"

const sameTerminal = (a: Terminal, b: Terminal) => canonicalTarget(a) === canonicalTarget(b)

export const make = Effect.gen(function* () {
  const sessionStore = yield* SessionStore.Service
  const harnesses = yield* Harnesses.Service
  const bus = yield* Bus.Service
  const { track } = yield* SessionLive.Service

  const reportedStatus = (id: string) =>
    Effect.map(sessionStore.getSession(id), (session) => session?.status ?? "unknown")

  const awaitReady = Effect.fn("Executions.awaitReady")(
    (h: Runtime, terminal: Terminal, adapter: HarnessDefinition, id: string) =>
      Effect.gen(function* () {
        const reports = adapter.ready === "integration"
        const step = adapter.startup ? yield* adapter.startup : undefined
        const screen = h.read(terminal, 40).pipe(Effect.orElseSucceed(() => ""))

        const look = Effect.gen(function* () {
          const seen = yield* sessionState(h, terminal, reportedStatus(id))
          const ready = (yield* sessionStore.readyAt(id)) !== undefined || (!reports && seen === "idle")

          return { seen, ready }
        })

        return yield* look.pipe(
          Effect.flatMap((now) => {
            if (now.ready || step === undefined) return Effect.succeed(now)

            return step({
              screen,
              sendKeys: (keys) => h.send(terminal, { keys: [...keys] }).pipe(Effect.ignore),
            }).pipe(Effect.as(now))
          }),
          Effect.repeat({ until: (now) => now.ready, schedule: STARTUP_DIALOG_POLL }),
          Effect.timeoutOrElse({
            duration: READY_TIMEOUT,
            orElse: () =>
              screen.pipe(
                Effect.flatMap((tail) => Effect.logInfo(`not ready ${id}: terminal tail\n${tail.trim()}`)),
                Effect.andThen(
                  Effect.fail(
                    new NotReady({
                      id,
                      message: `did not become ready in ${Duration.format(READY_TIMEOUT)} (${adapter.binary} may be signed out: sign in with ${adapter.binary}; or a startup dialog vibest could not answer: open ${adapter.binary} once in the repository and accept it)`,
                    }),
                  ),
                ),
              ),
          }),
          Effect.map((now): AgentState => (reports && !settled(now.seen) ? "idle" : (stateOf(now.seen) ?? "unknown"))),
        )
      }),
  )

  const settleAfterInterrupt = Effect.fn("Executions.settleAfterInterrupt")((
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    stop: Effect.Effect<void> = Effect.void,
  ) => {
    const settledNow = agentState(h, terminal).pipe(
      Effect.map((seen) => {
        const state = stateOf(seen)

        return state !== undefined && state !== "working" && state !== "blocked"
      }),
    )

    return awaitEvent(
      stop.pipe(
        Effect.andThen(settledNow),
        Effect.map((idle) => (idle ? Option.some(true) : Option.none())),
      ),
      (event) =>
        Effect.succeed(
          (event.type === "terminal.state" &&
            sameTerminal(event.data.terminal, terminal) &&
            event.data.state !== "working" &&
            event.data.state !== "blocked") ||
            ((event.type === "session.execution.succeeded" ||
              event.type === "session.execution.failed" ||
              event.type === "session.execution.interrupted") &&
              event.data.sessionId === session.id)
            ? Option.some(true)
            : Option.none(),
        ),
      STOP_WAIT,
      settledNow,
    ).pipe(Effect.provideService(Bus.Service, bus))
  })

  const interruptAgent = Effect.fn("Executions.interruptAgent")((
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
  ) => {
    const key = harnesses.find(harnessIdOf(session))?.interruptKey

    return settleAfterInterrupt(
      h,
      session,
      terminal,
      key === undefined ? Effect.void : h.send(terminal, { keys: [key] }).pipe(Effect.ignore),
    )
  })

  const prompt = Effect.fn("Executions.prompt")(function* (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    text: string,
    onHandover: Effect.Effect<void> = Effect.void,
  ) {
    const kept = yield* sessionStore.openExecution(session.id)
    const adapter = yield* harnesses.get(harnessIdOf(session))
    const state = yield* awaitReady(h, terminal, adapter, session.id)
    const open = yield* sessionStore.openExecution(session.id)

    if (open !== undefined && open !== kept) return undefined

    const begun =
      open === undefined
        ? yield* Effect.flatMap(Clock.currentTimeMillis, (at) => sessionStore.startExecution(session.id, at))
        : { execution: open, opened: true }

    if (!begun.opened) return undefined
    const execution = begun.execution
    const already = yield* sessionStore.executionWasAccepted(session.id, execution)

    const standing = Effect.map(sessionStore.openExecution(session.id), (now) =>
      now === execution ? ("mine" as const) : now === undefined ? ("closed" as const) : ("busy" as const),
    )

    yield* onHandover
    const r = yield* track(session.id)
    yield* Ref.set(r.endedAt, undefined)
    yield* Ref.set(r.blockedNotified, false)
    yield* sessionStore.setStatus(session.id, state)

    const missed = sessionStore.closeExecution(session.id, execution, "not_started")

    const beforeText = (error: RuntimeError) =>
      Effect.gen(function* () {
        if (error.code === "unreachable") return yield* Effect.fail(error)

        if (!(yield* sessionStore.executionTaken(session.id)) && (yield* standing) === "mine") yield* missed

        return yield* new HandoffRejected({ message: error.message })
      })

    const send = Ref.set(r.prompting, true).pipe(
      Effect.andThen(
        adapter.clearKeys === undefined
          ? Effect.void
          : h.send(terminal, { keys: [...adapter.clearKeys] }).pipe(Effect.catchTag("RuntimeError", beforeText)),
      ),
      Effect.andThen(h.send(terminal, { text })),
      Effect.ensuring(Ref.set(r.prompting, false)),
    )

    yield* send.pipe(
      Effect.catchTag("RuntimeError", (error) =>
        Effect.gen(function* () {
          if (already) return

          const after = yield* standing

          if (after === "closed" || error.code === "unreachable" || after === "busy") return yield* Effect.fail(error)
          yield* missed

          return yield* error
        }),
      ),
    )

    const seen = stateOf(
      yield* sessionState(h, terminal, Effect.succeed(state)).pipe(Effect.orElseSucceed(() => state)),
    )

    if (seen === "working" || seen === "blocked") yield* sessionStore.setStatus(session.id, seen)

    return HANDOFF_UNPROVED
  }, Effect.scoped)

  const openFirst = Effect.fn("Executions.openFirst")(function* (id: string, onHandover: Effect.Effect<void>) {
    const { execution } = yield* Effect.flatMap(Clock.currentTimeMillis, (at) => sessionStore.startExecution(id, at))
    yield* onHandover

    return execution
  })

  const launched = Effect.fn("Executions.launched")(function* (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    execution: number,
  ) {
    const adapter = yield* harnesses.get(harnessIdOf(session))
    const step = adapter.startup ? yield* adapter.startup : undefined

    const answer =
      step === undefined
        ? Effect.void
        : step({
            screen: h.read(terminal, 40).pipe(Effect.orElseSucceed(() => "")),
            sendKeys: (keys) => h.send(terminal, { keys: [...keys] }).pipe(Effect.ignore),
          })

    const taken = Effect.gen(function* () {
      if ((yield* sessionStore.openExecution(session.id)) !== execution) return true

      if (yield* sessionStore.executionAccepted(session.id)) return true
      const state = stateOf(yield* sessionState(h, terminal, reportedStatus(session.id)))

      if (state !== "working") return false
      yield* sessionStore.setStatus(session.id, state)

      return true
    })

    const process = (yield* sessionStore.getSession(session.id))?.process?.id
    const seenRunning = yield* Ref.make(false)

    const running = Effect.tap(alive(h, terminal), (up) => (up ? Ref.set(seenRunning, true) : Effect.void))

    const gone = Effect.gen(function* () {
      const row = yield* sessionStore.getSession(session.id)

      if (row?.process?.id !== process || (yield* running)) return Option.none<Pickup>()
      const started = (yield* Ref.get(seenRunning)) || (row?.process?.readyAt ?? null) !== null

      return started ? Option.some(Pickup.Exited()) : Option.none<Pickup>()
    })

    const exitedHere = (event: BusEvent) =>
      event.type === "terminal.exited" && event.data.runtime === h.id && sameTerminal(event.data.terminal, terminal)

    const signalExit = Effect.flatMap(sessionStore.processesAt(h.id, terminal), (processes) =>
      Effect.asVoid(bus.publish(TerminalExited, { runtime: h.id, terminal, processes })),
    )

    const exited = Effect.flatMap(bus.subscribe(), (subscription) =>
      awaitOn(
        subscription,
        gone,
        (event) => (exitedHere(event) ? gone : Effect.succeedNone),
        READY_TIMEOUT,
        Effect.never,
      ),
    ).pipe(Effect.tap(() => signalExit))

    const took = yield* taken.pipe(
      Effect.tap((done) => (done ? Effect.void : Effect.andThen(answer, running))),
      Effect.repeat({ until: (done) => done, schedule: STARTUP_DIALOG_POLL }),
      Effect.timeoutOrElse({ duration: READY_TIMEOUT, orElse: () => Effect.succeed(false) }),
      Effect.map((done) => (done ? Pickup.Taken() : undefined)),
      Effect.raceFirst(exited),
    )

    if (took !== undefined) return took
    yield* Effect.logInfo(`task_not_started ${session.id}: terminal tail\n${yield* paneTail(h, terminal)}`)
    yield* sessionStore.closeExecution(session.id, execution, "not_started")

    if (adapter.ready === "integration" && (yield* sessionStore.readyAt(session.id)) === undefined)
      return yield* new NotReady({
        id: session.id,
        message: `did not become ready in ${Duration.format(READY_TIMEOUT)} (${adapter.binary} may be signed out: sign in with ${adapter.binary}; or a startup dialog vibest could not answer: open ${adapter.binary} once in the repository and accept it)`,
      })

    return Pickup.NotStarted({
      message: `${sessionLabel(session)} did not start working on its first message (${adapter.binary} may be signed out: sign in with ${adapter.binary})`,
    })
  }, Effect.scoped)

  return { awaitReady, settleAfterInterrupt, interruptAgent, prompt, openFirst, launched }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Executions") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SessionStore.node, Harnesses.node, Bus.node, SessionLive.node],
})
