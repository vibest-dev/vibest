import type { Polled } from "@vibest/protocol/protocol"
// Inbox rows and their delivery to a scope's owner (SPEC §11; docs/architecture.md, delivery). Rows live in the storage
// port. Rows for a session (`send`, `task`) are delivered by Sessions; here only owner-bound rows (report, result,
// notice) are pushed. An owner whose harness adapter has `delivery: "poll"` takes its rows itself, by polling
// vibestd's HTTP socket (`poll` / `ack`). Every other idle owner gets them typed in through the runtime's prompt.
// Nobody there: the row is `dropped`.
import { Cause, Clock, Context, Duration, Effect, Exit, Layer, Option, PubSub, Queue, Schedule, Stream } from "effect"

import { Db, encodeAddress, type InboxRow, type NewInboxRow, type RuntimeAddress } from "./db.ts"
import { Drain } from "./drain.ts"
import { Harnesses } from "./harness.ts"
import { keyedLock } from "./keyed-lock.ts"
import { Restarting } from "./restarting.ts"
import { agentState, alive, Runtimes, RuntimeError, type Runtime } from "./runtimes.ts"

export const RECONCILE = Duration.seconds(10)
/** A row a poll handed out and nobody acked goes back to pending after this (each row its own lease). */
export const LEASE = Duration.seconds(30)
/** A owner that polled and then stopped for this long is gone: its leased rows go back to pending at once. */
export const AWAY = Duration.seconds(5)

export type Presence = "idle" | "busy" | "gone" | "unknown"

/** What runs at a owner's terminal, from the runtime alone (SPEC §1.2; runtime-port.md §3 `state`, §5's `process` fallback). */
export const ownerIdle = (h: Runtime, terminal: RuntimeAddress): Effect.Effect<Presence, RuntimeError> =>
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
  return fit(`${type} Agent "`, session?.title ?? "", `" ${statusOf(last)} (${last.sessionId})${more}`)
}

