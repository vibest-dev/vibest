import { type Claim, type VibestClient, withVibest } from "@vibest/client/client"
import { Forbidden } from "@vibest/protocol/rpc"
import { Config, Console, Effect, Option, Path, Schema } from "effect"

export const callerEnvOf = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))

const runsInSession = (sessionId: string, repositoryRoot: string) =>
  withVibest(
    { _tag: "cli", repositoryRoot },
    (client, ping) =>
      ping.capabilities?.sessionHere === true
        ? client["Session.Here"]({ id: sessionId, callerEnv: callerEnvOf() })
        : Effect.succeed(true),
    { start: false },
  ).pipe(Effect.orElseSucceed(() => true))

export const caller = Effect.gen(function* () {
  const path = yield* Path.Path
  const repositoryRoot = path.resolve(".")
  const sessionId = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_SESSION_ID"))) || undefined
  const agentName = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_AGENT")))
  const coordinatorCwd = agentName === "coordinator" ? { repositoryRoot } : {}
  const agent = sessionId !== undefined && (yield* runsInSession(sessionId, repositoryRoot))
  const claim: Claim = agent ? { _tag: "session", sessionId, ...coordinatorCwd } : { _tag: "cli", repositoryRoot }
  return { claim, agent }
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
