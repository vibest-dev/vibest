import { type Claim, type VibestClient, withVibest } from "@vibest/client/client"
import { Forbidden } from "@vibest/protocol/rpc"
import { Config, Console, Effect, Option, Path, Schema } from "effect"

export const caller = Effect.gen(function* () {
  const path = yield* Path.Path
  const repositoryRoot = path.resolve(".")
  const sessionId = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_SESSION_ID"))) || undefined
  const agentName = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_AGENT")))
  const entryCwd = agentName === "coordinator" ? { repositoryRoot } : {}
  const claim: Claim = sessionId ? { _tag: "session", sessionId, ...entryCwd } : { _tag: "cli", repositoryRoot }
  return { claim, agent: sessionId !== undefined, sessionId }
})

const userOnlyRefusal = (command: string, sessionId: string | undefined) => {
  const run = `vibest${command ? ` ${command}` : ""}`
  return [
    `an agent may not run ${run}; ask the user to.`,
    `This shell carries agent session ${sessionId}.`,
    `If you are the user, run it as env -u VIBEST_SESSION_ID -u VIBEST_AGENT ${run}, or open a terminal that was not started from an agent.`,
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
