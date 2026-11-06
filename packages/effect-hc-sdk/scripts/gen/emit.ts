export type JSONSchema = Record<string, any>

export interface OpenRpc {
  readonly info: { readonly version: string; readonly description: string }
  readonly methods: ReadonlyArray<{
    readonly name: string
    readonly params: ReadonlyArray<{ readonly name: string; readonly required?: boolean; readonly schema: JSONSchema }>
    readonly result: { readonly schema: JSONSchema }
    readonly errors: ReadonlyArray<{ readonly data?: { readonly kind?: string } }>
  }>
  readonly components: { readonly schemas: Record<string, JSONSchema> }
}

interface Emitted {
  readonly ts: string
  readonly schema: string
}

const COMPONENT_REF = "#/components/schemas/"
const key = (name: string) => JSON.stringify(name)

const nullable = (inner: Emitted): Emitted => ({ ts: `${inner.ts} | null`, schema: `Schema.NullOr(${inner.schema})` })

const UNKNOWN: Emitted = { ts: "unknown", schema: "Schema.Unknown" }

const scalar = (type: string, s: JSONSchema): Emitted => {
  switch (type) {
    case "string":
      return { ts: "string", schema: "Schema.String" }
    case "integer":
    case "number":
      return { ts: "number", schema: "Schema.Number" }
    case "boolean":
      return { ts: "boolean", schema: "Schema.Boolean" }
    case "null":
      return { ts: "null", schema: "Schema.Null" }
    case "array": {
      const item = s.items ? emit(s.items) : UNKNOWN
      return { ts: `ReadonlyArray<${item.ts}>`, schema: `Schema.Array(${item.schema})` }
    }
    case "object":
      return object(s)
    default:
      return UNKNOWN
  }
}

const record = (value: Emitted): Emitted => ({
  ts: `{ readonly [key: string]: ${value.ts} }`,
  schema: `Schema.Record(Schema.String, ${value.schema})`,
})

export const struct = (
  fields: ReadonlyArray<{ readonly name: string; readonly optional: boolean; readonly value: Emitted }>,
) => ({
  ts: `{ ${fields.map((f) => `readonly ${key(f.name)}${f.optional ? "?" : ""}: ${f.value.ts}${f.optional ? " | undefined" : ""};`).join(" ")} }`,
  schema: `Schema.Struct({ ${fields.map((f) => `${key(f.name)}: ${f.optional ? `Schema.optional(${f.value.schema})` : f.value.schema}`).join(", ")} })`,
})

const object = (s: JSONSchema): Emitted => {
  const props: Record<string, JSONSchema> = s.properties ?? {}
  if (Object.keys(props).length === 0)
    return record(typeof s.additionalProperties === "object" ? emit(s.additionalProperties) : UNKNOWN)
  const required = new Set<string>(s.required ?? [])
  return struct(Object.entries(props).map(([name, v]) => ({ name, optional: !required.has(name), value: emit(v) })))
}

export const emit = (s: JSONSchema): Emitted => {
  if (typeof s.$ref === "string") {
    if (!s.$ref.startsWith(COMPONENT_REF)) return UNKNOWN
    const name = s.$ref.slice(COMPONENT_REF.length)
    return { ts: name, schema: `Schema.suspend((): Schema.Codec<${name}> => ${name})` }
  }
  if (Array.isArray(s.enum))
    return {
      ts: s.enum.map((v: unknown) => JSON.stringify(v)).join(" | "),
      schema: `Schema.Literals([${s.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}])`,
    }
  const alternatives: ReadonlyArray<JSONSchema> | undefined = s.anyOf ?? s.oneOf
  if (alternatives !== undefined) {
    const nonNull = alternatives.filter((a) => a.type !== "null")
    const inner =
      nonNull.length === 1
        ? emit(nonNull[0]!)
        : {
            ts: nonNull.map((a) => `(${emit(a).ts})`).join(" | "),
            schema: `Schema.Union([${nonNull.map((a) => emit(a).schema).join(", ")}])`,
          }
    return nonNull.length === alternatives.length ? inner : nullable(inner)
  }
  const types: ReadonlyArray<string> = Array.isArray(s.type) ? s.type : s.type ? [s.type] : []
  if (types.length === 0) return s.properties ? object(s) : UNKNOWN
  const nonNull = types.filter((t) => t !== "null")
  if (nonNull.length !== 1) return nonNull.length === 0 ? scalar("null", s) : UNKNOWN
  const inner = scalar(nonNull[0]!, s)
  return nonNull.length === types.length ? inner : nullable(inner)
}

const pascal = (method: string) =>
  method
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")

const declare = (name: string, value: Emitted) =>
  `export type ${name} = ${value.ts}\nexport const ${name}: Schema.Codec<${name}> = ${value.schema}\n`

export const emitApi = (doc: OpenRpc, generation: number): string => {
  const components = Object.entries(doc.components.schemas).map(([name, s]) => declare(name, emit(s)))
  const methods = doc.methods.map((m) => {
    const params = `${pascal(m.name)}Params`
    const result = emit(m.result.schema)
    const resultName =
      typeof m.result.schema.$ref === "string" && result.ts !== "unknown" ? result.ts : `${pascal(m.name)}Result`
    const kinds = [...new Set(m.errors.flatMap((e) => (e.data?.kind ? [e.data.kind] : [])))]
    return {
      name: m.name,
      params,
      resultName,
      kinds,
      declarations: [
        declare(
          params,
          struct(m.params.map((p) => ({ name: p.name, optional: p.required !== true, value: emit(p.schema) }))),
        ),
        ...(resultName === result.ts ? [] : [declare(resultName, result)]),
      ],
    }
  })
  return `import { Schema } from "effect"

export const VERSION = ${JSON.stringify(doc.info.version)} as const
export const GENERATION = ${generation} as const

${components.join("\n")}
${methods.flatMap((m) => m.declarations).join("\n")}
export const METHODS = {
${methods.map((m) => `  ${key(m.name)}: { params: ${m.params}, result: ${m.resultName}, errors: [${m.kinds.map(key).join(", ")}] },`).join("\n")}
} as const
`
}
