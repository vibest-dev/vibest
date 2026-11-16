import { type VibestClient } from "@vibest/client/client"
import { LaunchFailed } from "@vibest/schema/session"
import { Console, Effect, Option } from "effect"

import { askLine, interactive } from "./ask.ts"

export const openProject = (client: Pick<VibestClient, "Project.Open">) =>
  Effect.gen(function* () {
    const opened = yield* client["Project.Open"]({}).pipe(
      Effect.catchTag("ProjectMoved", (moved) =>
        Effect.gen(function* () {
          const refused = new LaunchFailed({
            message: `not starting: ${moved.message} on an interactive terminal (nothing changed)`,
          })
          if (!(yield* interactive)) return yield* refused
          const line = yield* askLine(`The project moved from ${moved.from} to here, move it? [Y/n]: `)
          const answer = Option.getOrUndefined(line)?.trim().toLowerCase()
          if (answer === undefined || !["", "y", "yes", "n", "no"].includes(answer)) return yield* refused
          return yield* client["Project.Open"]({ move: answer === "" || answer.startsWith("y") })
        }),
      ),
    )
    if (opened.moved !== undefined) {
      yield* Console.error(`moved the project from ${opened.moved.from} to ${opened.directory}`)
      for (const command of opened.moved.manual)
        yield* Console.error(`a worktree of yours still names the old place; to repair it, run: ${command}`)
    }
    if (opened.candidates !== undefined)
      yield* Console.error(
        `a new project here: more than one moved project had these origins (${opened.candidates.join(", ")})`,
      )
    return opened
  })
