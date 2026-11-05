import type { Polled } from "@vibest/protocol/protocol"
import { shortId } from "@vibest/schema/id"
// Inbox rows and their delivery to a project's coordinator (SPEC §11). Rows live in sqlite. Rows for a session (`send`)
// are delivered by Sessions; here only coordinator-bound rows (report, result, notice) are pushed. A command-line
// caller reads a session's latest result with `vibest result`.
// A coordinator whose harness adapter has `inbox: "subscribe"` or `"poll"` takes its rows itself: the Pi extension over
// vibest.sock (`stream`), the Claude plugin by polling vibestd's HTTP socket (`poll` / `ack`). Every other idle
// coordinator gets them typed in through the runtime's prompt. Nobody there: the row is `dropped`.
import { Cause, Clock, Context, Duration, Effect, Exit, Layer, Option, PubSub, Queue, Stream } from "effect"

import { Bus, type EngineEvent } from "./bus.ts"
import { Db, encodeAddress, type InboxRow, type NewInboxRow, type RuntimeAddress } from "./db.ts"
import { Drain } from "./drain.ts"
import * as Engine from "./engine.ts"
import { Harnesses } from "./harness.ts"
import { keyedLock } from "./keyed-lock.ts"
import { Restarting } from "./restarting.ts"
import { agentState, alive, Runtimes, RuntimeError, type Runtime } from "./runtimes.ts"

/** A row a poll handed out and nobody acked goes back to pending after this (each row its own lease). */
export const LEASE = Duration.seconds(30)
/** A coordinator that polled and then stopped for this long is gone: its leased rows go back to pending at once. */
export const AWAY = Duration.seconds(5)

export type Presence = "idle" | "busy" | "gone" | "unknown"

/** What runs at a coordinator's terminal, from the runtime alone (SPEC §1.2; runtime-port.md §3 `state`, §5's `process` fallback). */
export const coordinatorIdle = (h: Runtime, terminal: RuntimeAddress): Effect.Effect<Presence, RuntimeError> =>
  Effect.gen(function* () {
    const seen = yield* agentState(h, terminal)
    // An absent agent is a terminal the runtime cannot name (reused, or its record dropped): its process decides.
    if (seen === "unknown" || seen === "absent") return (yield* alive(h, terminal)) ? "busy" : "gone"
    return seen === "idle" ? "idle" : "busy"
  })

/** Consecutive rows from one sender become one delivery: a notice is from vibestd, anything else from its session. */
export const senderKey = (row: InboxRow) => (row.kind === "notice" ? "vibestd" : row.sessionId)
export const nextBatch = (pending: ReadonlyArray<InboxRow>) => {
  const first = pending[0] ? senderKey(pending[0]) : undefined
  const other = pending.findIndex((r) => senderKey(r) !== first)
  return other === -1 ? pending : pending.slice(0, other)
}

export const text = (batch: ReadonlyArray<InboxRow>) => batch.map((r) => r.message).join("\n\n")

/** A delivery's one-line summary is at most this many code points. */
export const LINE_MAX = 120

const codePoints = (s: string) => [...s].length
const clip = (s: string, max: number) => {
  const cps = [...s]
  return cps.length <= max ? s : `${cps.slice(0, Math.max(0, max - 1)).join("")}…`
}

/** How a result or report row ended, as its line says it. */
const statusOf = (row: InboxRow) => {
  if (row.kind !== "result") return "sent a message"
  const { error, status } = row.details
  if (error === "interrupted") return "was interrupted"
  return status === "failed" || (typeof error === "string" && error !== "") ? "failed" : "completed"
}

