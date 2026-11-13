import { described, importCheck, readPing, runCaptured } from "@vibest/client/client"
import { installMethod, latestOf, releasesUrl, UpdateError } from "@vibest/client/release"
import { Layout, shellQuote, VibestCommand } from "@vibest/schema/layout"
import { Config, Console, Duration, Effect, FileSystem, Option } from "effect"

import { userOnly } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { compareVersions, replaceAnyway, versionOf } from "../../replace.ts"
import {
  daemonPlan,
  extraVibests,
  handoffDaemon,
  replaceForUpdate,
  restartAgents,
  runInherit,
  stageCommand,
  upgradeCommand,
} from "../../update.ts"
import { VERSION } from "../../version.ts"
import { Commands } from "../commands.ts"

export default Runtime.handler(Commands.commands.update, ({ yes, restartAgentsAfter }) =>
  Effect.gen(function* () {
    yield* userOnly("update")
    if (Option.isSome(restartAgentsAfter))
      return yield* restartAgents(VERSION, yes, "vibest update", restartAgentsAfter.value)
    const self = yield* VibestCommand
    const method = installMethod(self, Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_HARNESSES"))))
    const layout = yield* Layout
    let target: { readonly version: string; readonly command: ReadonlyArray<string> } = {
      version: VERSION,
      command: self,
    }
    let back: string | undefined
    if (method === undefined)
      yield* Console.log(`this vibest (${self.join(" ")}) was not installed by npm or install.sh; nothing to install.`)
    else {
      const releases = yield* releasesUrl
      const latest = yield* latestOf(method)
      if (compareVersions(VERSION, latest) >= 0) yield* Console.log(`vibest is already up to date (v${VERSION}).`)
      else {
        yield* Console.log(`vibest ${latest} is available (this is ${VERSION}).`)
        const fs = yield* FileSystem.FileSystem
        const real = yield* fs.realPath(self[0]!).pipe(Effect.orElseSucceed(() => self[0]!))
        const installSh = (env: Record<string, string>) =>
          [
            ["sh", "-c", 'script=$(curl -fsSL "$0/install.sh") && printf \'%s\\n\' "$script" | sh', releases],
            { VIBEST_DOWNLOAD_URL: releases, ...env },
          ] as const
        const cannot = yield* Effect.scoped(
          Effect.gen(function* () {
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-update-" })
            const [argv, env] =
              method.kind === "npm"
                ? [stageCommand(real, dir, latest), {}]
                : installSh({ VIBEST_INSTALL: `${dir}/share`, VIBEST_BIN: `${dir}/bin` })
            const staged = [method.kind === "npm" ? `${dir}/node_modules/.bin/vibest` : `${dir}/bin/vibest`]
            const fetched = yield* runCaptured(argv, Duration.minutes(5), env)
            if (fetched !== undefined) return `it could not be fetched to try it first (${argv.join(" ")}: ${fetched})`
            const reported = yield* versionOf(staged)
            if (reported !== latest) return `the vibest fetched to try it reports ${reported}, not ${latest}`
            return yield* importCheck(staged)
          }),
        )
        if (cannot !== undefined) {
          const running = Option.getOrUndefined(yield* readPing(layout.socket))
          const kept = running
            ? `${described(running.version, running)} was not stopped and keeps working`
            : "no vibestd was running, and none was started"
          return yield* new UpdateError({
            message: `vibest ${latest} cannot take over: ${cannot}. Nothing was installed: vibest ${VERSION} stays, and ${kept}. ${running && /SchemaMismatch/.test(cannot) ? replaceAnyway(layout.socket, running.pid, "vibest update") : "Once that is fixed, run vibest update again"}`,
          })
        }
        const [installArgv, installEnv] =
          method.kind === "npm" ? [upgradeCommand(real, latest), {}] : installSh({ VIBEST_INSTALL: method.share })
        yield* runInherit(installArgv, installEnv).pipe(
          Effect.mapError((e) => new UpdateError({ message: `${e.message}; vibestd not attempted` })),
        )
        target = {
          version: latest,
          command: method.kind === "curl" ? [`${method.share}/versions/${latest}/bin/vibest`] : self,
        }
        back =
          method.kind === "npm"
            ? upgradeCommand(real, VERSION).map(shellQuote).join(" ")
            : `ln -sfn ${shellQuote(self[0]!)} "$(cat ${shellQuote(`${method.share}/bin`)} 2>/dev/null || echo ~/.local/bin)/vibest"`
      }
    }
    for (const f of yield* extraVibests)
      yield* Console.log(
        `${f.mark === "problem" ? "warning: " : ""}${f.text}${f.fix ? `; remove it with: ${f.fix}` : ""}`,
      )
    const running = Option.getOrUndefined(yield* readPing(layout.socket))
    const plan = daemonPlan(running, target)
    if (plan.action === "none") return
    yield* Console.log(`vibestd: ${plan.action}. ${plan.reason}.`)
    const failed =
      plan.action === "handoff"
        ? yield* handoffDaemon(running!, target)
        : plan.action === "restart"
          ? yield* replaceForUpdate(target)
          : undefined
    if (failed !== undefined)
      return yield* new UpdateError({
        message: `vibest ${target.version}: ${failed}${back === undefined ? "" : `. To go back to vibest ${VERSION} instead: ${back}`}`,
      })
    const serving = Option.getOrUndefined(yield* readPing(layout.socket))
    if (target.version !== VERSION && serving?.version === target.version)
      return yield* runInherit([
        ...target.command,
        "update",
        "--restart-agents-after",
        String(process.pid),
        ...(yes ? ["--yes"] : []),
      ]).pipe(
        Effect.mapError(
          (e) =>
            new UpdateError({
              message: `${e.message}. vibest ${target.version} is installed and vibestd runs it; to restart the agents still on the old integration, run vibest update again`,
            }),
        ),
      )
    const agents = yield* restartAgents(target.version, yes, "vibest update")
    if (agents !== undefined) return yield* new UpdateError({ message: agents })
  }),
)
