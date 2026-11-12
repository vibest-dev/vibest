import type { Effect, Types } from "effect"

import type { SubscriptionAccount, SubscriptionLimit } from "./index.ts"
import type { Transform } from "./registration.ts"

export interface LaunchInput {
  readonly worktree: string
  readonly projectDir: string
  readonly systemPromptFile: string
  readonly provider: string | null
  readonly model: string | null
  readonly sessionId: string | null
  readonly resume: boolean
  readonly pluginDir: string
  readonly vibest: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

export interface CoordinatorInput {
  readonly root: string
  readonly projectDir: string
  readonly systemPromptFile: string
  readonly provider: string | null
  readonly model: string | null
  readonly sessionId: string | null
  readonly pluginDir: string
  readonly env: Readonly<Record<string, string>>
}

export interface StartupPane {
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

export type HarnessEvent = Readonly<Record<string, unknown>>

export interface HarnessDefinition {
  readonly id: string
  readonly binary: string
  readonly integration?: string
  readonly ownSessionId: boolean
  readonly systemPromptInPrompt: boolean
  readonly interruptKey: string
  readonly replyField: "text" | "last_assistant_message"
  readonly inbox?: "subscribe" | "poll"
  readonly ready: "integration" | "runtime"
  readonly startup?: Effect.Effect<(pane: StartupPane) => Effect.Effect<void>>
  readonly checkProvider?: (provider: string | null) => string | undefined
  readonly launchArgs: (input: LaunchInput) => ReadonlyArray<string>
  readonly coordinatorArgs?: (input: CoordinatorInput) => ReadonlyArray<string>
  readonly models: ModelLister
  readonly checkEnvironment?: (home: string) => Effect.Effect<string | undefined>
  readonly subscription?: (home: string) => Effect.Effect<ReadonlyArray<SubscriptionRead>>
  readonly guardAnswer?: (reason: string | undefined) => unknown
  readonly executionEnd?: (event: HarnessEvent) => { readonly end: Readonly<Record<string, unknown>> } | undefined
  readonly userPrompt?: (
    event: HarnessEvent,
  ) => { readonly text: string } | { readonly execution: number; readonly refused?: true } | undefined
  readonly conversationOf?: (event: HarnessEvent) => string | undefined
}

export interface HarnessEditor {
  list(): ReadonlyArray<HarnessDefinition>
  get(id: string): HarnessDefinition | undefined
  add(definition: HarnessDefinition): void
  update(id: string, update: (definition: Types.Mutable<HarnessDefinition>) => void): void
  remove(id: string): void
}

export interface HarnessDomain {
  readonly transform: Transform<HarnessEditor>
  readonly reload: () => Effect.Effect<void>
}
