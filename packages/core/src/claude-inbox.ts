// Claude coordinator inbox, this process only. The database marker suppresses paste; it is not a live generation.
// Detach, a user-terminal replace, and pane-move recovery are not implemented: each can deliver one message twice.
// Startup does not read or sweep the claims directory. A file this process did not record stays where it is.
import { Effect, FileSystem, type Path } from "effect"

/** Claude's fs.read rejects above this. It is not a guess about stdout. */
export const CLAUDE_INBOX_MAX_BYTES = 4 * 1024 * 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const isInboxId = (value: string) => UUID.test(value)

export const utf8Bytes = (value: string) => {
  let n = 0
  for (const char of value) {
    const code = char.codePointAt(0)!
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return n
}

/** Messages of rows the claim actually returned, in that order. Rows claim missed are not included. */
export const claimedText = (
  rows: ReadonlyArray<{ readonly id: number; readonly message: string }>,
  ids: ReadonlyArray<number>,
) => {
  const owned = new Set(ids)
  return rows
    .filter((row) => owned.has(row.id))
    .map((row) => row.message)
    .join("\n\n")
}

/** Remove only this publication's temp file. NotFound is success. Any other removal failure is logged and fails. */
export const removeOwnedTemp = (fs: FileSystem.FileSystem, tmp: string) =>
  fs.remove(tmp).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.void,
    ),
    Effect.tapError((error) => Effect.logWarning(`inbox claim temp ${tmp} was not removed: ${error.message}`)),
  )

export const writeClaimFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  body: string,
  suffix: string,
) => {
  const tmp = `${file}.${suffix}.tmp`
  return Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(tmp, body, { mode: 0o600 })
    yield* fs.rename(tmp, file)
  }).pipe(
    Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : Effect.uninterruptible(removeOwnedTemp(fs, tmp)))),
  )
}

export type ReceiptOp = "ack" | "release-retry" | "release-fail"

export type LiveClaim = { token: string; ids: ReadonlyArray<number>; file: string }

export type LiveAttachment = {
  generation: string
  claudeSessionId: string
  runtime: string
  address: string
  claim: LiveClaim | undefined
  receipt: { token: string; op: ReceiptOp } | undefined
}

/** One registry per process. A new Inbox layer starts empty, which is what a daemon restart is. */
export const createRegistry = () => {
  const byProject = new Map<number, LiveAttachment>()
  return {
    get: (projectId: number) => byProject.get(projectId),
    set: (projectId: number, live: LiveAttachment) => byProject.set(projectId, live),
    delete: (projectId: number) => byProject.delete(projectId),
    projects: () => [...byProject.keys()],
    clear: () => byProject.clear(),
  }
}
