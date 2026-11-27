import type { Mcp } from "@vibest/schema/mcp"

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface EvalCliOptions {
  readonly stories: ReadonlyArray<string>
  readonly harness: string
  readonly agent: string
  readonly provider: string
  readonly model: string
  readonly concurrency: number
  readonly timeoutSec: number
  readonly outDir: string
}

export interface StorySetupResult {
  readonly prompt: string
  readonly mcpServers: Readonly<Record<string, Mcp.ServerConfig>>
  readonly seedCommands?: ReadonlyArray<ReadonlyArray<string>> | undefined
  readonly teardown?: (() => Promise<void>) | undefined
  readonly groundTruthSummary: string
}

export interface CheckResult {
  readonly id: string
  readonly label: string
  readonly passed: boolean
  readonly required: boolean
  readonly evidence: string
}

export interface ToolCallTrace {
  readonly name: string
  readonly summary: string
  readonly command?: string | undefined
  readonly resultPreview?: string | undefined
}

export interface TurnTrace {
  readonly index: number
  readonly thinking: string
  readonly text: string
  readonly toolCalls: ReadonlyArray<ToolCallTrace>
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
}

export interface HttpLogEntry {
  readonly timestamp: string
  readonly method: string
  readonly url: string
  readonly status: number
  readonly spanMs: number
}

export interface TranscriptMetrics {
  readonly assistantTurns: number
  readonly toolCallsTotal: number
  readonly bashCalls: number
  readonly mcpListCalls: number
  readonly mcpSearchCalls: number
  readonly mcpReadCalls: number
  readonly mcpCallInvocations: number
  readonly codeModeExecCalls: number
  readonly automationCliCalls: number
  readonly mcpSkillRead: boolean
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly httpRequestsTotal: number
  readonly httpErrorCount: number
  readonly httpMcpCalls: number
  readonly httpCodeModeCalls: number
  readonly httpAutomationCalls: number
  readonly spillFiles: ReadonlyArray<string>
}

export interface StoryEvalContext {
  readonly worldRoot: string
  readonly extRoot: string
  readonly repoDir: string
  readonly vibestHome: string
  readonly sessionId: string
  readonly finalState: string
  readonly replyText: string
  readonly metrics: TranscriptMetrics
  readonly turns: ReadonlyArray<TurnTrace>
  readonly httpLogs: ReadonlyArray<HttpLogEntry>
  readonly runVibest: (args: ReadonlyArray<string>) => Promise<CommandResult>
  readonly runShell: (cwd: string, argv: ReadonlyArray<string>) => Promise<CommandResult>
}

export interface StorySpec {
  readonly id: string
  readonly slug: string
  readonly title: string
  readonly personaGoal: string
  readonly promptTemplate: string
  readonly setup: (worldRoot: string, extRoot: string, repoDir: string) => Promise<StorySetupResult>
  readonly grade: (ctx: StoryEvalContext) => Promise<ReadonlyArray<CheckResult>>
}

export interface StoryRunReport {
  readonly id: string
  readonly slug: string
  readonly title: string
  readonly personaGoal: string
  readonly prompt: string
  readonly groundTruthSummary: string
  readonly sessionId: string
  readonly finalState: string
  readonly durationMs: number
  readonly passed: boolean
  readonly requiredPassed: number
  readonly requiredTotal: number
  readonly bonusPassed: number
  readonly bonusTotal: number
  readonly checks: ReadonlyArray<CheckResult>
  readonly metrics: TranscriptMetrics
  readonly replyText: string
  readonly turns: ReadonlyArray<TurnTrace>
  readonly httpLogs: ReadonlyArray<HttpLogEntry>
}

export interface SuiteReport {
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly harness: string
  readonly agent: string
  readonly provider: string
  readonly model: string
  readonly storiesPassed: number
  readonly storiesTotal: number
  readonly requiredChecksPassed: number
  readonly requiredChecksTotal: number
  readonly totalTokens: number
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly totalCacheReadTokens: number
  readonly stories: ReadonlyArray<StoryRunReport>
}
