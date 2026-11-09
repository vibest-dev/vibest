import type { Claim } from "@vibest/client/client"
import { Forbidden } from "@vibest/protocol/rpc"
import { Config, Effect, Option, Path } from "effect"

export const caller = Effect.gen(function* () {
  const path = yield* Path.Path
  const repositoryRoot = path.resolve(".")
  const sessionId = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_SESSION_ID"))) || undefined
  const agentName = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_AGENT")))
  const coordinatorCwd = agentName === "coordinator" ? { repositoryRoot } : {}
  const claim: Claim = sessionId ? { _tag: "session", sessionId, ...coordinatorCwd } : { _tag: "cli", repositoryRoot }
  return { claim, agent: sessionId !== undefined }
})

export const userOnly = (command: string) =>
  Effect.flatMap(caller, (c) =>
    c.agent
      ? Effect.fail(
          new Forbidden({
            method: command || "vibest",
            message: `an agent may not run vibest${command ? ` ${command}` : ""}; ask the user to`,
          }),
        )
      : Effect.void,
  )
