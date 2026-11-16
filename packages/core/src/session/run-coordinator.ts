import { Effect, FiberSet, type Scope } from "effect"

export * as RunCoordinator from "./run-coordinator.ts"

export interface Interface<Key, Wake> {
  readonly wake: (key: Key, wake: Wake) => Effect.Effect<void>
}

type Execution<Wake> = { pending: { readonly wake: Wake } | undefined }

export const make = <Key, Wake>(options: {
  readonly drain: (key: Key, wake: Wake) => Effect.Effect<void>
  readonly merge: (pending: Wake, next: Wake) => Wake
}): Effect.Effect<Interface<Key, Wake>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const executions = new Map<Key, Execution<Wake>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const loop = (key: Key, execution: Execution<Wake>, wake: Wake): Effect.Effect<void> =>
      Effect.suspend(() => options.drain(key, wake)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const next = execution.pending
            if (next === undefined) return Effect.void
            execution.pending = undefined
            return Effect.yieldNow.pipe(Effect.andThen(loop(key, execution, next.wake)))
          }),
        ),
      )

    const settle = (key: Key, execution: Execution<Wake>) => {
      if (execution.pending === undefined) executions.delete(key)
      else start(key, execution.pending.wake)
    }

    const start = (key: Key, wake: Wake) => {
      const execution: Execution<Wake> = { pending: undefined }
      executions.set(key, execution)
      fork(
        Effect.yieldNow.pipe(
          Effect.andThen(loop(key, execution, wake)),
          Effect.onExit(() => Effect.sync(() => settle(key, execution))),
        ),
      )
    }

    const wake = (key: Key, next: Wake) =>
      Effect.sync(() => {
        const execution = executions.get(key)
        if (execution === undefined) return start(key, next)
        execution.pending = {
          wake: execution.pending === undefined ? next : options.merge(execution.pending.wake, next),
        }
      })

    return { wake }
  })
