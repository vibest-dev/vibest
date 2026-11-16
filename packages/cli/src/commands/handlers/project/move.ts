import { Console, Effect, Path } from "effect"

import { json, userOnly, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.project.commands.move, (o) =>
  Effect.gen(function* () {
    yield* userOnly("project move")
    const from = (yield* Path.Path).resolve(o.from)
    const moved = yield* vibest((client) => client["Project.Move"]({ from }))
    for (const command of moved.manual)
      yield* Console.error(`a worktree of yours still names the old place; to repair it, run: ${command}`)
    yield* json(moved)
  }),
)
