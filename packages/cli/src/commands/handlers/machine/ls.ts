import type { MachineInfo } from "@vibest/schema/machine"
import { Effect } from "effect"

import { json, userOnly, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

const NO_LOAD_HERE = "this vibestd cannot read machine load; run vibest daemon restart"

export default Runtime.handler(Commands.commands.machine.commands.ls, () =>
  userOnly("machine ls").pipe(
    Effect.andThen(
      vibest((client) =>
        Effect.gen(function* () {
          const reads = (yield* client.Ping(undefined)).capabilities?.load === true
          const machines = yield* client["Machine.List"]()

          const withLoad = (machine: MachineInfo) =>
            reads
              ? client["Machine.Load"]({ machine: machine.name }).pipe(
                  Effect.match({
                    onSuccess: (load) => ({ ...machine, load }),
                    onFailure: (e) => ({ ...machine, loadError: e.message }),
                  }),
                )
              : Effect.succeed({ ...machine, loadError: NO_LOAD_HERE })

          return yield* Effect.forEach(machines, withLoad, { concurrency: "unbounded" })
        }),
      ),
    ),
    Effect.flatMap(json),
  ),
)
