import { UpdateError } from "@vibest/client/release"
import { VibestCommand } from "@vibest/schema/layout"
import { Console, Effect } from "effect"

import { userOnly } from "../../../caller.ts"
import * as Runtime from "../../../framework/runtime.ts"
import { replaceDaemon } from "../../../replace.ts"
import { LEFT, restartAgents } from "../../../update.ts"
import { VERSION } from "../../../version.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.daemon.commands.restart, () =>
  userOnly("daemon restart").pipe(
    Effect.andThen(Effect.flatMap(VibestCommand, (command) => replaceDaemon({ version: VERSION, command }))),
    Effect.andThen(restartAgents(VERSION, false, "vibest daemon restart")),
    Effect.flatMap((failed) =>
      failed === undefined ? Effect.void : Effect.fail(new UpdateError({ message: failed })),
    ),
    Effect.catchIf(
      (e) => e._tag === "ReplaceFailed" && e.outcome === "declined",
      () => Console.log(`${LEFT.declined}.`),
    ),
  ),
)
