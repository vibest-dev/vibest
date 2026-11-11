import { Effect } from "effect"

import type { Caller } from "./host.ts"

export interface CallerHit {
  readonly id: string
  readonly name?: string
  readonly terminal: string | undefined
}

const shown = (id: string, name: string | undefined) => name ?? id

export type EntryPlace =
  | { readonly in: "terminal"; readonly runtime: string; readonly terminal: string }
  | { readonly in: "launch"; readonly runtime: string }
  | { readonly in: "refused"; readonly message: string }

export const entryPlace = (o: {
  readonly runtime: string | undefined
  readonly hits: ReadonlyArray<CallerHit>
}): EntryPlace => {
  const named = (id: string) => o.hits.find((hit) => hit.id === id)
  if (o.runtime !== undefined) {
    const hit = named(o.runtime)
    if (hit === undefined) return { in: "launch", runtime: o.runtime }
    return hit.terminal === undefined
      ? { in: "refused", message: `this ${shown(o.runtime, hit.name)} place could not be named` }
      : { in: "terminal", runtime: o.runtime, terminal: hit.terminal }
  }
  const chosen = o.hits[0]
  if (chosen === undefined)
    return { in: "refused", message: "no runtime was detected in this environment; pass --runtime" }
  return chosen.terminal === undefined
    ? {
        in: "refused",
        message: `${shown(chosen.id, chosen.name)} is detected in this environment, but its place could not be named; pass --runtime`,
      }
    : { in: "terminal", runtime: chosen.id, terminal: chosen.terminal }
}

const present = (keys: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>) =>
  keys.every((key) => {
    const value = env[key]
    return value !== undefined && value !== ""
  })

export const callerKind = (
  specs: ReadonlyArray<Pick<Caller, "id" | "env">>,
  env: Readonly<Record<string, string | undefined>>,
) => specs.find((spec) => present(spec.env, env))?.id

export const specHits = (
  specs: ReadonlyArray<Pick<Caller, "id" | "name" | "env" | "terminal">>,
  env: Readonly<Record<string, string | undefined>>,
  runtime?: string,
) =>
  Effect.gen(function* () {
    const matches = specs.filter((spec) => present(spec.env, env))
    const chosen = runtime === undefined ? matches[0] : matches.find((hit) => hit.id === runtime)
    const terminal = chosen === undefined ? undefined : yield* chosen.terminal(env)
    return matches.map((hit): CallerHit => ({
      id: hit.id,
      ...(hit.name === undefined ? {} : { name: hit.name }),
      terminal: hit === chosen ? terminal : undefined,
    }))
  })

export const filterCallerEnv = (
  specs: ReadonlyArray<{ readonly env: ReadonlyArray<string> }>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {}
  for (const spec of specs) for (const key of spec.env) if (!(key in out) && env[key] !== undefined) out[key] = env[key]
  return out
}

const declared = (keys: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>) => {
  const out: Record<string, string | undefined> = {}
  for (const key of keys) out[key] = env[key]
  return out
}

export const callerTarget = (
  specs: ReadonlyArray<Pick<Caller, "env" | "target">>,
  env: Readonly<Record<string, string | undefined>>,
  named?: string,
): string | undefined => {
  for (const spec of specs) {
    if (typeof spec.target !== "function") continue
    const target = spec.target(declared(spec.env, env), named)
    if (target !== undefined) return target
  }
  return undefined
}
