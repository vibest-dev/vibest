import { Config, Effect, Formatter, Layer, Logger, Option, Random, References } from "effect"

const logfmt = (run: string) =>
  Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", run],
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

const levels = { DEBUG: "Debug", INFO: "Info", WARN: "Warn", ERROR: "Error" } as const

const minimumLogLevel = Layer.effect(
  References.MinimumLogLevel,
  Config.option(Config.String("VIBEST_LOG_LEVEL")).pipe(
    Effect.map((value) => {
      const name = Option.getOrElse(value, () => "").toUpperCase()
      return name in levels ? levels[name as keyof typeof levels] : levels.INFO
    }),
    Effect.orElseSucceed(() => levels.INFO),
  ),
)

const runLogger = Random.nextIntBetween(0, 0xffffffff).pipe(
  Effect.map((n) => Logger.withConsoleError(logfmt(n.toString(16).padStart(8, "0")))),
)

export const layer = Layer.mergeAll(Logger.layer([runLogger]), minimumLogLevel)
