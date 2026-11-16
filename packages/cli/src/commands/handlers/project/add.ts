import { Effect, Path } from "effect"

import { json, userOnly } from "../../../caller.ts"
import { withVibest } from "../../../client.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { openProject } from "../../../open-project.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.project.commands.add, (o) =>
  Effect.gen(function* () {
    yield* userOnly("project add")
    const repositoryRoot = (yield* Path.Path).resolve(o.directory)
    const opened = yield* withVibest({ _tag: "cli", repositoryRoot }, openProject, { start: true })
    yield* json(opened)
  }),
)
