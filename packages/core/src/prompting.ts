import { NotReady } from "@vibest/schema/session"
import { Clock, Duration, Effect, Exit, Option, PubSub, Ref, Schedule } from "effect"

import { awaitEvent, awaitOn, Bus, type EngineEvent } from "./bus.ts"
import type { Db, SessionRow } from "./db.ts"
import type { Harnesses } from "./harness.ts"
import type { HarnessDefinition } from "./host.ts"
import {
  agentState,
  type AgentState,
  paneTail,
  peekHint,
  type Runtime,
  stateOf,
  type Terminal,
  type AgentSeen,
} from "./runtimes.ts"
import type { Tracked } from "./session-types.ts"

export const READY_TIMEOUT = Duration.seconds(60)
export const CONFIRM_TIMEOUT = Duration.seconds(8)
export const STOP_WAIT = Duration.seconds(10)
const STARTUP_DIALOG_POLL = Schedule.spaced("500 millis")

export const sessionPrompting = (deps: {
  readonly db: Pick<
    Db["Service"],
    "readyAt" | "updateSession" | "openExecution" | "beginExecution" | "stampExecution" | "closeExecution"
  >
  readonly harnesses: Pick<Harnesses["Service"], "get" | "find">
  readonly bus: Bus["Service"]
  readonly track: (id: string) => Effect.Effect<Tracked>
}) => {
  const { db, harnesses, bus, track } = deps
  const settled = (seen: AgentSeen) => seen !== "absent" && seen !== "unknown"
  const awaitReady = (h: Runtime, terminal: Terminal, adapter: HarnessDefinition, id: string) =>
    Effect.gen(function* () {
      const reports = adapter.ready === "integration"
      if (h.state === undefined && !reports) return "unknown" as AgentState
      const step = adapter.startup ? yield* adapter.startup : undefined
      const screen = h.read(terminal, 40).pipe(Effect.orElseSucceed(() => ""))
      const look = Effect.gen(function* () {
        const seen: AgentSeen = h.state === undefined ? "unknown" : yield* agentState(h, terminal)
        const ready = (yield* db.readyAt(id)) !== undefined || (!reports && settled(seen))
        return { seen, ready }
      })
      return yield* look.pipe(
        Effect.flatMap((now) => {
          if (now.ready || settled(now.seen) || step === undefined) return Effect.succeed(now)
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
                    message: `${id} did not become ready in ${Duration.format(READY_TIMEOUT)} (a startup dialog vibest could not answer? open ${adapter.id} once in the repository and accept it)`,
                  }),
                ),
              ),
            ),
        }),
        Effect.map((now): AgentState => (reports && !settled(now.seen) ? "idle" : (stateOf(now.seen) ?? "unknown"))),
      )
    })

  const sameTerminal = (a: Terminal, b: Terminal) => a.machine === b.machine && a.id === b.id
  const sawExecutionStart = (id: string) => Effect.flatMap(track(id), (r) => Ref.set(r.sawWorking, true))

  const pickedUp = (session: SessionRow, state: "working" | "blocked") =>
    Effect.gen(function* () {
      yield* Ref.set((yield* track(session.id)).sawWorking, true)
      yield* db.updateSession(session.id, { status: state })
      return true
    })

  const pickupNow = (h: Runtime, session: SessionRow, terminal: Terminal) =>
    Effect.gen(function* () {
      const state = stateOf(yield* agentState(h, terminal))
      if (state === "working" || state === "blocked") return yield* pickedUp(session, state)
      return yield* Ref.get((yield* track(session.id)).sawWorking)
    })

  const confirmed = (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    subscription: PubSub.Subscription<EngineEvent>,
  ) =>
    awaitOn(
      subscription,
      pickupNow(h, session, terminal).pipe(Effect.map((picked) => (picked ? Option.some(true) : Option.none()))),
      (event) =>
        event.type === "live.execution_start" &&
        event.sessionId === session.id &&
        event.at >= session.executionPromptedAt
          ? Effect.as(sawExecutionStart(session.id), Option.some(true))
          : event.type === "live.state" &&
              sameTerminal(event.terminal, terminal) &&
              (event.state === "working" || event.state === "blocked")
            ? Effect.map(pickedUp(session, event.state), Option.some)
            : Effect.succeed(Option.none()),
      CONFIRM_TIMEOUT,
      pickupNow(h, session, terminal),
    )

  const busy = (state: AgentState) => state === "working" || state === "blocked"
  const busyOf = (seen: AgentSeen) => {
    const state = stateOf(seen)
    return state !== undefined && busy(state)
  }

  const settleAfterInterrupt = (
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
          (event.type === "live.state" &&
            sameTerminal(event.terminal, terminal) &&
            event.state !== "working" &&
            event.state !== "blocked") ||
            (event.type === "execution.ended" && event.sessionId === session.id)
            ? Option.some(true)
            : Option.none(),
        ),
      STOP_WAIT,
      settledNow,
    ).pipe(Effect.provideService(Bus, bus))
  }
  const interruptAgent = (h: Runtime, session: SessionRow, terminal: Terminal) => {
    const key = harnesses.find(session.harnessId)?.interruptKey
    return settleAfterInterrupt(
      h,
      session,
      terminal,
      key === undefined ? Effect.void : h.send(terminal, { keys: [key] }).pipe(Effect.ignore),
    )
  }

  const prompt = Effect.fn("Sessions.prompt")(function* (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    text: string,
    onHandover: Effect.Effect<void> = Effect.void,
  ) {
    const kept = yield* db.openExecution(session.id)
    const begin = Effect.flatMap(Clock.currentTimeMillis, (at) => db.beginExecution(session.id, at))
    let execution = kept
    if (execution === undefined) {
      const begun = yield* begin
      if (!begun.opened) return undefined
      execution = begun.execution
    }
    const standing = Effect.suspend(() =>
      Effect.map(db.openExecution(session.id), (open) =>
        open === execution ? ("mine" as const) : open === undefined ? ("closed" as const) : ("busy" as const),
      ),
    )
    const adapter = yield* harnesses.get(session.harnessId)
    const state = yield* awaitReady(h, terminal, adapter, session.id).pipe(
      Effect.onExit((exit) =>
        kept === undefined && !Exit.isSuccess(exit)
          ? Effect.uninterruptible(db.closeExecution(session.id, execution!, "not_started"))
          : Effect.void,
      ),
    )
    const before = yield* standing
    if (before === "busy") return undefined
    if (before === "closed") {
      const begun = yield* begin
      if (!begun.opened) return undefined
      execution = begun.execution
    }
    const now = yield* Clock.currentTimeMillis
    yield* onHandover
    const r = yield* track(session.id)
    yield* Ref.set(r.endedAt, undefined)
    yield* Ref.set(r.blockedNotified, false)
    yield* Ref.set(r.sawWorking, false)
    yield* db.stampExecution(session.id, execution, now)
    yield* db.updateSession(session.id, { status: state, lastActive: now })
    const send = Ref.set(r.prompting, true).pipe(
      Effect.andThen(h.send(terminal, { text })),
      Effect.ensuring(Ref.set(r.prompting, false)),
    )
    const missed = Effect.suspend(() => db.closeExecution(session.id, execution!, "not_started"))
    const subscription = yield* bus.subscribe
    const delivered = yield* send.pipe(
      Effect.as(false),
      Effect.catchTag("RuntimeError", (error) =>
        Effect.gen(function* () {
          const after = yield* standing
          if (after === "closed") return true
          if (error.code === "unreachable" || after === "busy") return yield* Effect.fail(error)
          yield* missed
          return yield* error
        }),
      ),
    )
    if (delivered) return undefined
    if (state === "unknown" && adapter.ready === "runtime") {
      yield* sawExecutionStart(session.id)
      yield* db.updateSession(session.id, { status: "working" })
      return undefined
    }
    const round = { ...session, executionPromptedAt: now }
    const settledElsewhere = Effect.map(standing, (left) => left !== "mine")
    if (yield* confirmed(h, round, terminal, subscription)) return undefined
    if (yield* settledElsewhere) return undefined
    yield* h.send(terminal, { keys: ["enter"] }).pipe(Effect.ignore)
    if (yield* confirmed(h, round, terminal, subscription)) return undefined
    if (yield* settledElsewhere) return undefined
    yield* send.pipe(Effect.ignore)
    if (yield* confirmed(h, round, terminal, subscription)) return undefined
    if (yield* settledElsewhere) return undefined
    yield* Effect.logInfo(`task_not_started ${session.id}: terminal tail\n${yield* paneTail(h, terminal)}`)
    yield* missed
    return `task_not_started: ${session.id} did not start working on the message; ${peekHint(session.id)}`
  }, Effect.scoped)

  return { awaitReady, sawExecutionStart, busy, busyOf, settleAfterInterrupt, interruptAgent, prompt }
}
