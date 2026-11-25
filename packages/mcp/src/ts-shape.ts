import { Predicate, Schema } from "effect"

// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- required public API name
export * as TsShape from "./ts-shape.ts"

const UNSUPPORTED_KEYWORDS = ["if", "then", "else", "allOf", "not", "patternProperties", "additionalProperties"]

const isJsonRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const hasUnsupportedKeyword = (schema: Schema.JsonObject): boolean =>
  UNSUPPORTED_KEYWORDS.some((keyword) => {
    if (!Object.hasOwn(schema, keyword)) return false

    return keyword !== "additionalProperties" || schema.additionalProperties !== false
  })

const decodePointerToken = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~")

const renderType = (type: Schema.Json | undefined): string | null => {
  switch (type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "object":
      return "{}"
    case "array":
      return "unknown[]"
    default:
      return null
  }
}

const renderLiteral = (value: Schema.Json | undefined): string | null => {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return JSON.stringify(value)

  return Predicate.isNumber(value) && Number.isFinite(value) ? String(value) : null
}

export const formatPropertyName = (name: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)

const needsParentheses = (type: string): boolean => type.includes(" | ")

// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- required public API name
export const renderTsShape = (inputSchema: Schema.Json | undefined): string | null => {
  try {
    if (!isJsonRecord(inputSchema)) return null
    const definitions = new Map<string, Schema.JsonObject>()

    for (const key of ["$defs", "definitions"]) {
      const rawDefinitions = inputSchema[key]

      if (rawDefinitions === undefined) continue

      if (!isJsonRecord(rawDefinitions)) return null

      for (const [name, definition] of Object.entries(rawDefinitions)) {
        if (!isJsonRecord(definition)) return null
        definitions.set(`${key}/${decodePointerToken(name)}`, definition)
      }
    }

    const aliases = new Map<string, string>()
    const usedAliases = new Set<string>()
    let aliasIndex = 0

    const aliasFor = (definitionKey: string): string => {
      const existing = aliases.get(definitionKey)

      if (existing) return existing
      const name = definitionKey.slice(definitionKey.indexOf("/") + 1)
      let alias = /^[A-Za-z_$][\w$]*$/.test(name) && !usedAliases.has(name) ? name : `Definition${++aliasIndex}`

      while (usedAliases.has(alias)) alias = `Definition${++aliasIndex}`
      aliases.set(definitionKey, alias)
      usedAliases.add(alias)

      return alias
    }

    const render = (schema: Schema.Json | undefined): string | null => {
      if (!isJsonRecord(schema) || hasUnsupportedKeyword(schema)) return null

      if ("$ref" in schema) {
        if (!Predicate.isString(schema.$ref)) return null
        const match = schema.$ref.match(/^#\/(\$defs|definitions)\/([^/]+)$/)

        if (!match) return null
        const definitionGroup = match[1]
        const definitionName = match[2]

        if (definitionGroup === undefined || definitionName === undefined) return null
        const definitionKey = `${definitionGroup}/${decodePointerToken(definitionName)}`

        if (!definitions.has(definitionKey)) return null

        return aliasFor(definitionKey)
      }

      if (Array.isArray(schema.enum)) {
        const values = schema.enum.map(renderLiteral)

        return values.every((value): value is string => value !== null) ? values.join(" | ") : null
      }

      if (Object.hasOwn(schema, "const")) return renderLiteral(schema.const)

      if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
        const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : []

        if (variants.length === 0) return null
        const rendered = variants.map(render)

        return rendered.every((value): value is string => value !== null) ? rendered.join(" | ") : null
      }

      if (schema.type === "object" || schema.properties !== undefined) {
        if (schema.properties === undefined) return "{}"

        if (!isJsonRecord(schema.properties)) return null

        const required = new Set(
          Array.isArray(schema.required)
            ? schema.required.filter((name): name is string => Predicate.isString(name))
            : [],
        )

        const properties: Array<string> = []

        for (const [name, property] of Object.entries(schema.properties)) {
          const rendered = render(property)

          if (rendered === null) return null
          properties.push(`${formatPropertyName(name)}${required.has(name) ? "" : "?"}: ${rendered};`)
        }

        return properties.length === 0 ? "{}" : `{ ${properties.join(" ")} }`
      }

      if (schema.type === "array") {
        if (schema.items === undefined) return "unknown[]"
        const item = render(schema.items)

        return item === null ? null : `${needsParentheses(item) ? `(${item})` : item}[]`
      }

      if (Array.isArray(schema.type)) {
        const types = schema.type.map(renderType)

        return types.every((type): type is string => type !== null) ? types.join(" | ") : null
      }

      if (Predicate.isString(schema.type)) return renderType(schema.type)

      return "unknown"
    }

    const root = render(inputSchema)

    if (root === null) return null
    const definitionsText: Array<string> = []

    for (const [key, alias] of aliases) {
      const definition = definitions.get(key)

      if (!definition) return null
      const rendered = render(definition)

      if (rendered === null) return null
      definitionsText.push(`type ${alias} = ${rendered};`)
    }

    return definitionsText.length > 0 ? `${definitionsText.join("\n")}\n\n${root}` : root
  } catch {
    return null
  }
}

export const renderToolSignature = (inputSchema: Schema.JsonObject | undefined): string =>
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- required public API name
  renderTsShape(inputSchema) ?? "Record<string, unknown>"
