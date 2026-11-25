import { Schema } from "effect"

import { MachineName } from "./id.ts"

export const TerminalTarget = Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString).check(
  Schema.makeFilter((record) => Object.keys(record).length > 0, {
    title: "nonEmptyTerminalTarget",
    description: "a terminal target with at least one field",
  }),
)

export type TerminalTarget = typeof TerminalTarget.Type

export const canonicalTarget = (target: TerminalTarget): string => {
  const sorted: Record<string, string> = {}

  for (const key of Object.keys(target).sort()) sorted[key] = target[key]!

  return JSON.stringify(sorted)
}

export const formatTerminalTarget = (target: TerminalTarget): string => {
  const keys = Object.keys(target).sort()

  if (keys.length === 1) return target[keys[0]!]!

  return keys.map((key) => `${key}=${target[key]!}`).join(" ")
}

export const Terminal = Schema.Struct({
  runtime: Schema.NonEmptyString,
  machine: Schema.optional(MachineName),
  target: TerminalTarget,
})

export type Terminal = typeof Terminal.Type

export const SessionRef = Schema.Struct({
  id: Schema.NonEmptyString,
  machine: Schema.optional(MachineName),
})

export type SessionRef = typeof SessionRef.Type