export class Inbox extends Context.Service<
  Inbox,
  {
    /** `row`, one per recipient (`to`, else its default), each announced. */
    readonly enqueue: (row: NewInboxRow, to?: ReadonlyArray<string | null>) => Effect.Effect<ReadonlyArray<InboxRow>>
    /** For rows inserted inside another transaction (Db.finishTurn). */
    readonly announce: (row: InboxRow) => Effect.Effect<void>
    /** Try to hand a scope's owner its next batch now. */
    readonly deliver: (scope: string) => Effect.Effect<void>
    /** The next owner-bound row whose delivery succeeded (`agent.prompt` returned, or the integration acked it); each row once. One taker: Sessions, which runs `done` once it has handled the row. */
    readonly delivered: Effect.Effect<{ readonly row: InboxRow; readonly done: Effect.Effect<void> }>
    /**
     * The owner's next batch, each row leased for LEASE (answered at once, empty when there is none or vibestd is
     * stopping). Rows whose lease ran out go back to pending first.
     */
    readonly poll: (scope: string) => Effect.Effect<Polled>
    /**
     * The rows the owner took (`ids`: delivered) and gave back (`release`: pending again). Only its own leased or
     * pending rows count; repeating is harmless. Returns the rows now delivered.
     */
    readonly ack: (
      scope: string,
      ids: ReadonlyArray<number>,
      release?: ReadonlyArray<number>,
    ) => Effect.Effect<ReadonlyArray<number>>
    /** Scope locks held or waited on (vibestd-state.md 3): tests check it shrinks back. */
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
      /** How the owner of harness `id` (as recorded or as the runtime names it) takes its rows. */
      const inboxOf = (id: string | null | undefined) => harnesses.find(id)?.delivery
      yield* db.recoverSending(
        harnesses
          .all()
          .filter((h) => h.delivery === "poll")
          .map((h) => h.id),
      )
      const lifetime = yield* Effect.scope
      const pubsub = yield* PubSub.unbounded<InboxRow>()
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

      const withLock = <A, E, R>(label: string, scope: string, body: Effect.Effect<A, E, R>, settlement = false) =>
        drain.work(label, locks.withLock(scope)(body), settlement)

      const deliver = (scope: string) =>
        withLock(
          `deliver scope ${scope}`,
          scope,
          Effect.gen(function* () {
            const coord = yield* db.ownerOf(scope)
            if (!coord?.address || coord.address.id === "" || !coord.runtime)
              return yield* db.dropWaiting(scope, "absent")
            // vibestd is restarting its harness in place: the rows wait for the new one.
            if (restarting.has(coord.id)) return
            const address = encodeAddress(coord.address)
            const guard = { scope, runtime: coord.runtime, address }
            const h = yield* runtimes.route(coord.runtime).pipe(Effect.option)
            if (Option.isNone(h)) return
            const presence = yield* ownerIdle(h.value, coord.address)
            if (presence === "gone") return yield* db.dropWaiting(scope, guard)
            if (presence !== "idle") return
            // Its harness takes its rows itself (`poll`); they wait until it does.
            if (inboxOf(coord.harnessId) === "poll") return
            const batch = nextBatch(yield* db.ownerPending(scope))
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
          }).pipe(Effect.catchCause((cause) => Effect.logWarning(`deliver to scope ${scope}: ${Cause.pretty(cause)}`))),
        )

      const announce = (row: InboxRow) =>
        row.kind === "send" || row.status !== "pending"
          ? Effect.void
          : db
              .scopeOf(row.sessionId)
              .pipe(
                Effect.flatMap((scope) =>
                  scope === undefined
                    ? Effect.void
                    : PubSub.publish(pubsub, row).pipe(
                        Effect.andThen(Effect.forkIn(deliver(scope), lifetime)),
                        Effect.asVoid,
                      ),
                ),
              )

      /** The scope whose owner runs at `terminal`, in any registered runtime. */
      const at = (terminal: RuntimeAddress) =>
        Effect.gen(function* () {
          const all = yield* runtimes.all
          for (const h of all) {
            const owned = yield* db.ownerAt(h.kind, terminal).pipe(Effect.option)
            if (Option.isSome(owned)) return owned.value
          }
          return undefined
        })

      // Triggers: a owner terminal's state changes (or its exit), and the reconcile tick. The registry's merged
      // `events` stream carries every registered runtime's (each registration's share ends when it unloads); a runtime
      // without `events` of its own is the poll's to cover (§5).
      yield* Effect.forkIn(
        runtimes.events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "exited")
              // The merged stream does not say which runtime it came from; each kind's row matches on its own address.
              return drain.work(
                "owner exited",
                runtimes.all.pipe(
                  Effect.flatMap((all) =>
                    Effect.forEach(all, (h) => db.clearOwnerAt(h.kind, event.terminal), { discard: true }),
                  ),
                  Effect.ignore,
                ),
              )
            if (event.type === "state")
              return at(event.terminal).pipe(
                Effect.flatMap((scope) => (scope === undefined ? Effect.void : deliver(scope))),
              )
            return Effect.void
          }),
        ),
        lifetime,
      )
      yield* Effect.forkIn(
        db.pendingScopes.pipe(
          Effect.flatMap((scopes) => Effect.forEach(scopes, deliver, { discard: true })),
          Effect.repeat(Schedule.spaced(RECONCILE)),
        ),
        lifetime,
      )

      /**
       * Claim the owner's next batch, under the scope's lock. Only for a owner whose harness takes its rows
       * itself in `mode`, still where `origin` (when given) read it. `hold` runs in the same uninterruptible region as the
       * claim, so a cut-off caller cannot lose the ids.
       */
      const claimNext = (
        scope: string,
        origin: { readonly runtime: string; readonly address: string; readonly harnessId: string } | undefined,
        hold: (ids: ReadonlyArray<number>) => Effect.Effect<void>,
      ) =>
        withLock(
          `claim scope ${scope}`,
          scope,
          Effect.uninterruptible(
            Effect.gen(function* () {
              const current = yield* db.ownerOf(scope)
              if (!current || inboxOf(current.harnessId) !== "poll" || !current.address || !current.runtime)
                return undefined
              const address = encodeAddress(current.address)
              if (
                origin &&
                (current.harnessId !== origin.harnessId ||
                  current.runtime !== origin.runtime ||
                  address !== origin.address)
              )
                return undefined
              const pending = yield* db.ownerPending(scope)
              if (pending.length === 0) return undefined
              const batch = nextBatch(pending)
              const claimed = yield* db.claim(
                batch.map((r) => r.id),
                { scope, runtime: current.runtime, address, harnessId: current.harnessId },
              )
              if (claimed.length === 0) return undefined
              yield* hold(claimed)
              return batch.filter((r) => claimed.includes(r.id))
            }),
          ),
        )

      // The Claude plugin's leases are memory only: per scope, each leased (`sending`) row of its owner and when
      // its lease ends; changed under the scope's lock. Also the last poll per scope, for the away check; its entry
      // goes when the scope is away. A vibestd that starts has no leases: Db.recoverSending puts `sending` rows of a
      // polling owner back to pending.
      const leases = new Map<string, Map<number, number>>()
      const lastPoll = new Map<string, number>()
      const forget = (scope: string, ids: ReadonlyArray<number>) => {
        const held = leases.get(scope)
        if (held === undefined) return
        for (const id of ids) held.delete(id)
        if (held.size === 0) leases.delete(scope)
      }
      /** Ends the leases that ran out by `now` (every one when `now` is undefined): their rows still `sending` go back to pending. */
      const endLeases = (scope: string, now: number | undefined) =>
        withLock(
          `end leases scope ${scope}`,
          scope,
          Effect.suspend(() => {
            const ended = [...(leases.get(scope) ?? [])]
              .filter(([, until]) => now === undefined || until <= now)
              .map(([id]) => id)
            return Effect.tap(db.releaseLeased(scope, ended), () => Effect.sync(() => forget(scope, ended)))
          }),
          true,
        )

      const poll = (scope: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          lastPoll.set(scope, now)
          const empty: Polled = { ids: [], line: "", text: "" }
          // Stopping: nothing new goes out; leases already out still settle (ack is a settlement).
          if ((yield* drain.phase) !== "open") return empty
          yield* endLeases(scope, now)
          const rows = yield* claimNext(scope, undefined, (ids) =>
            Effect.sync(() => {
              const held = leases.get(scope) ?? new Map<number, number>()
              for (const id of ids) held.set(id, now + Duration.toMillis(LEASE))
              leases.set(scope, held)
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

      const ack = (scope: string, ids: ReadonlyArray<number>, release: ReadonlyArray<number> = []) =>
        withLock(
          `ack inbox ${ids.join(",")}`,
          scope,
          Effect.uninterruptible(
            Effect.map(db.settleLeased(scope, ids, release), (rows) => {
              forget(scope, [...ids, ...release])
              publishDelivered(rows)
              return rows.map((r) => r.id)
            }),
          ),
          true,
        )

      // A plugin that went away sends no poll, so this check runs on its own clock, not in poll or on RECONCILE.
      yield* Effect.forkIn(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          for (const [scope, at] of lastPoll) {
            if (now - at <= Duration.toMillis(AWAY)) continue
            lastPoll.delete(scope)
            yield* endLeases(scope, undefined)
          }
        }).pipe(Effect.repeat(Schedule.spaced("1 second"))),
        lifetime,
      )

      return Inbox.of({
        enqueue: (row, to) =>
          db.insertInbox(row, to).pipe(Effect.tap((rows) => Effect.forEach(rows, announce, { discard: true }))),
        announce,
        deliver,
        delivered: Queue.take(delivered),
        poll,
        ack,
        locks: Effect.sync(() => locks.size()),
      })
    }),
  )
}
