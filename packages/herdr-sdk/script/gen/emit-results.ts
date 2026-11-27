import { Schema } from "effect"

import { METHOD_RESULT } from "./method-result-map.js"
import { type Document, JSONSchema } from "./schema.js"
import { emitDefs, tsType } from "./ts-type.js"

const decodeVariant = Schema.decodeUnknownSync(
  Schema.Struct({ properties: Schema.Struct({ type: Schema.Struct({ const: Schema.String }) }) }),
)

const decodeResponseResult = Schema.decodeUnknownSync(Schema.Struct({ oneOf: Schema.Array(JSONSchema) }))

const typeName = (tag: string) => "Result_" + tag.replace(/[^a-zA-Z0-9]/g, "_")

export function emitResults(schema: Document, header: string): string {
  const ok = schema.schemas.success_response

  const variants = decodeResponseResult(ok.$defs.ResponseResult).oneOf.map((v) => {
    const tag = decodeVariant(v).properties.type.const

    return { tag, name: typeName(tag), ts: tsType(v) }
  })

  return `${header}
${emitDefs(ok.$defs, new Set(["ResponseResult"]))}

${variants.map((v) => `export type ${v.name} = ${v.ts};`).join("\n\n")}

/** The full union of every result shape the server can return. */
export type ResponseResult =
${variants.map((v) => `  | ${v.name}`).join("\n")};

/** Result shape, keyed by its \`type\` tag. */
export interface ResultByTag {
${variants.map((v) => `  ${JSON.stringify(v.tag)}: ${v.name};`).join("\n")}
}

export type ResultTag = keyof ResultByTag;

/** See script/gen/method-result-map.ts. */
export const METHOD_RESULT = ${JSON.stringify(METHOD_RESULT, null, 2)} as const;
`
}
