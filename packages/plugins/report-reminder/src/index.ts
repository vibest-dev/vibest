import { Plugin, type PluginSession } from "@vibest/plugin/effect"
import { Effect, Stream } from "effect"

const ID = "vibest.report-reminder"

export default Plugin.define({
  id: ID,
  effect: (ctx) => {
    const remind = (session: PluginSession, execution: number) =>
      ctx.session
        .send({
          to: session.parentId!,
          message: `${session.title} (${session.id}) completed execution ${execution} without sending a message.`,
          request: `${ID}:${session.id}:${execution}`,
        })
        .pipe(Effect.catch((e) => Effect.logWarning(`${ID}: ${e.message}`)))

    const sentNothing = (session: PluginSession) =>
      session.parentId !== null && session.latest?.outcome === "completed" && session.latest.sent === 0

    const ended = (sessionId: string, execution: number) =>
      Effect.gen(function* () {
        const session = yield* ctx.session.get(sessionId)

        if (session === undefined || session.parentId === null) return

        if ((yield* ctx.session.sentIn(sessionId, execution)) === 0) yield* remind(session, execution)
      })

    return Effect.gen(function* () {
      yield* ctx.event.subscribe({ types: ["execution.ended"] }).pipe(
        Stream.runForEach((fact) =>
          fact.sessionId === undefined || fact.data.outcome !== "completed"
            ? Effect.void
            : ended(fact.sessionId, fact.data.execution),
        ),
        Effect.forkScoped,
      )
      yield* ctx.session.list().pipe(
        Effect.flatMap((sessions) =>
          Effect.forEach(sessions, (s) => (sentNothing(s) ? remind(s, s.latest!.execution) : Effect.void), {
            discard: true,
          }),
        ),
        Effect.forkScoped,
      )
    })
  },
})
