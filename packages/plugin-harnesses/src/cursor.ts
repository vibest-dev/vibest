import type { Harness } from "@vibest/plugin"
import { Effect, FileSystem, Path } from "effect"

import { noProvider, opt } from "./models.ts"
import { platform } from "./platform.ts"
import { cursorSubscription } from "./subscriptions/cursor.ts"

export const cursorModels = (lines: ReadonlyArray<string>): ReadonlyArray<Harness.RawModel> | undefined => {
  if (!lines.some((l) => l.startsWith("Available models"))) return undefined
  return lines.flatMap((l) => {
    const m = /^(\S+) - (.+?)(?: \(([^)]*)\))?$/.exec(l.trim())
    return m ? [{ model: m[1]!, name: m[2]!, default: (m[3] ?? "").split(/,\s*/).includes("current") }] : []
  })
}

export const keychainProblem = (home: string) =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") return undefined
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const keychain = path.join(home, "Library", "Keychains", "login.keychain-db")
    const present =
      home !== "" &&
      (yield* fs.stat(keychain).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      ))
    return present
      ? undefined
      : `Cursor is disabled: HOME has no login keychain file (${keychain}); use the macOS login home to avoid Cursor's keychain probe dialog`
  })

const cursorEnvironment = (home: string) => keychainProblem(home).pipe(Effect.provide(platform))

export const cursor: Harness.HarnessDefinition = {
  id: "cursor",
  binary: "cursor-agent",
  checkEnvironment: cursorEnvironment,
  ownSessionId: false,
  systemPromptInPrompt: true,
  interruptKey: "ctrl+c",
  resultField: "text",
  ready: "runtime",
  checkProvider: noProvider("cursor"),
  launchArgs: (i) => [
    ...(i.resume && i.sessionId ? [`--resume=${i.sessionId}`] : []),
    "--add-dir",
    i.projectDir,
    "--trust",
    "--plugin-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  models: { args: () => ["models"], answer: cursorModels },
  subscription: (home) =>
    Effect.flatMap(cursorEnvironment(home), (problem) => cursorSubscription(home, problem)).pipe(
      Effect.provide(platform),
    ),
  guardAnswer: (reason) =>
    reason ? { permission: "deny", user_message: reason, agent_message: reason } : { permission: "allow" },
  conversationOf: (event) => (typeof event.conversation_id === "string" ? event.conversation_id : undefined),
  userPrompt: (event, coordinator) => {
    if (coordinator) return undefined
    if (event.hook_event_name === "afterAgentThought" || event.hook_event_name === "postToolUse") return { text: "" }
    if (event.hook_event_name !== "beforeSubmitPrompt" || typeof event.prompt !== "string" || !event.prompt.trim())
      return undefined
    return { text: event.prompt }
  },
  turnEnd: (event, coordinator) =>
    !coordinator && event.hook_event_name === "afterAgentResponse" ? { result: event } : undefined,
}
