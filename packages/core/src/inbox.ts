import { type Sender } from "@vibest/schema/event"
import { sessionLabel } from "@vibest/schema/id"
import type { Taken, InboxRow } from "@vibest/schema/session"
import { SessionEvent } from "@vibest/schema/session-event"
import type { TerminalTarget } from "@vibest/schema/terminal"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer, Queue, Stream } from "effect"

import { Bus } from "./bus.ts"
import { type NewInboxRow, type SessionRow, harnessIdOf, localSessionOf } from "./database/db-rows.ts"
import { Db } from "./database/db.ts"
import { Drain } from "./drain.ts"
import { Harnesses } from "./harnesses.ts"
import * as Reactor from "./reactor.ts"
import { detailOf } from "./replies.ts"
import { agentState, alive, RuntimeError, type Runtime } from "./runtimes.ts"

export * as Inbox from "./inbox.ts"

export type Presence = "idle" | "busy" | "gone" | "unknown"

export const terminalPresence = Effect.fn("Inbox.terminalPresence")(function* (
  h: Runtime,
  terminal: TerminalTarget,
): Effect.fn.Return<Presence, RuntimeError> {
  const seen = yield* agentState(h, terminal)

  if (seen === "unknown" || seen === "absent") return (yield* alive(h, terminal)) ? "busy" : "gone"

  return seen === "idle" ? "idle" : "busy"
})

export const content = (batch: ReadonlyArray<InboxRow>) => batch.map((r) => r.message).join("\n\n")

export type Undelivered = ReadonlyArray<{
  readonly id: number
  readonly message: string
  readonly kind?: string
  readonly sender?: Sender
}>

export interface Interface {
  readonly enqueue: (row: NewInboxRow) => Effect.Effect<InboxRow | undefined>
  readonly pulls: (harnessId: string) => boolean
  readonly take: (sessionId: string, process: number | undefined) => Effect.Effect<Taken | undefined>
  readonly stream: (sessionId: string) => Stream.Stream<null>
  readonly claimRetype: (sessionId: string, execution: number) => Effect.Effect<boolean>
  readonly undelivered: (session: SessionRow, rows: Undelivered, reason: string) => Effect.Effect<void>
  readonly dropQueue: (session: SessionRow, reason: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("vibest/Inbox") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* Db.Service
    const drain = yield* Drain.Service
    const harnesses = yield* Harnesses.Service
    const reactor = yield* Reactor.make

    const pulls = (harnessId: string) => harnesses.find(harnessId)?.delivery === "pull"

    const handedOver = new Set<string>()
    const handedKey = (sessionId: string | undefined, execution: number) => `${sessionId}:${execution}`
    const waiting = new Map<string, Set<Queue.Queue<null>>>()

    const wake = (id: string | undefined) =>
      Effect.sync(() => {
        for (const signal of (id === undefined ? undefined : waiting.get(id)) ?? []) Queue.offerUnsafe(signal, null)
      })

    const forgetHandover = (sessionId: string | undefined, execution: number) =>
      Effect.sync(() => handedOver.delete(handedKey(sessionId, execution)))

    yield* reactor.on(
      [
        SessionEvent.ExecutionSucceeded,
        SessionEvent.ExecutionFailed,
        SessionEvent.ExecutionInterrupted,
        SessionEvent.ExecutionUnresolved,
      ],
      (event) =>
        forgetHandover(event.data.sessionId, event.data.executionId).pipe(Effect.andThen(wake(event.data.sessionId))),
    )
    yield* reactor.on([SessionEvent.ExecutionStarted], (event) =>
      forgetHandover(event.data.sessionId, event.data.executionId),
    )
    yield* reactor.on([SessionEvent.InboxEnqueued], (event) => wake(event.data.sessionId))

    const stream = (sessionId: string) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const signal = yield* Queue.sliding<null>(1)
          yield* Effect.acquireRelease(
            Effect.sync(() => waiting.set(sessionId, (waiting.get(sessionId) ?? new Set()).add(signal))),
            () =>
              Effect.sync(() => {
                const open = waiting.get(sessionId)
                open?.delete(signal)

                if (open?.size === 0) waiting.delete(sessionId)
              }),
          )
          Queue.offerUnsafe(signal, null)

          return Stream.fromQueue(signal)
        }),
      )

    const take = Effect.fn("Inbox.take")(function* (sessionId: string, process: number | undefined) {
      if ((yield* drain.phase) !== "open") return undefined
      const session = yield* db.session.getSession(sessionId)

      if (session === undefined || !pulls(harnessIdOf(session))) return undefined
      const taken = yield* drain.work(`take inbox of ${sessionId}`, db.inbox.takeInbox(sessionId, process))

      if (taken === undefined) return undefined
      handedOver.add(handedKey(sessionId, taken.execution))

      return {
        execution: taken.execution,
        ids: taken.rows.map((r) => r.id),
        content: content(taken.rows),
        detail: detailOf(taken.rows),
      } satisfies Taken
    })

    const undelivered = Effect.fn("Inbox.undelivered")((session: SessionRow, rows: Undelivered, reason: string) =>
      db.inbox
        .setInboxStatus(
          session.id,
          rows.map((r) => r.id),
          "failed",
          undefined,
          undefined,
          reason,
        )
        .pipe(
          Effect.andThen(
            Effect.forEach(
              [...Map.groupBy(rows, (r) => (r.sender === undefined ? null : (localSessionOf(r.sender) ?? null)))],
              ([sender, group]) => {
                const message = `A message to ${sessionLabel(session)} was not delivered: ${reason}\n\n${group.map((r) => r.message).join("\n\n")}`

                return sender === null
                  ? db.inbox.insertInbox({ sessionId: session.id, message })
                  : db.inbox.insertNoticeTo(sender, message)
              },
              { discard: true },
            ),
          ),
          Effect.asVoid,
        ),
    )

    const dropQueue = Effect.fn("Inbox.dropQueue")((session: SessionRow, reason: string) =>
      Effect.gen(function* () {
        const pending = yield* db.inbox.pendingInbox(session.id)
        const task = yield* db.inbox.unsentDelegation(session.id)

        if (pending.length > 0) yield* undelivered(session, pending, reason)

        if (task.length === 0) return
        yield* db.inbox.dropUnsent(session.id, reason)

        const message = `A message to ${sessionLabel(session)} was not delivered: ${reason}\n\n${task.map((row) => row.message).join("\n\n")}`
        const sender = task[0]?.sender
        const local = sender === undefined ? undefined : localSessionOf(sender)

        if (local === undefined) yield* db.inbox.insertInbox({ sessionId: session.id, message })
        else yield* db.inbox.insertNoticeTo(local, message)
      }),
    )

    const claimRetype = Effect.fn("Inbox.claimRetype")((sessionId: string, execution: number) =>
      Effect.sync(() => handedOver.delete(handedKey(sessionId, execution))),
    )

    return Service.of({ enqueue: db.inbox.insertInbox, pulls, take, stream, claimRetype, undelivered, dropQueue })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Bus.node, Db.node, Drain.node, Harnesses.node],
})
