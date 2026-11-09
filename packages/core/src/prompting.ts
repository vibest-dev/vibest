import { NoSuchSession, NotReady } from "@vibest/schema/session"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PlatformError,
  PubSub,
  Ref,
  Schedule,
} from "effect"
import { ChildProcessSpawner } from "effect/process"

import { awaitEvent, awaitOn, Bus, type EngineEvent } from "./bus.ts"
import type { Db, SessionRow } from "./db.ts"
import type { Harnesses } from "./harness.ts"
import type { HarnessDefinition } from "./host.ts"
import {
  agentState,
  type AgentState,
  paneTail,
  peekHint,
  RuntimeError,
  type Runtime,
  stateOf,
  type Terminal,
  type AgentSeen,
} from "./runtimes.ts"
import type { Platform, Tracked } from "./session-types.ts"
import type { Git } from "./worktree.ts"

export const READY_TIMEOUT = Duration.seconds(60)
export const CONFIRM_TIMEOUT = Duration.seconds(8)
export const STOP_WAIT = Duration.seconds(10)
const STARTUP_DIALOG_POLL = Schedule.spaced("500 millis")

export type Collected = "none" | "delivered"

export const sessionPrompting = (deps: {
  readonly db: Pick<Db["Service"], "readyAt" | "updateSession">
  readonly harnesses: Pick<Harnesses["Service"], "get">
  readonly bus: Bus["Service"]
  readonly track: (id: string) => Effect.Effect<Tracked>
  readonly platform: Context.Context<Platform>
  readonly collectResult: (
    h: Runtime | undefined,
    session: SessionRow,
  ) => Effect.Effect<
    Collected,
    RuntimeError | NoSuchSession | PlatformError.PlatformError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Git
  >
}) => {
  const { db, harnesses, bus, track, platform, collectResult } = deps
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
  const sawTurnStart = (id: string) => Effect.flatMap(track(id), (r) => Ref.set(r.sawWorking, true))

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
        event.type === "live.turn_start" && event.sessionId === session.id && event.at >= session.turnPromptedAt
          ? Effect.as(sawTurnStart(session.id), Option.some(true))
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

  const settleAfterInterrupt = (h: Runtime, session: SessionRow, terminal: Terminal) => {
    const settledNow = agentState(h, terminal).pipe(
      Effect.map((seen) => {
        const state = stateOf(seen)
        return state !== undefined && state !== "working" && state !== "blocked"
      }),
    )
    return awaitEvent(
      settledNow.pipe(Effect.map((idle) => (idle ? Option.some(true) : Option.none()))),
      (event) =>
        Effect.succeed(
          (event.type === "live.state" &&
            sameTerminal(event.terminal, terminal) &&
            event.state !== "working" &&
            event.state !== "blocked") ||
            (event.type === "turn.reported" && event.sessionId === session.id)
            ? Option.some(true)
            : Option.none(),
        ),
      STOP_WAIT,
      settledNow,
    ).pipe(Effect.provideService(Bus, bus))
  }
  const interruptAgent = (h: Runtime, session: SessionRow, terminal: Terminal) =>
    Effect.gen(function* () {
      yield* h.send(terminal, { keys: [harnesses.get(session.harnessId).interruptKey] }).pipe(Effect.ignore)
      return yield* settleAfterInterrupt(h, session, terminal)
    })

  const prompt = Effect.fn("Sessions.prompt")(function* (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    text: string,
    onHandover: Effect.Effect<void> = Effect.void,
    options?: { readonly keepRound?: boolean },
  ) {
    const openedHere = session.turnState !== "open"
    if (openedHere) {
      const at = yield* Clock.currentTimeMillis
      yield* db.updateSession(session.id, { turnState: "open", turnPromptedAt: at, lastActive: at })
    }
    const adapter = harnesses.get(session.harnessId)
    const state = yield* awaitReady(h, terminal, adapter, session.id).pipe(
      Effect.onExit((exit) =>
        openedHere && !Exit.isSuccess(exit)
          ? Effect.uninterruptible(
              Effect.flatMap(Clock.currentTimeMillis, (t) =>
                db.updateSession(session.id, { turnState: "not_started", lastActive: t }),
              ),
            )
          : Effect.void,
      ),
    )
    const now = yield* Clock.currentTimeMillis
    yield* onHandover
    const r = yield* track(session.id)
    yield* Ref.set(r.endedAt, undefined)
    yield* Ref.set(r.blockedNotified, false)
    yield* Ref.set(r.sawWorking, false)
    yield* db.updateSession(session.id, { status: state, turnState: "open", turnPromptedAt: now, lastActive: now })
    const send = Ref.set(r.prompting, true).pipe(
      Effect.andThen(h.send(terminal, { text })),
      Effect.ensuring(Ref.set(r.prompting, false)),
    )
    const missed = options?.keepRound
      ? Effect.void
      : db.updateSession(session.id, { turnState: "not_started", lastActive: yield* Clock.currentTimeMillis })
    const subscription = yield* bus.subscribe
    const delivered = yield* send.pipe(
      Effect.as(false),
      Effect.catchTag("RuntimeError", (error) =>
        Effect.gen(function* () {
          if ((yield* collectResult(h, session).pipe(Effect.provideContext(platform), Effect.orDie)) !== "none")
            return true
          if (error.code === "unreachable") return yield* Effect.fail(error)
          yield* missed
          return yield* error
        }),
      ),
    )
    if (delivered) return undefined
    if (state === "unknown" && adapter.ready === "runtime") {
      yield* sawTurnStart(session.id)
      yield* db.updateSession(session.id, { status: "working" })
      return undefined
    }
    const round = { ...session, turnPromptedAt: now }
    if (yield* confirmed(h, round, terminal, subscription)) return undefined
    yield* h.send(terminal, { keys: ["enter"] }).pipe(Effect.ignore)
    if (yield* confirmed(h, round, terminal, subscription)) return undefined
    yield* send.pipe(Effect.ignore)
    if (yield* confirmed(h, round, terminal, subscription)) return undefined
    if ((yield* collectResult(h, session).pipe(Effect.provideContext(platform), Effect.orDie)) !== "none")
      return undefined
    yield* Effect.logInfo(`task_not_started ${session.id}: terminal tail\n${yield* paneTail(h, terminal)}`)
    yield* missed
    return `task_not_started: ${session.id} did not start working on the message; ${peekHint(session.id)}`
  }, Effect.scoped)

  return { awaitReady, sawTurnStart, busy, busyOf, settleAfterInterrupt, interruptAgent, prompt }
}
