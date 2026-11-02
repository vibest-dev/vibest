// Inbox rows and their delivery to a project's coordinator (SPEC §11). Rows live in sqlite. Rows for a session (`send`)
// are delivered by Sessions; here only coordinator-bound rows (report, result, notice) are pushed. A command-line
// caller reads a session's latest result with `vibest result`.
// A coordinator whose harness adapter has `inbox: "subscribe"` (the Pi extension) pulls its rows over vibest.sock; one
// with `inbox: "bridge"` (the Claude plugin) pulls them while its bridge is attached; every other idle coordinator gets
// them typed in through the runtime's prompt. Nobody there: the row is `dropped`.
import { Cause, Context, Crypto, Duration, Effect, Exit, FileSystem, HashMap, Layer, Option, Path, PubSub, Queue, Schedule, Semaphore, Stream, SynchronizedRef } from "effect"
import { claimedText, CLAUDE_INBOX_MAX_BYTES, createRegistry, isInboxId, utf8Bytes, writeClaimFile, type LiveAttachment, type ReceiptOp } from "./claude-inbox.ts"
import { Db, encodeAddress, type CoordinatorBridge, type InboxRow, type NewInboxRow, type RuntimeAddress } from "./db.ts"
import { Drain } from "./drain.ts"
import { Harnesses } from "./harness.ts"
import { Layout } from "./paths.ts"
import { agentState, alive, Runtimes, RuntimeError, type Runtime } from "./runtimes.ts"

export const RECONCILE = Duration.seconds(10)

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

const text = (batch: ReadonlyArray<InboxRow>) => batch.map((r) => r.message).join("\n\n")

export type InboxReply = {
  readonly generation?: string
  readonly token?: string
  readonly file?: string
  readonly acked?: boolean
  readonly released?: boolean
  readonly already?: boolean
  readonly empty?: boolean
  readonly error?: string
  readonly bytes?: number
}

export type InboxCall = {
  readonly projectId: number
  /** The coordinator's terminal id, as the caller's runtime knows it (opaque to core). */
  readonly terminal: string
  /** The terminal's machine; the local one when the caller does not say. */
  readonly machine?: string
  readonly claudeSessionId: string
}

