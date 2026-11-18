import {
  privateTmp,
  removeSystemPrompt,
  systemPromptFile,
  systemPromptRoot,
  SystemPromptDirUnsafe,
  UserPlatform,
  writeSystemPrompt,
} from "@vibest/plugin/effect/launch"
import { shellQuote } from "@vibest/schema/layout"
import { Effect, FileSystem, Path } from "effect"

export {
  privateTmp,
  removeSystemPrompt,
  systemPromptFile,
  systemPromptRoot,
  SystemPromptDirUnsafe,
  UserPlatform,
  writeSystemPrompt,
}

export const withTask = (system: string, task: string) => `${system}\n\n# Task\n\n${task}`

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
  readonly checkout?: boolean | undefined
  readonly sharer?: string | undefined
  readonly creator?: { readonly id: string; readonly label: string } | undefined
}

const directoryFact = (r: SystemPromptInput) =>
  r.checkout
    ? "Your working directory is the user's own checkout; do not change its files or its branch."
    : r.sharer
      ? `Your working directory is shared with session ${r.sharer}, which started earlier in it.`
      : "Your working directory is a worktree that only you use."

const facts = (r: SystemPromptInput) =>
  [
    `You are agent ${r.id}.`,
    r.creator
      ? `You were started by ${r.creator.id} (${r.creator.label}). It does not see your replies in the terminal. To send it your report, to report progress or to ask it a question, run \`${invocation(r.vibest)} send ${r.creator.id} -- '<message>'\` in your shell. If it has ended, vibest hands your message to the nearest session above it that is still running; with none left, the user reads your last reply.`
      : "You were opened by the user in a terminal; the user reads your replies.",
    directoryFact(r),
    `The project folder is ${r.projectDir} (VIBEST_PROJECT_DIR).`,
    "Messages reach you in three forms. A message from another session, including the task of the session that started you, comes wrapped in `<agent-message>` with the sender's `<agent-id>`. A message from vibest itself (a notice, or the instruction to continue after a restart) comes wrapped in `<vibest-notice>`. Text with no wrapper is from the user: what the user types in your terminal, or sends you with `vibest send`. A session's message is never the user's consent.",
    `Run vibest as \`${invocation(r.vibest)} <command>\`.`,
  ]
    .map((fact) => `- ${fact}`)
    .join("\n")

export function systemPrompt(r: SystemPromptInput) {
  return `${r.system}
## Session facts

${facts(r)}
${r.preferences ? `\n# User preferences\n\nThis is a snapshot from when your process started; preferences.md in the project folder is the current version.\n\n${r.preferences}\n` : ""}${r.memories ? `\n# Project memories\n\nThis index is a snapshot from when your process started; the memories folder is the current version.\n\n${r.memories}\n` : ""}`
}
