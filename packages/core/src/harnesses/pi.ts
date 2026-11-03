// Pi: vibest's plugin is the @vibest/pi extension (its turn-end report, the coordinator's inbox, and the guard on tool
// calls, in process), loaded with `pi -e` into each Pi vibest starts; models come from `pi --mode rpc`.
import { Schema } from "effect"

import { type HarnessAdapter, opt } from "../harness.ts"
import { findMessage, jsonLines, type RawModel, withConfigured } from "../models.ts"

/** The extension in vibest's Pi plugin directory (packages/integration/pi/scripts/build.ts). */
const extension = (pluginDir: string) => `${pluginDir}/extension.mjs`

const piState = findMessage(
  Schema.Struct({
    id: Schema.Literal("vibest-state"),
    type: Schema.Literal("response"),
    data: Schema.optional(
      Schema.Struct({
        model: Schema.optional(Schema.NullOr(Schema.Struct({ provider: Schema.String, id: Schema.String }))),
      }),
    ),
  }),
)
const piList = findMessage(
  Schema.Struct({
    id: Schema.Literal("vibest-models"),
    type: Schema.Literal("response"),
    data: Schema.Struct({
      models: Schema.Array(
        Schema.Struct({
          provider: Schema.String,
          id: Schema.String,
          name: Schema.String,
          contextWindow: Schema.Number,
          maxTokens: Schema.Number,
        }),
      ),
    }),
  }),
)

/** Pi: `pi --mode rpc`, `get_state` for the model it starts with and `get_available_models` for every provider's models. */
export const piModels = (lines: ReadonlyArray<string>): ReadonlyArray<RawModel> | undefined => {
  const state = piState(lines)
  const list = piList(lines)
  if (!state || !list) return undefined
  const current = state.data?.model ?? undefined
  return withConfigured(
    list.data.models.map((m) => ({
      provider: m.provider,
      model: m.id,
      name: m.name,
      description: `${m.contextWindow} context, ${m.maxTokens} max output tokens`,
      default: m.provider === current?.provider && m.id === current.id,
    })),
    current && { provider: current.provider, model: current.id },
  )
}

/**
 * Pi refuses `--provider` without `--model` ("--provider requires --model"), so a login chosen without a model is
 * dropped and Pi starts on its own default.
 * ponytail: the chosen login is lost then; pick that provider's default model when quota routing on Pi matters.
 */
const providerModel = (provider: string | null, model: string | null) =>
  model ? [...opt("--provider", provider), "--model", model] : []

export const pi: HarnessAdapter = {
  id: "pi",
  binary: "pi",
  conversation: "assigned",
  rulesInPrompt: false,
  interruptKey: "esc",
  delivery: "poll",
  reportsState: true,
  checkProvider: () => undefined,
  launchArgs: (i) => [
    "--session-id",
    i.sessionId!,
    "--append-system-prompt",
    i.rulesFile,
    "-e",
    extension(i.pluginDir),
    // Exact allowlist, as coordinatorArgs does: no write or edit tool. bash stays; the guard refuses commands that write.
    ...providerModel(i.provider, i.model),
  ],
  // The rules replace Pi's coding-assistant preamble; Pi still adds context files (AGENTS.md), skills and cwd after them.
  coordinatorArgs: (i) => [
    ...opt("--session-id", i.sessionId),
    "--system-prompt",
    i.rulesFile,
    // An exact allowlist, not +/- entries on the defaults: those keep every extension's tools, and a user's delegation
    // extension (pi-subagents' `subagent`) then wins over `vibest run`. Extensions still load; only their tools are off.
    "--tools",
    "read,bash,codemode,grep,find,ls",
    "--no-mcp",
    "-e",
    extension(i.pluginDir),
    ...providerModel(i.provider, i.model),
  ],
  models: {
    args: () => ["--mode", "rpc", "--no-session"],
    request: jsonLines(
      { id: "vibest-state", type: "get_state" },
      { id: "vibest-models", type: "get_available_models" },
    ),
    answer: piModels,
  },
}
