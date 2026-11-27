import type { AgentDefinition, InvalidAgent } from "@vibest/plugin/effect"

export interface AgentFile {
  readonly name: string
  readonly path: string
  readonly text: string | undefined
}

const KEYS = ["name", "description", "harness", "provider", "model", "mcpServers"] as const

type Key = (typeof KEYS)[number]

type ScalarKey = Exclude<Key, "mcpServers">

const KEY_SET: ReadonlySet<string> = new Set(KEYS)

const isKey = (key: string): key is Key => KEY_SET.has(key)

const FILE_ID = /^[a-z][a-z0-9-]{0,31}$/

const NAMED_ENTRY = /^([A-Za-z0-9._-]+|['"][^'"]+['"])\s*:\s*(.*)$/

const INLINE_NAMED_OBJECT = /^\{\s*([A-Za-z0-9._-]+|['"][^'"]+['"])\s*:\s*\{[\s\S]*\}\s*\}$/

interface Failed {
  readonly error: string
}

const failed = (error: string): Failed => ({ error })

interface Parsed {
  readonly id: string
  readonly fields: Partial<Record<ScalarKey, string>>
  readonly mcpServers: ReadonlyArray<string> | undefined
  readonly warnings: ReadonlyArray<string>
  readonly body: string
}

const unquoted = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2")

const addUnique = (list: Array<string>, seen: Set<string>, name: string) => {
  const cleaned = name.trim()

  if (cleaned === "" || seen.has(cleaned)) return
  seen.add(cleaned)
  list.push(cleaned)
}

const inlineIgnoredWarning = (name: string) =>
  `inline mcpServers config for "${name}" is ignored; configure it centrally with vibest mcp add`

const ANONYMOUS_INLINE_WARNING =
  "inline mcpServers object entry is ignored; list server names configured with vibest mcp add"

const splitInlineItems = (content: string): ReadonlyArray<string> => {
  const items: Array<string> = []
  let start = 0
  let braceDepth = 0
  let bracketDepth = 0
  let quote: string | undefined

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!

    if (quote !== undefined) {
      if (ch === "\\" && i + 1 < content.length) {
        i++
        continue
      }

      if (ch === quote) quote = undefined
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }

    if (ch === "{") {
      braceDepth++
      continue
    }

    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1)
      continue
    }

    if (ch === "[") {
      bracketDepth++
      continue
    }

    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1)
      continue
    }

    if (ch === "," && braceDepth === 0 && bracketDepth === 0) {
      items.push(content.slice(start, i).trim())
      start = i + 1
    }
  }

  const tail = content.slice(start).trim()

  if (tail !== "" || items.length > 0) items.push(tail)

  return items
}

const parseInlineObjectEntry = (entry: string, servers: Array<string>, seen: Set<string>, warnings: Array<string>) => {
  const named = INLINE_NAMED_OBJECT.exec(entry)

  if (named !== null) {
    const name = unquoted(named[1]!)
    addUnique(servers, seen, name)
    warnings.push(inlineIgnoredWarning(name))

    return
  }

  warnings.push(ANONYMOUS_INLINE_WARNING)
}

interface InlineMcpServersResult {
  readonly mcpServers: ReadonlyArray<string> | undefined
  readonly warnings: ReadonlyArray<string>
}

interface BlockMcpServersResult {
  readonly nextIndex: number
  readonly mcpServers: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
}

const parseInlineMcpServers = (rest: string): InlineMcpServersResult => {
  const warnings: Array<string> = []

  if (rest.startsWith("[")) {
    if (!rest.endsWith("]")) {
      warnings.push('malformed mcpServers list; expected closing "]"')

      return { mcpServers: undefined, warnings }
    }

    const inner = rest.slice(1, -1).trim()

    if (inner === "") return { mcpServers: [], warnings }

    const servers: Array<string> = []
    const seen = new Set<string>()

    for (const rawItem of splitInlineItems(inner)) {
      if (rawItem === "") continue

      if (rawItem.startsWith("{")) {
        parseInlineObjectEntry(rawItem, servers, seen, warnings)
        continue
      }

      addUnique(servers, seen, unquoted(rawItem))
    }

    return { mcpServers: servers, warnings }
  }

  if (rest.startsWith("{")) {
    const servers: Array<string> = []
    const seen = new Set<string>()
    parseInlineObjectEntry(rest, servers, seen, warnings)

    return { mcpServers: servers.length > 0 ? servers : undefined, warnings }
  }

  warnings.push(`mcpServers must be a list of server names; ignoring ${JSON.stringify(rest)}`)

  return { mcpServers: undefined, warnings }
}

const consumeNestedLines = (lines: ReadonlyArray<string>, start: number, parentIndent: number) => {
  let index = start
  let hasNested = false

  while (index < lines.length) {
    const line = lines[index]!
    const trimmed = line.trim()

    if (trimmed === "") {
      index++
      continue
    }

    const indent = line.search(/\S/)

    if (indent <= parentIndent) break
    hasNested = true
    index++
  }

  return { nextIndex: index, hasNested }
}

