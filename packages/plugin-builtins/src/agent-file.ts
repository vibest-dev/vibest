import type { AgentDefinition, InvalidAgent } from "@vibest/plugin/effect"
import { Predicate } from "effect"
import { isMap, isScalar, isSeq, parseDocument, type ParsedNode, type YAMLMap } from "yaml"

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

const ANONYMOUS_INLINE_WARNING =
  "inline mcpServers object entry is ignored; list server names configured with vibest mcp add"

const inlineIgnoredWarning = (name: string) =>
  `inline mcpServers config for "${name}" is ignored; configure it centrally with vibest mcp add`

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

interface FrontmatterResult {
  readonly fields: Partial<Record<ScalarKey, string>>
  readonly mcpServers: ReadonlyArray<string> | undefined
  readonly warnings: ReadonlyArray<string>
}

interface CollectedMcpServers {
  readonly mcpServers: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
}

const addUnique = (list: Array<string>, seen: Set<string>, name: string) => {
  const cleaned = name.trim()

  if (cleaned === "" || seen.has(cleaned)) return
  seen.add(cleaned)
  list.push(cleaned)
}

const isNullNode = (node: ParsedNode | null | undefined): boolean =>
  node === null || node === undefined || (isScalar(node) && (node.value === null || node.value === undefined))

const collectMapNode = (
  map: YAMLMap<ParsedNode, ParsedNode | null>,
  servers: Array<string>,
  seen: Set<string>,
  warnings: Array<string>,
) => {
  const isNamedServerMap =
    map.items.length > 0 &&
    map.items.every(
      (pair) =>
        isScalar(pair.key) && Predicate.isString(pair.key.value) && (isNullNode(pair.value) || isMap(pair.value)),
    )

  if (isNamedServerMap) {
    for (const pair of map.items) {
      if (!isScalar(pair.key) || !Predicate.isString(pair.key.value)) continue
      addUnique(servers, seen, pair.key.value)
      warnings.push(inlineIgnoredWarning(pair.key.value))
    }

    return
  }

  warnings.push(ANONYMOUS_INLINE_WARNING)
}

const collectMcpServers = (node: ParsedNode | null | undefined): CollectedMcpServers => {
  const servers: Array<string> = []
  const seen = new Set<string>()
  const warnings: Array<string> = []

  if (isNullNode(node)) return { mcpServers: servers, warnings }

  if (isSeq(node)) {
    for (const item of node.items) {
      if (isNullNode(item)) {
        warnings.push("ignoring empty mcpServers entry")
        continue
      }

      if (isScalar(item) && Predicate.isString(item.value)) {
        const cleaned = item.value.trim()

        if (cleaned === "") warnings.push("ignoring empty mcpServers entry")
        else addUnique(servers, seen, cleaned)
        continue
      }

      if (isMap(item)) {
        collectMapNode(item, servers, seen, warnings)
        continue
      }

      warnings.push(`ignoring unsupported mcpServers entry ${JSON.stringify(item.toJSON())}`)
    }

    return { mcpServers: servers, warnings }
  }

  if (isMap(node)) {
    collectMapNode(node, servers, seen, warnings)

    return { mcpServers: servers, warnings }
  }

  if (isScalar(node)) {
    warnings.push(`mcpServers must be a list of server names; ignoring ${JSON.stringify(node.value)}`)

    return { mcpServers: servers, warnings }
  }

  warnings.push("mcpServers must be a list of server names")

  return { mcpServers: servers, warnings }
}

const frontmatter = (lines: ReadonlyArray<string>): FrontmatterResult | Failed => {
  const source = lines.join("\n")

  if (source.trim() === "") return { fields: {}, mcpServers: undefined, warnings: [] }

  const doc = parseDocument(source, { uniqueKeys: false })

  if (doc.errors.length > 0) {
    return failed(`the frontmatter is not valid YAML: ${doc.errors[0]!.message}`)
  }

  if (!isMap(doc.contents)) {
    return failed("the frontmatter must be a key: value mapping")
  }

  const fields: Partial<Record<ScalarKey, string>> = {}
  const warnings: Array<string> = []
  let mcpServers: ReadonlyArray<string> | undefined
  let mcpServersSeen = false

  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key) || !Predicate.isString(pair.key.value)) {
      return failed("the frontmatter keys must be strings")
    }

    const key = pair.key.value

    if (!isKey(key)) return failed(`unknown key ${key}; the keys are ${KEYS.join(", ")}`)

    if (key === "mcpServers") {
      if (mcpServersSeen) return failed("mcpServers is given twice")
      mcpServersSeen = true
      const collected = collectMcpServers(pair.value)
      mcpServers = collected.mcpServers
      warnings.push(...collected.warnings)
      continue
    }

    if (fields[key] !== undefined) return failed(`${key} is given twice`)

    if (isNullNode(pair.value)) {
      fields[key] = ""
      continue
    }

    if (!isScalar(pair.value)) return failed(`${key} must be a string`)

    fields[key] = String(pair.value.value).trim()
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
