import type { JSONSchema } from "./schema.js";
import { emitDefs, tsType } from "./ts-type.js";

export function emitParams(schema: JSONSchema, header: string): string {
  const req = schema.schemas.request as JSONSchema;
  const methods: Array<{ method: string; params: string }> = req.oneOf.map((v: JSONSchema) => ({
    method: v.properties.method.const as string,
    params: tsType(v.properties.params),
  }));
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
`;
}
