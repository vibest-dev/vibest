import type { JSONSchema } from "./schema.js";

/** "#/schemas/request/$defs/PingParams" → "PingParams" */
export const refName = (ref: string): string => ref.split("/").pop()!;

export function tsType(s: JSONSchema): string {
  if (s.$ref) return refName(s.$ref);
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.oneOf) return s.oneOf.map((v: JSONSchema) => `(${tsType(v)})`).join(" | ");
  if (s.anyOf) return s.anyOf.map((v: JSONSchema) => `(${tsType(v)})`).join(" | ");
  if (s.allOf) return s.allOf.map((v: JSONSchema) => `(${tsType(v)})`).join(" & ");

  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.length === 0) return s.properties ? objectType(s) : "unknown";
  return types.map((t) => scalar(t, s)).join(" | ");
}

function scalar(t: string, s: JSONSchema): string {
  switch (t) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `Array<${s.items ? tsType(s.items) : "unknown"}>`;
    case "object": return objectType(s);
    default: return "unknown";
  }
}

export function objectType(s: JSONSchema): string {
  const props: Record<string, JSONSchema> = s.properties ?? {};
  const required = new Set<string>(s.required ?? []);
  const fields = Object.entries(props).map(([k, v]) => {
    const opt = required.has(k) ? "" : "?";
    const doc = v.description ? `/** ${String(v.description).replace(/\*\//g, "* /")} */ ` : "";
    return `${doc}${JSON.stringify(k)}${opt}: ${tsType(v)};`;
  });
  const extra =
    s.additionalProperties && typeof s.additionalProperties === "object"
      ? `[key: string]: ${tsType(s.additionalProperties)};`
      : "";
  const all = [...fields, extra].filter(Boolean);
  return all.length ? `{ ${all.join(" ")} }` : "Record<string, never>";
}

export function emitDefs(defs: Record<string, JSONSchema>, skip: ReadonlySet<string> = new Set()): string {
  return Object.entries(defs)
    .filter(([name]) => !skip.has(name))
    .map(([name, def]) => `${def.description ? `/** ${def.description} */\n` : ""}export type ${name} = ${tsType(def)};`)
    .join("\n\n");
}
