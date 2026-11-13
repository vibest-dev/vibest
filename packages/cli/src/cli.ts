import { commands } from "@vibest/builtins"
import { type Layout } from "@vibest/schema/layout"
import { Cause, Console, Effect, Exit, Option, type Runtime } from "effect"
import { CliError, type Command } from "effect/cli"

import { userOnly } from "./caller.ts"
import { clients } from "./client.ts"
import { Commands } from "./commands/commands.ts"
import * as FrameworkRuntime from "./framework/runtime.ts"
import { type Host } from "./host.ts"

const handlers = FrameworkRuntime.handlers(Commands, {
  $: () => import("./commands/handlers/default.ts"),
  daemon: {
    $: () => import("./commands/handlers/daemon/default.ts"),
    restart: () => import("./commands/handlers/daemon/restart.ts"),
    "import-check": () => import("./commands/handlers/daemon/import-check.ts"),
  },
  run: () => import("./commands/handlers/run.ts"),
  send: () => import("./commands/handlers/send.ts"),
  status: () => import("./commands/handlers/status.ts"),
  result: () => import("./commands/handlers/result.ts"),
  interrupt: () => import("./commands/handlers/interrupt.ts"),
  peek: () => import("./commands/handlers/peek.ts"),
  archive: () => import("./commands/handlers/archive.ts"),
  ls: () => import("./commands/handlers/ls.ts"),
  events: () => import("./commands/handlers/events.ts"),
  models: () => import("./commands/handlers/models.ts"),
  harness: {
    list: () => import("./commands/handlers/harness/list.ts"),
    models: () => import("./commands/handlers/harness/models.ts"),
  },
  project: {
    create: () => import("./commands/handlers/project/create.ts"),
    add: () => import("./commands/handlers/project/add.ts"),
    info: () => import("./commands/handlers/project/info.ts"),
    search: () => import("./commands/handlers/project/search.ts"),
  },
  plugins: () => import("./commands/handlers/plugins.ts"),
  subscriptions: () => import("./commands/handlers/subscriptions.ts"),
  integration: {
    guard: () => import("./commands/handlers/integration/guard.ts"),
    prompt: () => import("./commands/handlers/integration/prompt.ts"),
    stop: () => import("./commands/handlers/integration/stop.ts"),
    ready: () => import("./commands/handlers/integration/ready.ts"),
  },
  doctor: () => import("./commands/handlers/doctor.ts"),
  update: () => import("./commands/handlers/update.ts"),
  connect: () => import("./commands/handlers/connect.ts"),
  machine: {
    add: () => import("./commands/handlers/machine/add.ts"),
    ls: () => import("./commands/handlers/machine/ls.ts"),
    rm: () => import("./commands/handlers/machine/rm.ts"),
  },
})

export const command = FrameworkRuntime.command<Command.Environment | Host | Layout>(
  Commands,
  handlers,
  commands(userOnly, clients),
)

export const printFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      const error = Cause.findErrorOption(cause)
      if (Option.isNone(error)) return Console.error(Cause.pretty(cause))
      const e: unknown = error.value
      if (CliError.isCliError(e)) return Effect.void
      if (typeof e !== "object" || e === null || !("_tag" in e)) return Console.error(String(e))
      const { _tag, message } = e as { readonly _tag: string; readonly message?: string }
      return Console.error(message ? `${_tag}: ${message}` : _tag)
    }),
  )

export const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit)) return onExit(0)
  if (Cause.hasInterruptsOnly(exit.cause)) return onExit(130)
  const error = Cause.findErrorOption(exit.cause)
  onExit(Option.isSome(error) && CliError.isCliError(error.value) ? 2 : 1)
}
