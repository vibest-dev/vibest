import type { Taken } from "@vibest/protocol/protocol"
import { ExecutionAccepted, ExecutionEnded, InboxMoved, InboxQueued } from "@vibest/schema/event"
import { shortId } from "@vibest/schema/id"
import { Context, Effect, Layer, Queue, Stream } from "effect"

import { Bus, TerminalExited } from "./bus.ts"
import { Db, type InboxRow, type NewInboxRow, type RuntimeAddress, type SessionRow, harnessIdOf } from "./db.ts"
import { Drain } from "./drain.ts"
import { LayerNode } from "./effect/layer-node.ts"
import { Harnesses } from "./harness.ts"
import * as Reactor from "./reactor.ts"
import { unwrapped } from "./replies.ts"
import { agentState, alive, RuntimeError, type Runtime } from "./runtimes.ts"

export type Presence = "idle" | "busy" | "gone" | "unknown"

export const entryIdle = (h: Runtime, terminal: RuntimeAddress): Effect.Effect<Presence, RuntimeError> =>
  Effect.gen(function* () {
    const seen = yield* agentState(h, terminal)
    if (seen === "unknown" || seen === "absent") return (yield* alive(h, terminal)) ? "busy" : "gone"
    return seen === "idle" ? "idle" : "busy"
  })

export const text = (batch: ReadonlyArray<InboxRow>) => batch.map((r) => r.message).join("\n\n")

export const LINE_MAX = 120

const codePoints = (s: string) => [...s].length
const clip = (s: string, max: number) => {
  const cps = [...s]
  return cps.length <= max ? s : `${cps.slice(0, Math.max(0, max - 1)).join("")}…`
}

export const line = (
  batch: ReadonlyArray<InboxRow>,
  who: (sessionId: string) => { readonly agent: string; readonly title: string } | undefined,
) => {
  const last = batch.at(-1)
  if (!last) return ""
  const more = batch.length > 1 ? ` · +${batch.length - 1} more` : ""
  const fit = (prefix: string, middle: string, suffix: string) =>
    `${prefix}${clip(middle, LINE_MAX - codePoints(prefix) - codePoints(suffix))}${suffix}`
  if (last.kind === "notice") return fit("Notice: ", unwrapped(last.message).trim().split("\n")[0] ?? "", more)
  const sender = last.sender ?? ""
  const session = who(sender)
  const type =
    session === undefined ? "Agent" : `${session.agent.charAt(0).toUpperCase()}${session.agent.slice(1)} Agent`
  return fit(`${type} "`, session?.title ?? "", `" sent a message (${shortId(sender)})${more}`)
}

export type Undelivered = ReadonlyArray<{
  readonly id: number
  readonly message: string
  readonly kind?: string
  readonly sender?: string | null
}>

export class Inbox extends Context.Service<
  Inbox,
  {
    readonly enqueue: (row: NewInboxRow) => Effect.Effect<InboxRow | undefined>
    readonly pulls: (harnessId: string) => boolean
    readonly take: (sessionId: string, process: number | undefined) => Effect.Effect<Taken | undefined>
    readonly stream: (sessionId: string) => Stream.Stream<null>
    readonly claimRetype: (sessionId: string, execution: number) => Effect.Effect<boolean>
    readonly undelivered: (session: SessionRow, rows: Undelivered, reason: string) => Effect.Effect<void>
    readonly dropQueue: (session: SessionRow, reason: string) => Effect.Effect<void>
  }
>()("vibest/Inbox") {
  static readonly layer = Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const db = yield* Db
      const drain = yield* Drain
      const harnesses = yield* Harnesses
      const reactor = yield* Reactor.make

      const pulls = (harnessId: string) => harnesses.find(harnessId)?.inbox !== undefined

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
        drain.work("entry session exited", db.clearEntry(event.runtime, event.terminal), true),
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

      const take = (sessionId: string, process: number | undefined) =>
        Effect.gen(function* () {
          if ((yield* drain.phase) !== "open") return undefined
          const session = yield* db.getSession(sessionId)
          if (session === undefined || !pulls(harnessIdOf(session))) return undefined
          const taken = yield* drain.work(`take inbox of ${sessionId}`, db.takeInbox(sessionId, process))
          if (taken === undefined) return undefined
          handedOver.add(handedKey(sessionId, taken.execution))
          const last = taken.rows.at(-1)!
          const sender = last.kind === "notice" || last.sender === null ? undefined : yield* db.getSession(last.sender)
          return {
            execution: taken.execution,
            ids: taken.rows.map((r) => r.id),
            line: line(taken.rows, () => sender && { agent: sender.agent, title: sender.name }),
            text: text(taken.rows),
          } satisfies Taken
        })

      const undelivered = (session: SessionRow, rows: Undelivered, reason: string) =>
        db
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
                    ? db.insertInbox({ sessionId: session.id, message })
                    : db.insertNoticeTo(sender, message)
                },
                { discard: true },
              ),
            ),
            Effect.asVoid,
          )

      const dropQueue = (session: SessionRow, reason: string) =>
        db
          .pendingInbox(session.id)
          .pipe(Effect.flatMap((rows) => (rows.length === 0 ? Effect.void : undelivered(session, rows, reason))))

      const claimRetype = (sessionId: string, execution: number) =>
        Effect.sync(() => handedOver.delete(handedKey(sessionId, execution)))

      return Inbox.of({ enqueue: db.insertInbox, pulls, take, stream, claimRetype, undelivered, dropQueue })
    }),
  )

  static readonly node = LayerNode.make({
    service: Inbox,
    layer: Inbox.layer,
    deps: [Bus.node, Db.node, Drain.node, Harnesses.node],
  })
}
