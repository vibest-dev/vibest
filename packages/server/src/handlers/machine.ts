import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
import { Caller } from "@vibest/protocol/middleware"
import { Effect, Predicate } from "effect"
import { HttpApiBuilder } from "effect/http-api"

import { Load } from "../machine/load.ts"
import { Machines } from "../machine/machines.ts"
import * as CallerChecks from "./caller.ts"

export const MachineHandler = HttpApiBuilder.group(VibestApi, "server.machine", (handlers) =>
  Effect.gen(function* () {
    const { cliOnly, userOnly } = yield* CallerChecks.Service
    const machines = yield* Machines.Service
    const load = yield* Load.Service

    return handlers
      .handle("machine.list", () => userOnly("machine.list").pipe(Effect.andThen(machines.listing)))
      .handle("machine.add", ({ payload: { name, target } }) =>
        cliOnly("machine.add").pipe(Effect.andThen(machines.add(name, target))),
      )
      .handle("machine.load", ({ query: { machine } }) =>
        Effect.gen(function* () {
          const caller = yield* Caller

          if (Predicate.isTagged(caller, "Remote")) {
            if (machine !== undefined)
              return yield* new Forbidden({ method: "machine.load", message: "a remote reads its own machine" })

            return yield* load.read()
          }

          if (!Predicate.isTagged(caller, "Cli"))
            return yield* new Forbidden({
              method: "machine.load",
              message: "only the user or another machine reads the load",
            })

          if (machine === undefined) return yield* load.read()

          return yield* machines.reading(machine)
        }),
      )
      .handle("machine.remove", ({ params: { name } }) =>
        cliOnly("machine.remove").pipe(Effect.andThen(machines.remove(name))),
      )
  }),
)
