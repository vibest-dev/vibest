import { type Claim, type VibestClient } from "@vibest/client/client"
import { Forbidden } from "@vibest/protocol/rpc"
import { Config, Console, Effect, Option, Path, Schema } from "effect"

import { withVibest } from "./client.ts"

export const caller = Effect.gen(function* () {
  const path = yield* Path.Path
  const repositoryRoot = path.resolve(".")
  const sessionId = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_SESSION_ID"))) || undefined
  const claim: Claim = sessionId ? { _tag: "session", sessionId, repositoryRoot } : { _tag: "cli", repositoryRoot }
  return { claim, agent: sessionId !== undefined, sessionId }
})

const userOnlyRefusal = (command: string, sessionId: string | undefined) => {
  const run = `vibest${command ? ` ${command}` : ""}`
  return [
    `an agent may not run ${run}; ask the user to.`,
    `This shell carries agent session ${sessionId}.`,
    `If you are the user, run it as env -u VIBEST_SESSION_ID ${run}, or open a terminal that was not started from an agent.`,
  ].join(" ")
}

export const userOnly = (command: string) =>
  Effect.flatMap(caller, (c) =>
    c.agent
      ? Effect.fail(new Forbidden({ method: command || "vibest", message: userOnlyRefusal(command, c.sessionId) }))
      : Effect.void,
  )

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
export const json = (value: unknown) => Console.log(encodeJson(value))

export const vibest = <A, E, R>(f: (client: VibestClient, agent: boolean) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(caller, (c) => withVibest(c.claim, (client) => f(client, c.agent), { start: !c.agent }))
