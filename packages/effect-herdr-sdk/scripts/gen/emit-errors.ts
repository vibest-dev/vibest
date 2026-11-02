import type { JSONSchema } from "./schema.js";
import { emitDefs } from "./ts-type.js";

export function emitErrors(schema: JSONSchema, header: string): string {
  const err = schema.schemas.error_response as JSONSchema;
  return `${header}\n${emitDefs(err.$defs)}\n`;
}