export class Inbox extends Context.Service<Inbox, {
  readonly enqueue: (row: NewInboxRow) => Effect.Effect<InboxRow>
  /** For rows inserted inside another transaction (Db.finishTurn). */
  readonly announce: (row: InboxRow) => Effect.Effect<void>
  /** Try to hand a project's coordinator its next batch now. */
  readonly deliver: (projectId: number) => Effect.Effect<void>
  /** The coordinator's rows from now on, one string per claimed batch, instead of `agent.prompt`. */
  readonly stream: (projectId: number) => Stream.Stream<string>
  /** The next coordinator-bound row whose delivery succeeded (`agent.prompt` returned, or the Pi extension acked it); each row once. One taker: Sessions, which runs `done` once it has handled the row. */
  readonly delivered: Effect.Effect<{ readonly row: InboxRow; readonly done: Effect.Effect<void> }>
  readonly attach: (input: InboxCall & { readonly replace: boolean }) => Effect.Effect<InboxReply>
  readonly pull: (input: InboxCall & { readonly generation: string }) => Effect.Effect<InboxReply>
  readonly ack: (input: InboxCall & { readonly generation: string; readonly token: string }) => Effect.Effect<InboxReply>
  readonly release: (input: InboxCall & { readonly generation: string; readonly token: string; readonly retry: boolean }) => Effect.Effect<InboxReply>
  /** Retire this process's claim when the coordinator row no longer matches the attachment. Does not clear the marker. */
  readonly reconcile: (projectId: number) => Effect.Effect<void>
}>()("vibest/Inbox") {
  static readonly layer = Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const db = yield* Db
      const drain = yield* Drain
      const runtimes = yield* Runtimes
      const layout = yield* Layout
      const harnesses = yield* Harnesses
      /** How the coordinator of harness `id` (as recorded or as the runtime names it) takes its rows. */
      const inboxOf = (id: string | null | undefined) => harnesses.find(id)?.inbox
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const crypto = yield* Crypto.Crypto
      const scope = yield* Effect.scope
      const mint = crypto.randomUUIDv4.pipe(Effect.map((id) => id.toLowerCase()), Effect.orDie)
      const pubsub = yield* PubSub.unbounded<InboxRow>()
      // Made before any delivery runs, so none is missed.
      const delivered = yield* Queue.unbounded<{ readonly row: InboxRow; readonly done: Effect.Effect<void> }>()
      // Counted from before publication until the taker's completion work (archive) is done.
      const publishDelivered = (rows: ReadonlyArray<InboxRow>) => {
        Queue.offerAllUnsafe(delivered, rows.map((row) => ({ row, done: drain.track(`completion inbox ${row.id}`) })))
      }
      /** sending → delivered; only the rows that changed are queued, so each is queued once. */
      const markDelivered = (ids: ReadonlyArray<number>) =>
        drain.work(`settle inbox ${ids.join(",")}`, Effect.uninterruptible(db.setInboxStatus(ids, "delivered", "sending").pipe(
          Effect.flatMap((rows) => Effect.sync(() => publishDelivered(rows))),
        )), true)
      const registry = createRegistry()

      const locks = yield* SynchronizedRef.make(HashMap.empty<number, Semaphore.Semaphore>())
      const lock = (projectId: number) =>
        SynchronizedRef.modifyEffect(locks, (map) =>
          Option.match(HashMap.get(map, projectId), {
            onSome: (s) => Effect.succeed([s, map] as const),
            onNone: () => Semaphore.make(1).pipe(Effect.map((s) => [s, HashMap.set(map, projectId, s)] as const)),
          }),
        )

      const withLock = <A, E, R>(projectId: number, body: Effect.Effect<A, E, R>, settlement = false) =>
        drain.work(`inbox project ${projectId}`, lock(projectId).pipe(Effect.flatMap((s) => s.withPermit(body))), settlement)

      const removeClaimFile = (file: string) =>
        fs.remove(file).pipe(
          Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.void),
          Effect.tapError((error) => Effect.logWarning(`inbox claim file ${file} was not removed: ${error.message}`)),
          Effect.ignore,
        )

      const absent = (error: { readonly reason: { readonly _tag: string; readonly cause?: unknown } }) => {
        const cause = error.reason.cause
        const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined
        return error.reason._tag === "NotFound" || (error.reason._tag === "BadResource" && code === "ENOTDIR")
      }

      const removeIfPresent = (file: string) => {
        const remove = fs.remove(file).pipe(
          Effect.catchIf(absent, () => Effect.void),
          Effect.tapError((error) => Effect.logWarning(`inbox claim file ${file} was not removed: ${error.message}`)),
          Effect.orDie,
        )
        return fs.exists(file).pipe(Effect.matchEffect({
          onFailure: (error) => (absent(error) ? Effect.void : remove),
          onSuccess: (present) => (present ? remove : Effect.void),
        }))
      }

      const writeClaim = (file: string, body: string, suffix: string) => writeClaimFile(fs, path, file, body, suffix)

      /** The caller's place, encoded as the fence stores it. */
      const placeOf = (call: InboxCall) => encodeAddress({ machine: call.machine ?? "local", id: call.terminal })
      const refusal = (fence: { readonly harnessId: string; readonly harnessSessionId: string | null; readonly runtime: string | null; readonly address: string | null } | undefined, call: InboxCall): InboxReply | undefined => {
        if (call.terminal === "" || call.claudeSessionId === "") return { error: "invalid-caller" }
        if (!fence || inboxOf(fence.harnessId) !== "bridge") return { error: "wrong-harness" }
        if (fence.harnessSessionId === null) return { error: "not-reported" }
        if (fence.harnessSessionId !== call.claudeSessionId || fence.address !== placeOf(call)) return { error: "stale-receiver" }
        return undefined
      }

      const retireClaim = (live: LiveAttachment) =>
        Effect.gen(function* () {
          const ids = live.claim?.ids ?? []
          const file = live.claim?.file
          if (ids.length > 0) yield* db.setInboxStatus(ids, "failed", "sending")
          live.claim = undefined
          if (file !== undefined) yield* removeClaimFile(file)
        })

      const reconcileLocked = (projectId: number) =>
        Effect.gen(function* () {
          const live = registry.get(projectId)
          if (!live) return
          const fence = yield* db.readCoordinatorFence(projectId)
          const same = fence !== undefined && inboxOf(fence.harnessId) === "bridge" && fence.harnessSessionId === live.claudeSessionId && fence.runtime === live.runtime && fence.address === live.address
          if (same) return
          yield* retireClaim(live)
          registry.delete(projectId)
        })

      const deliver = (projectId: number) =>
        drain.work(`deliver project ${projectId}`, lock(projectId).pipe(
          Effect.flatMap((s) =>
            s.withPermit(
              Effect.gen(function* () {
                // Before any early return: a busy, missing, or unreachable coordinator still retires a stale claim.
                yield* reconcileLocked(projectId)
                const coord = yield* db.coordinatorOf(projectId)
                if (!coord?.address || coord.address.id === "" || !coord.runtime) return yield* db.dropWaiting(projectId, "absent")
                const address = encodeAddress(coord.address)
                const guard = { projectId, runtime: coord.runtime, address }
                const h = yield* runtimes.route(coord.runtime).pipe(Effect.option)
                if (Option.isNone(h)) return
                const presence = yield* coordinatorIdle(h.value, coord.address)
                if (presence === "gone") return yield* db.dropWaiting(projectId, guard)
                if (presence !== "idle") return
                const fence = yield* db.readCoordinatorFence(projectId)
                // Recheck under this lock, after the runtime was awaited, so attach cannot overlap an entered paste.
                if (fence && inboxOf(fence.harnessId) === "bridge" && fence.bridgeSet) return
                const batch = nextBatch(yield* db.coordinatorPending(projectId))
                if (batch.length === 0) return
                // Its harness takes its rows itself (`stream`); they wait until it does.
                if (inboxOf(coord.harnessId) === "subscribe") return
                const claimed = yield* db.claim(batch.map((r) => r.id), guard)
                if (claimed.length === 0) return
                const body = text(batch.filter((r) => claimed.includes(r.id)))
                yield* h.value.send(coord.address, { text: body }).pipe(
                  Effect.onExit((exit) => (Exit.isSuccess(exit) ? markDelivered(claimed) : db.setInboxStatus(claimed, "failed", "sending"))),
                )
              }),
            ),
          ),
          Effect.catchCause((cause) => Effect.logWarning(`deliver to project ${projectId}: ${Cause.pretty(cause)}`)),
        ))

      const announce = (row: InboxRow) =>
        row.kind === "send" || row.status !== "pending"
          ? Effect.void
          : db.projectOfSession(row.sessionId).pipe(
              Effect.flatMap((projectId) =>
                projectId === undefined
                  ? Effect.void
                  : PubSub.publish(pubsub, row).pipe(Effect.andThen(Effect.forkIn(deliver(projectId), scope)), Effect.asVoid),
              ),
            )

      /** The project whose coordinator runs at `terminal`, in any registered runtime. */
      const at = (terminal: RuntimeAddress) =>
        Effect.gen(function* () {
          const all = yield* runtimes.all
          for (const h of all) {
            const project = yield* db.coordinatorAt(h.kind, terminal).pipe(Effect.option)
            if (Option.isSome(project)) return project.value
          }
          return undefined
        })

      // Triggers: a coordinator terminal's state changes (or its exit), and the reconcile tick. The registry's merged
      // `events` stream carries every registered runtime's (each registration's share ends when it unloads); a runtime
      // without `events` of its own is the poll's to cover (§5).
      const changed = () => Effect.forEach(registry.projects(), (id) => withLock(id, reconcileLocked(id), true), { discard: true })
      yield* Effect.forkIn(
        runtimes.events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "exited")
              // The merged stream does not say which runtime it came from; each kind's row matches on its own address.
              return drain.work("main agent exited", runtimes.all.pipe(
                Effect.flatMap((all) => Effect.forEach(all, (h) => db.clearCoordinator(h.kind, event.terminal), { discard: true })),
                Effect.andThen(changed),
                Effect.ignore,
              ))
            if (event.type === "state")
              return at(event.terminal).pipe(Effect.flatMap((projectId) => (projectId === undefined ? Effect.void : deliver(projectId))))
            return Effect.void
          }),
        ),
        scope,
      )
      yield* Effect.forkIn(
        db.pendingProjects.pipe(
          Effect.flatMap((projects) => {
            const ids = new Set(projects)
            for (const id of registry.projects()) ids.add(id)
            return Effect.forEach([...ids], deliver, { discard: true })
          }),
          Effect.repeat(Schedule.spaced(RECONCILE)),
        ),
        scope,
      )

      // Guard is the coordinator row as this stream read it. Two subscribers: whichever claims a batch first takes it.
      // shortcut: delivered means the RPC client queued the chunk (next pull starts only after the socket Ack), not that pi.sendMessage succeeded; a dropped Ack can mark failed after the client already has it, upgrade when delivery must mean sendMessage returned
      const stream = (projectId: number) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscribed = yield* db.coordinatorOf(projectId)
            const origin = subscribed?.address && subscribed.runtime
              ? { projectId, runtime: subscribed.runtime, address: encodeAddress(subscribed.address), harnessId: subscribed.harnessId }
              : undefined
            const arrivals = yield* PubSub.subscribe(pubsub)
            // Claimed for the batch this pull emits. Set in the same uninterruptible region as the claim, so a close cannot lose the ids.
            let unconfirmed: Array<number> = []
            const claimOne = () =>
              drain.work(`Pi claim project ${projectId}`, lock(projectId).pipe(
                Effect.flatMap((s) =>
                  s.withPermit(
                    Effect.uninterruptible(
                      Effect.gen(function* () {
                        if (!origin) return undefined
                        const current = yield* db.coordinatorOf(projectId)
                        if (!current || inboxOf(current.harnessId) !== "subscribe" || current.harnessId !== origin.harnessId || !current.address || !current.runtime) return undefined
                        if (current.runtime !== origin.runtime || encodeAddress(current.address) !== origin.address) return undefined
                        const pending = yield* db.coordinatorPending(projectId)
                        if (pending.length === 0) return undefined
                        const batch = nextBatch(pending)
                        const claimed = yield* db.claim(batch.map((r) => r.id), origin)
                        if (claimed.length === 0) return undefined
                        unconfirmed = claimed.slice()
                        return text(batch.filter((r) => claimed.includes(r.id)))
                      }),
                    ),
                  ),
                ),
              ))
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
                  const row = yield* PubSub.take(arrivals)
                  if (row.kind === "send") continue
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

      const mintGeneration = (blocked: ReadonlyArray<string | undefined>) =>
        Effect.gen(function* () {
          for (let i = 0; i < 4; i++) {
            const generation = yield* mint
            if (!blocked.includes(generation)) return generation
          }
          return yield* Effect.die("inbox generation collided")
        })

      const attach = (input: InboxCall & { readonly replace: boolean }) =>
        withLock(input.projectId, Effect.gen(function* () {
          let ownedFile: string | undefined
          return yield* Effect.gen(function* () {
          // Read inside the transaction; the publish callback runs synchronously at commit, with what it saw.
          let committed: { readonly runtime: string; readonly address: string } | undefined
          const result = yield* db.withCoordinatorWrite(Effect.gen(function* () {
            const fence = yield* db.readCoordinatorFence(input.projectId)
            const refused = refusal(fence, input)
            if (refused) return { _tag: "reply" as const, reply: refused }
            if (fence!.bridgeSet && !input.replace) return { _tag: "reply" as const, reply: { error: "stale-receiver" } }
            const previous = registry.get(input.projectId)
            const generation = yield* mintGeneration([fence!.bridge?.generation, previous?.generation])
            const bridge: CoordinatorBridge = { generation, claudeSessionId: input.claudeSessionId, runtime: fence!.runtime ?? "", address: placeOf(input) }
            if (!(yield* db.writeCoordinatorBridge(input.projectId, bridge))) return { _tag: "reply" as const, reply: { error: "unavailable" } }
            if (previous?.claim !== undefined && previous.claim.ids.length > 0) {
              const failed = yield* db.transitionInbox(previous.claim.ids, "failed", "sending")
              if (failed.length !== previous.claim.ids.length) return yield* Effect.die("inbox replace did not retire its own claim")
            }
            committed = { runtime: fence!.runtime ?? "", address: placeOf(input) }
            return { _tag: "attached" as const, generation, file: previous?.claim?.file }
          }), (result) => {
            if (result._tag !== "attached" || committed === undefined) return
            registry.set(input.projectId, { generation: result.generation, claudeSessionId: input.claudeSessionId, runtime: committed.runtime, address: committed.address, claim: undefined, receipt: undefined })
            ownedFile = result.file
          })
          if (result._tag === "reply") return result.reply
          return { generation: result.generation }
          }).pipe(Effect.ensuring(Effect.uninterruptible(Effect.gen(function* () {
            if (ownedFile !== undefined) yield* removeClaimFile(ownedFile)
          }))))
        }))

      const sameLive = (live: LiveAttachment | undefined, fence: { readonly harnessSessionId: string | null; readonly runtime: string | null; readonly address: string | null; readonly bridge?: { readonly generation: string } | undefined }, call: InboxCall & { readonly generation: string }) =>
        live !== undefined && fence.bridge?.generation === live.generation && live.generation === call.generation && live.claudeSessionId === fence.harnessSessionId && live.runtime === fence.runtime && live.address === fence.address

      const pull = (input: InboxCall & { readonly generation: string }) =>
        withLock(input.projectId, Effect.gen(function* () {
          if (!isInboxId(input.generation)) return { error: "stale-receiver" }
          let publication: { readonly ids: ReadonlyArray<number>; readonly file: string; readonly tmp: string; readonly token: string } | undefined
          let published = false
          const compensate = Effect.uninterruptible(Effect.gen(function* () {
            if (published || !publication) return
            yield* db.transitionInbox(publication.ids, "pending", "sending")
            const live = registry.get(input.projectId)
            if (live?.claim?.token === publication.token) live.claim = undefined
            yield* removeIfPresent(publication.file)
            yield* removeIfPresent(publication.tmp)
          }))
          return yield* Effect.gen(function* () {
            const prepared = yield* db.withCoordinatorWrite(Effect.gen(function* () {
              const fence = yield* db.readCoordinatorFence(input.projectId)
              const refused = refusal(fence, input)
              if (refused || !fence) return { _tag: "reply" as const, reply: refused ?? { error: "stale-receiver" } }
              const live = registry.get(input.projectId)
              if (!sameLive(live, fence, input)) return { _tag: "reply" as const, reply: { error: "stale-receiver" } }
              let dropPrevious = false
              if (live!.claim) {
                const sending = yield* db.sendingAmong(live!.claim.ids)
                if (sending.length === live!.claim.ids.length) return { _tag: "have" as const, token: live!.claim.token, file: live!.claim.file }
                if (sending.length > 0) {
                  yield* db.transitionInbox(sending, "failed", "sending")
                  const still = yield* db.sendingAmong(live!.claim.ids)
                  if (still.length > 0) return { _tag: "narrow" as const, token: live!.claim.token, file: live!.claim.file, ids: still }
                }
                dropPrevious = true
              }
              const stop = <A extends { readonly error?: string; readonly empty?: true; readonly bytes?: number }>(reply: A) =>
                dropPrevious ? { _tag: "clear" as const, reply } : { _tag: "reply" as const, reply }
              const batch = nextBatch(yield* db.coordinatorPending(input.projectId))
              if (batch.length === 0) return stop({ empty: true })
              const bytes = utf8Bytes(text(batch))
              if (bytes > CLAUDE_INBOX_MAX_BYTES) return stop({ error: "too-large" as const, bytes })
              const token = yield* mint
              const suffix = yield* mint
              if (!isInboxId(token) || !isInboxId(suffix)) return stop({ error: "unavailable" as const })
              const claimed = yield* db.claim(batch.map((row) => row.id), { projectId: input.projectId, runtime: fence!.runtime ?? "", address: placeOf(input) })
              if (claimed.length === 0) return stop({ empty: true })
              const file = layout.inboxClaim(live!.generation, token)
              return { _tag: "publish" as const, token, file, body: claimedText(batch, claimed), ids: claimed, suffix, dropPrevious }
            }), (result) => {
              const live = registry.get(input.projectId)
              if (result._tag === "narrow" && live?.claim) live.claim = { token: live.claim.token, ids: result.ids, file: live.claim.file }
              if ((result._tag === "clear" || (result._tag === "publish" && result.dropPrevious)) && live) live.claim = undefined
              if (result._tag === "publish") publication = { ids: result.ids, file: result.file, tmp: `${result.file}.${result.suffix}.tmp`, token: result.token }
            })
            if (prepared._tag === "have" || prepared._tag === "narrow") return { token: prepared.token, file: prepared.file }
            if (prepared._tag === "clear" || prepared._tag === "reply") return prepared.reply
            const exit = yield* Effect.exit(Effect.uninterruptibleMask((restore) =>
              restore(writeClaim(prepared.file, prepared.body, prepared.suffix)).pipe(
                Effect.flatMap(() => Effect.sync(() => {
                  const live = registry.get(input.projectId)
                  if (live) live.claim = { token: prepared.token, ids: prepared.ids, file: prepared.file }
                  published = true
                })),
              ),
            ))
            if (Exit.isFailure(exit)) return { error: "unavailable" }
            return { token: prepared.token, file: prepared.file }
          }).pipe(Effect.ensuring(compensate))
        }))

      const settle = (input: InboxCall & { readonly generation: string; readonly token: string }, op: ReceiptOp) =>
        withLock(input.projectId, Effect.gen(function* () {
          if (!isInboxId(input.generation) || !isInboxId(input.token)) return { error: "stale-receiver" }
          let ownedFile: string | undefined
          return yield* Effect.gen(function* () {
          const committed = yield* db.withCoordinatorWrite(Effect.gen(function* () {
            const fence = yield* db.readCoordinatorFence(input.projectId)
            const refused = refusal(fence, input)
            if (refused || !fence) return refused ?? { error: "stale-receiver" }
            const live = registry.get(input.projectId)
            if (!sameLive(live, fence, input)) return { error: "stale-receiver" }
            if (live!.receipt?.token === input.token) {
              if (live!.receipt.op !== op) return { error: "stale-receiver" }
              return op === "ack" ? { acked: true, already: true } : { released: true, already: true }
            }
            if (live!.claim?.token !== input.token) return { error: "stale-receiver" }
            const status = op === "ack" ? "delivered" : op === "release-retry" ? "pending" : "failed"
            const changed = yield* db.transitionInbox(live!.claim.ids, status, "sending")
            if (changed.length !== live!.claim.ids.length) {
              if (changed.length > 0) yield* db.transitionInbox(changed, "sending", status)
              return { error: "stale-receiver" }
            }
            // Read in the transaction and queued on commit, so the completion archive sees every acked row once.
            const rows = op === "ack" ? yield* db.inboxRows(changed) : []
            return { _tag: "settled" as const, file: live!.claim.file, token: input.token, rows }
          }), (result) => {
            if (!("_tag" in result) || result._tag !== "settled") return
            const live = registry.get(input.projectId)
            if (!live) return
            live.receipt = { token: result.token, op }
            live.claim = undefined
            ownedFile = result.file
            publishDelivered(result.rows)
          })
          if (!("_tag" in committed) || committed._tag !== "settled") return committed
          return op === "ack" ? { acked: true } : { released: true }
          }).pipe(Effect.ensuring(Effect.uninterruptible(Effect.gen(function* () {
            if (ownedFile !== undefined) yield* removeClaimFile(ownedFile)
          }))))
        }), true)

      return Inbox.of({
        enqueue: (row) => db.insertInbox(row).pipe(Effect.tap(announce)),
        announce,
        deliver,
        stream,
        delivered: Queue.take(delivered),
        attach,
        pull,
        ack: (input) => settle(input, "ack"),
        release: (input) => settle(input, input.retry ? "release-retry" : "release-fail"),
        reconcile: (projectId) => withLock(projectId, reconcileLocked(projectId)),
      })
    }),
  )
}
