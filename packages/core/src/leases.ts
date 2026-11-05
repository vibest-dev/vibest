// Leases: an inbox row a recipient took (`delivering`) and has not settled yet. Engine-level: a recipient is any key
// its user picks. Memory only: a vibestd that starts holds none (Db.recoverDelivering decides what its claimed rows
// become). A lease with a ttl ends on its own timer (`lease:<inbox id>`); one without lasts until it settles or its
// recipient's leases all end.
import { type Duration, Effect } from "effect"

import * as Engine from "./engine.ts"

type OnExpire = (ids: ReadonlyArray<number>) => Effect.Effect<void>

/** Lives as long as the scope it is made in, its timers too. */
export const make = Effect.gen(function* () {
  const engine = yield* Engine.make
  const leases = new Map<number, { readonly recipient: string; readonly onExpire: OnExpire }>()

  /** Take `ids` out of the map (each once) and stop their timers; returns the leases that were held. */
  const take = (ids: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      const taken = ids.flatMap((id) => {
        const lease = leases.get(id)
        if (lease === undefined) return []
        leases.delete(id)
        return [{ id, ...lease }]
      })
      for (const { id } of taken) yield* engine.cancel(`lease:${id}`)
      return taken
    })

  /** End `ids`: each `onExpire` once, with the ids it was given for (in one call). */
  const end = (ids: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      const byExpire = new Map<OnExpire, Array<number>>()
      for (const { id, onExpire } of yield* take(ids)) byExpire.set(onExpire, [...(byExpire.get(onExpire) ?? []), id])
      for (const [onExpire, ended] of byExpire) yield* onExpire(ended)
    })

  return {
    /** `recipient` holds `ids` until they settle, or for `ttl`; then `onExpire` gets them back. */
    hold: (recipient: string, ids: ReadonlyArray<number>, ttl: Duration.Duration | undefined, onExpire: OnExpire) =>
      Effect.gen(function* () {
        for (const id of ids) {
          leases.set(id, { recipient, onExpire })
          if (ttl !== undefined) yield* engine.arm(`lease:${id}`, ttl, end([id]))
        }
      }),
    /** `ids` settled (delivered, failed or given back): their leases end without `onExpire`. */
    settle: (ids: ReadonlyArray<number>) => Effect.asVoid(take(ids)),
    /** Every lease `recipient` holds ends now. */
    expireAll: (recipient: string) =>
      Effect.suspend(() => end([...leases].filter(([, lease]) => lease.recipient === recipient).map(([id]) => id))),
    /** The ids `recipient` holds, in the order taken. */
    held: (recipient: string) => [...leases].filter(([, lease]) => lease.recipient === recipient).map(([id]) => id),
  }
})
