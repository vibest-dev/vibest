import type { Harness } from "@vibest/plugin/effect"
import { Effect, Predicate, type Schema } from "effect"

import { noProvider, opt } from "./models.ts"
import { parseJson, record } from "./subscriptions/index.ts"

export const agyModels = (lines: ReadonlyArray<string>): ReadonlyArray<Harness.RawModel> | undefined => {
  const start = lines.findIndex((line) => line.startsWith("{"))

  const models = record(
    record(record(parseJson(start < 0 ? undefined : lines.slice(start).join("\n")))?.command)?.data,
  )?.models

  if (!Array.isArray(models)) return undefined

  return models.flatMap((model) => {
    const m = record(model)

    return Predicate.isString(m?.id)
      ? [{ model: m.id, ...(Predicate.isString(m.label) && { name: m.label }), default: false }]
      : []
  })
}

export const agyConversation = (event: Schema.JsonObject): string | undefined =>
  Predicate.isString(event.conversationId) && event.conversationId !== "" ? event.conversationId : undefined

export const agyExecutionEnd = (event: Schema.JsonObject) => {
  if (event.hookEventName !== "Stop" || event.continuationActive === true) return undefined
  const error = Predicate.isString(event.error) ? event.error : ""
  const conversation = agyConversation(event)

  return {
    reply: "",
    ...(conversation !== undefined && { conversation }),
    ...(error !== "" && { failure: error }),
  }
}

const GUARDED_TOOLS = new Map([
  ["read_file", "Read"],
  ["view_file", "Read"],
  ["write_file", "Write"],
  ["write_to_file", "Write"],
  ["edit_file", "Edit"],
  ["replace_file_content", "Edit"],
  ["multi_replace_file_content", "Edit"],
  ["list_dir", "LS"],
  ["grep_search", "Grep"],
  ["find_by_name", "Find"],
])

const PATH_ARGS = ["Path", "AbsolutePath", "TargetFile", "File", "DirectoryPath", "SearchPath", "SearchDirectory"]

const text = (value: Schema.Json | undefined) => (Predicate.isString(value) && value !== "" ? value : undefined)

export const agyGuardCall = (event: Schema.JsonObject) => {
  const call = record(event.toolCall)

  if (call === undefined) return undefined
  const { name, args } = call
  const input = record(args) ?? {}
  const at = { ...(event.cwd !== undefined && { cwd: event.cwd }) }

  if (name === "run_command") {
    const cwd = text(input.Cwd)
    const command = input.CommandLine

    return {
      ...at,
      tool_name: "Bash",
      tool_input: { ...(command !== undefined && { command }), ...(cwd && { cwd }) },
    }
  }

  const tool = Predicate.isString(name) ? GUARDED_TOOLS.get(name) : undefined

  if (tool === undefined) return undefined
  const path = PATH_ARGS.map((key) => text(input[key])).find((value) => value !== undefined)

  return { ...at, tool_name: tool, tool_input: path === undefined ? {} : { path } }
}

const agyStartup: NonNullable<Harness.HarnessDefinition["startup"]> = Effect.succeed((pane) =>
  Effect.gen(function* () {
    const screen = yield* pane.screen

    if (screen.includes("Do you trust the contents of this project?") && screen.includes("> Yes, I trust this folder"))
      yield* pane.sendKeys(["enter"])
  }),
)

const LINE_KILLS = 40

export const agy: Harness.HarnessDefinition = {
  id: "agy",
  binary: "agy",
  delivery: "typed",
  ownSessionId: false,
  systemPromptInPrompt: true,
  interruptKey: "esc",
  promptArgs: ["--prompt-interactive"],
  clearKeys: ["ctrl+e", ...Array.from({ length: LINE_KILLS }, () => "ctrl+u")],
  startup: agyStartup,
  ready: "runtime",
  checkProvider: noProvider("agy"),
  launchArgs: (i) => [
    ...(i.resume && i.sessionId ? ["--conversation", i.sessionId] : []),
    "--dangerously-skip-permissions",
    "--add-dir",
    i.projectDir,
    ...(i.scratchpadDir ? ["--add-dir", i.scratchpadDir] : []),
    "--add-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  models: { args: () => ["--output-format", "json", "models"], answer: agyModels },
  conversationOf: agyConversation,
  userPrompt: (event) => (event.hookEventName === "PreInvocation" ? { activity: true } : undefined),
  executionEnd: agyExecutionEnd,
  guardCall: agyGuardCall,
  guardAnswer: (reason) => (reason ? { decision: "deny", reason } : { decision: "allow" }),
}
