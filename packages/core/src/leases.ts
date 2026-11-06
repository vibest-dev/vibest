import { type Duration, Effect } from "effect"

import * as Engine from "./engine.ts"

type OnExpire = (ids: ReadonlyArray<number>) => Effect.Effect<void>

export const make = Effect.gen(function* () {
  const engine = yield* Engine.make
  const leases = new Map<number, { readonly recipient: string; readonly onExpire: OnExpire }>()

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

  const end = (ids: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      const byExpire = new Map<OnExpire, Array<number>>()
      for (const { id, onExpire } of yield* take(ids)) byExpire.set(onExpire, [...(byExpire.get(onExpire) ?? []), id])
      for (const [onExpire, ended] of byExpire) yield* onExpire(ended)
    })

  return {
    hold: (recipient: string, ids: ReadonlyArray<number>, ttl: Duration.Duration | undefined, onExpire: OnExpire) =>
      Effect.gen(function* () {
        for (const id of ids) {
          leases.set(id, { recipient, onExpire })
          if (ttl !== undefined) yield* engine.arm(`lease:${id}`, ttl, end([id]))
        }
      }),
    settle: (ids: ReadonlyArray<number>) => Effect.asVoid(take(ids)),
    expireAll: (recipient: string) =>
      Effect.suspend(() => end([...leases].filter(([, lease]) => lease.recipient === recipient).map(([id]) => id))),
    held: (recipient: string) => [...leases].filter(([, lease]) => lease.recipient === recipient).map(([id]) => id),
  }
})
