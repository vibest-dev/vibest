import { Db } from "@vibest/core/database/db"
import { LOCAL_MACHINE } from "@vibest/core/database/ledger-read"
import { harnessCatalog } from "@vibest/core/harness"
import { Harnesses, unprovided } from "@vibest/core/harnesses"
import { type HookCaller, Integration } from "@vibest/core/integration"
import { forProvider } from "@vibest/core/models"
import { CALLER_HEADER } from "@vibest/protocol/protocol"
import { Caller, Forbidden, InvalidCaller } from "@vibest/protocol/rpc"
import { Effect } from "effect"
import type * as Headers from "effect/http/Headers"

import { noteOpen, processOf, reader } from "../gates.ts"
import { Remote } from "../machine/remote.ts"
import type { Handlers } from "./caller.ts"

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const harnesses = yield* Harnesses.Service
  const integration = yield* Integration.Service
  const remote = yield* Remote.Service

  const hook = (
    sessionId: string,
    harness: string,
    headers: Headers.Headers,
    run: (who: HookCaller) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const read = reader(headers)
      yield* noteOpen(db, read, sessionId)
      const row = yield* db.session.sessionIdentity(sessionId)
      if (!row || row.harness !== harness) return
      yield* run({ id: row.id, entry: row.entry, harness, process: processOf(read) })
    }).pipe(Effect.orDie)

  return {
    "Harnesses.List": ({ provider, machine }, { headers }) =>
      Effect.gen(function* () {
        if (machine !== undefined && machine !== LOCAL_MACHINE) {
          if (reader(headers)(CALLER_HEADER) === "peer")
            return yield* new Forbidden({
              method: "Harnesses.List",
              message: "a peer asks for this machine's harnesses only",
            })
          return yield* remote.harnesses(machine, provider)
        }
        const choices = yield* harnessCatalog
        return provider === undefined ? choices : forProvider(choices, harnesses, provider)
      }),

    "Integration.Guard": ({ harness, input }: { readonly harness: string; readonly input: string }) =>
      Effect.gen(function* () {
        const definition = harnesses.find(harness)
        if (definition === undefined) return yield* unprovided(harness, harnesses.all)
        const caller = yield* Caller
        if (caller._tag !== "Session")
          return yield* new InvalidCaller({
            method: "Integration.Guard",
            message: "Integration.Guard checks the tool call of a session",
          })
        const reason = yield* integration
          .guard(caller.sessionId, input)
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
