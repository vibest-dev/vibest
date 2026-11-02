// Cursor (cursor-agent): vibest's plugin @vibest/cursor, loaded with `--plugin-dir` into each Cursor vibest starts; rules
// in the first prompt; models from `cursor-agent models`. Not a Coordinator.
import { anthropicOnly, type HarnessAdapter, opt } from "../harness.ts"
import type { RawModel } from "../models.ts"

/** Cursor: `cursor-agent models`, lines of `id - Name (tags)`. `current` is what it runs without --model (`default` is the server's pick). */
export const cursorModels = (lines: ReadonlyArray<string>): ReadonlyArray<RawModel> | undefined => {
  if (!lines.some((l) => l.startsWith("Available models"))) return undefined
  return lines.flatMap((l) => {
    const m = /^(\S+) - (.+?)(?: \(([^)]*)\))?$/.exec(l.trim())
    return m ? [{ model: m[1]!, name: m[2]!, default: (m[3] ?? "").split(/,\s*/).includes("current") }] : []
  })
}

export const cursor: HarnessAdapter = {
  id: "cursor",
  binary: "cursor-agent",
  ownSessionId: false,
  rulesInPrompt: true,
  interruptKey: "ctrl+c",
  resultField: "text",
  inbox: "prompt",
  checkProvider: anthropicOnly("cursor"),
  launchArgs: (i) => [
    // One argument: `--resume [chatId]` takes an optional value, so a separate id starting with - would be read as a flag.
    ...(i.resume && i.sessionId ? [`--resume=${i.sessionId}`] : []),
    "--add-dir",
    i.scratch,
    "--trust",
    "--plugin-dir",
    i.pluginDir,
    // `cursor-agent --help`: --mode plan is read-only (no edits). The guard is the backstop.
    ...opt("--model", i.model),
  ],
  models: { args: () => ["models"], answer: cursorModels },
  // An explicit answer either way (its hook runs fail-closed); allow only lets the call go on to its usual permission checks.
  guardAnswer: (reason) =>
    reason ? { permission: "deny", user_message: reason, agent_message: reason } : { permission: "allow" },
  // Every hook's input carries it.
  conversationOf: (event) => (typeof event.conversation_id === "string" ? event.conversation_id : undefined),
  // beforeSubmitPrompt (cursor-agent 2026.10.22). The coordinator is not a Cursor session; an empty prompt is not a round.
  userPrompt: (event, coordinator) => {
    if (coordinator || event.hook_event_name !== "beforeSubmitPrompt") return undefined
    if (typeof event.prompt !== "string" || event.prompt.trim() === "") return undefined
    return { text: event.prompt }
  },
  // afterAgentResponse carries the reply (`text`); stop only a status, so it counts when the turn did not complete.
  turnEnd: (event, coordinator) => {
    if (coordinator) return undefined
    if (event.hook_event_name === "afterAgentResponse") return { result: event }
    if (event.hook_event_name !== "stop" || typeof event.status !== "string" || event.status === "completed")
      return undefined
    return { result: { ...event, error: `the turn ended with status ${event.status}` } }
  },
}
