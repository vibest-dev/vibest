import { Db } from "@vibest/core/db"
import { harnessCatalog, Harnesses, unprovided } from "@vibest/core/harness"
import { type HookCaller, Integration } from "@vibest/core/integration"
import { forProvider } from "@vibest/core/models"
import { Caller, InvalidCaller } from "@vibest/protocol/rpc"
import { Effect } from "effect"
import type * as Headers from "effect/http/Headers"

import { noteOpen, processOf, reader } from "../gates.ts"
import type { Handlers } from "./caller.ts"

export const make = Effect.gen(function* () {
  const db = yield* Db
  const harnesses = yield* Harnesses
  const integration = yield* Integration

  const hook = (
    sessionId: string,
    harness: string,
    headers: Headers.Headers,
    run: (who: HookCaller) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const read = reader(headers)
      yield* noteOpen(db, read, sessionId)
      const row = yield* db.sessionIdentity(sessionId)
      if (!row || row.harness !== harness) return
      yield* run({ id: row.id, agent: row.agent, entry: row.entry, harness, process: processOf(read) })
    }).pipe(Effect.orDie)

  return {
    "Harnesses.List": ({ provider }: { readonly provider?: string | undefined }) =>
      Effect.map(harnessCatalog, (choices) =>
        provider === undefined ? choices : forProvider(choices, harnesses, provider),
      ),

    "Integration.Guard": ({
      harness,
      agent,
      input,
    }: {
      readonly harness: string
      readonly agent: string
      readonly input: string
    }) =>
      Effect.gen(function* () {
        const definition = harnesses.find(harness)
        if (definition === undefined) return yield* unprovided(harness, harnesses.all)
        const caller = yield* Caller
        const reason = yield* integration
          .guard(agent, input, caller._tag === "Cli" ? undefined : caller.projectId)
          .pipe(Effect.mapError((e) => new InvalidCaller({ method: "Integration.Guard", message: String(e) })))
        const answer = definition.guardAnswer === undefined ? reason : definition.guardAnswer(reason)
        return answer === undefined ? {} : { answer }
      }),

    ExecutionEnd: ({ sessionId, harness, event }, { headers }) =>
      hook(sessionId, harness, headers, (who) => integration.executionEnd(who, event)),

    Prompt: ({ sessionId, harness, event }, { headers }) =>
      hook(sessionId, harness, headers, (who) => integration.prompt(who, event)),
  } satisfies Handlers
})
