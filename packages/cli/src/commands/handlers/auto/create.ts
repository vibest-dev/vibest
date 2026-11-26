import { Automation } from "@vibest/schema/automation"
import { Json } from "@vibest/schema/json"
import { Effect, FileSystem, Option, Path, type Schema } from "effect"

import { caller, json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

const parseJsonFlag = (raw: string, flagName: string): Effect.Effect<Schema.Json, Automation.InvalidError> => {
  const decoded = Json.parseJsonOption(raw)

  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new Automation.InvalidError({ message: `Invalid ${flagName} JSON value` }))
}

export default Runtime.handler(Commands.commands.auto.commands.create, (o) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const directory = path.resolve(".")
    const tz = Option.getOrUndefined(o.tz)
    const at = Option.getOrUndefined(o.at)
    const every = Option.getOrUndefined(o.every)
    const cron = Option.getOrUndefined(o.cron)
    const eventServer = Option.getOrUndefined(o.eventServer)
    const eventName = Option.getOrUndefined(o.event)
    const webhookSecret = Option.getOrUndefined(o.webhookSecret)
    const expires = Option.getOrUndefined(o.expires)

    const triggerKinds = [
      at !== undefined,
      every !== undefined,
      cron !== undefined,
      o.webhook || webhookSecret !== undefined,
      eventServer !== undefined || eventName !== undefined,
    ].filter(Boolean).length

    if (triggerKinds !== 1) {
      return yield* new Automation.InvalidError({
        message: "Specify exactly one trigger: --at, --every, --cron, --webhook, or --event-server + --event",
      })
    }

    let trigger: Automation.Trigger

    if (at !== undefined) {
      trigger = { type: "at", at, ...(tz !== undefined && { tz }) }
    } else if (every !== undefined) {
      trigger = { type: "every", every, ...(tz !== undefined && { tz }) }
    } else if (cron !== undefined) {
      trigger = { type: "cron", cron, ...(tz !== undefined && { tz }) }
    } else if (o.webhook || webhookSecret !== undefined) {
      trigger = { type: "webhook" }
    } else {
      if (eventServer === undefined || eventName === undefined) {
        return yield* new Automation.InvalidError({
          message: "Event trigger requires both --event-server and --event",
        })
      }

      const rawEventArgs = Option.getOrUndefined(o.eventArgs)
      let eventArgs: Schema.JsonObject | undefined

      if (rawEventArgs !== undefined) {
        const parsed = yield* parseJsonFlag(rawEventArgs, "--event-args")

        if (!Json.isJsonObject(parsed)) {
          return yield* new Automation.InvalidError({ message: "--event-args must be a JSON object" })
        }

        eventArgs = parsed
      }

      trigger = {
        type: "event",
        server: eventServer,
        event: eventName,
        ...(eventArgs !== undefined && { args: eventArgs }),
      }
    }

    const targetSession = Option.getOrUndefined(o.session)
    const targetAgent = Option.getOrUndefined(o.agent)

    if (targetSession !== undefined && targetAgent !== undefined) {
      return yield* new Automation.InvalidError({ message: "Specify at most one of --session or --agent" })
    }

    const to: Automation.Target | undefined =
      targetSession !== undefined
        ? { sessionId: targetSession }
        : targetAgent !== undefined
          ? { agent: targetAgent }
          : undefined

    const promptText = Option.getOrUndefined(o.prompt)
    const inlineCode = Option.getOrUndefined(o.code)
    const codeFile = Option.getOrUndefined(o.codeFile)

    const codeText =
      codeFile !== undefined
        ? yield* fs
            .readFileString(path.resolve(codeFile))
            .pipe(
              Effect.mapError(
                (error) => new Automation.InvalidError({ message: `Failed to read ${codeFile}: ${error.message}` }),
              ),
            )
        : inlineCode

    if ((promptText !== undefined && codeText !== undefined) || (promptText === undefined && codeText === undefined)) {
      return yield* new Automation.InvalidError({
        message: "Specify exactly one action: --prompt or --code / --code-file",
      })
    }

    let action: Automation.Action

    if (promptText !== undefined) {
      action = { type: "prompt", prompt: promptText, ...(to !== undefined && { to }) }
    } else {
      const rawArgs = Option.getOrUndefined(o.args)
      const parsedArgs = rawArgs !== undefined ? yield* parseJsonFlag(rawArgs, "--args") : undefined

      action = {
        type: "code",
        code: codeText!,
        ...(parsedArgs !== undefined && { args: parsedArgs }),
        ...(to !== undefined && { to }),
      }
    }

    const c = yield* caller

    yield* vibest((client) =>
      client["server.automation"]
        ["automation.create"]({
          payload: {
            name: o.name,
            trigger,
            action,
            directory,
            ...(c.sessionId !== undefined && { sessionId: c.sessionId }),
            ...(expires !== undefined && { expires }),
            ...(webhookSecret !== undefined && { webhookSecret }),
          },
        })
        .pipe(Effect.flatMap(json)),
    )
  }),
)
