import { type Claim, type VibestClient, withVibest } from "@vibest/client/client"
import { Forbidden } from "@vibest/protocol/rpc"
import { Config, Console, Effect, Option, Path, Schema } from "effect"

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

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
export const json = (value: unknown) => Console.log(encodeJson(value))

export const vibest = <A, E, R>(f: (client: VibestClient, agent: boolean) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(caller, (c) => withVibest(c.claim, (client) => f(client, c.agent), { start: !c.agent }))
