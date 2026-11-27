import { Predicate, type Schema } from "effect"

export * as SchemaType from "./schema-type.ts"

const MAX_REF_EXPANSIONS = 32
const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
])

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

export const formatPropertyKey = (key: string): string => (VALID_IDENT.test(key) ? key : JSON.stringify(key))

export const toIdentifier = (raw: string): string => {
  const normalized = raw
    .trim()
    .replace(/[^A-Za-z0-9_$]+/g, "_")
    .replace(/^_+|_+$/g, "")

  if (normalized.length === 0) return "_tool"
  const prefixed = /^[0-9]/.test(normalized) ? `_${normalized}` : normalized

  return RESERVED_WORDS.has(prefixed) ? `${prefixed}_` : prefixed
}

const decodePointerToken = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~")

const resolveLocalRef = (root: Schema.JsonObject, ref: string): Schema.JsonObject | undefined => {
  if (!ref.startsWith("#/")) return undefined
  const parts = ref.slice(2).split("/").map(decodePointerToken)
  let current: Schema.Json | undefined = root

  for (const part of parts) {
    if (!isJsonObject(current)) return undefined
    current = current[part]
  }

  return isJsonObject(current) ? current : undefined
}

const renderPrimitiveType = (type: string): string | undefined => {
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
    case "array":
      return "unknown[]"
    case "object":
      return "Record<string, unknown>"
    default:
      return undefined
  }
}

const renderLiteral = (value: Schema.Json | undefined): string => {
  if (value === undefined) return "unknown"

  return JSON.stringify(value)
}

interface RenderContext {
  readonly root: Schema.JsonObject
  readonly activeRefs: ReadonlySet<string>
  expansions: number
}

const renderSchema = (schema: Schema.Json | undefined, ctx: RenderContext, indent: string): string => {
  if (!isJsonObject(schema)) return "unknown"

  if (Predicate.isString(schema.$ref)) {
    const ref = schema.$ref

    if (ctx.activeRefs.has(ref) || ctx.expansions >= MAX_REF_EXPANSIONS) return "unknown"
    const target = resolveLocalRef(ctx.root, ref)

    if (!target) return "unknown"
    ctx.expansions += 1
    const nextRefs = new Set(ctx.activeRefs)
    nextRefs.add(ref)

    return renderSchema(target, { root: ctx.root, activeRefs: nextRefs, expansions: ctx.expansions }, indent)
  }

  if (Object.hasOwn(schema, "const")) {
    return renderLiteral(schema.const)
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(renderLiteral).join(" | ")
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf.map((entry) => renderSchema(entry, ctx, indent)).join(" | ")
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.map((entry) => renderSchema(entry, ctx, indent)).join(" | ")
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.map((entry) => renderSchema(entry, ctx, indent)).join(" & ")
  }

  if (Array.isArray(schema.type) && schema.type.length > 0) {
    const parts = schema.type
      .filter((entry): entry is string => Predicate.isString(entry))
      .map((entry) => renderPrimitiveType(entry) ?? "unknown")

    return parts.length > 0 ? parts.join(" | ") : "unknown"
  }

  if (schema.type === "array" || schema.items !== undefined || schema.prefixItems !== undefined) {
    if (Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0) {
      const tupleParts = schema.prefixItems.map((entry) => renderSchema(entry, ctx, indent))

      return `[${tupleParts.join(", ")}]`
    }

    if (Array.isArray(schema.items)) {
      const tupleParts = schema.items.map((entry) => renderSchema(entry, ctx, indent))

      return `[${tupleParts.join(", ")}]`
    }

    if (schema.items !== undefined) {
      const inner = renderSchema(schema.items, ctx, indent)

      return inner.includes(" | ") || inner.includes(" & ") ? `(${inner})[]` : `${inner}[]`
    }

    return "unknown[]"
  }

  if (schema.type === "object" || isJsonObject(schema.properties) || schema.additionalProperties !== undefined) {
    const props = isJsonObject(schema.properties) ? schema.properties : undefined

    const requiredSet = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => Predicate.isString(entry))
        : [],
    )

    const entries = props ? Object.entries(props) : []
    const lines: Array<string> = []
    const childIndent = indent.length > 0 ? `${indent}  ` : ""

    for (const [key, value] of entries) {
      const optional = requiredSet.has(key) ? "" : "?"
      const valueType = renderSchema(value, ctx, childIndent)

      if (indent.length > 0) {
        lines.push(`${childIndent}${formatPropertyKey(key)}${optional}: ${valueType};`)
      } else {
        lines.push(`${formatPropertyKey(key)}${optional}: ${valueType};`)
      }
    }

    if (isJsonObject(schema.additionalProperties)) {
      const extraType = renderSchema(schema.additionalProperties, ctx, childIndent)
      lines.push(indent.length > 0 ? `${childIndent}[key: string]: ${extraType};` : `[key: string]: ${extraType};`)
    } else if (schema.additionalProperties === true && lines.length === 0) {
      return "Record<string, unknown>"
    }

    if (lines.length === 0) return "{}"

    return indent.length > 0 ? `{\n${lines.join("\n")}\n${indent}}` : `{ ${lines.join(" ")} }`
  }

  if (Predicate.isString(schema.type)) {
    return renderPrimitiveType(schema.type) ?? "unknown"
  }

  return "unknown"
}

export const schemaToType = (schema: Schema.Json | undefined, indent = ""): string => {
  if (!isJsonObject(schema)) return "unknown"

  return renderSchema(schema, { root: schema, activeRefs: new Set(), expansions: 0 }, indent)
}

export const renderToolSignature = (inputSchema: Schema.JsonObject | undefined): string => {
  if (!isJsonObject(inputSchema)) return "Record<string, unknown>"
  const rendered = schemaToType(inputSchema, "")

  return rendered === "unknown" ? "Record<string, unknown>" : rendered
}
