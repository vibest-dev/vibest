import { Console, Effect, Option } from "effect"

import { vibest } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.peek, (o) =>
  vibest((client) => client.Peek({ id: o.id, lines: Option.getOrUndefined(o.lines) })).pipe(
    Effect.flatMap((r) =>
      Effect.gen(function* () {
        if (r.terminal !== undefined) yield* Console.error(`terminal here: ${r.terminal.split("@")[0]}`)
        if (r.view !== undefined) yield* Console.error(`not shown here: ${r.view}`)
        yield* Console.log(r.text)
      }),
    ),
  ),
)
