import type { Document } from "./schema.js"
import { emitDefs } from "./ts-type.js"

export function emitErrors(schema: Document, header: string): string {
  return `${header}\n${emitDefs(schema.schemas.error_response.$defs)}\n`
}
