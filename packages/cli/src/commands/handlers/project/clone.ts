import { ProjectCloneFailed } from "@vibest/schema/project"
import { Console, Effect, Option, Path, Stream } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.project.commands.clone, (o) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const machine = Option.getOrUndefined(o.machine)
    const dir = Option.getOrUndefined(o.dir)
    const directory = dir === undefined || machine !== undefined ? dir : path.resolve(dir)

    const added = yield* vibest((client, _agent, ping) =>
      ping.capabilities?.projectClone !== true
        ? Effect.fail(new ProjectCloneFailed({ message: "this vibestd does not clone projects; run vibest update" }))
        : client["server.project"]
            ["project.clone"]({
              payload: {
                url: o.url,
                ...(directory !== undefined && { directory }),
                ...(machine !== undefined && { machine }),
              },
            })
            .pipe(
              Effect.flatMap((stream) =>
                stream.pipe(
                  Stream.tap((step) => ("progress" in step ? Console.error(step.progress) : Effect.void)),
                  Stream.runLast,
                ),
              ),
            ),
    )

    const last = Option.getOrUndefined(added)

    if (last === undefined || "progress" in last)
      return yield* new ProjectCloneFailed({ message: "the clone ended without a project" })
    yield* json({ ...last, ...(machine !== undefined && { machine }) })
  }),
)
