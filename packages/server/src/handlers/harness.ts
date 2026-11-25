import { Harness, harnessCatalog } from "@vibest/core/harness"
import { Harnesses } from "@vibest/core/harnesses"
import { forProvider } from "@vibest/core/models"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
import { CALLER_HEADER } from "@vibest/protocol/protocol"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"

import { reader } from "../gates.ts"
import { Remote } from "../machine/remote.ts"

export const HarnessHandler = HttpApiBuilder.group(VibestApi, "server.harness", (handlers) =>
  Effect.gen(function* () {
    const harnesses = yield* Harnesses.Service
    const harness = yield* Harness.Service
    const remote = yield* Remote.Service

    return handlers.handle("harness.list", ({ query: { provider, machine } }) =>
      Effect.gen(function* () {
        if (machine !== undefined) {
          const request = yield* HttpServerRequest.HttpServerRequest

          if (reader(request.headers)(CALLER_HEADER) === "remote")
            return yield* new Forbidden({
              method: "harness.list",
              message: "a remote asks for this machine's harnesses only",
            })

          return yield* remote.harnesses(machine, provider)
        }

        const choices = yield* harnessCatalog.pipe(
          Effect.provideService(Harnesses.Service, harnesses),
          Effect.provideService(Harness.Service, harness),
        )

        return provider === undefined ? choices : forProvider(choices, harnesses, provider)
      }),
    )
  }),
)
