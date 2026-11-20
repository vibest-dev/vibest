import { Plugin, type PluginOptions, type PluginSession } from "@vibest/plugin/effect"
import { Clock, Duration, Effect, Predicate, Schedule } from "effect"

const ID = "vibest.idle-stop"
const DEFAULT_IDLE_MINUTES = 30
const LONGEST_CHECK_GAP_MINUTES = 5

const idleMinutesOf = (options: PluginOptions) =>
  Predicate.isNumber(options.idleMinutes) && options.idleMinutes > 0 ? options.idleMinutes : DEFAULT_IDLE_MINUTES

const idleFor = (session: PluginSession, now: number, idle: Duration.Duration) =>
  session.parentId !== null && !session.waiting && now - session.lastActive >= Duration.toMillis(idle)

export default Plugin.define({
  id: ID,
  effect: (ctx) => {
    const minutes = idleMinutesOf(ctx.options)
    const idle = Duration.minutes(minutes)

    const tell = (session: PluginSession) =>
      ctx.session.send({
        to: session.parentId!,
        message: `${session.title} (${session.id}) was idle for ${minutes} minutes and was stopped. Send it a message with vibest send to resume it; archive it with vibest archive when you no longer need it.`,
        request: `${ID}:${session.id}:${session.lastActive}`,
      })

    const stop = (session: PluginSession) =>
      ctx.session.stop(session.id, { idleSince: session.lastActive }).pipe(
        Effect.flatMap((stopped) => (stopped ? tell(session) : Effect.void)),
        Effect.catch((e) => Effect.logWarning(`${ID}: ${e.message}`)),
      )

    const stopIdle = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const sessions = yield* ctx.session.list()
      yield* Effect.forEach(
        sessions.filter((session) => idleFor(session, now, idle)),
        stop,
        { discard: true },
      )
    })

    return stopIdle.pipe(
      Effect.repeat(Schedule.spaced(Duration.minutes(Math.min(minutes, LONGEST_CHECK_GAP_MINUTES)))),
      Effect.forkScoped,
      Effect.asVoid,
    )
  },
})
