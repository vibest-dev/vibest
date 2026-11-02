// herdr's socket-path resolution, read through Config and the Path service. Windows is recognised by
// `path.sep`, so `BunPath.layerWin32` reproduces the Windows rules on any host.
import { Config, Effect, Option, Path } from "effect"

/** Options that steer socket-path resolution away from the ordinary release-build default. */
export interface SocketPathOptions {
  /**
   * Point at a `herdr-dev` debug build's config dir instead of a release build's `herdr`.
   * herdr's own debug builds use `herdr-dev` as their app-dir name; this SDK never guesses
   * that at runtime — pass it explicitly when you know you're talking to a dev server.
   */
  dev?: boolean
  /** A named session's socket lives at `<configdir>/sessions/<name>/herdr.sock`, not `<configdir>/herdr.sock`. */
  sessionName?: string
}

const env = (name: string) => Config.option(Config.String(name)).pipe(Config.map(Option.filter((v) => v !== "")))

/** First non-empty variable among `names`. */
const firstEnv = Effect.fnUntraced(function* (...names: ReadonlyArray<string>) {
  for (const name of names) {
    const value = yield* env(name)
    if (Option.isSome(value)) return value
  }
  return Option.none<string>()
})

/**
 * Mirrors herdr's own config-dir resolution (`config_dir()` in herdr's `src/config/io.rs`):
 * `XDG_CONFIG_HOME` if set; else on Windows `%APPDATA%`, then `%USERPROFILE%\AppData\Roaming`,
 * then `$HOME/.config`, then the temp dir; else (POSIX) `$HOME/.config`, then the temp dir.
 */
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
  // Rust's temp_dir(): TMPDIR else /tmp on POSIX. ponytail: Windows GetTempPath also falls back to the Windows dir; TMP/TEMP covers real setups.
  const temp = yield* windows ? firstEnv("TMP", "TEMP") : firstEnv("TMPDIR")
  return path.join(
    Option.getOrElse(temp, () => (windows ? "C:\\Windows\\Temp" : "/tmp")),
    appDir,
  )
})

/**
 * herdr's socket path: `HERDR_SOCKET_PATH` (herdr's own published override) if set; else the
 * deprecated `HERDR_SOCKET` fallback, kept for backward compatibility; else herdr's default,
 * `<configdir>/herdr.sock` (or `<configdir>/sessions/<name>/herdr.sock` for a named session).
 */
export const defaultSocketPath = Effect.fn("defaultSocketPath")(function* (options: SocketPathOptions = {}) {
  const override = yield* firstEnv("HERDR_SOCKET_PATH", "HERDR_SOCKET")
  if (Option.isSome(override)) return override.value
  const path = yield* Path.Path
  const dir = yield* configDir(options.dev ?? false)
  return options.sessionName
    ? path.join(dir, "sessions", options.sessionName, "herdr.sock")
    : path.join(dir, "herdr.sock")
})

/**
 * The address the socket dial actually needs: unchanged for a POSIX path (a real Unix-domain socket);
 * for a Windows path herdr only writes a marker file there and listens on the named pipe `\\.\pipe\<path>`
 * (a published herdr contract, matched byte-for-byte). A Windows path is recognised by its drive or backslash.
 */
export const socketEndpoint = (path: string): string => (/^[A-Za-z]:|\\/.test(path) ? `\\\\.\\pipe\\${path}` : path)
