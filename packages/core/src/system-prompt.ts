// The system prompt file each harness is started with. Made again on every harness start (new, resume, restart, move)
// into `$TMPDIR/vibest/<session id>/system-prompt.md`, never read back. The text is the product's (`SessionPrompt`,
// @vibest/vibest/system-prompt): the engine only writes it and takes it away.
import { Config, Context, Data, Effect, FileSystem, Option, Path } from "effect"

import { writeAtomic } from "./paths.ts"

/** What a session's system prompt is made from, as the engine knows it; the product adds its own files. */
export interface SessionPromptInput {
  readonly id: string
  /** argv that runs vibest (`VibestCommand`). */
  readonly vibest: ReadonlyArray<string>
  /** The session's grouping key (its row's project). */
  readonly key: string
  /** The session whose directory this one shares (`vibest run --peer`), if any. */
  readonly peer?: string | undefined
  /** Its agent definition: whether it may start sessions, and the rules it adds. */
  readonly agent?: { readonly spawn: boolean; readonly rules?: string | undefined } | undefined
}

/** The port that writes a session's system prompt text (the product's: @vibest/vibest/system-prompt). */
export class SessionPrompt extends Context.Service<
  SessionPrompt,
  { readonly text: (input: SessionPromptInput) => Effect.Effect<string> }
>()("vibest/SessionPrompt") {}

/** The per-user temporary directory cannot be used safely: the start fails with this. */
export class SystemPromptDirUnsafe extends Data.TaggedError("SystemPromptDirUnsafe")<{ readonly message: string }> {}

/** What `lstat` says of a path: the link itself, never what it points to. */
export interface LinkInfo {
  readonly symlink: boolean
  readonly directory: boolean
  readonly uid: number
  readonly mode: number
}

/** From the platform (src/platform): this user's numeric id and `lstat`. Only the fallback without TMPDIR needs them. */
export const UserPlatform = Context.Reference<{
  readonly uid: number | undefined
  readonly lstat: (path: string) => Promise<LinkInfo>
}>("vibest/UserPlatform", {
  defaultValue: () => ({ uid: undefined, lstat: () => Promise.reject(new Error("no lstat on this platform")) }),
})

/**
 * The parent of every session's system prompt directory: `<tmpdir>/vibest`, or `<fallbackParent>/vibest-<uid>` when
 * tmpdir is empty. The fallback sits in a shared directory, so it must be a real directory (no symlink) owned by this
 * user with mode 0700, else it is refused.
 */
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
  // One lstat, which does not follow a link: nothing can be swapped between two checks. Another user cannot replace
  // a directory of ours in a sticky /tmp afterwards.
  const st = yield* Effect.tryPromise({ try: () => user.lstat(dir), catch: (e) => unsafe(`${dir}: ${String(e)}`) })
  if (st.symlink || !st.directory || st.uid !== user.uid || (st.mode & 0o777) !== 0o700)
    return yield* unsafe(
      `${dir} is not a private directory of this user (it must be a directory, not a symlink, owned by uid ${user.uid} with mode 0700); remove it or set TMPDIR`,
    )
  return dir
})

/** `privateTmp` for this process: TMPDIR, else `/tmp`. */
export const systemPromptRoot = Effect.gen(function* () {
  return yield* privateTmp(
    Option.getOrElse(yield* Config.option(Config.String("TMPDIR")), () => ""),
    "/tmp",
  )
})

/** Writes session `id`'s system prompt; its path, for the harness flag. */
export const writeSystemPrompt = Effect.fn("writeSystemPrompt")(function* (id: string, text: string) {
  const path = yield* Path.Path
  const file = path.join(yield* systemPromptRoot, id, "system-prompt.md")
  yield* writeAtomic(file, text)
  return file
})

/** Session `id`'s temporary directory goes, best effort (archive). */
export const removeSystemPrompt = (id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.remove(path.join(yield* systemPromptRoot, id), { recursive: true, force: true })
  }).pipe(Effect.ignore)
