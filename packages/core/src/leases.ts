import { type Duration, Effect } from "effect"

import * as Engine from "./engine.ts"

type OnExpire = (ids: ReadonlyArray<number>) => Effect.Effect<void>

type Lease = { readonly recipient: string; readonly session: string; readonly id: number; readonly onExpire: OnExpire }

const keyOf = (session: string, id: number) => `${session} ${id}`

export const make = Effect.gen(function* () {
  const engine = yield* Engine.make
  const leases = new Map<string, Lease>()

  const take = (keys: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const taken = keys.flatMap((key) => {
        const lease = leases.get(key)
        if (lease === undefined) return []
        leases.delete(key)
        return [lease]
      })
      for (const lease of taken) yield* engine.cancel(`lease:${keyOf(lease.session, lease.id)}`)
      return taken
    })

  const end = (keys: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const byExpire = new Map<OnExpire, Array<number>>()
      for (const { id, onExpire } of yield* take(keys)) byExpire.set(onExpire, [...(byExpire.get(onExpire) ?? []), id])
      for (const [onExpire, ended] of byExpire) yield* onExpire(ended)
    })

  const of = (recipient: string) => [...leases].filter(([, lease]) => lease.recipient === recipient)

  return {
    hold: (
      recipient: string,
      session: string,
      ids: ReadonlyArray<number>,
      ttl: Duration.Duration | undefined,
      onExpire: OnExpire,
    ) =>
      Effect.gen(function* () {
        for (const id of ids) {
          const key = keyOf(session, id)
          leases.set(key, { recipient, session, id, onExpire })
          if (ttl !== undefined) yield* engine.arm(`lease:${key}`, ttl, end([key]))
        }
      }),
    settle: (session: string, ids: ReadonlyArray<number>) => Effect.asVoid(take(ids.map((id) => keyOf(session, id)))),
    expireAll: (recipient: string) => Effect.suspend(() => end(of(recipient).map(([key]) => key))),
    held: (recipient: string) => of(recipient).map(([, lease]) => lease.id),
  }
})
