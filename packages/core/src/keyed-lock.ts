import { Effect, Semaphore } from "effect"

/**
 * One lock per key, kept in memory only while someone holds or waits on it (.agents/rules/vibestd-state.md 3). The
 * count covers waiters too, which the semaphore does not expose: an entry dropped while one waited would let the next
 * caller make a second lock for the same key.
 */
export const keyedLock = <K>() => {
  const entries = new Map<K, { readonly lock: Semaphore.Semaphore; users: number }>()
  /**
   * Run `effect` holding the key's lock. The count is raised and lowered inside the mask; only the semaphore's own
   * `withPermit` runs under `restore`, so it alone decides when the permit is returned (Semaphore.withPermits).
   */
  const withLock =
    (key: K) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const entry = entries.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 }
          entry.users++
          entries.set(key, entry)
          return restore(entry.lock.withPermit(effect)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (--entry.users === 0) entries.delete(key)
              }),
            ),
          )
        }),
      )
  return {
    withLock,
    /** Someone holds or waits on the key's lock. */
    busy: (key: K) => entries.has(key),
    /** For tests: keys someone holds or waits on. */
    size: () => entries.size,
  }
}
