import { Duration, Effect, Schedule } from "effect"

export const reconnectSchedule = (options: { readonly first: Duration.Input; readonly max: Duration.Input }) => {
  const max = Duration.fromInputUnsafe(options.max)
  return Schedule.exponential(options.first).pipe(
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, max))),
  )
}
