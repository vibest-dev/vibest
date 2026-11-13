import { claimHeaders, hookCall, type VibestClient } from "@vibest/client/client"
import { messageOf } from "@vibest/schema/error"
import { Layout } from "@vibest/schema/layout"
import { Cause, Clock, Config, Effect, Exit, Option } from "effect"

const nonempty = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.map((value) => {
      const text = Option.getOrUndefined(value)
      return text ? text : undefined
    }),
  )

export const notify = <A>(
  harness: string,
  sessionId: string,
  what: string,
  send: (client: VibestClient) => Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const headers = yield* claimHeaders({ _tag: "session", sessionId })
    const exit = yield* hookCall(layout.socket, headers, send)
    if (Exit.isSuccess(exit)) return exit.value
    const at = new Date(yield* Clock.currentTimeMillis).toISOString()
    const cause = Cause.squash(exit.cause)
    return yield* Effect.fail(
      `${at} vibest: ${harness} ${what} of session ${sessionId} did not reach vibestd: ${messageOf(cause)}`,
    )
  })

const hookSession = Effect.gen(function* () {
  const sessionId = yield* nonempty("VIBEST_SESSION_ID")
  return sessionId ? { sessionId } : undefined
})

export const integrationStop = (harness: string, raw: string) =>
  Effect.gen(function* () {
    const who = yield* hookSession
    if (!who) return
    yield* notify(harness, who.sessionId, "execution end", (client) =>
      client.ExecutionEnd({ sessionId: who.sessionId, harness, event: raw }),
    )
  })

export const integrationPrompt = (harness: string, raw: string) =>
  Effect.gen(function* () {
    const who = yield* hookSession
    if (!who) return
    yield* notify(harness, who.sessionId, "execution start", (client) =>
      client.Prompt({ sessionId: who.sessionId, harness, event: raw }),
    )
  })

export const integrationReady = (harness: string) =>
  Effect.gen(function* () {
    const who = yield* hookSession
    if (!who) return
    yield* notify(harness, who.sessionId, "ready report", (client) => client["Session.Ready"]({ id: who.sessionId }))
  })
