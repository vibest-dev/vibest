import { cliHeaders, connect, type VibestClient, readPing } from "@vibest/client/client"
import { UpdateError } from "@vibest/client/release"
import { PROTOCOL_HEADER } from "@vibest/protocol/protocol"
import { type Ping } from "@vibest/protocol/rpc"
import { shortId } from "@vibest/schema/id"
import { Layout, shellQuote } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import { Cause, Config, Console, Duration, Effect, Exit, FileSystem, Option, Path, Schedule } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient } from "effect/rpc"

import { askYesNo, interactive } from "./ask.ts"
import { withVibest } from "./client.ts"
import { type ReplaceFailed, replaceDaemon, compareVersions, versionOf } from "./replace.ts"
import { VERSION } from "./version.ts"

export type Finding = { readonly mark: "ok" | "problem" | "note"; readonly text: string; readonly fix?: string }

export const ownerOf = (real: string) => {
  if (real.includes("/.bun/install/global/node_modules/")) return { kind: "bun" } as const
  const npm = /^(.+)\/lib\/node_modules\/@vibest\//.exec(real)
  return npm ? ({ kind: "npm", prefix: npm[1]! } as const) : undefined
}

export const upgradeCommand = (real: string, version: string, platform = `${process.platform}-${process.arch}`) => {
  const owner = ownerOf(real)
  return owner?.kind === "bun"
    ? ["bun", "add", "-g", `@vibest/cli@${version}`, `@vibest/cli-${platform}@${version}`]
    : owner?.kind === "npm"
      ? [`${owner.prefix}/bin/npm`, "install", "-g", "--prefix", owner.prefix, `@vibest/cli@${version}`]
      : ["npm", "install", "-g", `@vibest/cli@${version}`]
}

export const stageCommand = (
  real: string,
  dir: string,
  version: string,
  platform = `${process.platform}-${process.arch}`,
) => {
  const owner = ownerOf(real)
  return owner?.kind === "bun"
    ? ["bun", "add", "--cwd", dir, `@vibest/cli@${version}`, `@vibest/cli-${platform}@${version}`]
    : [owner?.kind === "npm" ? `${owner.prefix}/bin/npm` : "npm", "install", "--prefix", dir, `@vibest/cli@${version}`]
}

export const removeCommand = (link: string, real: string) => {
  const owner = ownerOf(real)
  return owner?.kind === "bun"
    ? "bun remove -g @vibest/cli"
    : owner?.kind === "npm"
      ? `${shellQuote(`${owner.prefix}/bin/npm`)} uninstall -g --prefix ${shellQuote(owner.prefix)} @vibest/cli`
      : `rm ${shellQuote(link)}`
}

export const extraVibests = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dirs = (Option.getOrUndefined(yield* Config.option(Config.String("PATH"))) ?? "").split(":").filter(Boolean)
  const found: Array<{ readonly link: string; readonly real: string }> = []
  for (const dir of dirs) {
    const link = `${dir}/vibest`
    const real = yield* fs.realPath(link).pipe(Effect.option)
    if (Option.isSome(real) && !found.some((f) => f.real === real.value)) found.push({ link, real: real.value })
  }
  if (found.length < 2) return []
  return yield* Effect.forEach(
    found,
    (v, i) =>
      Effect.map(versionOf([v.link]), (version): Finding =>
        i === 0
          ? { mark: "note", text: `${v.link} ${version} runs as vibest; ${found.length - 1} more on PATH` }
          : {
              mark: "problem",
              text: `${v.link} ${version} is also on PATH, behind the first`,
              fix: removeCommand(v.link, v.real),
            },
      ),
    { concurrency: "unbounded" },
  )
})

export const noticeFrom = <E, R>(ping: Effect.Effect<Option.Option<Ping>, E, R>) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* Config.option(Config.String("VIBEST_SESSION_ID")))) return
    if (Option.isSome(yield* Config.option(Config.String("VIBEST_NO_UPDATE_CHECK")))) return
    const latest = Option.getOrUndefined(yield* ping)?.update?.latest
    if (latest && compareVersions(VERSION, latest) < 0)
      yield* Console.error(`vibest ${latest} is available (this is ${VERSION}); update with: vibest update`)
  }).pipe(Effect.ignore)

export const updateNotice = noticeFrom(Effect.flatMap(Layout, (layout) => readPing(layout.socket)))

export const runInherit = (argv: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const code = yield* spawner
      .exitCode(
        ChildProcess.make(argv[0]!, argv.slice(1), {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env,
          extendEnv: true,
        }),
      )
      .pipe(Effect.mapError((e) => new UpdateError({ message: `${argv.join(" ")}: ${e.message}` })))
    if (code !== 0) return yield* new UpdateError({ message: `${argv.join(" ")} exited with ${code}` })
  })

export const LEFT: Record<ReplaceFailed["outcome"], string> = {
  declined: "vibestd not replaced: you declined; it still runs the vibest it was started with",
  busy: "vibestd not replaced: it refused to stop (see above); it still runs the vibest it was started with",
  unchanged: "vibestd not replaced: it still runs the vibest it was started with",
  unknown: "vibestd was asked to stop; whether it, the new one or none runs now is not known (see vibest status)",
  other: "vibestd was asked to stop, and another vibestd answers now, not the vibest asked for",
}

export const replaceForUpdate = (target: { readonly version: string; readonly command: ReadonlyArray<string> }) =>
  replaceDaemon(target).pipe(
    Effect.as(undefined),
    Effect.catchTag("ReplaceFailed", (e) =>
      e.outcome === "declined"
        ? Console.log(`${LEFT.declined}. To replace it later: vibest daemon restart`).pipe(Effect.as(undefined))
        : Console.error(`${LEFT[e.outcome]}. ${e.message}`).pipe(Effect.as(LEFT[e.outcome])),
    ),
  )

