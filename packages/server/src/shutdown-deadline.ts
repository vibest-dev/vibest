import { SHUTDOWN_DEADLINE, SHUTDOWN_FLUSH } from "@vibest/client/client"
import type { Releases } from "@vibest/core/effect/layer-node"
import { Console, Deferred, Duration, Effect, Fiber, type Scope } from "effect"

export interface ShutdownHost {
  readonly onSignals: (onSignal: (signal: string) => void) => Effect.Effect<void, never, Scope.Scope>
  readonly exit: (code: number) => Effect.Effect<void>
}

const releasingText = (reason: string, pending: ReturnType<Releases["pending"]>) =>
  [
    `${reason}; exiting. Still releasing:`,
    ...(pending.length > 0
      ? pending.map((item) => `  ${(item.ms / 1000).toFixed(1)}s  ${item.name}`)
      : ["  nothing tracked; the stuck finalizer is outside any LayerNode layer"]),
  ].join("\n")

export const install = (host: ShutdownHost, releases: Releases, stopRequested: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const fork = Effect.runForkWith(yield* Effect.context<never>())
    let timer: Fiber.Fiber<void> | undefined
    const arm = (cause: string) => {
      timer = fork(
        Effect.gen(function* () {
          yield* Effect.logInfo("shutdown started", { cause })
          yield* Effect.sleep(SHUTDOWN_DEADLINE)
          const pending = releases.pending()
          yield* Console.error(
            releasingText(`shutdown did not finish within ${Duration.format(SHUTDOWN_DEADLINE)}`, pending),
          )
          yield* Effect.logError("shutdown deadline exceeded", {
            deadline: Duration.format(SHUTDOWN_DEADLINE),
            releasing: pending.map((item) => `${item.name} for ${item.ms}ms`),
          })
          yield* Effect.sleep(SHUTDOWN_FLUSH)
          yield* host.exit(1)
        }),
      )
    }
    yield* host.onSignals((signal) => {
      if (timer === undefined) return arm(signal)
      fork(
        Console.error(releasingText(`received ${signal} again during shutdown`, releases.pending())).pipe(
          Effect.andThen(host.exit(1)),
        ),
      )
    })
    yield* Effect.addFinalizer(() => (timer === undefined ? Effect.void : Fiber.interrupt(timer)))
    yield* Deferred.await(stopRequested).pipe(
      Effect.andThen(Effect.sync(() => timer === undefined && arm("stop request"))),
      Effect.forkScoped,
    )
  })
