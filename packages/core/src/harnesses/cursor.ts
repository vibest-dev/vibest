import { Effect, FileSystem, Path } from "effect"

import { anthropicOnly, type HarnessAdapter, opt } from "../harness.ts"
import type { RawModel } from "../models.ts"

export const cursorModels = (lines: ReadonlyArray<string>): ReadonlyArray<RawModel> | undefined => {
  if (!lines.some((l) => l.startsWith("Available models"))) return undefined
  return lines.flatMap((l) => {
    const m = /^(\S+) - (.+?)(?: \(([^)]*)\))?$/.exec(l.trim())
    return m ? [{ model: m[1]!, name: m[2]!, default: (m[3] ?? "").split(/,\s*/).includes("current") }] : []
  })
}

export const cursorEnvironment = (home: string) =>
  Effect.gen(function* () {
    const platform = (globalThis as { readonly process?: { readonly platform?: string } }).process?.platform
    if (platform !== "darwin") return undefined
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const keychains = path.join(home, "Library", "Keychains")
    const present =
      home !== "" &&
      (yield* fs.stat(keychains).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      ))
    return present
      ? undefined
      : `Cursor is disabled: HOME has no Library/Keychains directory (${home || "unset"}); use the macOS login home to avoid Cursor's keychain probe dialog`
  })

export const cursor: HarnessAdapter = {
  id: "cursor",
  binary: "cursor-agent",
  checkEnvironment: cursorEnvironment,
  ownSessionId: false,
  systemPromptInPrompt: true,
  interruptKey: "ctrl+c",
  resultField: "text",
  ready: "runtime",
  checkProvider: anthropicOnly("cursor"),
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
  guardAnswer: (reason) =>
    reason ? { permission: "deny", user_message: reason, agent_message: reason } : { permission: "allow" },
  conversationOf: (event) => (typeof event.conversation_id === "string" ? event.conversation_id : undefined),
  userPrompt: (event, coordinator) => {
    if (coordinator || event.hook_event_name !== "beforeSubmitPrompt") return undefined
    if (typeof event.prompt !== "string" || event.prompt.trim() === "") return undefined
    return { text: event.prompt }
  },
  turnEnd: (event, coordinator) => {
    if (coordinator) return undefined
    if (event.hook_event_name === "afterAgentResponse") return { result: event }
    if (event.hook_event_name !== "stop" || typeof event.status !== "string" || event.status === "completed")
      return undefined
    return { result: { ...event, error: `the turn ended with status ${event.status}` } }
  },
}
