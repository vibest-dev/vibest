import { probe, startDaemon } from "@vibest/client/client"
import { Layout } from "@vibest/schema/layout"
import * as Daemon from "@vibest/server/daemon"
import { HANDOFF_ENV } from "@vibest/server/server"
import { Console, Effect } from "effect"

import { userOnly } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Host } from "../../../host.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.daemon, ({ foreground, handoff }) =>
  userOnly("daemon").pipe(
    Effect.andThen(
      Effect.gen(function* () {
        if (foreground) {
          const host = yield* Host
          delete process.env[HANDOFF_ENV]
          return yield* Daemon.run(host.daemon, host.replacements, { handoff })
        }
        const layout = yield* Layout
        if (!(yield* probe(layout.socket))) yield* startDaemon
        yield* Console.log(`vibestd is running on ${layout.socket}`)
      }),
    ),
  ),
)
