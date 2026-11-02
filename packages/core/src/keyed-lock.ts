import { Effect, Semaphore } from "effect"

/**
 * One lock per key, kept in memory only while someone holds or waits on it (.agents/rules/vibestd-state.md 3). The
 * count covers waiters too, which the semaphore does not expose: an entry dropped while one waited would let the next
 * caller make a second lock for the same key.
 */
export const keyedLock = <K>() => {
  const entries = new Map<K, { readonly lock: Semaphore.Semaphore; users: number }>()
  /**
   * Wait for the key's lock; the effect it returns releases it. Run it inside the caller's uninterruptibleMask and pass
   * its `restore`: the count and the release are set up uninterruptibly, only the wait is interruptible (main's
   * `restore(Semaphore.take)`). A mask of its own would end interrupted after the permit was taken, losing the release.
   */
  const take = (key: K, restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const entry = entries.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 }
      entry.users++
      entries.set(key, entry)
      const leave = Effect.sync(() => {
        if (--entry.users === 0) entries.delete(key)
      })
      return restore(Semaphore.take(entry.lock, 1)).pipe(
        Effect.onInterrupt(() => leave),
        Effect.as(Semaphore.release(entry.lock, 1).pipe(Effect.andThen(leave))),
      )
    })
  const withLock =
    (key: K) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        take(key, restore).pipe(Effect.flatMap((release) => restore(effect).pipe(Effect.ensuring(release)))),
      )
  return {
    take,
    withLock,
    /** Someone holds or waits on the key's lock. */
    busy: (key: K) => entries.has(key),
    /** For tests: keys someone holds or waits on. */
    size: () => entries.size,
  }
}
