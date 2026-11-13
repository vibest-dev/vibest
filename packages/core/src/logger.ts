import { Cause, Logger } from "effect"

const readable = (value: unknown): unknown => {
  if (Cause.isCause(value)) return Cause.pretty(value)
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (Array.isArray(value)) return value.map(readable)
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, readable(field)]))
  return value
}

export const readableCauses = Logger.make<unknown, void>((options) =>
  Logger.defaultLogger.log({ ...options, message: readable(options.message) }),
)

export const layer = Logger.layer([readableCauses])
