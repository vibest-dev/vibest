import { Config, Effect, Formatter, Layer, Logger, Option, Predicate, Random, References } from "effect"

const logfmt = (run: string) =>
  Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]

    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", run],
      ...messages.flatMap((value) => {
        const record = plainRecord(value)

        return record === undefined ? [["message", value] as const] : flatten(record)
      }),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })

const plainPrototypes: ReadonlySet<object | null> = new Set([Object.prototype, null])

const plainRecord = <A>(value: A) =>
  Predicate.isObject(value) && plainPrototypes.has(Object.getPrototypeOf(value)) ? value : undefined

function flatten<V>(
  input: { readonly [key: string]: V },
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)

  if (entries.length === 0 && prefix) return [[prefix, input]]

  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    const record = plainRecord(value)

    return record === undefined ? [[path, value] as const] : flatten(record, path, seen)
  })
}

function format<A>(input: A) {
  const value = Predicate.isString(input) ? input : Formatter.format(input)

  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

const levels = { DEBUG: "Debug", INFO: "Info", WARN: "Warn", ERROR: "Error" } as const

const levelNamed = new Map(Object.entries(levels))

const minimumLogLevel = Layer.effect(
  References.MinimumLogLevel,
  Config.option(Config.String("VIBEST_LOG_LEVEL")).pipe(
    Effect.map((value) => {
      const name = Option.getOrElse(value, () => "").toUpperCase()

      return levelNamed.get(name) ?? levels.INFO
    }),
    Effect.orElseSucceed(() => levels.INFO),
  ),
)

const runLogger = Random.nextIntBetween(0, 0xffffffff).pipe(
  Effect.map((n) => Logger.withConsoleError(logfmt(n.toString(16).padStart(8, "0")))),
)

export const layer = Layer.mergeAll(Logger.layer([runLogger]), minimumLogLevel)
