import { Effect, Semaphore } from "effect"

export const directoryLock = (directory: string) => `directory:${directory}`

export const keyedLock = <K>() => {
  const entries = new Map<K, { readonly lock: Semaphore.Semaphore; holdersAndWaiters: number }>()
  const withLock =
    (key: K) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const entry = entries.get(key) ?? { lock: Semaphore.makeUnsafe(1), holdersAndWaiters: 0 }
          entry.holdersAndWaiters++
          entries.set(key, entry)
          return restore(entry.lock.withPermit(effect)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (--entry.holdersAndWaiters === 0) entries.delete(key)
              }),
            ),
          )
        }),
      )
  return {
    withLock,
    busy: (key: K) => entries.has(key),
    size: () => entries.size,
  }
}
