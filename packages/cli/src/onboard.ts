import type { RuntimeDoctor as RuntimeDoctorSchema } from "@vibest/protocol/schemas"
import { Layout } from "@vibest/schema/layout"
import { type HarnessChoice, LaunchFailed } from "@vibest/schema/session"
import { Config, Console, Effect, FileSystem, Option, Path, Schedule, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { askChoice, askYesNo, interactive } from "./ask.ts"
import { Host } from "./host.ts"

export const HC_INSTALL_VERSION = "0.1.22"

const HC = "hc"
const HC_BINARIES = ["hc", "herdr-core"]
const RUNTIME_ORDER = [HC, "rex", "herdr"]

const RUNTIME_LABELS = new Map([
  [HC, "Current terminal (herdr-core)"],
  ["rex", "Rex"],
  ["herdr", "Herdr"],
])

const NO_RUNTIME_HELP =
  "no terminal runtime is installed. Install herdr-core with curl -fsSL https://releases.herdr.dev/core/install.sh | sh, or install Rex or Herdr, then run vibest again"

const FETCH_AND_RUN_INSTALLER = 'set -e; script=$(curl -fsSL "$1"); printf "%s\\n" "$script" | sh'

type RuntimeDoctor = typeof RuntimeDoctorSchema.Type

interface Client<E> {
  readonly "server.runtime": {
    readonly "runtime.doctor": (args: {
      readonly payload: { readonly harnesses: ReadonlyArray<string> }
    }) => Effect.Effect<ReadonlyArray<RuntimeDoctor>, E>
  }
  readonly "server.harness": {
    readonly "harness.list": (args: {
      readonly query: { readonly provider?: string | undefined; readonly machine?: string | undefined }
    }) => Effect.Effect<ReadonlyArray<HarnessChoice>, E>
  }
}

export type Setting = "defaultRuntime" | "defaultHarness"

const env = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.orDie,
    Effect.map((value) => Option.getOrUndefined(value) || undefined),
  )

const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))

const decodeDefaults = Schema.decodeUnknownOption(
  Schema.Struct({
    defaultRuntime: Schema.optional(Schema.NonEmptyString),
    defaultHarness: Schema.optional(Schema.NonEmptyString),
  }),
)

const readConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const layout = yield* Layout

  return yield* fs.readFileString(layout.config).pipe(Effect.option)
})

const readSettings = Effect.map(readConfig, (text) =>
  Option.isNone(text) ? Option.some<Readonly<Record<string, Schema.Json>>>({}) : decodeSettings(text.value),
)

export const savedSetting = (key: Setting) =>
  Effect.gen(function* () {
    const { parseJsonc } = yield* Host
    const text = yield* readConfig

    if (Option.isNone(text)) return undefined
    const settings = yield* Effect.try(() => parseJsonc(text.value)).pipe(Effect.option)

    return Option.getOrUndefined(Option.flatMapNullishOr(Option.flatMap(settings, decodeDefaults), (all) => all[key]))
  })

export const saveSetting = (key: Setting, value: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const layout = yield* Layout
    const settings = yield* readSettings

    if (Option.isNone(settings))
      return yield* Console.error(
        `${layout.config} is not plain JSON, so it was left as it is; add "${key}": "${value}" to it yourself`,
      )
    const staged = `${layout.config}.${process.pid}.tmp`
    yield* fs.makeDirectory(layout.home, { recursive: true })
    yield* fs.writeFileString(staged, `${JSON.stringify({ ...settings.value, [key]: value }, null, 2)}\n`)
    yield* fs.rename(staged, layout.config)
  }).pipe(Effect.orDie)

const localBin = Effect.gen(function* () {
  const path = yield* Path.Path

  return (yield* env("HC_INSTALL_DIR")) ?? path.join((yield* env("HOME")) ?? "", ".local", "bin")
})

const executable = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.stat(file).pipe(
      Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
      Effect.orElseSucceed(() => false),
    )
  })

export const findHc = Effect.gen(function* () {
  const path = yield* Path.Path
  const dirs = [...((yield* env("PATH")) ?? "").split(":").filter((dir) => dir !== ""), yield* localBin]

  for (const dir of dirs)
    for (const name of HC_BINARIES) {
      const file = path.join(dir, name)

      if (yield* executable(file)) return file
    }

  return undefined
})

export interface AvailableRuntime {
  readonly kind: string
  readonly online: boolean
}

export const runtimeLabel = (kind: string) => RUNTIME_LABELS.get(kind) ?? kind

const rank = (kind: string) => {
  const at = RUNTIME_ORDER.indexOf(kind)

  return at < 0 ? RUNTIME_ORDER.length : at
}

export const availableRuntimes = <E>(client: Client<E>) =>
  Effect.gen(function* () {
    const rows = yield* client["server.runtime"]["runtime.doctor"]({ payload: { harnesses: [] } })
    const hc = yield* findHc

    return rows
      .filter((row) => row.status === "online" || (row.kind === HC && row.status === "offline" && hc !== undefined))
      .map((row): AvailableRuntime => ({ kind: row.kind, online: row.status === "online" }))
      .toSorted((a, b) => rank(a.kind) - rank(b.kind))
  })

const hcOnline = <E>(client: Client<E>) =>
  Effect.map(client["server.runtime"]["runtime.doctor"]({ payload: { harnesses: [] } }), (rows) =>
    rows.some((row) => row.kind === HC && row.status === "online"),
  )

