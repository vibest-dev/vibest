import { Formatter, Logger } from "effect"

const logfmt = Logger.map(Logger.formatStructured, (output) => {
  const messages = Array.isArray(output.message) ? output.message : [output.message]
  return [
    ["timestamp", output.timestamp],
    ["level", output.level],
    ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
    ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
    ...flatten(output.spans),
    ...flatten(output.annotations),
  ]
    .map(([key, value]) => `${key}=${format(value)}`)
    .join(" ")
})

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

export const layer = Logger.layer([Logger.withConsoleError(logfmt)])
