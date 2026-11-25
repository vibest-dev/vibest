import { type VibestClient } from "@vibest/client/client"
import { LaunchFailed, NO_RUNTIME_DETECTED } from "@vibest/schema/session"
import { Console, Data, Effect, FileSystem, Option, Path } from "effect"

import { askChoice, interactive } from "../../ask.ts"
import { callerEnvOf, caller, userOnly } from "../../caller.ts"
import { withVibest } from "../../client.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Host } from "../../host.ts"
import { attachCommand, chooseHarness, chooseRuntime, savedSetting } from "../../onboard.ts"
import { noticeFrom } from "../../update.ts"
import { Commands } from "../commands.ts"

const DEFAULT_AGENT = "coordinator"

export type RunningRoot = Effect.Success<ReturnType<VibestClient["Session.Attach"]>>["running"]

export type RunningAction = { readonly _tag: "Move"; readonly sessionId: string } | { readonly _tag: "New" }

export const RunningActions = Data.taggedEnum<RunningAction>()

export const resolveRunning = (running: RunningRoot) =>
  Effect.gen(function* () {
    if (running === null) return undefined

    const where = `session ${running.sessionId} (${running.harness}) runs in ${running.place}`

    if (!(yield* interactive))
      return yield* new LaunchFailed({
        message: `not starting: ${where}. Exit it there first, pass --new to start a parallel conversation, or run vibest on an interactive terminal to move it here`,
      })

    const choice = yield* askChoice(`Session ${running.sessionId} (${running.harness}) runs in ${running.place}.`, [
      "Move it to this terminal",
      "Start a new parallel conversation",
      "Cancel",
    ])

    if (Option.isNone(choice) || choice.value === 2)
      return yield* new LaunchFailed({ message: `not starting: ${where}` })

    if (choice.value === 0) return RunningActions.Move({ sessionId: running.sessionId })

    return RunningActions.New()
  })

export default Runtime.handler(Commands, (o) =>
  Effect.gen(function* () {
    const { exec } = yield* Host
    yield* userOnly("")
    const harness = Option.getOrUndefined(o.harness)
    const provider = Option.getOrUndefined(o.provider)
    const model = Option.getOrUndefined(o.model)
    const runtimeKind = Option.getOrUndefined(o.runtime)
    const agent = Option.getOrElse(o.agent, () => DEFAULT_AGENT)
    const agentNamed = Option.isSome(o.agent)

    const claim = (yield* caller).claim
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const here = yield* fs.realPath(path.resolve("."))

    const entered = yield* withVibest(claim, (client, ping) =>
      Effect.gen(function* () {
        yield* noticeFrom(Effect.succeed(Option.some(ping)))

        if (agentNamed && ping.capabilities?.agents !== true)
          return yield* new LaunchFailed({ message: "this vibestd does not take --agent; run vibest update" })

        const attach = (runtime: string | undefined) =>
          client["Session.Attach"]({
            callerEnv: callerEnvOf(),
            fresh: o.fresh,
            ...(agentNamed && { agent, agentNamed: true }),
            ...(runtime !== undefined && { runtime }),
          })

        const inPlainTerminal = (refused: LaunchFailed) =>
          Effect.gen(function* () {
            const chosen = yield* chooseRuntime(client, { reuse: true, saveWithoutAsking: false })

            if (chosen === undefined)
              return yield* new LaunchFailed({ message: `${refused.message}; or run vibest onboard` })

            return { ...(yield* attach(chosen)), onboarded: true }
          })

        const placed = yield* attach(runtimeKind).pipe(
          Effect.map((found) => ({ ...found, onboarded: false })),
          Effect.catchTag("LaunchFailed", (refused) =>
            runtimeKind === undefined && refused.message.startsWith(NO_RUNTIME_DETECTED)
              ? inPlainTerminal(refused)
              : Effect.fail(refused),
          ),
        )

        const chosenHarness = yield* Effect.gen(function* () {
          if (harness !== undefined || agentNamed || !placed.onboarded) return harness

          if ((yield* savedSetting("defaultHarness")) !== undefined) return undefined

          if (!o.fresh && placed.hasRoot) return undefined

          return yield* chooseHarness(client, { saveWithoutAsking: false })
        })

        const action = o.fresh ? undefined : yield* resolveRunning(placed.running)
        const fresh = o.fresh || action?._tag === "New"
        const move = action?._tag === "Move"

        if (placed.place.in === "launch") {
          const opened = yield* client.Launch({
            projectId: placed.projectId,
            ...(action?._tag === "Move" && { sessionId: action.sessionId }),
            fresh,
            ...(move && { move: true }),
            ...(chosenHarness !== undefined && { harness: chosenHarness }),
            ...(provider !== undefined && { provider }),
            ...(model !== undefined && { model }),
            agent,
            agentNamed,
            focus: !o.headless,
            runtime: placed.place.runtime,
            callerEnv: callerEnvOf(),
            ...(Option.isSome(o.session) && { runtimeSession: o.session.value }),
          })

          return { launched: opened } as const
        }

        if (Option.isSome(o.session))
          return yield* new LaunchFailed({
            message: `--session ${o.session.value} names a runtime's session; inside this ${placed.place.runtime} terminal its own session is used. Run vibest outside it, or drop --session`,
          })

        if (here !== placed.directory) yield* Effect.sync(() => process.chdir(placed.directory))
        const terminal = placed.place.terminal

        const started = yield* client["Session.Claim"]({
          ...(action?._tag === "Move" && { sessionId: action.sessionId }),
          ...(chosenHarness !== undefined && { harness: chosenHarness }),
          agent,
          agentNamed,
          fresh,
          ...(move && { move: true }),
          terminal,
          runtime: placed.place.runtime,
          ...(provider !== undefined && { provider }),
          ...(model !== undefined && { model }),
          pid: process.pid,
        })

        if (started.routing !== undefined) yield* Console.error(`session: ${started.routing}`)

        return { started } as const
      }),
    )

    if ("started" in entered) {
      const { command } = entered.started

      return yield* Effect.sync(() => exec(command.file, command.args, command.env))
    }

    const opened = entered.launched

    if (opened.routing !== undefined) yield* Console.error(`session: ${opened.routing}`)
    yield* Console.log(`session ${opened.sessionId} is starting in ${opened.place}`)

    if (o.headless || !opened.attach) return
    const [file, ...args] = yield* attachCommand(opened.attach)

    return yield* Effect.sync(() => exec(file!, args, {}))
  }),
)
