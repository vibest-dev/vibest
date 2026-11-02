import type { JSONSchema } from "./schema.js";
import { emitDefs, tsType } from "./ts-type.js";
import { METHOD_RESULT } from "./method-result-map.js";

const typeName = (tag: string) => "Result_" + tag.replace(/[^a-zA-Z0-9]/g, "_");

export function emitResults(schema: JSONSchema, header: string): string {
  const ok = schema.schemas.success_response as JSONSchema;
  const variants: Array<{ tag: string; name: string; ts: string }> = ok.$defs.ResponseResult.oneOf.map(
    (v: JSONSchema) => ({ tag: v.properties.type.const as string, name: typeName(v.properties.type.const), ts: tsType(v) }),
  );
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

/** See scripts/gen/method-result-map.ts. */
export const METHOD_RESULT = ${JSON.stringify(METHOD_RESULT, null, 2)} as const;
`;
}
