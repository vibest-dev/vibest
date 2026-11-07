import { Effect } from "effect"

import type { Candidate } from "./plugin-sources.ts"

export interface CallerHit {
  readonly kind: string
  readonly priority: number
  readonly terminal: string | undefined
}

const caller = (plugin: Candidate["plugin"]) => {
  if (!("effect" in plugin) || plugin.caller === undefined) return undefined
  const spec = plugin.caller
  return typeof spec.terminal === "function" && Array.isArray(spec.env) ? spec : undefined
}

export const callerKeys = (plugins: ReadonlyArray<Candidate>): ReadonlyArray<string> => [
  ...new Set(plugins.flatMap((candidate) => caller(candidate.plugin)?.env ?? [])),
]

const present = (keys: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>) =>
  keys.every((key) => {
    const value = env[key]
    return value !== undefined && value !== ""
  })

export const callerHits = (
  plugins: ReadonlyArray<Candidate>,
  env: Readonly<Record<string, string | undefined>>,
  runtime?: string,
) =>
  Effect.gen(function* () {
    const matches: Array<{
      readonly kind: string
      readonly priority: number
      readonly terminal: NonNullable<ReturnType<typeof caller>>["terminal"]
    }> = []
    for (const candidate of plugins) {
      const spec = caller(candidate.plugin)
      if (spec === undefined || !present(spec.env, env)) continue
      matches.push({ kind: spec.kind, priority: spec.priority, terminal: spec.terminal })
    }
    const ranked = [...matches].sort((a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind))
    const chosen = runtime === undefined ? ranked[0] : ranked.find((hit) => hit.kind === runtime)
    const terminal = chosen === undefined ? undefined : yield* chosen.terminal(env)
    return ranked.map((hit) => ({
      kind: hit.kind,
      priority: hit.priority,
      terminal: hit === chosen ? terminal : undefined,
    }))
  })

export const callerByKind = (plugins: ReadonlyArray<Candidate>, kind: string) => {
  for (const candidate of plugins) {
    const spec = caller(candidate.plugin)
    if (spec?.kind === kind) return spec
  }
  return undefined
}
