import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { renderHtmlReport, renderMarkdownReport } from "./report.ts"
import { runStoryEval } from "./sandbox.ts"
import { ALL_STORIES } from "./stories.ts"
import type { EvalCliOptions, StoryRunReport, StorySpec, SuiteReport } from "./types.ts"

const readFlag = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const idx = argv.indexOf(flag)

  if (idx === -1) return undefined
  const val = argv[idx + 1]

  return val !== undefined && !val.startsWith("--") ? val : undefined
}

const parseCliOptions = (argv: ReadonlyArray<string>): EvalCliOptions => {
  const storyFilter = readFlag(argv, "--story")
    ?.split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)

  const harness = readFlag(argv, "--harness") ?? "pi"
  const agent = readFlag(argv, "--agent") ?? "general"
  const provider = readFlag(argv, "--provider") ?? "tcpa"
  const model = readFlag(argv, "--model") ?? "glm-5.4"
  const concurrency = Math.max(1, Number(readFlag(argv, "--concurrency") ?? "2"))
  const timeoutSec = Math.max(60, Number(readFlag(argv, "--timeout") ?? "420"))
  const outDir = path.resolve(readFlag(argv, "--out") ?? path.join(os.tmpdir(), `vibest-eval-report-${Date.now()}`))

  return {
    stories: storyFilter ?? ALL_STORIES.map((s) => s.id),
    harness,
    agent,
    provider,
    model,
    concurrency,
    timeoutSec,
    outDir,
  }
}

const runPool = async (
  selected: ReadonlyArray<StorySpec>,
  opts: EvalCliOptions,
): Promise<ReadonlyArray<StoryRunReport>> => {
  const results = new Map<string, StoryRunReport>()
  const queue = [...selected]

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const next = queue.shift()

      if (!next) return
      const report = await runStoryEval(next, opts)
      results.set(next.id, report)
    }
  }

  const workers = Array.from({ length: Math.min(opts.concurrency, selected.length) }, () => worker())
  await Promise.all(workers)

  return selected.flatMap((s) => {
    const r = results.get(s.id)

    return r ? [r] : []
  })
}

const main = async (): Promise<void> => {
  const opts = parseCliOptions(process.argv.slice(2))
  const selected = ALL_STORIES.filter((s) => opts.stories.includes(s.id.toUpperCase()))

  if (selected.length === 0) {
    console.error(
      `Unknown --story filter: ${opts.stories.join(",")}. Available: ${ALL_STORIES.map((s) => s.id).join(", ")}`,
    )
    process.exit(1)
  }

  await fs.mkdir(opts.outDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  console.log(
    `Running ${selected.length} zero-hint user stories on ${opts.harness} (agent=${opts.agent}, ${opts.provider}/${opts.model}), concurrency=${opts.concurrency}...`,
  )

  const storyReports = await runPool(selected, opts)
  const finishedAt = new Date().toISOString()
  const durationMs = Date.now() - startedMs

  const suite: SuiteReport = {
    startedAt,
    finishedAt,
    durationMs,
    harness: opts.harness,
    agent: opts.agent,
    provider: opts.provider,
    model: opts.model,
    storiesPassed: storyReports.filter((s) => s.passed).length,
    storiesTotal: storyReports.length,
    requiredChecksPassed: storyReports.reduce((acc, s) => acc + s.requiredPassed, 0),
    requiredChecksTotal: storyReports.reduce((acc, s) => acc + s.requiredTotal, 0),
    totalTokens: storyReports.reduce((acc, s) => acc + s.metrics.totalTokens, 0),
    totalInputTokens: storyReports.reduce((acc, s) => acc + s.metrics.inputTokens, 0),
    totalOutputTokens: storyReports.reduce((acc, s) => acc + s.metrics.outputTokens, 0),
    totalCacheReadTokens: storyReports.reduce((acc, s) => acc + s.metrics.cacheReadTokens, 0),
    stories: storyReports,
  }

  const jsonPath = path.join(opts.outDir, "eval-report.json")
  const mdPath = path.join(opts.outDir, "eval-report.md")
  const htmlPath = path.join(opts.outDir, "eval-report.html")

  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(suite, null, 2)}\n`, "utf8"),
    fs.writeFile(mdPath, renderMarkdownReport(suite), "utf8"),
    fs.writeFile(htmlPath, renderHtmlReport(suite), "utf8"),
  ])

  console.log(
    `\n=== Eval Summary: ${suite.storiesPassed}/${suite.storiesTotal} stories passed (${suite.requiredChecksPassed}/${suite.requiredChecksTotal} checks) ===`,
  )
  console.log(`JSON: ${jsonPath}`)
  console.log(`MD:   ${mdPath}`)
  console.log(`HTML: ${htmlPath}`)

  if (suite.storiesPassed < suite.storiesTotal) {
    process.exitCode = 1
  }
}

await main()
