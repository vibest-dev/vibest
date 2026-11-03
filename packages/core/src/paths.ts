// ~/.vibest layout (SPEC §5.1). Everything on disk is derived from VIBEST_HOME plus a session id or repository key.
import { type Duration, Effect, FileSystem, Option, Path, Random, Stdio, Stream } from "effect"
export { Layout, VibestCommand, shellQuote } from "@vibest/schema/layout"

const SESSION_ID = /^[0-9a-f]{8}$/
export const ALLOCATION_LEAF = /^[0-9a-f]{4}$/
export const ALLOCATION_NAME_ATTEMPTS = 16

/** Darwin and Windows worktree volumes fold case. Linux keeps two spellings as two directories. */
const hostPlatform = (globalThis as { readonly process?: { readonly platform?: string } }).process?.platform
export const caseFoldedWorktrees = hostPlatform === "darwin" || hostPlatform === "win32"

/** Same bucket on this platform. Spelling stored on the row is unchanged. */
export const sameWorktreeBucket = (a: string, b: string) =>
  caseFoldedWorktrees ? a.toLowerCase() === b.toLowerCase() : a === b

/** One ordinary directory name. A name that is a legacy session id on this filesystem is not a bucket. */
export const safeRepositoryDirectory = (name: string) =>
  name.length > 0 &&
  name.length <= 255 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("\0") &&
  !SESSION_ID.test(caseFoldedWorktrees ? name.toLowerCase() : name)

/** Readers never see half a file (SPEC §5.5): write a sibling temp file, then rename over the target. */
export const writeAtomic = Effect.fn("writeAtomic")(function* (
  file: string,
  content: string,
  options?: { readonly mode?: number },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  const tmp = `${file}.${yield* Random.nextIntBetween(0, 2 ** 31)}.tmp`
  yield* fs.writeFileString(tmp, content, options?.mode === undefined ? undefined : { mode: options.mode })
  yield* fs.rename(tmp, file)
})

/** Both ends on a terminal: the user sees the question and answers it themselves. */
export const interactive = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  return (yield* stdio.stdinIsTerminal) && (yield* stdio.stdoutIsTerminal)
})

/**
 * Print `question` (no newline) and read a line: y / yes is a yes; anything else, EOF or no answer within `timeout` is a no.
 * `defaultYes` (a `[Y/n]` question): an empty line is a yes too.
 */
export const askYesNo = (question: string, timeout: Duration.Input = "2 minutes", defaultYes = false) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(question), stdio.stdout()).pipe(Effect.ignore)
    const answer = yield* Stream.decodeText(stdio.stdin).pipe(
      Stream.splitLines,
      Stream.runHead,
      Effect.timeoutOption(timeout),
      Effect.orElseSucceed(() => Option.none()),
    )
    const line = Option.flatten(answer)
    if (defaultYes && Option.isSome(line) && line.value.trim() === "") return true
    return /^\s*y(es)?\s*$/i.test(Option.getOrElse(line, () => ""))
  })
