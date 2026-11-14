import { ExecutionEnded, InboxQueued } from "@vibest/schema/event"
import { NoSuchSession, RuntimeUnreachable, SessionBusy } from "@vibest/schema/session"
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect"

import { nextBatch } from "../batch.ts"
import { Bus } from "../bus.ts"
import {
  type SessionRow,
  harnessIdOf,
  runtimeOf,
  terminalOf,
  exitedAt,
  executionStateOf,
  archived,
} from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Harnesses } from "../harness.ts"
import { Inbox, text as inboxText } from "../inbox.ts"
import { errorMessage } from "../plugin.ts"
import * as Reactor from "../reactor.ts"
import { alive, agentState, type Runtime, Runtimes, RuntimeError, stateOf, type Terminal } from "../runtimes.ts"
import { busy, Executions, STOP_WAIT } from "./executions.ts"
import { Exits } from "./exits.ts"
import { SessionLive } from "./live.ts"
import { SessionLocks } from "./locks.ts"
import { Placement } from "./placement.ts"

export class SendRefused extends Schema.TaggedError<SendRefused>()("SendRefused", {
  message: Schema.String,
}) {}

export const unreachable = (session: SessionRow) => (e: { readonly message: string }) =>
  Effect.fail(new RuntimeUnreachable({ session: runtimeOf(session), message: e.message }))

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
  const reactor = yield* Reactor.make
  const { locked } = locks
  const { undelivered } = inbox

  const deliverQueued = Effect.fn("Delivery.deliverQueued")(function* (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
  ) {
    const task = yield* db.untakenTask(session.id)
    if (task !== undefined) return yield* handTask(h, session, terminal, task)
    if (inbox.pulls(harnessIdOf(session))) return
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
                        `the connection to ${runtimeOf(session)} broke after the message was handed over (${e.message}); it may have reached the session`,
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
    if (archived(session)) return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
    if (
      session.entry ||
      executionStateOf(session) === "open" ||
      session.status === "blocked" ||
      ((session.process?.placedAt ?? null) === null && exitedAt(session) === null) ||
      (yield* sessionLive.restarting.has(id))
    )
      return
    const h = yield* runtimes.route(runtimeOf(session))
    const terminal = terminalOf(session)
    const seen = yield* agentState(h, terminal)
    const state = stateOf(seen) === "unknown" ? undefined : stateOf(seen)
    if (state !== undefined && busy(state)) return
    if (state === undefined && !(yield* alive(h, terminal))) {
      if (exitedAt(session) === null) return yield* exits.settle(h, id)
      if ((yield* db.pendingInbox(id)).length === 0) return
      if (!(yield* harnesses.get(harnessIdOf(session))).ownSessionId && !(session.process?.conversation ?? null))
        return yield* new NoSuchSession({
          id,
          message: `${id} exited before the runtime reported its session id; spawn a new session`,
        })
      yield* resume(h, session)
    }
    const fresh = (yield* db.getSession(id)) ?? session
    yield* deliverQueued(h, fresh, terminalOf(fresh))
  })

  const send = Effect.fn("Delivery.send")(function* (id: string, message: string, request?: string, sender?: string) {
    const session = yield* getRow(id)
    if (request !== undefined && (yield* db.queuedBy(id, request))) return
    const worktree = yield* worktreeOf(session)
    if (archived(session) || !(yield* fs.exists(worktree).pipe(Effect.orDie)))
      return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
    const row = yield* db.insertSend(id, message, request, sender)
    if (!row) return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
  })

  const toEntry = (id: string, message: string, request?: string, sender?: string) =>
    Effect.gen(function* () {
      if (!(yield* db.insertSend(id, message, request, sender)))
        return yield* new NoSuchSession({
          id,
          message: `${id} is the entry session of this project and is not running`,
        })
    })

  const deliverTo = Effect.fn("Delivery.deliverTo")(function* (
    id: string,
    message: string,
    request?: string,
    sender?: string,
  ) {
    if (!(yield* db.sessionIdentity(id))?.entry) return yield* send(id, message, request, sender)
    return yield* toEntry(id, message, request)
  })

  const admit = Effect.fn("Delivery.admit")(function* (
    sender: { readonly sessionId: string; readonly projectId: string },
    input: string,
    message: string,
    request?: string,
  ) {
    const toOrigin = yield* db.sendToOrigin(sender.sessionId, input, message, request)
    if (toOrigin === false)
      return yield* new NoSuchSession({
        id: input,
        message: `${input} is on another machine that vibestd does not know; nothing was sent`,
      })
    if (toOrigin === true) return { id: input }
    const id = yield* db.resolveSession(input)
    const target = yield* db.sessionIdentity(id)
    if (target?.projectId !== sender.projectId)
      return yield* new SendRefused({
        message: `${id} belongs to another entry session's project; a message goes only to an agent of your own project`,
      })
    const creator = (yield* db.creatorOf(sender.sessionId)) ?? undefined
    const mine = creator !== undefined && "local" in creator ? creator.local : undefined
    if (!(yield* db.maySend(sender.sessionId, id)))
      return yield* new SendRefused({
        message: `${id} is not the agent that started you, and you did not start it${mine === undefined ? "" : `; you may send to ${mine}`}`,
      })
    const session = yield* db.getSession(id)
    const stopped = !session || archived(session)
    if (!(stopped && mine === id)) {
      if (stopped && !target.entry) return yield* new NoSuchSession({ id, message: `${id} was archived` })
      if (target.entry) yield* toEntry(id, message, request, sender.sessionId)
      else yield* send(id, message, request, sender.sessionId)
      return { id }
    }
    const heir = yield* db.nearestAlive(sender.sessionId)
    if (heir === undefined)
      return yield* new NoSuchSession({
        id,
        message: `${id} has ended and no session above it is running; the user reads your last reply with vibest result`,
      })
    if ("peer" in heir) {
      if (!(yield* db.sendToPeer(sender.sessionId, heir.peer, heir.session, message, request)))
        return yield* new NoSuchSession({
          id,
          message: `${id} has ended and the session above it is on another machine that vibestd does not know; nothing was sent`,
        })
      return { id: heir.session }
    }
    if ((yield* db.sessionIdentity(heir.local))?.entry) yield* toEntry(heir.local, message, request, sender.sessionId)
    else yield* send(heir.local, message, request, sender.sessionId)
    return { id: heir.local }
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
    })

  const deliverNext = (id: string) =>
    locked(id)(db.hasQueued(id).pipe(Effect.flatMap((queued) => (queued ? deliver(id) : Effect.void)))).pipe()

  const interrupt = Effect.fn("Delivery.interrupt")(function* (id: string) {
    const known = yield* getRow(id)
    return yield* locked(id)(
      Effect.gen(function* () {
        const session = yield* getRow(id)
        const h = yield* runtimes.route(runtimeOf(session))
        const terminal = terminalOf(session)
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
    yield* db.startObserved(id, prompting || text.trim() === "" ? undefined : text, now, process)
  })

  const typeTaken = Effect.fn("Delivery.typeTaken")(function* (id: string, execution: number) {
    yield* locks.withLock(id)(
      Effect.gen(function* () {
        const session = yield* db.getSession(id)
        if (session === undefined) return
        const r = yield* sessionLive.track(id)
        const rows = yield* db.unacceptedBatch(id, execution)
        if (rows === undefined || rows.length === 0 || !(yield* inbox.claimRetype(id, execution))) return
        const h = yield* runtimes.route(runtimeOf(session))
        yield* Ref.set(r.prompting, true).pipe(
          Effect.andThen(h.send(terminalOf(session), { text: inboxText(rows) })),
          Effect.ensuring(Ref.set(r.prompting, false)),
          Effect.ignore,
        )
      }).pipe(Effect.catchTag("NoRuntime", () => Effect.void)),
    )
  })

  yield* reactor.on([ExecutionEnded], (event) =>
    event.data.outcome === "failed" ? Effect.void : deliverNext(event.sessionId!),
  )
  yield* reactor.on([InboxQueued], (event) => queued(event.sessionId!, event.seq))

  yield* db.recoverDelivering(
    (sessionId, messages) =>
      `A message to ${sessionId} was not delivered: vibestd stopped while handing it to the session; it may or may not have arrived\n\n${messages.join("\n\n")}`,
  )

  return { deliverQueued, send, deliverTo, admit, interrupt, userPrompt, typeTaken }
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
      PlatformNode.fileSystem,
    ],
  })
}
