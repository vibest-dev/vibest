import { assert, describe, it } from "@effect/vitest"

import { parsePiTranscript, parseVibestHttpLogs, redactSecrets } from "../src/metrics.ts"
import { renderHtmlReport, renderMarkdownReport } from "../src/report.ts"
import { ALL_STORIES, computeExpectedReconciliation, FORBIDDEN_HINT_PATTERNS } from "../src/stories.ts"
import type { SuiteReport } from "../src/types.ts"

describe("@vibest/eval zero-hint real user stories", () => {
  it("enforces zero CLI, MCP, CodeMode, or Automation command hints in every user story prompt", () => {
    assert.strictEqual(ALL_STORIES.length, 4)

    for (const story of ALL_STORIES) {
      for (const forbidden of FORBIDDEN_HINT_PATTERNS) {
        assert.isFalse(
          forbidden.test(story.promptTemplate),
          `Story ${story.id} (${story.slug}) leaked forbidden command hint matching ${String(forbidden)}: ${story.promptTemplate}`,
        )
      }
    }
  })

  it("computes deterministic cent-exact ground truth for the 8-region settlement reconciliation story", () => {
    const expected = computeExpectedReconciliation()
    assert.strictEqual(expected.totalTransactions, 960)
    assert.deepStrictEqual(expected.breached, [
      {
        service: "fx-quote",
        failedCount: 32,
        failedUsd: 891.2,
        thresholdUsd: 600,
        owner: "@suqing",
      },
      {
        service: "payout-ach",
        failedCount: 24,
        failedUsd: 1114.8,
        thresholdUsd: 800,
        owner: "@guanyu",
      },
    ])
  })

  it("parses Pi jsonl transcripts, vibestd HTTP logs, and redacts bearer/API secrets", () => {
    const sampleJsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 1200, output: 180, cacheRead: 4000, reasoning: 50, totalTokens: 5380 },
          content: [
            { type: "thinking", thinking: "Checking configured MCP servers with token sk-secret1234567890abcd" },
            {
              type: "toolCall",
              id: "call_1",
              name: "bash",
              arguments: { command: "cat /tmp/skills/mcp/SKILL.md && vibest mcp list && vibest mcp exec 'return 1'" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "Authorization: Bearer super_secret_token_value_12345" }],
        },
      }),
    ].join("\n")

    const sampleHttp = [
      'timestamp=2026-11-26T20:00:01.100Z level=INFO message="Sent HTTP response" http.span=12 http.method=GET http.url=/api/mcp http.status=200',
      'timestamp=2026-11-26T20:00:02.250Z level=INFO message="Sent HTTP response" http.span=840 http.method=POST http.url=/api/codemode/execute http.status=200',
    ].join("\n")

    const httpLogs = parseVibestHttpLogs(sampleHttp)
    const parsed = parsePiTranscript([sampleJsonl], httpLogs, ["tool_1_out.txt"])

    assert.strictEqual(parsed.metrics.assistantTurns, 1)
    assert.strictEqual(parsed.metrics.mcpSkillRead, true)
    assert.strictEqual(parsed.metrics.mcpListCalls, 1)
    assert.strictEqual(parsed.metrics.codeModeExecCalls, 1)
    assert.strictEqual(parsed.metrics.totalTokens, 5380)
    assert.strictEqual(parsed.metrics.httpMcpCalls, 1)
    assert.strictEqual(parsed.metrics.httpCodeModeCalls, 1)
    assert.notInclude(parsed.turns[0]!.thinking, "sk-secret1234567890abcd")
    assert.include(parsed.turns[0]!.toolCalls[0]!.resultPreview ?? "", "Bearer [REDACTED]")
    assert.include(redactSecrets('{"apiKey":"abc123456789"}'), "[REDACTED]")

    const dummySuite: SuiteReport = {
      startedAt: "2026-11-26T20:00:00.000Z",
      finishedAt: "2026-11-26T20:01:00.000Z",
      durationMs: 60_000,
      harness: "pi",
      agent: "general",
      provider: "tcpa",
      model: "glm-5.4",
      storiesPassed: 1,
      storiesTotal: 1,
      requiredChecksPassed: 1,
      requiredChecksTotal: 1,
      totalTokens: 5380,
      totalInputTokens: 1200,
      totalOutputTokens: 180,
      totalCacheReadTokens: 4000,
      stories: [
        {
          id: "S1",
          slug: "hono-jwt-auth",
          title: "Sample",
          personaGoal: "Goal",
          prompt: "Prompt",
          groundTruthSummary: "GT",
          sessionId: "12345678-0000-0000-0000-000000000000",
          finalState: "completed",
          durationMs: 60_000,
          passed: true,
          requiredPassed: 1,
          requiredTotal: 1,
          bonusPassed: 0,
          bonusTotal: 0,
          checks: [{ id: "S1.ok", label: "ok", passed: true, required: true, evidence: "pass" }],
          metrics: parsed.metrics,
          replyText: "Done",
          turns: parsed.turns,
          httpLogs,
        },
      ],
    }

    assert.include(renderMarkdownReport(dummySuite), "# Vibest Real User-Story Evaluation Report")
    assert.include(renderHtmlReport(dummySuite), "Vibest Real User-Story Benchmark Report")
  })
})
