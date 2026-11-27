import { Agents } from "@vibest/core/agent/registry"
import { Mcp } from "@vibest/core/mcp"
import { Session } from "@vibest/core/session"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
import { CALLER_HEADER, CWD_HEADER, REPOSITORY_HEADER } from "@vibest/protocol/protocol"
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
    const mcp = yield* Mcp.Service
    const sessions = yield* Session.Service
    const remote = yield* Remote.Service

    return handlers
      .handle("agent.list", ({ query: { machine } }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const header = reader(request.headers)

          if (machine !== undefined) {
            if (header(CALLER_HEADER) === "remote")
              return yield* new Forbidden({
                method: "agent.list",
                message: "a remote asks for this machine's agents only",
              })

            return yield* remote.agents(machine)
          }

          const directory = header(REPOSITORY_HEADER) ?? header(CWD_HEADER)
          const configured = yield* mcp.list(directory)
          const configuredByName = new Map(configured.map((server) => [String(server.name), server]))

          return {
            agents: agents.all.map(
              ({ id, description, plugin, harness, provider, model, mcpServers, warnings, system }) => {
                const combinedWarnings = [...(warnings ?? [])]

                if (mcpServers !== undefined) {
                  for (const name of mcpServers) {
                    const info = configuredByName.get(name)

                    if (info === undefined) {
                      combinedWarnings.push(`mcpServers entry "${name}" is not configured in vibest mcp`)
                    } else if (info.disabled === true) {
                      combinedWarnings.push(`mcpServers entry "${name}" is disabled in vibest mcp`)
                    }
                  }
                }

                return {
                  id,
                  description,
                  plugin,
                  ...(harness !== undefined && { harness }),
                  ...(provider !== undefined && { provider }),
                  ...(model !== undefined && { model }),
                  ...(mcpServers !== undefined && { mcpServers }),
                  ...(combinedWarnings.length > 0 && { warnings: combinedWarnings }),
                  system,
                }
              },
            ),
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
