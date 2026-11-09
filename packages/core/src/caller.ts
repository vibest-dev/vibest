import { Context, Effect } from "effect"

import type { Candidate } from "./plugin-sources.ts"

export interface CallerHit {
  readonly kind: string
  readonly terminal: string | undefined
}

export type MainPlace =
  | { readonly in: "terminal"; readonly runtime: string; readonly terminal: string }
  | { readonly in: "launch"; readonly runtime: string }
  | { readonly in: "refused"; readonly message: string }

export const mainPlace = (o: {
  readonly marked: boolean
  readonly runtime: string | undefined
  readonly hits: ReadonlyArray<CallerHit>
}): MainPlace => {
  const named = (kind: string) => o.hits.find((hit) => hit.kind === kind)
  const here = (kind: string): MainPlace => {
    const hit = named(kind)
    if (hit === undefined)
      return {
        in: "refused",
        message: `vibestd opened this terminal in ${kind}, but that runtime's environment is not set`,
      }
    if (hit.terminal === undefined) return { in: "refused", message: `this ${kind} terminal could not be named` }
    return { in: "terminal", runtime: kind, terminal: hit.terminal }
  }
  if (o.marked)
    return o.runtime === undefined
      ? { in: "refused", message: "vibestd opened this terminal without naming its runtime" }
      : here(o.runtime)
  if (o.runtime !== undefined) {
    const hit = named(o.runtime)
    if (hit === undefined) return { in: "launch", runtime: o.runtime }
    return hit.terminal === undefined
      ? { in: "refused", message: `this ${o.runtime} terminal could not be named` }
      : { in: "terminal", runtime: o.runtime, terminal: hit.terminal }
  }
  const chosen = o.hits[0]
  if (chosen === undefined)
    return { in: "refused", message: "no runtime was detected in this environment; pass --runtime" }
  return chosen.terminal === undefined
    ? {
        in: "refused",
        message: `${chosen.kind} is detected in this environment, but its terminal could not be named; pass --runtime`,
      }
    : { in: "terminal", runtime: chosen.kind, terminal: chosen.terminal }
}

export const OnCallerPlugins = Context.Reference<(plugins: ReadonlyArray<Candidate>) => void>(
  "vibest/OnCallerPlugins",
  {
    defaultValue: () => () => {},
  },
)

export const callerOf = (plugin: { readonly caller?: unknown; readonly effect?: unknown } | undefined) => {
  if (plugin === undefined || !("effect" in plugin) || plugin.caller === undefined) return undefined
  const spec = plugin.caller as {
    readonly kind?: unknown
    readonly env?: unknown
    readonly terminal?: unknown
    readonly ready?: (env: Readonly<Record<string, string | undefined>>) => Effect.Effect<boolean, unknown, never>
    readonly missing?: string
    readonly target?: (env: Readonly<Record<string, string | undefined>>, named?: string) => string | undefined
  }
  return typeof spec.kind === "string" &&
    spec.kind !== "" &&
    typeof spec.terminal === "function" &&
    Array.isArray(spec.env)
    ? {
        kind: spec.kind,
        env: spec.env,
        terminal: spec.terminal as (
          env: Readonly<Record<string, string | undefined>>,
        ) => Effect.Effect<string | undefined, unknown, never>,
        ...(typeof spec.ready === "function" ? { ready: spec.ready } : {}),
        ...(typeof spec.missing === "string" ? { missing: spec.missing } : {}),
        ...(typeof spec.target === "function" ? { target: spec.target } : {}),
      }
    : undefined
}

const caller = (plugin: Candidate["plugin"]) => ("effect" in plugin ? callerOf(plugin) : undefined)

export type CallerSpec = NonNullable<ReturnType<typeof callerOf>>

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
      readonly terminal: NonNullable<ReturnType<typeof caller>>["terminal"]
    }> = []
    for (const candidate of plugins) {
      const spec = caller(candidate.plugin)
      if (spec === undefined || !present(spec.env, env)) continue
      matches.push({ kind: spec.kind, terminal: spec.terminal })
    }
    const chosen = runtime === undefined ? matches[0] : matches.find((hit) => hit.kind === runtime)
    const terminal = chosen === undefined ? undefined : yield* chosen.terminal(env)
    return matches.map((hit) => ({
      kind: hit.kind,
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

const declared = (keys: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>) => {
  const out: Record<string, string | undefined> = {}
  for (const key of keys) out[key] = env[key]
  return out
}

export const callerTarget = (
  specs: ReadonlyArray<{
    readonly env: ReadonlyArray<string>
    readonly target?: (env: Readonly<Record<string, string | undefined>>, named?: string) => string | undefined
  }>,
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