/**
 * The one line a delivery shows (the full text goes to the model beside it): `<Type> Agent "<title>" <status> (<id>)`,
 * or `Notice: <first line>`. The id stays, so the model can read the full result back after /compact dropped it. A
 * batch of several rows is named by its last, with ` · +N more`. The title (or the notice) is cut to fit LINE_MAX.
 */
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
    /** Try to hand a project's coordinator its next batch now. */
    readonly deliver: (projectId: string) => Effect.Effect<void>
    /** The coordinator's rows from now on, one string per claimed batch, instead of `agent.prompt`. */
    readonly stream: (projectId: string) => Stream.Stream<string>
    /** The next coordinator-bound row whose delivery succeeded (`agent.prompt` returned, or the integration acked it); each row once. One taker: Sessions, which runs `done` once it has handled the row. */
    readonly delivered: Effect.Effect<{ readonly row: InboxRow; readonly done: Effect.Effect<void> }>
    /**
     * The coordinator's next batch, each row leased for LEASE (answered at once, empty when there is none or vibestd is
     * stopping). Rows whose lease ran out go back to pending first.
     */
    readonly poll: (projectId: string) => Effect.Effect<Polled>
    /**
     * The rows the coordinator took (`ids`: delivered) and gave back (`release`: pending again). Only its own leased or
     * pending rows count; repeating is harmless. Returns the rows now delivered.
     */
    readonly ack: (
      projectId: string,
      ids: ReadonlyArray<number>,
      release?: ReadonlyArray<number>,
    ) => Effect.Effect<ReadonlyArray<number>>
    /** Project locks held or waited on (vibestd-state.md 3): tests check it shrinks back. */
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
      /** How the coordinator of harness `id` (as recorded or as the runtime names it) takes its rows. */
      const inboxOf = (id: string | null | undefined) => harnesses.find(id)?.inbox
      const bus = yield* Bus
      // Made before any delivery runs, so none is missed.
      const delivered = yield* Queue.unbounded<{ readonly row: InboxRow; readonly done: Effect.Effect<void> }>()
      // Counted from before publication until the taker's completion work (archive) is done.
      const publishDelivered = (rows: ReadonlyArray<InboxRow>) => {
        Queue.offerAllUnsafe(
          delivered,
          rows.map((row) => ({ row, done: drain.track(`completion inbox ${row.id}`) })),
        )
      }
      /** sending → delivered; only the rows that changed are queued, so each is queued once. */
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

      // Dropped once released with nobody waiting (vibestd-state.md 3).
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
            // vibestd is restarting its harness in place: the rows wait for the new one.
            if (restarting.has(coord.id)) return
            const address = encodeAddress(coord.address)
            const guard = { projectId, runtime: coord.runtime, address }
            const h = yield* runtimes.route(coord.runtime).pipe(Effect.option)
            if (Option.isNone(h)) return
            const presence = yield* coordinatorIdle(h.value, coord.address)
            if (presence === "gone") return yield* db.dropWaiting(projectId, guard)
            if (presence !== "idle") return
            // Its harness takes its rows itself (`stream`, `poll`); they wait until it does.
            const mode = inboxOf(coord.harnessId)
            if (mode === "subscribe" || mode === "poll") return
            const batch = nextBatch(yield* db.coordinatorPending(projectId))
            if (batch.length === 0) return
            const claimed = yield* db.claim(
              batch.map((r) => r.id),
              guard,
            )
            if (claimed.length === 0) return
            const body = text(batch.filter((r) => claimed.includes(r.id)))
            yield* h.value
              .send(coord.address, { text: body })
              .pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit) ? markDelivered(claimed) : db.setInboxStatus(claimed, "failed", "sending"),
                ),
              )
          }).pipe(
            Effect.catchCause((cause) => Effect.logWarning(`deliver to project ${projectId}: ${Cause.pretty(cause)}`)),
          ),
        )

      /** The project whose main agent is session `id`, if it is one. */
      const mainOf = (id: string) =>
        Effect.gen(function* () {
          const projectId = yield* db.projectOfSession(id)
          return projectId !== undefined && (yield* db.coordinatorOf(projectId))?.id === id ? projectId : undefined
        })
      const ifMain = (id: string, then: (projectId: string) => Effect.Effect<void>) =>
        mainOf(id).pipe(Effect.flatMap((projectId) => (projectId === undefined ? Effect.void : then(projectId))))

      // Each handler runs in its own fiber (engine.ts); `deliver` re-reads everything under the project's lock.
      const engine = yield* Engine.make
      yield* engine.on((event) => {
        switch (event.type) {
          // A row for the main agent was queued, or put back.
          case "inbox.queued":
            return ifMain(event.sessionId, deliver)
          case "inbox.status":
            return event.data.to === "pending" ? ifMain(event.sessionId, deliver) : Effect.void
          // The main agent's process ended and no other took its place (not moving either): what waits for it is dropped.
          case "process.end":
            return ifMain(event.sessionId, (projectId) =>
              withLock(`drop project ${projectId}`, projectId, db.dropWaiting(projectId, "absent")),
            )
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

      /** A main agent's stream looks again when a row for it is queued or put back to pending. */
      const wakes = (main: string | undefined, event: EngineEvent) =>
        "id" in event &&
        event.sessionId === main &&
        (event.type === "inbox.queued" || (event.type === "inbox.status" && event.data.to === "pending"))

      /**
       * Claim the coordinator's next batch, under the project's lock. Only for a coordinator whose harness takes its rows
       * itself in `mode`, still where `origin` (when given) read it. `hold` runs in the same uninterruptible region as the
       * claim, so a cut-off caller cannot lose the ids.
       */
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

      // Guard is the coordinator row as this stream read it. Two subscribers: whichever claims a batch first takes it.
      // shortcut: delivered means the RPC client queued the chunk (next pull starts only after the socket Ack), not that pi.sendMessage succeeded; a dropped Ack can mark failed after the client already has it, upgrade when delivery must mean sendMessage returned
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
            // Taken before the first claim: a row queued or put back for this main agent in between still wakes it.
            const arrivals = yield* bus.subscribe
            // Claimed for the batch this pull emits. Set in the same uninterruptible region as the claim, so a close cannot lose the ids.
            let unconfirmed: ReadonlyArray<number> = []
            const claimOne = () =>
              origin === undefined
                ? Effect.succeed(undefined)
                : claimNext(projectId, "subscribe", origin, (ids) =>
                    Effect.sync(() => {
                      unconfirmed = ids
                    }),
                  ).pipe(Effect.map((rows) => (rows === undefined ? undefined : text(rows))))
            // One batch per pull, no buffer: the socket server starts this pull only after the previous chunk's Ack.
            return Stream.unfold(0, () =>
              Effect.gen(function* () {
                if (unconfirmed.length > 0) {
                  yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      const ids = unconfirmed.slice()
                      yield* markDelivered(ids)
                      unconfirmed = []
                    }),
                  )
                }
                while (true) {
                  const batch = yield* claimOne()
                  if (batch !== undefined) return [batch, 0] as const
                  while (!wakes(subscribed?.id, yield* PubSub.take(arrivals))) {}
                }
              }),
            ).pipe(
              Stream.ensuring(
                Effect.suspend(() => {
                  const ids = unconfirmed.slice()
                  unconfirmed = []
                  return ids.length === 0 ? Effect.void : db.setInboxStatus(ids, "failed", "sending")
                }),
              ),
            )
          }),
        )

      // The Claude plugin's leases are memory only: per project, each leased (`sending`) row of its main agent and when
      // its lease ends; changed under the project's lock. A vibestd that starts has no leases: Db.recoverDelivering puts
      // `sending` rows of a polling main agent back to pending.
      const leases = new Map<string, Map<number, number>>()
      const forget = (projectId: string, ids: ReadonlyArray<number>) => {
        const held = leases.get(projectId)
        if (held === undefined) return
        for (const id of ids) held.delete(id)
        if (held.size === 0) leases.delete(projectId)
      }
      /** Ends the leases that ran out by `now` (every one when `now` is undefined): their rows still `sending` go back to pending. */
      const endLeases = (projectId: string, now: number | undefined) =>
        withLock(
          `end leases project ${projectId}`,
          projectId,
          Effect.suspend(() => {
            const ended = [...(leases.get(projectId) ?? [])]
              .filter(([, until]) => now === undefined || until <= now)
              .map(([id]) => id)
            return Effect.tap(db.releaseLeased(projectId, ended), () => Effect.sync(() => forget(projectId, ended)))
          }),
          true,
        )

      const poll = (projectId: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          // A plugin that went away sends no poll: AWAY after its last one, its leases end at once.
          yield* engine.arm(`away:${projectId}`, AWAY, endLeases(projectId, undefined))
          const empty: Polled = { ids: [], line: "", text: "" }
          // Stopping: nothing new goes out; leases already out still settle (ack is a settlement).
          if ((yield* drain.phase) !== "open") return empty
          yield* endLeases(projectId, now)
          const rows = yield* claimNext(projectId, "poll", undefined, (ids) =>
            Effect.sync(() => {
              const held = leases.get(projectId) ?? new Map<number, number>()
              for (const id of ids) held.set(id, now + Duration.toMillis(LEASE))
              leases.set(projectId, held)
            }),
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
            Effect.map(db.settleLeased(projectId, ids, release), (rows) => {
              forget(projectId, [...ids, ...release])
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
        delivered: Queue.take(delivered),
        poll,
        ack,
        locks: Effect.sync(() => locks.size()),
      })
    }),
  )
}
