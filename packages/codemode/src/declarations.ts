import { SchemaType } from "@vibest/util/schema-type"
import type { Schema } from "effect"

const INDENT = "  "
export const DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16_000

export interface DeclarationTool {
  readonly server: string
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema?: Schema.JsonObject | undefined
  readonly outputSchema?: Schema.JsonObject | undefined
}

export const schemaToType = (schema: Schema.JsonObject, maxChars = DEFAULT_INPUT_SCHEMA_MAX_CHARS): string => {
  const rendered = SchemaType.schemaToType(schema, "")

  return rendered.length <= maxChars ? rendered : "unknown"
}

const docComment = (description: string | undefined, indent: string): string => {
  const text = description?.trim()

  if (!text) return ""
  const lines = text.replaceAll("*/", "*\\/").split(/\r?\n/)

  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`

  return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`
}

export const renderToolSignature = (tool: DeclarationTool, maxChars = DEFAULT_INPUT_SCHEMA_MAX_CHARS): string => {
  const input = tool.inputSchema === undefined ? "unknown" : schemaToType(tool.inputSchema, maxChars)
  const output = tool.outputSchema === undefined ? "unknown" : schemaToType(tool.outputSchema, maxChars)

  return `${SchemaType.toIdentifier(tool.name)}(args?: ${input}): Promise<${output}>;`
}

export const renderDeclarations = (tools: ReadonlyArray<DeclarationTool>): string => {
  const byServer = new Map<string, Array<DeclarationTool>>()

  for (const tool of tools) {
    const serverKey = SchemaType.toIdentifier(tool.server)
    const bucket = byServer.get(serverKey) ?? []

    if (bucket.length === 0) byServer.set(serverKey, bucket)
    bucket.push(tool)
  }

  const serverBlocks: Array<string> = []

  for (const [serverKey, serverTools] of [...byServer.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    const members = serverTools
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(
        (tool) => `${docComment(tool.description, `${INDENT}${INDENT}`)}${INDENT}${INDENT}${renderToolSignature(tool)}`,
      )

    serverBlocks.push(`${INDENT}${SchemaType.formatPropertyKey(serverKey)}: {\n${members.join("\n")}\n${INDENT}};`)
  }

  const toolsBlock =
    serverBlocks.length === 0 ? "declare const tools: {};" : `declare const tools: {\n${serverBlocks.join("\n")}\n};`

  return [
    toolsBlock,
    "declare const input: unknown;",
    "declare function load(key: string): unknown;",
    "declare function store(key: string, value: unknown): void;",
  ].join("\n\n")
}
