import { Predicate, Schema } from "effect"

export * as Json from "./json.ts"

export const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

export const decodeJsonOption = Schema.decodeUnknownOption(Schema.Json)

export const deepEqualJson = (a: Schema.Json | undefined, b: Schema.Json | undefined): boolean => {
  if (a === b) return true

  if (a === undefined || b === undefined || a === null || b === null) return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false

    return a.every((item, idx) => deepEqualJson(item, b[idx]))
  }

  if (isJsonObject(a) && isJsonObject(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)

    if (keysA.length !== keysB.length) return false

    return keysA.every((key) => Object.hasOwn(b, key) && deepEqualJson(a[key], b[key]))
  }

  return false
}
