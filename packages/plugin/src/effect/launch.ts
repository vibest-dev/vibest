import { Config, Context, Data, Effect, FileSystem, Option, Path, Random } from "effect"

export class SystemPromptDirUnsafe extends Data.TaggedError("SystemPromptDirUnsafe")<{ readonly message: string }> {}

export interface LinkInfo {
  readonly symlink: boolean
  readonly directory: boolean
  readonly uid: number
  readonly mode: number
}

export const UserPlatform = Context.Reference<{
  readonly uid: number | undefined
  readonly lstat: (path: string) => Promise<LinkInfo>
}>("vibest/UserPlatform", {
  defaultValue: () => ({ uid: undefined, lstat: () => Promise.reject(new Error("no lstat on this platform")) }),
})

export const privateTmp = Effect.fn("privateTmp")(function* (tmpdir: string, fallbackParent: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const unsafe = (message: string) => new SystemPromptDirUnsafe({ message })
  if (tmpdir !== "") {
    const dir = path.join(tmpdir, "vibest")
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(Effect.mapError((e) => unsafe(e.message)))
    return dir
  }
  const user = yield* UserPlatform
  if (user.uid === undefined) return yield* unsafe("TMPDIR is not set and this platform has no user id")
  const dir = path.join(fallbackParent, `vibest-${user.uid}`)
  yield* fs
    .makeDirectory(dir, { mode: 0o700 })
    .pipe(
      Effect.catchTag("PlatformError", (e) =>
        e.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(unsafe(e.message)),
      ),
    )
  const st = yield* Effect.tryPromise({ try: () => user.lstat(dir), catch: (e) => unsafe(`${dir}: ${String(e)}`) })
  if (st.symlink || !st.directory || st.uid !== user.uid || (st.mode & 0o777) !== 0o700)
    return yield* unsafe(
      `${dir} is not a private directory of this user (it must be a directory, not a symlink, owned by uid ${user.uid} with mode 0700); remove it or set TMPDIR`,
    )
  return dir
})

export const systemPromptRoot = Effect.gen(function* () {
  return yield* privateTmp(
    Option.getOrElse(yield* Config.option(Config.String("TMPDIR")), () => ""),
    "/tmp",
  )
})

const writeAtomic = Effect.fn("writeAtomic")(function* (file: string, content: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  const tmp = `${file}.${yield* Random.nextIntBetween(0, 2 ** 31)}.tmp`
  yield* fs.writeFileString(tmp, content)
  yield* fs.rename(tmp, file)
})

const promptFile = (id: string, name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(yield* systemPromptRoot, id, name)
  })

export const systemPromptFile = (id: string) => promptFile(id, "system-prompt.md")

export const writeSystemPrompt = (id: string, text: string) =>
  Effect.gen(function* () {
    const file = yield* systemPromptFile(id)
    yield* writeAtomic(file, text)
    return file
  })

const writeFirstInput = (id: string, text: string) =>
  Effect.gen(function* () {
    const file = yield* promptFile(id, "first-input.md")
    yield* writeAtomic(file, text)
    return file
  })

export const removeSystemPrompt = (id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.remove(path.join(yield* systemPromptRoot, id), { recursive: true, force: true })
  }).pipe(Effect.ignore)

export interface Launch {
  readonly harness?: string
  readonly argv: ReadonlyArray<string>
  readonly prompt?: string
  readonly system?: string
  readonly env: Readonly<Record<string, string>>
}

const IDENTITY_ENV = [
  "VIBEST_SESSION_ID",
  "VIBEST_PROCESS",
  "VIBEST_PROJECT_ID",
  "VIBEST_PROJECT_DIR",
  "VIBEST_HARNESS",
  "VIBEST_RUNTIME",
  "VIBEST_HOME",
  "VIBEST_COMMAND",
] as const

const identityPairs = (env: Readonly<Record<string, string>>) =>
  IDENTITY_ENV.flatMap((key) => {
    const value = env[key]
    return value === undefined ? [] : [`${key}=${value}`]
  })

const MESSAGE_FROM_FILE = 'm=$(cat -- "$0") || exit 1; exec "$@" "$m"'

const messageFromFile = (argv: ReadonlyArray<string>, file: string) => ["sh", "-c", MESSAGE_FROM_FILE, file, ...argv]

export const launchLine = Effect.fn("launchLine")(function* (launch: Launch) {
  const id = launch.env.VIBEST_SESSION_ID
  if (launch.prompt !== undefined && id === undefined)
    return yield* Effect.die("a launch with a prompt has no session id")
  const argv =
    launch.prompt === undefined || id === undefined
      ? [...launch.argv]
      : messageFromFile(launch.argv.slice(0, -1), yield* writeFirstInput(id, launch.prompt))
  const prefix = identityPairs(launch.env)
  return prefix.length === 0 ? argv : ["env", ...prefix, ...argv]
})
