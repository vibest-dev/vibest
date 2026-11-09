import type { Harness } from "@vibest/plugin"
import { Schema } from "effect"

export const opt = (flag: string, value: string | null) => (value ? [flag, value] : [])

export const noProvider = (harness: string) => (provider: string | null) =>
  provider ? `${harness} has no provider option` : undefined

export const jsonLines = (...messages: ReadonlyArray<unknown>) => messages.map((m) => `${JSON.stringify(m)}\n`).join("")

export const findMessage = <A>(schema: Schema.Codec<A, unknown>) => {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema))
  return (lines: ReadonlyArray<string>): A | undefined => {
    for (const line of lines) {
      const r = decode(line)
      if (r._tag === "Some") return r.value
    }
    return undefined
  }
}

export const withConfigured = (
  models: ReadonlyArray<Harness.RawModel>,
  configured: Omit<Harness.RawModel, "default"> | undefined,
): ReadonlyArray<Harness.RawModel> =>
  models.some((m) => m.default) || !configured ? models : [...models, { ...configured, default: true }]
