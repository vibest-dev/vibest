import type { Polled } from "@vibest/protocol/protocol"
import { shortId } from "@vibest/schema/id"
import { Context, Duration, Effect, Layer, Queue, Stream } from "effect"

import { Bus } from "./bus.ts"
import { Db, encodeAddress, type InboxRow, type NewInboxRow, type RuntimeAddress } from "./db.ts"
import { Drain } from "./drain.ts"
import { LayerNode } from "./effect/layer-node.ts"
import * as Engine from "./engine.ts"
import { Harnesses } from "./harness.ts"
import { keyedLock } from "./keyed-lock.ts"
import * as Leases from "./leases.ts"
import { Restarting } from "./restarting.ts"
import { agentState, alive, Runtimes, RuntimeError, type Runtime } from "./runtimes.ts"

export const LEASE = Duration.seconds(30)
export const AWAY = Duration.seconds(5)

export type Presence = "idle" | "busy" | "gone" | "unknown"

export const coordinatorIdle = (h: Runtime, terminal: RuntimeAddress): Effect.Effect<Presence, RuntimeError> =>
  Effect.gen(function* () {
    const seen = yield* agentState(h, terminal)
    if (seen === "unknown" || seen === "absent") return (yield* alive(h, terminal)) ? "busy" : "gone"
    return seen === "idle" ? "idle" : "busy"
  })

export const senderKey = (row: InboxRow) => (row.kind === "notice" ? "vibestd" : row.sessionId)
export const nextBatch = (pending: ReadonlyArray<InboxRow>) => {
  const first = pending[0] ? senderKey(pending[0]) : undefined
  const other = pending.findIndex((r) => senderKey(r) !== first)
  return other === -1 ? pending : pending.slice(0, other)
}

export const text = (batch: ReadonlyArray<InboxRow>) => batch.map((r) => r.message).join("\n\n")

export const LINE_MAX = 120

const codePoints = (s: string) => [...s].length
const clip = (s: string, max: number) => {
  const cps = [...s]
  return cps.length <= max ? s : `${cps.slice(0, Math.max(0, max - 1)).join("")}…`
}

const statusOf = (row: InboxRow) => {
  if (row.kind !== "result") return "sent a message"
  const { error, status } = row.details
  if (error === "interrupted") return "was interrupted"
  return status === "failed" || (typeof error === "string" && error !== "") ? "failed" : "completed"
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
  if (last.kind === "notice") return fit("Notice: ", last.message.trim().split("\n")[0] ?? "", more)
  const session = who(last.sessionId)
  const agent = session?.agent || "general"
  const type = `${agent.charAt(0).toUpperCase()}${agent.slice(1)}`
  return fit(`${type} Agent "`, session?.title ?? "", `" ${statusOf(last)} (${shortId(last.sessionId)})${more}`)
}

export class Inbox extends Context.Service<
  Inbox,
  {
    readonly enqueue: (row: NewInboxRow) => Effect.Effect<InboxRow>
    readonly deliver: (projectId: string) => Effect.Effect<void>
    readonly stream: (projectId: string) => Stream.Stream<string>
    readonly delivered: Queue.Queue<{ readonly row: InboxRow; readonly done: Effect.Effect<void> }>
    readonly poll: (projectId: string) => Effect.Effect<Polled>
    readonly ack: (
      projectId: string,
      ids: ReadonlyArray<number>,
      release?: ReadonlyArray<number>,
    ) => Effect.Effect<ReadonlyArray<number>>
    readonly locks: Effect.Effect<number>
  }
