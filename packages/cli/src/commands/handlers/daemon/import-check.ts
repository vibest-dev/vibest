import * as Daemon from "@vibest/server/daemon"
import { Effect } from "effect"

import { userOnly } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Host } from "../../../host.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.daemon.commands["import-check"], () =>
  userOnly("daemon import-check").pipe(Effect.andThen(Effect.flatMap(Host, (host) => Daemon.checkImport(host.daemon)))),
)
