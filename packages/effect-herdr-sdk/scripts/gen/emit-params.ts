import { Schema } from "effect"

import { type Document, JSONSchema } from "./schema.js"
import { emitDefs, tsType } from "./ts-type.js"

const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({ properties: Schema.Struct({ method: Schema.Struct({ const: Schema.String }), params: JSONSchema }) }),
)

export function emitParams(schema: Document, header: string): string {
  const req = schema.schemas.request

  const methods = req.oneOf.map((v) => {
    const { method, params } = decodeRequest(v).properties

    return { method: method.const, params: tsType(params) }
  })

  return `${header}
${emitDefs(req.$defs)}

/** Every method the server accepts, mapped to its params type. */
export interface MethodParams {
${methods.map((m) => `  ${JSON.stringify(m.method)}: ${m.params};`).join("\n")}
}

export type Method = keyof MethodParams;

export const METHODS = [
${methods.map((m) => `  ${JSON.stringify(m.method)},`).join("\n")}
] as const satisfies readonly Method[];
`
}
