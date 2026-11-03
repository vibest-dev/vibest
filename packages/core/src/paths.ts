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

export const allocationLeafTaken = (
  rows: ReadonlyArray<{
    readonly id: string
    readonly metadata: {
      readonly peer?: string | undefined
      readonly worktreeRepository?: string | undefined
      readonly worktreeName?: string | undefined
    }
  }>,
  repository: string,
  leaf: string,
  selfId?: string,
) =>
  rows.some(
    (row) =>
      row.id !== selfId &&
      row.metadata.peer === undefined &&
      row.metadata.worktreeRepository !== undefined &&
      row.metadata.worktreeName !== undefined &&
      sameWorktreeBucket(row.metadata.worktreeRepository, repository) &&
      sameWorktreeBucket(row.metadata.worktreeName, leaf),
  )

export interface WorktreeOwner {
  readonly id: string
  readonly metadata: { readonly worktreeRepository?: string | undefined; readonly worktreeName?: string | undefined }
}

export interface WorktreeSession extends WorktreeOwner {
  readonly metadata: {
    readonly peer?: string | undefined
    readonly worktreeRepository?: string | undefined
    readonly worktreeName?: string | undefined
  }
}

/** The only directory `owner` may use. Undefined: the recorded names are not safe to join. */
export const worktreePath = (
  layout: {
    readonly legacyWorktree: (id: string) => string
    readonly allocationWorktree: (repository: string, name: string) => string
  },
  owner: WorktreeOwner,
): string | undefined => {
  if (!SESSION_ID.test(owner.id)) return undefined
  const repository = owner.metadata.worktreeRepository
  const name = owner.metadata.worktreeName
  if (repository === undefined && name === undefined) return layout.legacyWorktree(owner.id)
  if (
    repository !== undefined &&
    name !== undefined &&
    safeRepositoryDirectory(repository) &&
    ALLOCATION_LEAF.test(name)
  )
    return layout.allocationWorktree(repository, name)
  return undefined
}

export type WorktreeLocation =
  | { readonly _tag: "Resolved"; readonly path: string; readonly ownerId: string }
  | { readonly _tag: "Unresolved"; readonly message: string }

/** Owner row, then its recorded directory. A peer loads that row; a missing or unsafe one is not a second path. */
export const resolveWorktree = Effect.fn("resolveWorktree")(function* (
  layout: {
    readonly legacyWorktree: (id: string) => string
    readonly allocationWorktree: (repository: string, name: string) => string
  },
  session: WorktreeSession,
  loadOwner: (id: string) => Effect.Effect<WorktreeOwner | undefined>,
) {
  const ownerId = session.metadata.peer ?? session.id
  const owner = ownerId === session.id ? session : yield* loadOwner(ownerId)
  if (!owner)
    return { _tag: "Unresolved" as const, message: `owner session ${ownerId} has no row; nothing was deleted` }
  const path = worktreePath(layout, owner)
  if (path !== undefined) return { _tag: "Resolved" as const, path, ownerId: owner.id }
  const repository = owner.metadata.worktreeRepository
  const name = owner.metadata.worktreeName
  const message =
    repository === undefined && name === undefined
      ? `session id ${JSON.stringify(owner.id)} is not 8 lowercase hex; nothing was deleted`
      : `worktree allocation ${JSON.stringify(repository)}/${JSON.stringify(name)} on session ${owner.id} is not a safe path; nothing was deleted`
  return { _tag: "Unresolved" as const, message }
})

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
