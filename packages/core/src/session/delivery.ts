import { NoSuchSession, RuntimeUnreachable, SessionBusy } from "@vibest/schema/session"
import { SessionEvent } from "@vibest/schema/session-event"
import { LayerNode } from "@vibest/util/layer-node"
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Predicate, Ref } from "effect"

import { awaitEvent, Bus } from "../bus.ts"
import {
  type SessionRow,
  harnessIdOf,
  isRoot,
  runtimeOf,
  terminalOf,
  exitedAt,
  executionStateOf,
  archived,
  startOf,
} from "../database/rows.ts"
import { Harnesses } from "../harness/registry.ts"
import { Inbox, content as inboxContent } from "../inbox.ts"
import { InboxStore } from "../inbox/store.ts"
import { errorMessage } from "../plugin.ts"
import * as Reactor from "../reactor.ts"
import { nextBatch } from "../runtime/batch.ts"
import {
  alive,
  agentState,
  type Runtime,
  Runtimes,
  RuntimeError,
  sessionState,
  stateOf,
  type Terminal,
} from "../runtime/registry.ts"
import { busy, Executions, HANDOFF_UNPROVED, HOOK_GRACE, STOP_WAIT } from "./executions.ts"
import { Exits } from "./exits.ts"
import { SessionLive } from "./live.ts"
import { SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"
import { RunCoordinator } from "./run-coordinator.ts"
import { Sends } from "./sends.ts"
import { Starts } from "./starts.ts"
import { SessionStore } from "./store.ts"

export * as Delivery from "./delivery.ts"

export const unreachable = (session: SessionRow) => (e: { readonly message: string }) =>
  Effect.fail(new RuntimeUnreachable({ session: runtimeOf(session), message: e.message }))

export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const sessionStore = yield* SessionStore.Service
  const inboxStore = yield* InboxStore.Service
  const runtimes = yield* Runtimes.Service
  const harnesses = yield* Harnesses.Service
  const inbox = yield* Inbox.Service
  const sessionLive = yield* SessionLive.Service
  const locks = yield* SessionLocks.Service
  const { prompt, interruptAgent } = yield* Executions.Service
  const exits = yield* Exits.Service
  const { notice, resume, taskInput } = yield* Placement.Service
  const { send, admit } = yield* Sends.Service
  const reactor = yield* Reactor.make
  const starts = yield* Starts.Service
  const { locked } = locks
  const { undelivered } = inbox

  const deliverQueued = Effect.fn("Delivery.deliverQueued")(function* (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal | undefined,
    hand?: (
      text: string,
      onHandover: Effect.Effect<void>,
    ) => Effect.Effect<
      string | undefined,
      Effect.Error<ReturnType<typeof prompt>> | Effect.Error<ReturnType<typeof resume>>
    >,
  ) {
    const into =
      hand ??
      ((text: string, onHandover: Effect.Effect<void>) =>
        terminal === undefined
          ? Effect.die("deliverQueued called without a terminal")
          : prompt(h, session, terminal, text, onHandover))

    const task = yield* inboxStore.untakenTask(session.id)

    if (task !== undefined) {
      const first = yield* taskInput(session, task.content)

      const notStarted = yield* into(first.text, first.onHandover).pipe(
        Effect.catchTag("HandoffRejected", (e) =>
          undelivered(session, [{ id: task.id, message: task.content }], e.message).pipe(Effect.as(undefined)),
        ),
      )

      if (notStarted === HANDOFF_UNPROVED) return

      if (notStarted) yield* notice(session, notStarted)

      return
    }

    if (hand === undefined && inbox.pulls(harnessIdOf(session))) return
    const pending = yield* inboxStore.pendingInbox(session.id)

    if (pending.length === 0) return
    const batch = nextBatch(pending)
    const ids = batch.map((r) => r.id)
    const claimed: Array<number> = []
    let handedInto: number | undefined
    yield* into(
      batch.map((r) => r.message).join("\n\n"),
      Effect.flatMap(sessionStore.openExecution(session.id), (execution) =>
        inboxStore.claim(session.id, ids, execution).pipe(
          Effect.tap((got) =>
            Effect.sync(() => {
              claimed.push(...got)
              handedInto = execution
            }),
          ),
        ),
      ),
    ).pipe(
      Effect.flatMap((notStarted) => {
        const rows = batch.filter((r) => claimed.includes(r.id))

        if (rows.length === 0 || handedInto === undefined) return Effect.void

        if (notStarted === HANDOFF_UNPROVED) return inboxStore.confirm(session.id, handedInto)

        if (notStarted) return Effect.void

        return inboxStore.setInboxStatus(session.id, claimed, "delivered", "delivering", handedInto)
      }),
      Effect.catchTags({
        HandoffRejected: (e) => {
          const rows = batch.filter((r) => claimed.includes(r.id))

          return rows.length === 0 ? Effect.fail(e) : undelivered(session, rows, e.message)
        },
        RuntimeError: (e) => {
          const rows = batch.filter((r) => claimed.includes(r.id))

          if (claimed.length === 0) return Effect.fail(e)

          if (e.code === "unreachable")
            return inboxStore
              .pendingInbox(session.id)
              .pipe(
                Effect.flatMap((pending) =>
                  pending.some((r) => claimed.includes(r.id)) ? Effect.fail(e) : Effect.void,
                ),
              )

          if (handedInto === undefined) return undelivered(session, rows, e.message)

          return sessionStore
            .executionWasAccepted(session.id, handedInto)
            .pipe(Effect.flatMap((accepted) => (accepted ? Effect.void : undelivered(session, rows, e.message))))
        },
        NotReady: (e) => {
          const rows = batch.filter((r) => claimed.includes(r.id))

          if (rows.length > 0) return undelivered(session, rows, e.message)

          return inboxStore
            .pendingInbox(session.id)
            .pipe(
              Effect.flatMap((pending) =>
                ids.some((id) => pending.some((r) => r.id === id)) ? Effect.fail(e) : Effect.void,
              ),
            )
        },
      }),
    )
  })

  const getRow = (id: string) =>
    sessionStore
      .getSession(id)
      .pipe(
        Effect.flatMap((session) =>
          session ? Effect.succeed(session) : Effect.fail(new NoSuchSession({ id, message: `no session ${id}` })),
        ),
      )

  const resumeAdmitted = (id: string) =>
    Effect.gen(function* () {
      const admitted = (yield* sessionStore.getSession(id))?.process?.id

      return yield* Effect.gen(function* () {
        const session = yield* getRow(id)

        if (archived(session)) return
        const h = yield* runtimes.route(runtimeOf(session))

        return yield* deliverQueued(h, session, terminalOf(session)?.target, (text, onHandover) =>
          resume(h, session, { text, onHandover }),
        )
      }).pipe(
        Effect.ensuring(
          sessionStore
            .getSession(id)
            .pipe(
              Effect.flatMap((now) =>
                now?.process?.id === admitted && (now?.process?.placedAt ?? null) === null
                  ? sessionStore.endProcess(id, "launch_failed", admitted)
                  : Effect.void,
              ),
            ),
        ),
      )
    })

  const relaunch = (id: string) => locked(id)(resumeAdmitted(id)).pipe(Reactor.logFailure(`relaunch ${id}`))

  const deliver = Effect.fn("Delivery.deliver")(function* (id: string) {
    const session = yield* getRow(id)

    if (archived(session)) return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })

    const localRoot = isRoot(session) && !(yield* sessionStore.startedByRemote(id))

    if (
      (localRoot && exitedAt(session) === null && inbox.pulls(harnessIdOf(session))) ||
      executionStateOf(session) === "open" ||
      session.status === "blocked" ||
      ((session.process?.placedAt ?? null) === null && exitedAt(session) === null) ||
      (yield* sessionLive.restarting.has(id))
    )
      return
    const h = yield* runtimes.route(runtimeOf(session))
    const terminal = terminalOf(session)?.target
    const seen = terminal === undefined ? ("absent" as const) : yield* agentState(h, terminal)
    const state = stateOf(seen) === "unknown" ? undefined : stateOf(seen)

    if (state !== undefined && busy(state)) return

    if (state === undefined && (terminal === undefined || !(yield* alive(h, terminal)))) {
      if (exitedAt(session) === null) return yield* exits.settle(h, id, session.process?.id)

      if (localRoot) return

      if ((yield* inboxStore.pendingInbox(id)).length === 0) return

      if (!(yield* harnesses.get(harnessIdOf(session))).ownSessionId && !(session.process?.harnessSessionId ?? null))
        return yield* new NoSuchSession({
          id,
          message: `${id} exited before the runtime reported its session id; spawn a new session`,
        })

      const start = startOf(session)

      if (!(yield* starts.admit(id, start))) return yield* starts.wait({ id, start, launch: relaunch(id) })

      return yield* resumeAdmitted(id)
    }

    const fresh = (yield* sessionStore.getSession(id)) ?? session
    const freshTerminal = terminalOf(fresh)?.target

    if (freshTerminal !== undefined) yield* deliverQueued(h, fresh, freshTerminal)
  })

  const undeliverable = (id: string, rows: ReadonlySet<number>) => (cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      if (rows.size === 0) return yield* Effect.failCause(cause)

      const transient = Cause.findErrorOption(cause).pipe(
        Option.exists(
          (e) =>
            Predicate.isTagged(e, "RuntimeUnreachable") ||
            (e instanceof RuntimeError && (e.code === "unreachable" || e.code === "busy")),
        ),
      )

      if (Cause.hasInterruptsOnly(cause) || transient) return
      const stuck = (yield* inboxStore.pendingInbox(id)).filter((r) => rows.has(r.id))
      const session = yield* sessionStore.getSession(id)

      if (stuck.length > 0 && session !== undefined) yield* inbox.undelivered(session, stuck, errorMessage(cause))
    })

  type Wake = { readonly rows: ReadonlySet<number>; readonly ended: boolean }

  const due = (id: string, wake: Wake) =>
    Effect.gen(function* () {
      if (wake.ended && (yield* inboxStore.hasQueued(id))) return true

      return wake.rows.size > 0 && (yield* inboxStore.pendingInbox(id)).some((r) => wake.rows.has(r.id))
    })

  const deliverWoken = (id: string, wake: Wake) =>
    locked(id)(
      due(id, wake).pipe(
        Effect.flatMap((ready) => (ready ? deliver(id) : Effect.void)),
        Effect.catchCause(undeliverable(id, wake.rows)),
      ),
    ).pipe(Reactor.logFailure(`deliver ${id}`))

  const wakes = yield* RunCoordinator.make<string, Wake>({
    drain: deliverWoken,
    merge: (pending, next) => ({ rows: new Set([...pending.rows, ...next.rows]), ended: pending.ended || next.ended }),
  })

  const interrupt = Effect.fn("Delivery.interrupt")(function* (id: string) {
    const known = yield* getRow(id)

    if (yield* starts.remove(id)) {
      if (known.process === null) {
        yield* sessionStore.endUnstarted(id, "not_started")

        return { message: `${id} was waiting for a free slot; it will not start` }
      }

      return {
        message: `${id} was waiting for a free slot to resume; it stays stopped until another message or the next vibestd start delivers its pending ones`,
      }
    }

    return yield* locked(id)(
      Effect.gen(function* () {
        const session = yield* getRow(id)
        const h = yield* runtimes.route(runtimeOf(session))
        const terminal = terminalOf(session)?.target
        const execution = yield* sessionStore.openExecution(id)

        if (execution === undefined)
          return {
            message: `${id} is not working; its execution had already finished and its reply is recorded`,
          }

        if (terminal === undefined) return { message: `${id} is not working; nothing to interrupt` }
        const state = stateOf(yield* sessionState(h, terminal, Effect.succeed(session.status))) ?? "unknown"

        if (!(yield* sessionStore.executionAccepted(id)) && !busy(state))
          return { message: `${id} is not working; nothing to interrupt` }

        if (!(yield* interruptAgent(h, session, terminal)))
          return yield* new SessionBusy({
            id,
            message: `${id} did not stop within ${Duration.format(STOP_WAIT)}; it may still be working`,
          })

        const settled = Effect.map(sessionStore.openExecution(id), (open) => open !== execution)

        const confirmed =
          (yield* settled) || harnesses.find(harnessIdOf(session))?.executionEnd === undefined
            ? yield* settled
            : yield* awaitEvent(
                Effect.map(settled, (done) => (done ? Option.some(true) : Option.none())),
                (event) =>
                  (event.type === "session.execution.interrupted" ||
                    event.type === "session.execution.succeeded" ||
                    event.type === "session.execution.failed" ||
                    event.type === "session.execution.unresolved") &&
                  event.data.sessionId === id
                    ? Effect.map(settled, (done) => (done ? Option.some(true) : Option.none()))
                    : Effect.succeed(Option.none()),
                HOOK_GRACE,
                settled,
              ).pipe(Effect.provideService(Bus.Service, bus))

        if (!confirmed)
          return {
            message: `${id} is idle, but the interrupt was not confirmed; its execution is unchanged`,
          }
        const last = yield* sessionStore.latestReply(id)

        if (last?.execution === execution && last.status === "interrupted")
          return { message: `${id} interrupted; its terminal, worktree and session are kept` }

        return {
          message: `${id} finished its execution before the interrupt took effect; its reply is recorded`,
        }
      }),
    ).pipe(Effect.catchTags({ RuntimeError: unreachable(known) }))
  })

  const userPrompt = Effect.fn("Delivery.userPrompt")(function* (
    id: string,
    text: string,
    at?: number,
    process?: number,
  ) {
    const now = at ?? (yield* Clock.currentTimeMillis)
    const prompting = yield* Ref.get((yield* sessionLive.track(id)).prompting)
    const activity = text.trim() === ""
    yield* sessionStore.startObserved(
      id,
      prompting || activity ? undefined : text,
      now,
      process,
      !prompting && activity,
    )
  })

  const typeTaken = Effect.fn("Delivery.typeTaken")(function* (id: string, execution: number) {
    yield* locks.withLock(id)(
      Effect.gen(function* () {
        const session = yield* sessionStore.getSession(id)

        if (session === undefined) return
        const rows = yield* inboxStore.unacceptedBatch(id, execution)

        if (rows === undefined || rows.length === 0 || !(yield* inbox.claimRetype(id, execution))) return
        const h = yield* runtimes.route(runtimeOf(session))
        const terminal = terminalOf(session)?.target

        if (terminal !== undefined) yield* h.send(terminal, { text: inboxContent(rows) }).pipe(Effect.ignore)
      }).pipe(Effect.catchTag("NoRuntime", () => Effect.void)),
    )
  })

  yield* reactor.on(
    [SessionEvent.ExecutionSucceeded, SessionEvent.ExecutionInterrupted, SessionEvent.ExecutionUnresolved],
    (event) => wakes.wake(event.data.sessionId, { rows: new Set(), ended: true }),
  )
  yield* reactor.on([SessionEvent.InboxEnqueued], (event) =>
    wakes.wake(event.data.sessionId, { rows: new Set([event.data.messageId]), ended: false }),
  )

  for (const id of yield* sessionStore.unstartedRuns()) {
    const session = yield* sessionStore.getSession(id)

    if (session !== undefined && (yield* inboxStore.untakenTask(id)) !== undefined)
      yield* sessionStore.endUnstarted(
        id,
        "not_started",
        `${id} (${session.name}) did not start: vibestd restarted while it was waiting for a free slot; run it again`,
      )
  }

  for (const id of yield* inboxStore.pendingRecipients()) {
    const session = yield* sessionStore.getSession(id)

    if (
      session !== undefined &&
      !archived(session) &&
      exitedAt(session) !== null &&
      !(isRoot(session) && !(yield* sessionStore.startedByRemote(id)))
    )
      yield* wakes.wake(id, { rows: new Set(), ended: true })
  }

  return { deliverQueued, send, admit, interrupt, userPrompt, typeTaken }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Delivery") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Bus.node,
    SessionStore.node,
    InboxStore.node,
    Executions.node,
    Exits.node,
    Harnesses.node,
    Inbox.node,
    Placement.node,
    Runtimes.node,
    SessionLive.node,
    SessionLocks.node,
    Sends.node,
    Starts.node,
  ],
})