const runShown = (file: string, args: ReadonlyArray<string>, extra: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    return yield* spawner
      .exitCode(
        ChildProcess.make(file, args, {
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          env: extra,
          extendEnv: true,
        }),
      )
      .pipe(Effect.orElseSucceed(() => -1))
  })

export const ensureRuntime = <E>(client: Client<E>, kind: string) =>
  Effect.gen(function* () {
    if (kind !== HC || (yield* hcOnline(client))) return
    const hc = yield* findHc

    if (hc === undefined)
      return yield* new LaunchFailed({ message: "herdr-core is not running and no hc was found to start it" })

    if ((yield* runShown(hc, ["server", "start"])) !== 0)
      return yield* new LaunchFailed({ message: `${hc} server start failed` })

    const online = yield* hcOnline(client).pipe(
      Effect.repeat({ until: (up) => up, schedule: Schedule.spaced("250 millis") }),
      Effect.timeoutOption("15 seconds"),
    )

    if (Option.isNone(online))
      return yield* new LaunchFailed({ message: `herdr-core did not answer after ${hc} server start` })
  })

export const installHc = <E>(client: Client<E>) =>
  Effect.gen(function* () {
    const dir = yield* localBin
    const version = (yield* env("HC_VERSION")) ?? HC_INSTALL_VERSION
    const releases = ((yield* env("HERDR_RELEASES_URL")) ?? "https://releases.herdr.dev").replace(/\/+$/, "")

    const agreed = yield* askYesNo(
      `No terminal runtime was found. Install herdr-core (hc ${version}) into ${dir} so vibest can run in this terminal? [y/N]: `,
    )

    if (!agreed) return yield* new LaunchFailed({ message: NO_RUNTIME_HELP })

    const code = yield* runShown("/bin/sh", ["-c", FETCH_AND_RUN_INSTALLER, "sh", `${releases}/core/install.sh`], {
      HC_VERSION: version,
      HC_INSTALL_DIR: dir,
      HERDR_RELEASES_URL: releases,
    })

    if (code !== 0) return yield* new LaunchFailed({ message: `installing herdr-core failed (exit ${code})` })

    yield* ensureRuntime(client, HC)

    if (!((yield* env("PATH")) ?? "").split(":").includes(dir))
      yield* Console.log(`Note: add ${dir} to your PATH to run hc directly`)

    return HC
  })

export const chooseRuntime = <E>(
  client: Client<E>,
  o: { readonly reuse: boolean; readonly saveWithoutAsking: boolean },
) =>
  Effect.gen(function* () {
    const saved = o.reuse ? yield* savedSetting("defaultRuntime") : undefined
    const ask = yield* interactive

    if (saved !== undefined && !ask) {
      yield* ensureRuntime(client, saved)

      return saved
    }

    const found = yield* availableRuntimes(client)

    if (saved !== undefined && found.some((r) => r.kind === saved)) {
      yield* ensureRuntime(client, saved)

      return saved
    }

    if (!ask) return undefined

    if (found.length === 0) {
      const installed = yield* installHc(client)
      yield* saveSetting("defaultRuntime", installed)

      return installed
    }

    const picked =
      found.length === 1
        ? found[0]!.kind
        : yield* askChoice(
            "Where should vibest run its agents?",
            found.map((r) => runtimeLabel(r.kind)),
          ).pipe(
            Effect.flatMap((choice) =>
              Option.match(choice, {
                onNone: () => Effect.fail(new LaunchFailed({ message: "no runtime chosen; pass --runtime" })),
                onSome: (i) => Effect.succeed(found[i]!.kind),
              }),
            ),
          )

    yield* ensureRuntime(client, picked)

    if (
      o.saveWithoutAsking ||
      (found.length > 1 &&
        (yield* askYesNo(
          `Save ${runtimeLabel(picked)} as your default runtime for plain terminals? [Y/n]: `,
          undefined,
          true,
        )))
    )
      yield* saveSetting("defaultRuntime", picked)

    return picked
  })

export const chooseHarness = <E>(client: Client<E>, o: { readonly saveWithoutAsking: boolean }) =>
  Effect.gen(function* () {
    const rows = yield* client["server.harness"]["harness.list"]({ query: {} })
    const usable = rows.filter((row) => row.problem === null).map((row) => row.harness)

    if (usable.length <= 1 || !(yield* interactive)) {
      if (usable.length === 1 && o.saveWithoutAsking) yield* saveSetting("defaultHarness", usable[0]!)

      return usable.length === 1 ? usable[0] : undefined
    }

    const choice = yield* askChoice("Choose a coding agent:", usable)

    if (Option.isNone(choice)) return yield* new LaunchFailed({ message: "no coding agent chosen; pass --harness" })
    const picked = usable[choice.value]!

    if (
      o.saveWithoutAsking ||
      (yield* askYesNo(`Save ${picked} as your default coding agent? [Y/n]: `, undefined, true))
    )
      yield* saveSetting("defaultHarness", picked)

    return picked
  })

export const attachCommand = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const at = argv[0] === "env" ? argv.findIndex((arg, i) => i > 0 && !arg.includes("=")) : 0

    if (argv[at] !== HC) return argv
    const hc = yield* findHc

    return hc === undefined ? argv : argv.with(at, hc)
  })
