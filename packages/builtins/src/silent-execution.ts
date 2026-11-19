import { Plugin, type PluginSession } from "@vibest/plugin/effect"
import { Effect, Stream } from "effect"

const ID = "silent-execution"

const sentNothing = (session: PluginSession, execution: number) =>
  session.parentId !== null &&
  session.latest?.execution === execution &&
  session.latest.outcome === "completed" &&
  session.latest.sent === 0

export default Plugin.define({
  id: ID,
  effect: (ctx) => {
    const remind = (session: PluginSession, execution: number) =>
      sentNothing(session, execution)
        ? ctx.session
            .send({
              to: session.parentId!,
              message: `${session.title} (${session.id}) completed execution ${execution} without sending a message.`,
              request: `${ID}:${session.id}:${execution}`,
            })
            .pipe(Effect.catch((e) => Effect.logWarning(`${ID}: ${e.message}`)))
        : Effect.void

    return Effect.gen(function* () {
      yield* ctx.event.subscribe({ types: ["execution.ended"] }).pipe(
        Stream.runForEach((fact) =>
          fact.sessionId === undefined
            ? Effect.void
            : ctx.session
                .get(fact.sessionId)
                .pipe(
                  Effect.flatMap((session) =>
                    session === undefined ? Effect.void : remind(session, fact.data.execution),
                  ),
                ),
        ),
        Effect.forkScoped,
      )
      yield* ctx.session.list().pipe(
        Effect.flatMap((sessions) =>
          Effect.forEach(sessions, (s) => (s.latest === null ? Effect.void : remind(s, s.latest.execution)), {
            discard: true,
          }),
        ),
        Effect.forkScoped,
      )
    })
  },
})
