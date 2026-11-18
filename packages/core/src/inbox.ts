import { ExecutionAccepted, ExecutionEnded, InboxMoved, InboxQueued } from "@vibest/schema/event"
import type { Taken, InboxRow, RuntimeAddress } from "@vibest/schema/session"
import { Context, Effect, Layer, Queue, Stream } from "effect"

import { Bus, TerminalExited } from "./bus.ts"
import { type NewInboxRow, type SessionRow, harnessIdOf } from "./database/db-rows.ts"
import { Db } from "./database/db.ts"
import { Drain } from "./drain.ts"
import { LayerNode } from "./effect/layer-node.ts"
import { Harnesses } from "./harnesses.ts"
import * as Reactor from "./reactor.ts"
import { displayOf } from "./replies.ts"
import { agentState, alive, RuntimeError, type Runtime } from "./runtimes.ts"

export * as Inbox from "./inbox.ts"

export type Presence = "idle" | "busy" | "gone" | "unknown"

export const entryIdle = Effect.fn("Inbox.entryIdle")(function* (
  h: Runtime,
  terminal: RuntimeAddress,
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
  readonly sender?: string | null
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

    yield* reactor.on([ExecutionEnded], (event) =>
      Effect.sync(() => handedOver.delete(handedKey(event.sessionId, event.data.execution))).pipe(
        Effect.andThen(wake(event.sessionId)),
      ),
    )
    yield* reactor.on([ExecutionAccepted], (event) =>
      Effect.sync(() => void handedOver.delete(handedKey(event.sessionId, event.data.execution))),
    )
    yield* reactor.on([InboxQueued], (event) => wake(event.sessionId))
    yield* reactor.on([InboxMoved], (event) => (event.data.to === "pending" ? wake(event.sessionId) : Effect.void))
    yield* reactor.on([TerminalExited], (event) =>
      drain.work("entry session exited", db.session.clearEntry(event.processes), true),
    )

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
      const who = new Map<string, { readonly agent: string; readonly title: string }>()

      for (const row of taken.rows) {
        if (row.kind === "notice" || row.sender === null || who.has(row.sender)) continue
        const found = yield* db.session.getSession(row.sender)

        if (found !== undefined) who.set(row.sender, { agent: found.agent, title: found.name })
      }

      return {
        execution: taken.execution,
        ids: taken.rows.map((r) => r.id),
        content: content(taken.rows),
        display: displayOf(taken.rows, (id) => who.get(id)),
      } satisfies Taken
    })

    const undelivered = Effect.fn("Inbox.undelivered")((session: SessionRow, rows: Undelivered, reason: string) =>
      db.inbox
        .setInboxStatus(
          session.id,
          rows.map((r) => r.id),
          "failed",
        )
        .pipe(
          Effect.andThen(
            Effect.forEach(
              [...Map.groupBy(rows, (r) => (r.kind === "send" ? (r.sender ?? null) : null))],
              ([sender, group]) => {
                const message = `A message to ${session.id} was not delivered: ${reason}\n\n${group.map((r) => r.message).join("\n\n")}`

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
      db.inbox
        .pendingInbox(session.id)
        .pipe(Effect.flatMap((rows) => (rows.length === 0 ? Effect.void : undelivered(session, rows, reason)))),
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
