import { Config, Effect, Option, Path } from "effect"

export interface SocketPathOptions {
  dev?: boolean
  sessionName?: string
}

const env = (name: string) => Config.option(Config.String(name)).pipe(Config.map(Option.filter((v) => v !== "")))

const firstEnv = Effect.fnUntraced(function* (...names: ReadonlyArray<string>) {
  for (const name of names) {
    const value = yield* env(name)
    if (Option.isSome(value)) return value
  }
  return Option.none<string>()
})

export const configDir = Effect.fn("configDir")(function* (dev = false) {
  const path = yield* Path.Path
  const windows = path.sep === "\\"
  const appDir = dev ? "herdr-dev" : "herdr"
  const xdg = yield* env("XDG_CONFIG_HOME")
  if (Option.isSome(xdg)) return path.join(xdg.value, appDir)
  if (windows) {
    const appData = yield* env("APPDATA")
    if (Option.isSome(appData)) return path.join(appData.value, appDir)
    const profile = yield* env("USERPROFILE")
    if (Option.isSome(profile)) return path.join(profile.value, "AppData", "Roaming", appDir)
  }
  const home = yield* env("HOME")
  if (Option.isSome(home)) return path.join(home.value, ".config", appDir)
  const temp = yield* windows ? firstEnv("TMP", "TEMP") : firstEnv("TMPDIR")
  return path.join(
    Option.getOrElse(temp, () => (windows ? "C:\\Windows\\Temp" : "/tmp")),
    appDir,
  )
})

export const defaultSocketPath = Effect.fn("defaultSocketPath")(function* (options: SocketPathOptions = {}) {
  const override = yield* firstEnv("HERDR_SOCKET_PATH", "HERDR_SOCKET")
  if (Option.isSome(override)) return override.value
  const path = yield* Path.Path
  const dir = yield* configDir(options.dev ?? false)
  return options.sessionName
    ? path.join(dir, "sessions", options.sessionName, "herdr.sock")
    : path.join(dir, "herdr.sock")
})

export const socketEndpoint = (path: string): string => (/^[A-Za-z]:|\\/.test(path) ? `\\\\.\\pipe\\${path}` : path)
