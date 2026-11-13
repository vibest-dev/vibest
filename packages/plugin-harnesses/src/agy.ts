import type { Harness } from "@vibest/plugin"
import { shellQuote } from "@vibest/schema/layout"
import { Effect } from "effect"

import { noProvider, opt } from "./models.ts"
import { platform } from "./platform.ts"
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

export const agyConversation = (event: Harness.HarnessEvent): string | undefined =>
  typeof event.conversation_id === "string" && event.conversation_id !== "" ? event.conversation_id : undefined

const statusLine = (pluginDir: string) =>
  JSON.stringify({
    statusLine: {
      type: "command",
      command: `sh ${shellQuote(`${pluginDir}/status.sh`)}`,
      stack_with_default: true,
    },
  })

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
    "--settings",
    statusLine(i.pluginDir),
    ...opt("--model", i.model),
  ],
  models: { args: () => ["--output-format", "json", "models"], answer: agyModels },
  subscription: (home, binary) => agySubscription(home, binary).pipe(Effect.provide(platform)),
  conversationOf: agyConversation,
}
