import { type VibestClient } from "@vibest/client/client"
import { VibestCommand } from "@vibest/schema/layout"
import { describeSpawn, LaunchFailed } from "@vibest/schema/session"
import { Console, Effect, FileSystem, Option, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { askYesNo, interactive } from "../../ask.ts"
import { callerEnvOf, caller, userOnly } from "../../caller.ts"
import { withVibest } from "../../client.ts"
import { Runtime } from "../../framework/runtime.ts"
import { Host } from "../../host.ts"
import { updateNotice } from "../../update.ts"
import { Commands } from "../commands.ts"

const ENTRY_AGENT = "coordinator"

export const soleEntry = <A, E, R>(
  client: Pick<VibestClient, "Project.StopEntry">,
  running: Effect.Success<ReturnType<VibestClient["Project.RunningEntry"]>>,
  start: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (running) {
      const where = `the entry session (${running.harness}) runs in ${running.place}`
      const question = `The entry session (${running.harness}) runs in ${running.place}. Move it here and continue? [y/N]: `

      if (!((yield* interactive) && (yield* askYesNo(question))))
        return yield* new LaunchFailed({
          message: `not starting: ${where}, and a project has one entry session. Exit it there first, or run vibest here on an interactive terminal and answer y to move it here`,
        })
      const stopped = yield* client["Project.StopEntry"]({ runtime: running.runtime, address: running.address })

      if (stopped.result === "moved")
        return yield* new LaunchFailed({ message: "not starting: the entry session moved meanwhile; run vibest again" })

      if (stopped.result === "unsupported")
        return yield* new LaunchFailed({
          message: `not starting: ${where} and cannot be moved from here: ${stopped.reason}. Exit it there first`,
        })

      if (stopped.result === "running")
        return yield* new LaunchFailed({
          message: `not starting: ${where} and did not exit; nothing changed. Exit it there first`,
        })
    }

    return yield* start
  })

export default Runtime.handler(Commands, (o) =>
  Effect.gen(function* () {
    const { exec } = yield* Host
    yield* userOnly("")
    yield* updateNotice
    const harness = Option.getOrUndefined(o.harness)
    const provider = Option.getOrUndefined(o.provider)
    const model = Option.getOrUndefined(o.model)
    const runtimeKind = Option.getOrUndefined(o.runtime)

    const again = [
      ...(yield* VibestCommand),
      ...(harness ? ["--harness", harness] : []),
      ...(provider ? ["--provider", provider] : []),
      ...(model ? ["--model", model] : []),
      ...(runtimeKind ? ["--runtime", runtimeKind] : []),
      ...(o.fresh ? ["--new"] : []),
    ]

    const claim = (yield* caller).claim
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const here = yield* fs.realPath(path.resolve("."))

    const foreignSession = Option.match(o.session, {
      onNone: () => undefined,
      onSome: (name) =>
        new LaunchFailed({
          message: `--session ${name} names a herdr session; inside herdr this pane's own session is used. Run vibest outside herdr, or drop --session`,
        }),
    })

    const entered = yield* withVibest(claim, (client) =>
      Effect.gen(function* () {
        const [, placed] = yield* Effect.all(
          [
            client["Project.Open"]({}),
            client["Project.EntryPlace"]({
              callerEnv: callerEnvOf(),
              ...(runtimeKind !== undefined && { runtime: runtimeKind }),
            }),
          ],
          { concurrency: "unbounded" },
        )

        if (placed.place.in === "launch") {
          const opened = yield* client.Launch({
            argv: again,
            agent: ENTRY_AGENT,
            focus: !o.headless,
            runtime: placed.place.runtime,
            callerEnv: callerEnvOf(),
            ...(Option.isSome(o.session) && { runtimeSession: o.session.value }),
          })

          return { launched: opened } as const
        }

        if (foreignSession !== undefined) return yield* foreignSession

        if (here !== placed.directory) yield* Effect.sync(() => process.chdir(placed.directory))
        const terminal = placed.place.terminal

        const [chosen, running] = yield* Effect.all(
          [
            client["Project.StartEntry"]({
              harness,
              agent: ENTRY_AGENT,
              provider,
              model,
              runtime: placed.place.runtime,
            }),
            client["Project.RunningEntry"]({ terminal }),
          ],
          { concurrency: "unbounded" },
        )

        if (Object.keys(chosen.decidedBy).length > 0) yield* Console.error(`entry session: ${describeSpawn(chosen)}`)

        const started = yield* soleEntry(
          client,
          running,
          client["Project.EntrySession"]({
            harness: chosen.harness,
            agent: ENTRY_AGENT,
            fresh: o.fresh,
            terminal,
            runtime: chosen.runtime,
            provider: chosen.provider,
            model: chosen.model,
            routing: { decidedBy: chosen.decidedBy, trace: chosen.trace },
            pid: process.pid,
          }),
        )

        return { started } as const
      }),
    )

    if ("started" in entered) {
      const { command } = entered.started

      return yield* Effect.sync(() => exec(command.file, command.args, command.env))
    }

    const opened = entered.launched

    if (opened.routing !== undefined) yield* Console.error(`entry session: ${opened.routing}`)
    yield* Console.log(`the entry session is starting in ${opened.place}`)

    if (o.headless || !opened.attach) return
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [file, ...args] = opened.attach
    yield* spawner.exitCode(ChildProcess.make(file!, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }))
  }),
)
