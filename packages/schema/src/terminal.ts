import { Schema } from "effect"

import { MachineName } from "./id.ts"

export const TerminalTarget = Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString)

export type TerminalTarget = typeof TerminalTarget.Type

export const canonicalTarget = (target: TerminalTarget): string => {
  const sorted: Record<string, string> = {}

  for (const key of Object.keys(target).sort()) sorted[key] = target[key]!

  return JSON.stringify(sorted)
}

export const formatTerminalTarget = (target: TerminalTarget): string =>
  Object.keys(target)
    .sort()
    .map((key) => target[key]!)
    .join("/")

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

export const formatSessionRef = (ref: SessionRef): string =>
  ref.machine === undefined ? ref.id : `${ref.machine}/${ref.id}`
