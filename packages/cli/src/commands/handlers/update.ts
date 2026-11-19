import { described, importCheck, readPing, runCaptured } from "@vibest/client/client"
import { channelOf, compareVersions, installMethod, latestOf, UpdateError } from "@vibest/client/release"
import { Layout, shellQuote, VibestCommand } from "@vibest/schema/layout"
import { Config, Console, Duration, Effect, FileSystem, Match, Option } from "effect"

import { userOnly } from "../../caller.ts"
import { Runtime } from "../../framework/runtime.ts"
import { replaceAnyway, type Target, versionOf } from "../../replace.ts"
import {
  daemonPlan,
  download,
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

export default Runtime.handler(Commands.commands.update, ({ yes, beta, stable, restartAgentsAfter }) =>
  Effect.gen(function* () {
    yield* userOnly("update")

    if (beta && stable)
      return yield* new UpdateError({ message: "--beta and --stable choose opposite channels; pass one" })

    if (Option.isSome(restartAgentsAfter))
      return yield* restartAgents(VERSION, yes, "vibest update", restartAgentsAfter.value)
    const self = yield* VibestCommand
    const method = installMethod(self, Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_HARNESSES"))))
    const layout = yield* Layout

    let target: Target = {
      version: VERSION,
      command: self,
    }

    let back: string | undefined

    if (method === undefined)
      yield* Console.log(`this vibest (${self.join(" ")}) was not installed by npm or install.sh; nothing to install.`)
    else {
      const channel = beta ? "beta" : stable ? "stable" : channelOf(VERSION)
      yield* Console.log(`Checking for a newer vibest (this is ${VERSION})…`)
      const found = yield* latestOf(method, channel)
      const latest = found.version

      if (compareVersions(VERSION, latest) >= 0)
        yield* Console.log(
          `vibest is already up to date (v${VERSION}).${latest === VERSION ? "" : ` The newest ${channel === "stable" ? "stable release" : "release"} is ${latest}.`}`,
        )
      else {
        yield* Console.log(`vibest ${latest} is available (this is ${VERSION}).`)
        const fs = yield* FileSystem.FileSystem
        const real = yield* fs.realPath(self[0]!).pipe(Effect.orElseSucceed(() => self[0]!))

        yield* Effect.scoped(
          Effect.gen(function* () {
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-update-" })
            const release = `${dir}/release`
            const archive = `vibest-${process.platform}-${process.arch}.tar.gz`

            const stage = Effect.gen(function* () {
              if (found.kind === "npm") {
                yield* Console.log(`Downloading vibest ${latest} from npm…`)
                const argv = stageCommand(real, dir, latest)
                const failed = yield* runCaptured(argv, Duration.infinity)

                return failed === undefined ? undefined : `it could not be fetched (${argv.join(" ")}: ${failed})`
              }

              yield* fs.makeDirectory(`${dir}/stage`)
              yield* fs.makeDirectory(release)

              const failed =
                (yield* download(`${found.releases}/install.sh`, `${release}/install.sh`)) ??
                (yield* download(`${found.releases}/${archive}`, `${release}/${archive}`, `vibest ${latest}`)) ??
                (yield* runCaptured(["tar", "-xzf", `${release}/${archive}`, "-C", `${dir}/stage`], Duration.infinity))

              return failed === undefined ? undefined : `it could not be fetched (${failed})`
            })

            const staged = [found.kind === "npm" ? `${dir}/node_modules/.bin/vibest` : `${dir}/stage/bin/vibest`]

            const tried = Effect.gen(function* () {
              yield* Console.log(`Checking that vibest ${latest} runs here and opens the database…`)
              const reported = yield* versionOf(staged)

              if (reported !== latest) return `the vibest fetched reports ${reported}, not ${latest}`

              return yield* importCheck(staged)
            })

            const cannot = (yield* stage) ?? (yield* tried)

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
              method.kind === "curl"
                ? [
                    ["sh", `${release}/install.sh`],
                    { VIBEST_DOWNLOAD_URL: encodeURI(`file://${release}`), VIBEST_INSTALL: method.share },
                  ]
                : [upgradeCommand(real, latest), {}]

            yield* Console.log(`Installing vibest ${latest}…`)
            yield* runInherit(installArgv, installEnv).pipe(
              Effect.mapError((e) => new UpdateError({ message: `${e.message}; vibestd not attempted` })),
            )
          }),
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

    const failed = yield* Match.value(plan).pipe(
      Match.when({ action: "handoff" }, () => handoffDaemon(running!, target)),
      Match.when({ action: "restart" }, () => replaceForUpdate(target)),
      Match.orElse(() => Effect.succeed(undefined)),
    )

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
