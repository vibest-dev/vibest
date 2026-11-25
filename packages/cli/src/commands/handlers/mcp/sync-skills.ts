import { Effect, Option } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.mcp.commands["sync-skills"], (o) => {
  const projectDir = Option.getOrUndefined(o.project)

  return vibest((client) =>
    client["server.mcp"]
      ["mcp.syncSkills"]({
        payload: projectDir !== undefined ? { projectDir } : {},
      })
      .pipe(Effect.flatMap(json)),
  )
})
