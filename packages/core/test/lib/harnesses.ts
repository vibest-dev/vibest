import { Harness, Harnesses, HarnessUnavailable, makeHarnesses } from "@vibest/core/harness"
import type { HarnessDefinition, HarnessesShape } from "@vibest/core/host"
import { normalizeModels } from "@vibest/core/models"
import { HostEnv, Runtimes } from "@vibest/core/runtimes"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { Effect, Layer, type Scope } from "effect"

const opt = (flag: string, value: string | null) => (value ? [flag, value] : [])

const providerModel = (provider: string | null, model: string | null) =>
  model ? [...opt("--provider", provider), "--model", model] : []

export const PI: HarnessDefinition = {
  id: "pi",
  binary: "pi",
  ownSessionId: true,
  systemPromptInPrompt: false,
  interruptKey: "esc",
  replyField: "text",
  inbox: "subscribe",
  ready: "integration",
  launchArgs: (i) => [
    "--session-id",
    i.sessionId!,
    "--append-system-prompt",
    i.systemPromptFile,
    "-e",
    `${i.pluginDir}/extension.mjs`,
    ...providerModel(i.provider, i.model),
  ],
  coordinatorArgs: (i) => [
    ...opt("--session-id", i.sessionId),
    "--system-prompt",
    i.systemPromptFile,
    "-e",
    `${i.pluginDir}/extension.mjs`,
    ...providerModel(i.provider, i.model),
  ],
  models: { args: () => [], answer: () => undefined },
  executionEnd: (event, coordinator) =>
    coordinator || event.type !== "agent_settled"
      ? undefined
      : { end: { text: typeof event.text === "string" ? event.text : "", error: "", aborted: false } },
  userPrompt: (event, coordinator) =>
    coordinator || event.type !== "input" || typeof event.text !== "string" || event.text.trim() === ""
      ? undefined
      : { text: event.text },
}

const noProvider = (harness: string) => (provider: string | null) =>
  provider ? `${harness} has no provider option` : undefined

export const CLAUDE: HarnessDefinition = {
  id: "claude",
  binary: "claude",
  ownSessionId: true,
  systemPromptInPrompt: false,
  interruptKey: "esc",
  replyField: "last_assistant_message",
  inbox: "poll",
  ready: "integration",
  checkProvider: noProvider("claude"),
  launchArgs: (i) => [
    ...(i.resume ? ["--resume", i.sessionId!] : ["--session-id", i.sessionId!]),
    "--append-system-prompt-file",
    i.systemPromptFile,
    "--plugin-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  coordinatorArgs: (i) => [
    ...opt("--resume", i.sessionId),
    "--append-system-prompt-file",
    i.systemPromptFile,
    "--plugin-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  models: { args: () => [], answer: () => undefined },
  executionEnd: (event, coordinator) =>
    coordinator || event.hook_event_name !== "ExecutionComplete"
      ? undefined
      : {
          end:
            event.reason === "answer"
              ? event
              : event.reason === "aborted"
                ? {
                    ...event,
                    aborted: true,
                    error: "interrupted",
                    error_details: "the execution was stopped in its terminal (Esc) before it ended",
                  }
                : { ...event, error: "error", error_details: "the execution ended on an API error" },
        },
  userPrompt: (event, coordinator) =>
    coordinator || event.hook_event_name !== "PromptSubmit" || typeof event.text !== "string" || !event.text.trim()
      ? undefined
      : { text: event.text },
}

export const CURSOR: HarnessDefinition = {
  id: "cursor",
  binary: "cursor-agent",
  ownSessionId: false,
  systemPromptInPrompt: true,
  interruptKey: "ctrl+c",
  replyField: "text",
  ready: "runtime",
  checkProvider: noProvider("cursor"),
  launchArgs: (i) => [
    ...(i.resume && i.sessionId ? [`--resume=${i.sessionId}`] : []),
    "--plugin-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  models: { args: () => [], answer: () => undefined },
  guardAnswer: (reason) =>
    reason ? { permission: "deny", user_message: reason, agent_message: reason } : { permission: "allow" },
  conversationOf: (event) => (typeof event.conversation_id === "string" ? event.conversation_id : undefined),
  executionEnd: (event, coordinator) =>
    !coordinator && event.hook_event_name === "afterAgentResponse" ? { end: event } : undefined,
  userPrompt: (event, coordinator) => {
    if (coordinator) return undefined
    if (event.hook_event_name === "afterAgentThought" || event.hook_event_name === "postToolUse") return { text: "" }
    return event.hook_event_name === "beforeSubmitPrompt" && typeof event.prompt === "string" && event.prompt.trim()
      ? { text: event.prompt }
      : undefined
  },
}

export const HARNESSES: ReadonlyArray<HarnessDefinition> = [PI, CLAUDE, CURSOR]

export const harnessesFrom = (
  definitions: ReadonlyArray<HarnessDefinition> = HARNESSES,
): Effect.Effect<HarnessesShape, never, Scope.Scope> =>
  Effect.tap(makeHarnesses, (harnesses) =>
    harnesses.transform((editor) => definitions.forEach((definition) => editor.add(definition))),
  )

export const noHostEnv = Layer.succeed(HostEnv, { drop: () => {} })

export const runtimesLayer = Runtimes.layer.pipe(Layer.provide(noHostEnv))

export const harnessesLayer = (definitions: ReadonlyArray<HarnessDefinition> = HARNESSES) =>
  Layer.effect(Harnesses, harnessesFrom(definitions))

export interface HarnessStandIn {
  readonly hooked?: ReadonlyArray<string>
  readonly unusable?: ReadonlyArray<string>
  readonly models?: ReadonlyArray<string>
  readonly missingBinary?: ReadonlyArray<string>
  readonly harnesses?: ReadonlyArray<HarnessDefinition>
}

export const harnessLayer = (options: HarnessStandIn = {}) =>
  Layer.succeed(Harness, {
    available: (id) => Effect.succeed(!(options.missingBinary ?? []).includes(id)),
    plugin: (id) =>
      (options.hooked ?? (options.harnesses ?? HARNESSES).map((h) => h.id)).includes(id)
        ? Effect.succeed(`/vibest/harnesses/${id}`)
        : Effect.fail(
            new HarnessUnavailable({
              harness: id,
              message: `vibest's ${id} plugin is missing: /vibest/harnesses/${id}`,
            }),
          ),
    models: (id, provider) =>
      options.unusable?.includes(id)
        ? Effect.fail(new HarnessUnavailable({ harness: id, message: "Not logged in" }))
        : Effect.succeed(
            normalizeModels(id, provider, [
              { model: "fake-model", default: true },
              ...["fake-strong", ...(options.models ?? [])].map((model) => ({ model, default: false })),
            ]),
          ),
  })

export const subscriptionsLayer = Subscriptions.testLayer.pipe(Layer.provide(harnessLayer()))
