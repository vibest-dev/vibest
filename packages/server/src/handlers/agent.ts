import { Agents } from "@vibest/core/agent/registry"
import { Session } from "@vibest/core/session"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
import { CALLER_HEADER } from "@vibest/protocol/protocol"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"

import { reader } from "../gates.ts"
import { Remote } from "../machine/remote.ts"
import * as CallerChecks from "./caller.ts"

export const AgentHandler = HttpApiBuilder.group(VibestApi, "server.agent", (handlers) =>
  Effect.gen(function* () {
    const { cliOnly } = yield* CallerChecks.Service
    const agents = yield* Agents.Service
    const sessions = yield* Session.Service
    const remote = yield* Remote.Service

    return handlers
      .handle("agent.list", ({ query: { machine } }) =>
        Effect.gen(function* () {
          if (machine !== undefined) {
            const request = yield* HttpServerRequest.HttpServerRequest

            if (reader(request.headers)(CALLER_HEADER) === "remote")
              return yield* new Forbidden({
                method: "agent.list",
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
      )
      .handle("agent.outdated", () => cliOnly("agent.outdated").pipe(Effect.andThen(sessions.outdated)))
      .handle("agent.restart", ({ payload: { ids, after } }) =>
        cliOnly("agent.restart").pipe(Effect.andThen(sessions.restartLater(ids, after))),
      )
  }),
)
