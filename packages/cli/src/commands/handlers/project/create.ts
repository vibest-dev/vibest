import { Console, Effect } from "effect"

import { json, userOnly, vibest } from "../../../caller.ts"
import * as Runtime from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.project.commands.create, (o) =>
  Effect.gen(function* () {
    yield* userOnly("project create")
    const created = yield* vibest((client) => client["Project.Create"]({ directory: o.directory, from: [...o.from] }))
    for (const folder of created.folders) {
      if (folder.uncommitted.length === 0) continue
      yield* Console.error(
        `warning: ${folder.source}: uncommitted changes were not copied:\n${folder.uncommitted.map((line) => `  ${line}`).join("\n")}`,
      )
    }
    yield* json(created)
  }),
)
