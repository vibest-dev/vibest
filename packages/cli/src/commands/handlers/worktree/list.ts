import { ID } from "@vibest/schema/id"
import { Effect, Option, Path } from "effect"

import { caller, json } from "../../../caller.ts"
import { withVibest } from "../../../client.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.worktree.commands.list, (o) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const c = yield* caller
    const machine = Option.getOrUndefined(o.machine)
    const raw = Option.getOrUndefined(o.project)

    const project =
      raw === undefined || machine !== undefined || ID.test(raw) || path.isAbsolute(raw) ? raw : path.resolve(raw)

    const listed = yield* withVibest(
      c.claim,
      (client) =>
        client["Worktree.List"]({
          ...(project !== undefined && { project }),
          ...(machine !== undefined && { machine }),
        }),
      { start: !c.agent, needs: { capability: "worktrees", method: "Worktree.List" } },
    )

    yield* json(listed)
  }),
)