const parseBlockMcpServers = (lines: ReadonlyArray<string>, start: number): BlockMcpServersResult => {
  const servers: Array<string> = []
  const seen = new Set<string>()
  const warnings: Array<string> = []
  let index = start

  while (index < lines.length) {
    const line = lines[index]!
    const trimmed = line.trim()

    if (trimmed === "") {
      index++
      continue
    }

    const indent = line.search(/\S/)

    if (indent === 0) break

    if (trimmed.startsWith("#")) {
      index++
      continue
    }

    const listMatch = /^-(?:\s+(.*))?$/.exec(trimmed)

    if (listMatch !== null) {
      const itemRest = (listMatch[1] ?? "").trim()
      const nested = consumeNestedLines(lines, index + 1, indent)
      index = nested.nextIndex

      if (itemRest === "") {
        warnings.push(nested.hasNested ? ANONYMOUS_INLINE_WARNING : "ignoring empty mcpServers entry")
        continue
      }

      if (itemRest.startsWith("{")) {
        parseInlineObjectEntry(itemRest, servers, seen, warnings)
        continue
      }

      const named = NAMED_ENTRY.exec(itemRest)

      if (named !== null) {
        const name = unquoted(named[1]!)
        addUnique(servers, seen, name)
        warnings.push(inlineIgnoredWarning(name))
        continue
      }

      const name = unquoted(itemRest)
      addUnique(servers, seen, name)

      if (nested.hasNested) warnings.push(inlineIgnoredWarning(name))
      continue
    }

    const nested = consumeNestedLines(lines, index + 1, indent)
    index = nested.nextIndex

    const named = NAMED_ENTRY.exec(trimmed)

    if (named !== null) {
      const name = unquoted(named[1]!)
      addUnique(servers, seen, name)
      warnings.push(inlineIgnoredWarning(name))
      continue
    }

    warnings.push(`ignoring unsupported mcpServers entry ${JSON.stringify(trimmed)}`)
  }

  return { nextIndex: index, mcpServers: servers, warnings }
}

const frontmatter = (
  lines: ReadonlyArray<string>,
):
  | {
      readonly fields: Partial<Record<ScalarKey, string>>
      readonly mcpServers: ReadonlyArray<string> | undefined
      readonly warnings: ReadonlyArray<string>
    }
  | Failed => {
  const fields: Partial<Record<ScalarKey, string>> = {}
  const warnings: Array<string> = []
  let mcpServers: ReadonlyArray<string> | undefined
  let mcpServersSeen = false

  for (let i = 0; i < lines.length;) {
    const line = lines[i]!

    if (line.trim() === "") {
      i++
      continue
    }

    const match = /^([A-Za-z][\w-]*):(.*)$/.exec(line)

    if (match === null) return failed(`the frontmatter line ${JSON.stringify(line)} is not key: value`)
    const key = match[1]!

    if (!isKey(key)) return failed(`unknown key ${key}; the keys are ${KEYS.join(", ")}`)

    if (key === "mcpServers") {
      if (mcpServersSeen) return failed("mcpServers is given twice")
      mcpServersSeen = true
      const rest = match[2]!.trim()

      if (rest === "") {
        const block = parseBlockMcpServers(lines, i + 1)
        mcpServers = block.mcpServers
        warnings.push(...block.warnings)
        i = block.nextIndex
      } else {
        const inline = parseInlineMcpServers(rest)
        mcpServers = inline.mcpServers
        warnings.push(...inline.warnings)
        i++
      }

      continue
    }

    if (fields[key] !== undefined) return failed(`${key} is given twice`)
    fields[key] = unquoted(match[2]!)
    i++
  }

  return { fields, mcpServers, warnings }
}

const idOf = (file: AgentFile) => file.name.slice(0, -".md".length)

const parse = (file: AgentFile): Parsed | Failed => {
  const id = idOf(file)

  if (!FILE_ID.test(id))
    return failed(
      "the file name must be lowercase letters, digits and -, start with a letter and have at most 32 characters before .md",
    )

  if (file.text === undefined) return failed("the file cannot be read")
  const lines = file.text.split(/\r?\n/)

  if (lines[0]?.trim() !== "---") return failed("the file must start with a --- line and the frontmatter")
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---")

  if (end < 0) return failed("the frontmatter has no closing --- line")
  const read = frontmatter(lines.slice(1, end))

  if ("error" in read) return read
  const { fields, mcpServers, warnings } = read

  if (fields.name !== undefined && fields.name !== id)
    return failed(`name ${fields.name} differs from the file name ${id}`)

  if (fields.description === undefined) return failed("description is missing")

  if (fields.description.trim() === "") return failed("description is empty")

  if (fields.harness === undefined && (fields.provider !== undefined || fields.model !== undefined))
    return failed("provider and model need harness")

  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim()

  return body === ""
    ? failed("the prompt (the text after the frontmatter) is empty")
    : { id, fields, mcpServers, warnings, body }
}

const launchFields = ({ fields, mcpServers, warnings }: Parsed) => ({
  ...(fields.harness !== undefined && { harness: fields.harness }),
  ...(fields.provider !== undefined && { provider: fields.provider }),
  ...(fields.model !== undefined && { model: fields.model }),
  ...(mcpServers !== undefined && { mcpServers }),
  ...(warnings.length > 0 && { warnings }),
})

export const agentsFrom = (files: ReadonlyArray<AgentFile>) => {
  const definitions: Array<AgentDefinition> = []
  const invalid: Array<InvalidAgent> = []

  for (const file of files) {
    const result = parse(file)

    if ("error" in result) invalid.push({ id: idOf(file), source: file.path, error: result.error })
    else
      definitions.push({
        id: result.id,
        description: result.fields.description!,
        system: result.body,
        ...launchFields(result),
      })
  }

  return { definitions, invalid }
}
