import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Mcp } from "@vibest/schema/mcp"

export * as McpSkillSync from "./skill-sync.ts"

export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024

const sanitizeSegment = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "server"

const firstLine = (text: string | undefined): string => {
  if (!text) return ""
  const line = text.split(/\r?\n/).find((item) => item.trim().length > 0)

  return line ? line.trim() : ""
}

const summarizeDescription = (server: string, tools: ReadonlyArray<Mcp.ToolInfo>, instructions?: string): string => {
  const head = firstLine(instructions)

  if (head.length > 0 && head.length <= 140) return head

  const sample = tools
    .slice(0, 5)
    .map((tool) => tool.name)
    .join(", ")

  const suffix = tools.length > 5 ? ` (+${tools.length - 5} more)` : ""

  return sample.length > 0
    ? `Use MCP server "${server}" via vibest mcp CLI. Tools: ${sample}${suffix}.`
    : `Use MCP server "${server}" via vibest mcp CLI.`
}

export const renderSkillMarkdown = (input: {
  readonly server: string
  readonly title?: string | undefined
  readonly instructions?: string | undefined
  readonly tools: ReadonlyArray<Mcp.ToolInfo>
}): string => {
  const skillName = `mcp-${sanitizeSegment(input.server)}`
  const description = summarizeDescription(input.server, input.tools, input.instructions).replace(/"/g, "'")

  const lines: Array<string> = [
    "---",
    `name: ${skillName}`,
    `description: "${description}"`,
    "---",
    "",
    `# MCP Server: ${input.title ?? input.server}`,
    "",
  ]

  if (input.instructions) {
    lines.push("## Instructions", "", input.instructions.trim(), "")
  }

  lines.push(
    "## Usage",
    "",
    `- Inspect a tool schema: \`vibest mcp describe ${input.server} <tool>\``,
    `- Invoke a tool: \`vibest mcp call ${input.server} <tool> '<json>'\``,
    "",
    "## Tools",
    "",
  )

  if (input.tools.length === 0) {
    lines.push("_No tools currently cached. Run `vibest mcp sync-skills` after connecting._", "")
  } else {
    for (const tool of input.tools) {
      const desc = firstLine(tool.description)
      const tail = desc ? ` — ${desc}` : ""
      lines.push(`- \`${tool.name}(${tool.signature})\`${tail}`)
    }

    lines.push("")
  }

  return lines.join("\n")
}

export const syncSkillsToDirectory = (input: {
  readonly skillsRoot: string
  readonly servers: ReadonlyArray<{
    readonly server: Mcp.ServerName
    readonly exposure: Mcp.ExposureMode
    readonly disabled?: boolean | undefined
    readonly title?: string | undefined
    readonly instructions?: string | undefined
    readonly tools: ReadonlyArray<Mcp.ToolInfo>
  }>
}): Mcp.SkillSyncResult => {
  fs.mkdirSync(input.skillsRoot, { recursive: true })
  const expectedDirs = new Set<string>()
  const synced: Array<Mcp.SkillSyncEntry> = []

  for (const item of input.servers) {
    if (item.disabled || item.exposure !== "skill") continue
    const dirName = `mcp-${sanitizeSegment(item.server)}`
    expectedDirs.add(dirName)
    const skillDir = path.join(input.skillsRoot, dirName)
    const skillPath = path.join(skillDir, "SKILL.md")
    fs.mkdirSync(skillDir, { recursive: true })

    const markdown = renderSkillMarkdown({
      server: item.server,
      title: item.title,
      instructions: item.instructions,
      tools: item.tools,
    })

    const tmpPath = `${skillPath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmpPath, markdown, "utf8")
    fs.renameSync(tmpPath, skillPath)
    synced.push({ server: item.server, skillPath, toolCount: item.tools.length })
  }

  const removed: Array<string> = []

  if (fs.existsSync(input.skillsRoot)) {
    for (const entry of fs.readdirSync(input.skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("mcp-")) continue

      if (expectedDirs.has(entry.name)) continue
      const fullPath = path.join(input.skillsRoot, entry.name)
      fs.rmSync(fullPath, { recursive: true, force: true })
      removed.push(fullPath)
    }
  }

  return { synced, removed }
}

export const guardCallResult = (input: {
  readonly server: string
  readonly tool: string
  readonly result: Mcp.CallResult
  readonly maxBytes?: number
  readonly scratchpadDir?: string
}): Mcp.CallResult => {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const serialized = JSON.stringify(input.result)

  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return input.result
  const targetDir = input.scratchpadDir ?? process.env.VIBEST_SCRATCHPAD_DIR ?? os.tmpdir()
  fs.mkdirSync(targetDir, { recursive: true })
  const fileName = `mcp-${sanitizeSegment(input.server)}-${sanitizeSegment(input.tool)}-${crypto.randomUUID()}.txt`
  const outputFile = path.join(targetDir, fileName)

  const fullText = input.result.content
    .map((block) => (block.type === "text" ? block.text : `[${block.mimeType} ${block.data.length} bytes]`))
    .join("\n")

  fs.writeFileSync(outputFile, fullText.length > 0 ? fullText : serialized, "utf8")
  const previewBudget = Math.max(512, Math.floor(maxBytes / 2))
  const previewSource = fullText.length > 0 ? fullText : serialized
  const preview = previewSource.slice(0, previewBudget)

  return {
    isError: input.result.isError,
    content: [
      {
        type: "text",
        text: `${preview}\n\n[Output truncated at ${maxBytes} bytes; full output saved to ${outputFile}]`,
      },
    ],
    truncated: true,
    outputFile,
  }
}
