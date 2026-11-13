import { Cause, Console, Effect, Exit, Option, type Runtime } from "effect"
import { CliError } from "effect/cli"

export const printFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      const error = Cause.findErrorOption(cause)
      if (Option.isNone(error)) return Console.error(Cause.pretty(cause))
      const e: unknown = error.value
      if (CliError.isCliError(e)) return Effect.void
      if (typeof e !== "object" || e === null || !("_tag" in e)) return Console.error(String(e))
      const { _tag, message } = e as { readonly _tag: string; readonly message?: string }
      return Console.error(message ? `${_tag}: ${message}` : _tag)
    }),
  )

export const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit)) return onExit(0)
  if (Cause.hasInterruptsOnly(exit.cause)) return onExit(130)
  const error = Cause.findErrorOption(exit.cause)
  onExit(Option.isSome(error) && CliError.isCliError(error.value) ? 2 : 1)
}
