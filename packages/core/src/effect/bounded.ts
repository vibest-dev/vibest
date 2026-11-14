import { Duration, Effect, Fiber, Option, Scope } from "effect"

export * as Bounded from "./bounded.ts"

export const timeoutWithoutWaiting = Effect.fn("Bounded.timeoutWithoutWaiting")(function* <A, E>(
  effect: Effect.Effect<A, E>,
  scope: Scope.Scope,
  timeout: Duration.Input,
) {
  const fiber = yield* Effect.forkIn(
    Effect.suspend(() => effect),
    scope,
  )
  const exit = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(timeout))
  if (Option.isNone(exit)) yield* Effect.forkDetach(Fiber.interrupt(fiber))
  return exit
})
