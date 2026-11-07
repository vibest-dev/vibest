import { Effect } from "effect"

import type { Candidate } from "./plugin-sources.ts"

export interface CallerHit {
  readonly kind: string
  readonly priority: number
  readonly terminal: string | undefined
}

const caller = (plugin: Candidate["plugin"]) => ("effect" in plugin ? plugin.caller : undefined)

export const callerKeys = (plugins: ReadonlyArray<Candidate>): ReadonlyArray<string> => [
  ...new Set(plugins.flatMap((candidate) => caller(candidate.plugin)?.env ?? [])),
]

const present = (keys: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>) =>
  keys.every((key) => {
    const value = env[key]
    return value !== undefined && value !== ""
  })

export const callerHits = (plugins: ReadonlyArray<Candidate>, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const hits: Array<CallerHit> = []
    for (const candidate of plugins) {
      const spec = caller(candidate.plugin)
      if (spec === undefined || !present(spec.env, env)) continue
      hits.push({ kind: spec.kind, priority: spec.priority, terminal: yield* spec.terminal(env) })
    }
    return hits
  })

export const callerByKind = (plugins: ReadonlyArray<Candidate>, kind: string) => {
  for (const candidate of plugins) {
    const spec = caller(candidate.plugin)
    if (spec?.kind === kind) return spec
  }
  return undefined
}
