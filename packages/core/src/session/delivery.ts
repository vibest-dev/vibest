import { NoSuchSession, RuntimeUnreachable, SessionBusy } from "@vibest/schema/session"
import { Cause, Clock, Context, Duration, Effect, Exit, FileSystem, Layer, Option, Predicate, Ref } from "effect"

import { nextBatch } from "../batch.ts"
import { Bus, type EngineEvent } from "../bus.ts"
import { Db, type SessionRow } from "../db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import * as PlatformNode from "../effect/platform.ts"
import * as Engine from "../engine.ts"
import { Harnesses } from "../harness.ts"
import { Inbox } from "../inbox.ts"
import { errorMessage } from "../plugins.ts"
import { alive, agentState, type Runtime, Runtimes, RuntimeError, stateOf, type Terminal } from "../runtimes.ts"
import type { Platform } from "../session-types.ts"
import { Git } from "../worktree.ts"
import { busy, Executions, STOP_WAIT } from "./executions.ts"
import { Exits } from "./exits.ts"
import { SessionLive } from "./live.ts"
import { SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"

export const unreachable = (session: SessionRow) => (e: { readonly message: string }) =>
  Effect.fail(new RuntimeUnreachable({ session: session.runtime, message: e.message }))

const make = Effect.gen(function* () {
  const db = yield* Db
  const runtimes = yield* Runtimes
  const harnesses = yield* Harnesses
  const inbox = yield* Inbox
  const fs = yield* FileSystem.FileSystem
  const sessionLive = yield* SessionLive
  const locks = yield* SessionLocks
  const { prompt, interruptAgent } = yield* Executions
  const exits = yield* Exits
  const { worktreeOf, handTask, resume } = yield* Placement
  const platform = yield* Effect.context<Platform>()
  const engine = yield* Engine.make
  const { locked } = locks
  const { undelivered } = inbox

  const deliverQueued = Effect.fn("Delivery.deliverQueued")(function* (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
  ) {
    const task = yield* db.untakenTask(session.id)
    if (task !== undefined) return yield* handTask(h, session, terminal, task)
    if (inbox.pulls(session.harnessId)) return
    const pending = yield* db.pendingInbox(session.id)
    if (pending.length === 0) return
    const batch = nextBatch(pending)
    const ids = batch.map((r) => r.id)
    const claimed: Array<number> = []
    let handedInto: number | undefined
    yield* prompt(
      h,
      session,
      terminal,
      batch.map((r) => r.message).join("\n\n"),
      Effect.flatMap(db.openExecution(session.id), (execution) =>
        db.claim(session.id, ids).pipe(
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
        if (rows.length === 0) return Effect.void
        return notStarted
          ? undelivered(session, rows, notStarted)
          : db.setInboxStatus(session.id, claimed, "delivered", "delivering", handedInto)
      }),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || claimed.length === 0
          ? Effect.void
          : db.setInboxStatus(session.id, claimed, "failed", "delivering"),
      ),
      Effect.catchTags({
        RuntimeError: (e) =>
          e.code === "unreachable"
            ? db.pendingInbox(session.id).pipe(
                Effect.flatMap((pending) =>
                  pending.some((r) => claimed.includes(r.id))
                    ? Effect.fail(e)
                    : undelivered(
                        session,
                        batch.filter((r) => claimed.includes(r.id)),
                        `the connection to ${session.runtime} broke after the message was handed over (${e.message}); it may have reached the session`,
                      ),
                ),
              )
            : undelivered(
                session,
                batch.filter((r) => claimed.includes(r.id)),
                e.message,
              ),
        NotReady: (e) => {
          const rows = batch.filter((r) => claimed.includes(r.id))
          if (rows.length > 0) return undelivered(session, rows, e.message)
          return db
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
    db
      .getSession(id)
      .pipe(
        Effect.flatMap((session) =>
          session ? Effect.succeed(session) : Effect.fail(new NoSuchSession({ id, message: `no session ${id}` })),
        ),
      )

  const deliver = Effect.fn("Delivery.deliver")(function* (id: string) {
    const session = yield* getRow(id)
    if (session.metadata.archived || session.metadata.removed)
      return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
    if (
      session.entry ||
      session.executionState === "open" ||
      session.status === "blocked" ||
      (session.startedAt === null && session.exitedAt === null) ||
      (yield* sessionLive.restarting.has(id))
    )
      return
    const h = yield* runtimes.route(session.runtime)
    const terminal = session.address
    const seen = yield* agentState(h, terminal)
    const state = stateOf(seen) === "unknown" ? undefined : stateOf(seen)
    if (state !== undefined && busy(state)) return
    if (state === undefined && !(yield* alive(h, terminal))) {
      if (session.exitedAt === null) return yield* exits.settle(h, id)
      if ((yield* db.pendingInbox(id)).length === 0) return
      if (!(yield* harnesses.get(session.harnessId)).ownSessionId && !session.harnessSessionId)
        return yield* new NoSuchSession({
          id,
          message: `${id} exited before the runtime reported its session id; spawn a new session`,
        })
      yield* resume(h, session)
    }
    const fresh = (yield* db.getSession(id)) ?? session
    yield* deliverQueued(h, fresh, fresh.address)
  })

  const send = Effect.fn("Delivery.send")(function* (id: string, message: string, request?: string, sender?: string) {
    const session = yield* getRow(id)
    if (request !== undefined && (yield* db.queuedBy(id, request))) return
    const worktree = yield* worktreeOf(session)
    if (session.metadata.archived || session.metadata.removed || !(yield* fs.exists(worktree).pipe(Effect.orDie)))
      return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
    const row = yield* db.insertSend(id, message, request, sender)
    if (!row) return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
  })

  const queued = (id: string, inboxId: number | undefined) =>
    Effect.gen(function* () {
      const row = (yield* db.pendingInbox(id)).find((r) => r.id === inboxId)
      if (row === undefined) return
      const failed = (cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          const transient = Cause.findErrorOption(cause).pipe(
            Option.exists(
              (e) =>
                Predicate.isTagged(e, "RuntimeUnreachable") ||
                (e instanceof RuntimeError && (e.code === "unreachable" || e.code === "busy")),
            ),
          )
          if (Cause.hasInterruptsOnly(cause) || transient || !(yield* db.pendingInbox(id)).some((r) => r.id === row.id))
            return
          const session = yield* db.getSession(id)
          if (session !== undefined) yield* inbox.undelivered(session, [row], errorMessage(cause))
        })
      yield* locked(id)(deliver(id).pipe(Effect.catchCause(failed)))
    }).pipe(Effect.provideContext(platform))

  const deliverNext = (id: string) =>
    locked(id)(db.hasQueued(id).pipe(Effect.flatMap((queued) => (queued ? deliver(id) : Effect.void)))).pipe(
      Effect.provideContext(platform),
    )

  const interrupt = Effect.fn("Delivery.interrupt")(function* (id: string) {
    const known = yield* getRow(id)
    return yield* locked(id)(
      Effect.gen(function* () {
        const session = yield* getRow(id)
        const h = yield* runtimes.route(session.runtime)
        const terminal = session.address
        const execution = yield* db.openExecution(id)
        if (execution === undefined)
          return {
            message: `${id} is not working; its execution had already finished and its reply is recorded`,
          }
        const state = stateOf(yield* agentState(h, terminal))
        const runtimeKnows = state !== undefined && state !== "unknown"
        const started = yield* db.executionAccepted(id)
        if (!started && runtimeKnows && !busy(state)) return { message: `${id} is not working; nothing to interrupt` }
        if (!(yield* interruptAgent(h, session, terminal)))
          return yield* new SessionBusy({
            id,
            message: `${id} did not stop within ${Duration.format(STOP_WAIT)}; it may still be working`,
          })
        const closed = yield* db.closeExecution(id, execution, "interrupted")
        if (closed && !runtimeKnows) yield* db.setStatus(id, "idle")
        const last = closed ? undefined : yield* db.latestReply(id)
        if (!closed && !(last?.execution === execution && last.status === "interrupted"))
          return {
            message: `${id} finished its execution before the interrupt took effect; its reply is recorded`,
          }
        return { message: `${id} interrupted; its terminal, worktree and session are kept` }
      }),
    ).pipe(Effect.catchTags({ RuntimeError: unreachable(known) }), Effect.provideContext(platform))
  })

  const userPrompt = Effect.fn("Delivery.userPrompt")(function* (
    id: string,
    text: string,
    at?: number,
    process?: number,
  ) {
    const now = at ?? (yield* Clock.currentTimeMillis)
    const prompting = yield* Ref.get((yield* sessionLive.track(id)).prompting)
    yield* db.startObserved(id, prompting || text.trim() === "" ? undefined : text, now, process)
  })

  const handle = (event: EngineEvent): Effect.Effect<unknown, unknown> => {
    switch (event.type) {
      case "execution.ended":
        return event.data.outcome === "failed" ? Effect.void : deliverNext(event.sessionId!)
      case "inbox.queued":
        return queued(event.sessionId!, event.seq)
      default:
        return Effect.void
    }
  }

  yield* engine.on(handle)

  yield* db.recoverDelivering(
    (sessionId, messages) =>
      `A message to ${sessionId} was not delivered: vibestd stopped while handing it to the session; it may or may not have arrived\n\n${messages.join("\n\n")}`,
  )

  return { deliverQueued, send, interrupt, userPrompt }
})

export class Delivery extends Context.Service<Delivery, Effect.Success<typeof make>>()("vibest/Delivery") {
  static readonly make = make

  static readonly layer = Layer.effect(Delivery, make)

  static readonly node = LayerNode.make({
    service: Delivery,
    layer: Delivery.layer,
    deps: [
      Bus.node,
      Db.node,
      Executions.node,
      Exits.node,
      Harnesses.node,
      Inbox.node,
      Placement.node,
      Runtimes.node,
      SessionLive.node,
      SessionLocks.node,
      Git.node,
      PlatformNode.childProcessSpawner,
      PlatformNode.crypto,
      PlatformNode.fileSystem,
      PlatformNode.path,
    ],
  })
}
