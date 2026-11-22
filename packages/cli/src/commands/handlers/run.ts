import { LaunchFailed, NoCallingSession } from "@vibest/schema/session"
import { Effect, Option } from "effect"

import { caller, callerEnvOf, json } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { EmptyInput, input, readAttachments } from "../../input.ts"
import { requested } from "../../requested.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.run, (o) =>
  Effect.gen(function* () {
    if (!(yield* caller).agent) return yield* new NoCallingSession()

    if (o.team.length > 1) return yield* new EmptyInput({ message: "give --team only once" })
    const [harness, raw] = o.words.length === 2 ? o.words : [undefined, o.words[0]!]
    const prompt = yield* input(raw, "prompt")
    const files = yield* readAttachments(o.file)
    const team = o.team[0]

    const spawned = yield* requested((client, request, ping) =>
      Effect.gen(function* () {
        if (Option.isSome(o.runtime) && ping.capabilities?.spawnRuntime !== true)
          return yield* new LaunchFailed({
            message: "this vibestd does not take --runtime on vibest run; run vibest update",
          })

        if (Option.isSome(o.project) && ping.capabilities?.peerSpawnProject !== true)
          return yield* new LaunchFailed({
            message: "this vibestd does not take --project on vibest run; run vibest update",
          })

        if (files.length > 0 && ping.capabilities?.spawnFiles !== true)
          return yield* new LaunchFailed({
            message: "this vibestd does not take --file on vibest run; run vibest update",
          })

        if (team !== undefined && ping.capabilities?.teams !== true)
          return yield* new LaunchFailed({
            message: "this vibestd does not take --team on vibest run; run vibest update",
          })

        if (
          harness === undefined &&
          /^\S+$/.test(prompt) &&
          (yield* client["Harnesses.List"]({})).some((choice) => choice.harness === prompt)
        )
          return yield* new EmptyInput({
            message: `the prompt is missing: ${prompt} is a harness; give the prompt after it`,
          })

        return yield* client.Spawn({
          ...(request !== undefined && { request }),
          harness,
          agent: o.agent,
          prompt,
          name: Option.getOrUndefined(o.title),
          provider: Option.getOrUndefined(o.provider),
          model: Option.getOrUndefined(o.model),
          env: Option.getOrUndefined(o.env),
          share: Option.getOrUndefined(o.share),
          runtime: Option.getOrUndefined(o.runtime),
          machine: Option.getOrUndefined(o.machine),
          project: Option.getOrUndefined(o.project),
          callerEnv: callerEnvOf(),
          ...(Option.isSome(o.session) && { runtimeSession: o.session.value }),
          ...(files.length !== 0 && { files }),
          ...(team === "" && { newTeam: true }),
          ...(team !== undefined && team !== "" && { team }),
        })
      }),
    )

    yield* json({ id: spawned.id, ...(spawned.team !== undefined && { team: spawned.team }) })
  }),
)
