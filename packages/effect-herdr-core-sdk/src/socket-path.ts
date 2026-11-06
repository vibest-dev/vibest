import { Config, Effect, Option, Path } from "effect"

const env = (name: string) => Config.option(Config.String(name)).pipe(Config.map(Option.filter((v) => v !== "")))

export const DEFAULT_SESSION = "default"

export const defaultSocketPath = Effect.fn("defaultSocketPath")(function* () {
  const override = yield* env("HC_SOCKET")
  if (Option.isSome(override)) return override.value
  const path = yield* Path.Path
  const session = Option.getOrElse(yield* env("HC_SESSION"), () => DEFAULT_SESSION)
  const runtimeDir = yield* env("XDG_RUNTIME_DIR")
  if (Option.isSome(runtimeDir)) return path.join(runtimeDir.value, "herdr-core", `${session}.sock`)
  const stateHome = yield* env("XDG_STATE_HOME")
  const state = Option.isSome(stateHome)
    ? stateHome.value
    : path.join(
        Option.getOrElse(yield* env("HOME"), () => "/tmp"),
        ".local",
        "state",
      )
  return path.join(state, "herdr-core", session, `${session}.sock`)
})
