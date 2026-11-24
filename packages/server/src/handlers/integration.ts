import { Agents } from "@vibest/core/agents"
import { Db } from "@vibest/core/database/db"
import { harnessCatalog } from "@vibest/core/harness"
import { Harnesses, unprovided } from "@vibest/core/harnesses"
import { type HookCaller, Integration } from "@vibest/core/integration"
import { forProvider } from "@vibest/core/models"
import { guardInputOf } from "@vibest/core/replies"
import { CALLER_HEADER } from "@vibest/protocol/protocol"
import { Caller, Forbidden, InvalidCaller } from "@vibest/protocol/rpc"
import { Effect, Predicate } from "effect"
import type * as Headers from "effect/http/Headers"

import { noteOpen, processOf, reader } from "../gates.ts"
import { Remote } from "../machine/remote.ts"
import type { Handlers } from "./caller.ts"
import { group } from "./group.ts"

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const harnesses = yield* Harnesses.Service
  const agents = yield* Agents.Service
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
        if (machine !== undefined) {
          if (reader(headers)(CALLER_HEADER) === "remote")
            return yield* new Forbidden({
              method: "Harnesses.List",
              message: "a remote asks for this machine's harnesses only",
            })

          return yield* remote.harnesses(machine, provider)
        }

        const choices = yield* harnessCatalog

        return provider === undefined ? choices : forProvider(choices, harnesses, provider)
      }),

    "Agents.List": ({ machine }, { headers }) =>
      Effect.gen(function* () {
        if (machine !== undefined) {
          if (reader(headers)(CALLER_HEADER) === "remote")
            return yield* new Forbidden({
              method: "Agents.List",
              message: "a remote asks for this machine's agents only",
            })

          return yield* remote.agents(machine)
        }

        return {
          agents: agents.all.map(({ id, description, plugin, harness, provider, model, system }) => ({
            id,
            description,
            plugin,
            ...(harness !== undefined && { harness }),
            ...(provider !== undefined && { provider }),
            ...(model !== undefined && { model }),
            system,
          })),
          invalid: agents.invalid.map(({ id, source, error, plugin }) => ({ id, source, error, plugin })),
        }
      }),

    "Integration.Guard": ({ harness, input }: { readonly harness: string; readonly input: string }) =>
      Effect.gen(function* () {
        const definition = harnesses.find(harness)

        if (definition === undefined) return yield* unprovided(harness, harnesses.all)
        const caller = yield* Caller

        if (!Predicate.isTagged(caller, "Session"))
          return yield* new InvalidCaller({
            method: "Integration.Guard",
            message: "Integration.Guard checks the tool call of a session",
          })
        const call = guardInputOf(definition, input)

        const reason =
          call === undefined
            ? undefined
            : yield* integration
                .guard(caller.sessionId, call)
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

export const layer = group(["Harnesses.List", "Agents.List", "Integration.Guard", "ExecutionEnd", "Prompt"]).toLayer(
  make,
)
