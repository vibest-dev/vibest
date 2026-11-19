import { Plugin, type PluginSession } from "@vibest/plugin/effect"
import { Effect, Predicate, Stream } from "effect"

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

    const facts = ctx.event.subscribe({ types: ["execution.ended", "inbox.queued", "outbox.queued"] })

    type Watched = Stream.Success<typeof facts>

    const sendingSession = (fact: Exclude<Watched, { readonly type: "execution.ended" }>) => {
      if (fact.data.kind !== "send" || fact.data.execution === undefined) return undefined

      if (fact.type === "outbox.queued") return fact.data.session
      const sender = fact.data.sender

      return Predicate.isString(sender) || "plugin" in sender || sender.machine !== undefined
        ? undefined
        : sender.session
    }

    return Effect.gen(function* () {
      const sent = new Map<string, number>()

      const ended = (fact: Extract<Watched, { readonly type: "execution.ended" }>) =>
        Effect.gen(function* () {
          const key = `${fact.sessionId}:${fact.data.execution}`
          const counted = sent.get(key) ?? 0
          sent.delete(key)

          if (fact.sessionId === undefined || fact.data.outcome !== "completed") return
          const session = yield* ctx.session.get(fact.sessionId)

          if (session === undefined || session.parentId === null) return
          const nothing = session.latest?.execution === fact.data.execution ? sentNothing(session) : counted === 0

          if (nothing) yield* remind(session, fact.data.execution)
        })

      yield* facts.pipe(
        Stream.runForEach((fact) => {
          if (fact.type === "execution.ended") return ended(fact)
          const session = sendingSession(fact)

          if (session !== undefined) {
            const key = `${session}:${fact.data.execution}`
            sent.set(key, (sent.get(key) ?? 0) + 1)
          }

          return Effect.void
        }),
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
