import type { Harness } from "@vibest/plugin/effect"
import { Effect } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"

import { noProvider, opt } from "./models.ts"
import { nodePlatform } from "./node-platform.ts"
import { agySubscription } from "./subscriptions/agy.ts"
import { parseJson, record } from "./subscriptions/index.ts"

export const agyModels = (lines: ReadonlyArray<string>): ReadonlyArray<Harness.RawModel> | undefined => {
  const start = lines.findIndex((line) => line.startsWith("{"))
  const models = record(
    record(record(parseJson(start < 0 ? undefined : lines.slice(start).join("\n")))?.command)?.data,
  )?.models
  if (!Array.isArray(models)) return undefined
  return models.flatMap((model) => {
    const m = record(model)
    return typeof m?.id === "string"
      ? [{ model: m.id, ...(typeof m.label === "string" ? { name: m.label } : {}), default: false }]
      : []
  })
}

export const agyConversation = (event: Readonly<Record<string, unknown>>): string | undefined =>
  typeof event.conversationId === "string" && event.conversationId !== "" ? event.conversationId : undefined

export const agyExecutionEnd = (event: Readonly<Record<string, unknown>>) => {
  if (event.hookEventName !== "Stop" || event.continuationActive === true) return undefined
  const error = typeof event.error === "string" ? event.error : ""
  return { end: { text: "", conversation_id: agyConversation(event), ...(error !== "" ? { error } : {}) } }
}

const agyStartup: NonNullable<Harness.HarnessDefinition["startup"]> = Effect.succeed((pane) =>
  Effect.gen(function* () {
    const screen = yield* pane.screen
    if (screen.includes("Do you trust the contents of this project?") && screen.includes("> Yes, I trust this folder"))
      yield* pane.sendKeys(["enter"])
  }),
)

export const agy: Harness.HarnessDefinition = {
  id: "agy",
  binary: "agy",
  ownSessionId: false,
  systemPromptInPrompt: true,
  interruptKey: "esc",
  startup: agyStartup,
  replyField: "text",
  ready: "runtime",
  checkProvider: noProvider("agy"),
  launchArgs: (i) => [
    ...(i.resume && i.sessionId ? ["--conversation", i.sessionId] : []),
    "--dangerously-skip-permissions",
    "--add-dir",
    i.projectDir,
    "--add-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  models: { args: () => ["--output-format", "json", "models"], answer: agyModels },
  subscription: (home, binary) =>
    Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
      Effect.flatMap((spawner) => agySubscription(spawner)(home, binary)),
      Effect.provide(nodePlatform),
    ),
  conversationOf: agyConversation,
  userPrompt: (event) => (event.hookEventName === "PreInvocation" ? { text: "" } : undefined),
  executionEnd: agyExecutionEnd,
}
