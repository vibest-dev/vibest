import type { SubscriptionAccount, SubscriptionLimit } from "@vibest/schema/subscription"
import type { Effect, Schema, Types } from "effect"

import type { Transform } from "./registration.ts"

export interface LaunchInput {
  readonly worktree: string
  readonly projectDir: string
  readonly scratchDir?: string | undefined
  readonly systemPromptFile: string
  readonly provider: string | null
  readonly model: string | null
  readonly sessionId: string | null
  readonly resume: boolean
  readonly pluginDir: string
  readonly vibest: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

interface StartupPane {
  readonly screen: Effect.Effect<string>
  readonly sendKeys: (keys: ReadonlyArray<string>) => Effect.Effect<void>
}

export interface RawModel {
  readonly model: string
  readonly provider?: string | undefined
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly default: boolean
}

export interface ModelLister {
  readonly args: (provider: string | null) => ReadonlyArray<string>
  readonly request?: string
  readonly answer: (lines: ReadonlyArray<string>) => ReadonlyArray<RawModel> | undefined
}

export interface SubscriptionRead {
  readonly provider: string
  readonly account?: SubscriptionAccount
  readonly limits?: ReadonlyArray<SubscriptionLimit>
  readonly error?: string
}

type HarnessEvent = Schema.JsonObject

export interface HarnessDefinition {
  readonly id: string
  readonly binary: string
  readonly integration?: string
  readonly ownSessionId: boolean
  readonly systemPromptInPrompt: boolean
  readonly interruptKey: string
  readonly delivery: "typed" | "pull"
  readonly ready: "integration" | "runtime"
  readonly clearKeys?: ReadonlyArray<string>
  readonly promptArgs: ReadonlyArray<string>
  readonly startup?: Effect.Effect<(pane: StartupPane) => Effect.Effect<void>>
  readonly checkProvider?: (provider: string | null) => string | undefined
  readonly launchArgs: (input: LaunchInput) => ReadonlyArray<string>
  readonly models: ModelLister
  readonly checkEnvironment?: (home: string) => Effect.Effect<string | undefined>
  readonly subscription?: (home: string, binary: string) => Effect.Effect<ReadonlyArray<SubscriptionRead>>
  readonly guardAnswer?: (reason: string | undefined) => Schema.Json
  readonly guardCall?: (event: HarnessEvent) => HarnessEvent | undefined
  readonly executionEnd?: (event: HarnessEvent) =>
    | {
        readonly reply: string
        readonly failure?: string
        readonly interrupted?: boolean
        readonly conversation?: string
        readonly execution?: number
      }
    | undefined
  readonly userPrompt?: (
    event: HarnessEvent,
  ) =>
    | { readonly text: string }
    | { readonly execution: number; readonly refused?: true; readonly ids?: ReadonlyArray<number> }
    | { readonly activity: true }
    | undefined
  readonly conversationOf?: (event: HarnessEvent) => string | undefined
}

export interface HarnessEditor {
  add(definition: HarnessDefinition): void
  update(id: string, update: (definition: Types.Mutable<HarnessDefinition>) => void): void
}

export interface HarnessDomain {
  readonly transform: Transform<HarnessEditor>
}

const CLI_FIRST_ON_PATH = 'PATH=${VIBEST_CLI%/*}:$PATH exec "$@"'

export const harnessArgv = (definition: HarnessDefinition, input: LaunchInput, message?: string) => {
  const argv = [
    definition.binary,
    ...definition.launchArgs(input),
    ...(message === undefined ? [] : [...definition.promptArgs, message]),
  ]

  return input.env.VIBEST_CLI === undefined ? argv : ["sh", "-c", CLI_FIRST_ON_PATH, "sh", ...argv]
}
