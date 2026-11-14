import { Effect, Semaphore } from "effect"

export interface KeyedMutex<in Key> {
  readonly size: Effect.Effect<number>
  readonly withLock: (key: Key) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export const makeUnsafe = <Key>(): KeyedMutex<Key> => {
  const locks = new Map<Key, { readonly semaphore: Semaphore.Semaphore; users: number }>()

  const withLock =
    (key: Key) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const current = locks.get(key)
          const entry = current ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
          if (!current) locks.set(key, entry)
          entry.users++
          return restore(entry.semaphore.withPermit(effect)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.users--
                if (entry.users === 0) locks.delete(key)
              }),
            ),
          )
        }),
      )

  return { size: Effect.sync(() => locks.size), withLock }
}

export const make = <Key>(): Effect.Effect<KeyedMutex<Key>> => Effect.sync(makeUnsafe<Key>)
