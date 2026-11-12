import { Config, Context, Data, Effect, FileSystem, Option, Path } from "effect"

import { shellQuote, writeAtomic } from "./paths.ts"

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

export const writeSystemPrompt = Effect.fn("writeSystemPrompt")(function* (id: string, text: string) {
  const path = yield* Path.Path
  const file = path.join(yield* systemPromptRoot, id, "system-prompt.md")
  yield* writeAtomic(file, text)
  return file
})

export const removeSystemPrompt = (id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.remove(path.join(yield* systemPromptRoot, id), { recursive: true, force: true })
  }).pipe(Effect.ignore)

export const INJECT_LIMIT = 16000
const INDEX_LIMIT = 200
const SUMMARY_LIMIT = 150

const truncate = (text: string, what: string) =>
  text.length <= INJECT_LIMIT
    ? text
    : `${text.slice(0, INJECT_LIMIT)}\n\n[${what} truncated at ${INJECT_LIMIT} characters]`

const clip = (text: string) => (text.length <= SUMMARY_LIMIT ? text : text.slice(0, SUMMARY_LIMIT))

const memorySummary = (text: string) => {
  const lines = text.split(/\r?\n/)
  let rest = lines
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---")
    if (end > 0) {
      const field = lines.slice(1, end).find((line) => /^\s*description\s*:/.test(line))
      const value = field
        ?.replace(/^\s*description\s*:\s*/, "")
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2")
        .trim()
      if (value) return clip(value)
      rest = lines.slice(end + 1)
    }
  }
  const line = rest.find((l) => {
    const t = l.trim()
    return t !== "" && t !== "---"
  })
  return clip((line ?? "").trim().replace(/^#+\s*/, ""))
}

const memoryIndex = (entries: ReadonlyArray<readonly [string, string]>, left: number) => {
  if (entries.length === 0) return ""
  const lines = [
    "Each line is a file in the project folder; read it with your file tools when its line is relevant to the work.",
    ...entries.map(([rel, body]) => {
      const summary = memorySummary(body)
      return summary === "" ? `- memories/${rel}` : `- memories/${rel} — ${summary}`
    }),
  ]
  if (left > 0) lines.push(`${left} ${left === 1 ? "entry" : "entries"} left out; the folder holds them all.`)
  return lines.join("\n")
}

const invocation = (vibest: ReadonlyArray<string>) => vibest.map(shellQuote).join(" ")

export const projectText = Effect.fn("projectText")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const preferences = yield* fs.readFileString(path.join(projectDir, "preferences.md")).pipe(
    Effect.map((s) => s.trim()),
    Effect.orElseSucceed(() => ""),
  )
  const memoriesDir = path.join(projectDir, "memories")
  const names = (yield* fs.readDirectory(memoriesDir, { recursive: true }).pipe(Effect.orElseSucceed(() => [])))
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ file: f, rel: f.split(path.sep).join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const shown = names.slice(0, INDEX_LIMIT)
  const entries: Array<readonly [string, string]> = []
  for (const name of shown) {
    const body = yield* fs.readFileString(path.join(memoriesDir, name.file)).pipe(Effect.orElseSucceed(() => undefined))
    if (body !== undefined) entries.push([name.rel, body])
  }
  return {
    preferences: truncate(preferences, "preferences"),
    memories: memoryIndex(entries, names.length - shown.length),
  }
})

export interface SystemPromptInput {
  readonly system: string
  readonly id: string
  readonly projectDir: string
  readonly vibest: ReadonlyArray<string>
  readonly preferences: string
  readonly memories: string
  readonly peer?: string | undefined
  readonly creator?: { readonly id: string; readonly label: string } | undefined
}

const facts = (r: SystemPromptInput) =>
  [
    `You are agent ${r.id}.`,
    r.creator
      ? `You were started by ${r.creator.id} (${r.creator.label}). To send it your report, to report progress or to ask it a question, run \`${invocation(r.vibest)} send ${r.creator.id} -- '<message>'\` in your shell.`
      : "You were opened by the user in a terminal; the user reads your replies.",
    ...(r.peer ? [`Your working directory is shared with session ${r.peer}, which started earlier in it.`] : []),
    `The project folder is ${r.projectDir} (VIBEST_PROJECT_DIR).`,
  ]
    .map((fact) => `- ${fact}`)
    .join("\n")

export function systemPrompt(r: SystemPromptInput) {
  return `${r.system}
## Session facts

${facts(r)}
${r.preferences ? `\n# User preferences\n\n${r.preferences}\n` : ""}${r.memories ? `\n# Project memories\n\n${r.memories}\n` : ""}`
}