export const daemonPlan = (
  ping: Ping | undefined,
  target: { readonly version: string; readonly command: ReadonlyArray<string> },
) =>
  ping === undefined
    ? ({ action: "none", reason: "vibestd is not running; the next vibest command starts the new version" } as const)
    : ping.protocol === PROTOCOL &&
        ping.version === target.version &&
        ping.command?.join("\0") === target.command.join("\0")
      ? ({ action: "keep", reason: `vibestd ${ping.version} already runs this vibest` } as const)
      : ping.capabilities?.handoff === true
        ? ({
            action: "handoff",
            reason: `vibestd ${ping.version} hands itself over to ${target.version} (agents keep running)`,
          } as const)
        : ({
            action: "restart",
            reason: `vibestd ${ping.version} cannot hand itself over, so it is stopped and ${target.version} started`,
          } as const)

const HANDOFF_WATCH = Duration.seconds(45)

export const handoffDaemon = (
  old: Ping,
  target: { readonly version: string; readonly command: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const reported = yield* versionOf(target.command)
    if (reported !== target.version)
      return `\`${target.command.join(" ")} --version\` reports ${reported}, not ${target.version}; the old vibestd still runs. Next: vibest update`
    const reply = yield* RpcClient.withHeaders(
      connect(layout.socket).pipe(
        Effect.flatMap((c) => c["Daemon.Handoff"]({ instance: old.instance!, command: target.command })),
      ),
      { ...cliHeaders((yield* Path.Path).resolve(".")), [PROTOCOL_HEADER]: String(old.protocol) },
    ).pipe(Effect.scoped, Effect.exit)
    if (Exit.isFailure(reply)) {
      const e = Option.getOrUndefined(Cause.findErrorOption(reply.cause)) as { readonly message?: string } | undefined
      const still = Option.getOrUndefined(yield* readPing(layout.socket))
      if (still?.instance === old.instance)
        return `the handoff did not happen (${e?.message ?? "no reply"}); the old vibestd ${old.version} still runs. Next: vibest update`
    }
    const now = yield* readPing(layout.socket).pipe(
      Effect.repeat({
        until: (p) => Option.isSome(p) && p.value.instance !== old.instance && p.value.version === target.version,
        schedule: Schedule.spaced("200 millis"),
      }),
      Effect.timeoutOption(HANDOFF_WATCH),
      Effect.map(Option.flatten),
    )
    if (Option.isSome(now)) {
      yield* Console.log(`vibestd ${now.value.version} (pid ${now.value.pid}) took over; agents kept running.`)
      return undefined
    }
    const after = Option.getOrUndefined(yield* readPing(layout.socket))
    if (after === undefined)
      return `no vibestd answers on ${layout.socket}. Next: vibest daemon (see ${layout.home}/vibestd.log)`
    return `vibestd ${after.version} (instance ${after.instance ?? "unknown"}) answers, not the new ${target.version}. Next: vibest update`
  })

export const restartAgents = (
  version: string,
  yes: boolean,
  command: "vibest update" | "vibest daemon restart",
  after = process.pid,
) =>
  Effect.gen(function* () {
    const cwd = (yield* Path.Path).resolve(".")
    const ask = <A, E>(f: (client: VibestClient) => Effect.Effect<A, E>) =>
      withVibest({ _tag: "cli", repositoryRoot: cwd }, f, { start: false })
    const outdated = yield* ask((client) => client["Agents.Outdated"]())
    if (outdated.length === 0) return yield* Console.log("No agent runs an old integration.")
    const working = outdated.filter((a) => a.working).map((a) => shortId(a.id))
    const ids = outdated.map((a) => shortId(a.id)).join(", ")
    const busy = working.length === 0 ? "" : `; ${working.join(", ")} ${working.length === 1 ? "is" : "are"} working`
    const blocked = outdated.filter((a) => a.blocked !== null)
    const restartable = outdated.filter((a) => a.blocked === null)
    const refused = "their calls to vibestd will be refused with a message that names vibest update"
    const lead = command === "vibest update" ? `vibest ${version} installed.` : `vibestd ${version} runs now.`
    const list = `${outdated.length} agent${outdated.length === 1 ? "" : "s"} still run${outdated.length === 1 ? "s" : ""} the old integration (${ids}${busy})`
    for (const a of blocked) yield* Console.log(`${shortId(a.id)} cannot be restarted in place: ${a.blocked}.`)
    if (restartable.length === 0) return
    if (!yes) {
      if (!(yield* interactive))
        return yield* Console.log(
          `${lead} ${list}. Not restarted without a terminal (${command === "vibest update" ? "vibest update --yes" : "vibest daemon restart in a terminal"} restarts them); ${refused} until then.`,
        )
      if (
        !(yield* askYesNo(
          `${lead} ${list}. Restart ${restartable.length === 1 ? "it" : `these ${restartable.length} agents`} in place and continue ${restartable.length === 1 ? "its conversation" : "their conversations"}? [Y/n]: `,
          "2 minutes",
          true,
        ))
      )
        return yield* Console.log(`They keep the old integration; ${refused}.`)
    }
    yield* ask((client) => client["Agents.Restart"]({ ids: restartable.map((a) => a.id), after }))
    yield* Console.log(
      `${command} has finished. vibestd restarts ${restartable.map((a) => shortId(a.id)).join(", ")} in place once this command has exited; one that was working continues its execution (outcomes in ${(yield* Layout).home}/vibestd.log).`,
    )
  })
