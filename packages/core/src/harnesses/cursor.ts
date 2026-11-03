// Cursor (cursor-agent): vibest's plugin @vibest/cursor, loaded with `--plugin-dir` into each Cursor vibest starts; rules
// in the first prompt; models from `cursor-agent models`. Not a Coordinator.
import type { IntegrationEvent } from "@vibest/protocol/protocol"
import { toolCallOf } from "@vibest/protocol/tools"

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

const str = (value: unknown) => (typeof value === "string" ? value : undefined)

/**
 * cursor-agent 2026.10.22's hooks as neutral events: every hook names its conversation (`conversation_id`, only a plain
 * id, never one that reads as a flag); beforeSubmitPrompt is a typed turn start (vibest types its deliveries too),
 * afterAgentResponse carries the reply, stop only a status (a turn end when it did not complete); preToolUse is a tool
 * call, at the call's own cwd (a Shell's `tool_input.cwd`), else the hook's, else its one workspace root.
 */
export const decodeCursor = (
  hook: string,
  payload: Readonly<Record<string, unknown>>,
): ReadonlyArray<IntegrationEvent> | { readonly tool: ReturnType<typeof toolCallOf> } | undefined => {
  if (hook === "preToolUse") {
    const input = (payload.tool_input ?? {}) as Readonly<Record<string, unknown>>
    const roots = Array.isArray(payload.workspace_roots)
      ? payload.workspace_roots.filter((r) => typeof r === "string")
      : []
    const base = str(payload.cwd) || (roots.length === 1 ? (roots[0] as string) : "")
    const own = str(input.cwd)
    const cwd = own ? (own.startsWith("/") ? own : `${base}/${own}`) : base
    return { tool: toolCallOf(str(payload.tool_name) ?? "", input, cwd) }
  }
  const id = str(payload.conversation_id)
  const conversation: ReadonlyArray<IntegrationEvent> =
    id !== undefined && /^\w[\w.:-]{0,127}$/.test(id) ? [{ type: "conversation", conversation: id }] : []
  if (hook === "beforeSubmitPrompt") {
    const text = str(payload.prompt) ?? ""
    return text.trim() === "" ? conversation : [...conversation, { type: "turn.start", origin: "typed", text }]
  }
  if (hook === "afterAgentResponse")
    return [...conversation, { type: "turn.end", outcome: "completed", text: str(payload.text) ?? "" }]
  if (hook === "stop") {
    const status = str(payload.status)
    if (status === undefined || status === "completed") return conversation
    return [
      ...conversation,
      status === "aborted"
        ? { type: "turn.end", outcome: "interrupted" }
        : {
            type: "turn.end",
            outcome: "failed",
            failure: { kind: "other", message: `the turn ended with status ${status}` },
          },
    ]
  }
  return conversation
}

export const cursor: HarnessAdapter = {
  id: "cursor",
  binary: "cursor-agent",
  conversation: "reported",
  rulesInPrompt: true,
  interruptKey: "ctrl+c",
  delivery: "type",
  reportsReady: false,
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
  decode: (hook, payload) => decodeCursor(hook, payload),
}