>()("vibest/Inbox") {
  static readonly layer = Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const db = yield* Db
      const drain = yield* Drain
      const runtimes = yield* Runtimes
      const harnesses = yield* Harnesses
      const restarting = yield* Restarting
      const inboxOf = (id: string | null | undefined) => harnesses.find(id)?.inbox
      const delivered = yield* Queue.unbounded<{ readonly row: InboxRow; readonly done: Effect.Effect<void> }>()
      const publishDelivered = (rows: ReadonlyArray<InboxRow>) => {
        Queue.offerAllUnsafe(
          delivered,
          rows.map((row) => ({ row, done: drain.track(`completion inbox ${row.id}`) })),
        )
      }
      const markDelivered = (ids: ReadonlyArray<number>) =>
        drain.work(
          `settle inbox ${ids.join(",")}`,
          Effect.uninterruptible(
            db
              .setInboxStatus(ids, "delivered", "sending")
              .pipe(Effect.flatMap((rows) => Effect.sync(() => publishDelivered(rows)))),
          ),
          true,
        )

      const locks = keyedLock<string>()

      const withLock = <A, E, R>(label: string, projectId: string, body: Effect.Effect<A, E, R>, settlement = false) =>
        drain.work(label, locks.withLock(projectId)(body), settlement)

      const deliver = (projectId: string) =>
        withLock(
          `deliver project ${projectId}`,
          projectId,
          Effect.gen(function* () {
            const coord = yield* db.coordinatorOf(projectId)
            if (!coord?.address || coord.address.id === "" || !coord.runtime)
              return yield* db.dropWaiting(projectId, "absent")
            if (restarting.has(coord.id)) return
            const address = encodeAddress(coord.address)
            const guard = { projectId, runtime: coord.runtime, address }
            const h = runtimes.find(coord.runtime)
            if (h === undefined) return
            const presence = yield* coordinatorIdle(h, coord.address)
            if (presence === "gone") return yield* db.dropWaiting(projectId, guard)
          }).pipe(Engine.logFailure(`deliver to project ${projectId}`)),
        )

      const mainOf = (id: string) =>
        Effect.gen(function* () {
          const projectId = yield* db.projectOfSession(id)
          return projectId !== undefined && (yield* db.coordinatorOf(projectId))?.id === id ? projectId : undefined
        })
      const ifMain = (id: string, then: (projectId: string) => Effect.Effect<void>) =>
        mainOf(id).pipe(Effect.flatMap((projectId) => (projectId === undefined ? Effect.void : then(projectId))))

      const engine = yield* Engine.make
      const leases = yield* Leases.make
      let subscriptions = 0
      const waiting = new Map<string, Set<Queue.Queue<void>>>()
      const wake = (id: string) =>
        Effect.sync(() => {
          for (const signal of waiting.get(id) ?? []) Queue.offerUnsafe(signal, undefined)
        })
      yield* engine.on((event) => {
        switch (event.type) {
          case "inbox.queued":
            return wake(event.sessionId!).pipe(Effect.andThen(ifMain(event.sessionId!, deliver)))
          case "inbox.moved":
            return event.data.to === "pending"
              ? wake(event.sessionId!).pipe(Effect.andThen(ifMain(event.sessionId!, deliver)))
              : Effect.void
          case "live.state":
            return db
              .coordinatorAt(event.runtime, event.terminal)
              .pipe(Effect.flatMap((projectId) => (projectId === undefined ? Effect.void : deliver(projectId))))
          case "live.exited":
            return drain.work("main agent exited", db.clearCoordinator(event.runtime, event.terminal))
          default:
            return Effect.void
        }
      })

      const claimNext = (
        projectId: string,
        mode: "subscribe" | "poll",
        origin: { readonly runtime: string; readonly address: string; readonly harnessId: string } | undefined,
        hold: (ids: ReadonlyArray<number>) => Effect.Effect<void>,
      ) =>
        withLock(
          `claim project ${projectId}`,
          projectId,
          Effect.uninterruptible(
            Effect.gen(function* () {
              const current = yield* db.coordinatorOf(projectId)
              if (!current || inboxOf(current.harnessId) !== mode || !current.address || !current.runtime)
                return undefined
              const address = encodeAddress(current.address)
              if (
                origin &&
                (current.harnessId !== origin.harnessId ||
                  current.runtime !== origin.runtime ||
                  address !== origin.address)
              )
                return undefined
              const pending = yield* db.coordinatorPending(projectId)
              if (pending.length === 0) return undefined
              const batch = nextBatch(pending)
              const claimed = yield* db.claim(
                batch.map((r) => r.id),
                { projectId, runtime: current.runtime, address, harnessId: current.harnessId },
              )
              if (claimed.length === 0) return undefined
              yield* hold(claimed)
              return batch.filter((r) => claimed.includes(r.id))
            }),
          ),
        )

      const stream = (projectId: string) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscribed = yield* db.coordinatorOf(projectId)
            const origin =
              subscribed?.address && subscribed.runtime
                ? {
                    runtime: subscribed.runtime,
                    address: encodeAddress(subscribed.address),
                    harnessId: subscribed.harnessId,
                  }
                : undefined
            const signal = yield* Queue.sliding<void>(1)
            const main = subscribed?.id
            if (main !== undefined)
              yield* Effect.acquireRelease(
                Effect.sync(() => waiting.set(main, (waiting.get(main) ?? new Set()).add(signal))),
                () =>
                  Effect.sync(() => {
                    const open = waiting.get(main)
                    open?.delete(signal)
                    if (open?.size === 0) waiting.delete(main)
                  }),
              )
            const recipient = `${projectId} subscription ${++subscriptions}`
            const claimOne = () =>
              origin === undefined
                ? Effect.succeed(undefined)
                : claimNext(projectId, "subscribe", origin, (ids) =>
                    leases.hold(recipient, ids, undefined, (ended) => db.setInboxStatus(ended, "failed", "sending")),
                  ).pipe(Effect.map((rows) => (rows === undefined ? undefined : text(rows))))
            return Stream.unfold(0, () =>
              Effect.gen(function* () {
                const ids = leases.held(recipient)
                if (ids.length > 0)
                  yield* Effect.uninterruptible(markDelivered(ids).pipe(Effect.andThen(leases.settle(ids))))
                while (true) {
                  const batch = yield* claimOne()
                  if (batch !== undefined) return [batch, 0] as const
                  yield* Queue.take(signal)
                }
              }),
            ).pipe(Stream.ensuring(leases.expireAll(recipient)))
          }),
        )

      const released = (projectId: string) => (ids: ReadonlyArray<number>) =>
        withLock(`end leases project ${projectId}`, projectId, db.releaseLeased(projectId, ids), true).pipe(
          Effect.asVoid,
        )

      const poll = (projectId: string) =>
        Effect.gen(function* () {
          yield* engine.arm(`away:${projectId}`, AWAY, leases.expireAll(projectId))
          const empty: Polled = { ids: [], line: "", text: "" }
          if ((yield* drain.phase) !== "open") return empty
          const rows = yield* claimNext(projectId, "poll", undefined, (ids) =>
            leases.hold(projectId, ids, LEASE, released(projectId)),
          )
          if (rows === undefined) return empty
          const last = rows.at(-1)!
          const session = last.kind === "notice" ? undefined : yield* db.getSession(last.sessionId)
          return {
            ids: rows.map((r) => r.id),
            line: line(rows, () => session && { agent: session.agent, title: session.name }),
            text: text(rows),
          }
        })

      const ack = (projectId: string, ids: ReadonlyArray<number>, release: ReadonlyArray<number> = []) =>
        withLock(
          `ack inbox ${ids.join(",")}`,
          projectId,
          Effect.uninterruptible(
            Effect.gen(function* () {
              const rows = yield* db.settleLeased(projectId, ids, release)
              yield* leases.settle([...ids, ...release])
              publishDelivered(rows)
              return rows.map((r) => r.id)
            }),
          ),
          true,
        )

      return Inbox.of({
        enqueue: db.insertInbox,
        deliver,
        stream,
        delivered,
        poll,
        ack,
        locks: Effect.sync(() => locks.size()),
      })
    }),
  )

  static readonly node = LayerNode.make({
    service: Inbox,
    layer: Inbox.layer,
    deps: [Bus.node, Db.node, Drain.node, Harnesses.node, Restarting.node, Runtimes.node],
  })
}
