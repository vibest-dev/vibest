// An example third-party harness plugin (not loaded by default): `hookcli`, an agent CLI that has only shell hooks. It
// registers its adapter with `context.harness.register`; nothing in vibest names it. Its integration is the hook
// config it passes on the command line for this one session: each hook runs
// `vibest integration event --harness hookcli <hook>` with the hook's JSON on stdin, and `decode` below turns that
// payload into vibest's neutral events. vibest installs nothing into the CLI's own configuration.
//
// The hooks it has (as a real CLI of this kind would document them):
//   session  { id }                       its conversation id
//   prompt   { prompt }                   a prompt was submitted (typed in the pane, or typed by vibest)
//   pre_tool { tool, input, cwd }         before a tool runs; its answer `{ decision, reason? }` allows or refuses it
//   reply    { text }                     the turn's last answer
//   stop     { status }                   the turn ended: completed, aborted (Esc) or error
import { Plugin } from "@vibest/plugin"
import type { Harness } from "@vibest/plugin"
import { toolCallOf } from "@vibest/protocol/tools"

const HOOKS = ["session", "prompt", "pre_tool", "reply", "stop"] as const

const str = (value: unknown) => (typeof value === "string" ? value : undefined)

const decode: NonNullable<Harness.HarnessAdapter["decode"]> = (hook, payload) => {
  if (hook === "session") {
    const id = str(payload.id)
    return id === undefined ? [] : [{ type: "conversation", conversation: id }]
  }
  if (hook === "prompt") return [{ type: "turn.start", origin: "typed", text: str(payload.prompt) ?? "" }]
  if (hook === "pre_tool")
    return {
      tool: toolCallOf(
        str(payload.tool) ?? "",
        (payload.input ?? {}) as Readonly<Record<string, unknown>>,
        str(payload.cwd) ?? "",
      ),
    }
  if (hook === "reply") return [{ type: "turn.end", outcome: "completed", text: str(payload.text) ?? "" }]
  if (hook === "stop") {
    const status = str(payload.status)
    if (status === "aborted") return [{ type: "turn.end", outcome: "interrupted" }]
    if (status === "error")
      return [
        { type: "turn.end", outcome: "failed", failure: { kind: "other", message: "hookcli stopped on an error" } },
      ]
    return []
  }
  return undefined
}

export const hookcli: Harness.HarnessAdapter = {
  id: "hookcli",
  binary: "hookcli",
  // It reports its conversation id in its `session` hook.
  conversation: "reported",
  // No system-prompt flag: the rules go in front of the first prompt.
  systemPromptInPrompt: true,
  interruptKey: "esc",
  // Hooks only: it cannot take rows itself, so vibest types them; it cannot report ready or blocked, so the runtime's
  // agent state stands for them.
  delivery: "type",
  reportsState: false,
  checkProvider: (provider) => (provider === null ? undefined : "hookcli has no providers"),
  launchArgs: (i) => [
    ...(i.resume && i.sessionId ? ["--resume", i.sessionId] : []),
    "--hooks",
    JSON.stringify(
      Object.fromEntries(
        HOOKS.map((h) => [h, [...i.vibest, "integration", "event", "--harness", "hookcli", h].join(" ")]),
      ),
    ),
    ...(i.model ? ["--model", i.model] : []),
  ],
  models: { args: () => ["models"], answer: (lines) => lines.map((l) => ({ model: l.trim(), default: false })) },
  guardAnswer: (reason) => (reason === undefined ? { decision: "allow" } : { decision: "deny", reason }),
  decode,
}

export const hookcliPlugin = Plugin.define({ id: "harness-hookcli", effect: (ctx) => ctx.harness.register(hookcli) })
