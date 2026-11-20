import type { AgentDefinition, InvalidAgent } from "@vibest/plugin/effect"

export interface AgentFile {
  readonly name: string
  readonly path: string
  readonly text: string | undefined
}

const KEYS = ["name", "description", "extends", "harness", "provider", "model"] as const

type Key = (typeof KEYS)[number]

const KEY_SET: ReadonlySet<string> = new Set(KEYS)

const isKey = (key: string): key is Key => KEY_SET.has(key)

const FILE_ID = /^[a-z][a-z0-9-]{0,31}$/

interface Failed {
  readonly error: string
}

const failed = (error: string): Failed => ({ error })

interface Parsed {
  readonly id: string
  readonly fields: Partial<Record<Key, string>>
  readonly body: string
}

const unquoted = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2")

const frontmatter = (lines: ReadonlyArray<string>): { readonly fields: Partial<Record<Key, string>> } | Failed => {
  const fields: Partial<Record<Key, string>> = {}

  for (const line of lines) {
    if (line.trim() === "") continue
    const match = /^([A-Za-z][\w-]*):(.*)$/.exec(line)

    if (match === null) return failed(`the frontmatter line ${JSON.stringify(line)} is not key: value`)
    const key = match[1]!

    if (!isKey(key)) return failed(`unknown key ${key}; the keys are ${KEYS.join(", ")}`)

    if (fields[key] !== undefined) return failed(`${key} is given twice`)
    fields[key] = unquoted(match[2]!)
  }

  return { fields }
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
  const { fields } = read

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

  return body === "" ? failed("the prompt (the text after the frontmatter) is empty") : { id, fields, body }
}

const launchFields = ({ fields }: Parsed) => ({
  ...(fields.harness !== undefined && { harness: fields.harness }),
  ...(fields.provider !== undefined && { provider: fields.provider }),
  ...(fields.model !== undefined && { model: fields.model }),
})

export const agentsFrom = (
  files: ReadonlyArray<AgentFile>,
  registered: (id: string) => AgentDefinition | undefined,
) => {
  const parsed = files.map((file) => ({ file, result: parse(file) }))
  const valid = new Map<string, Parsed>()
  const invalidIds = new Set<string>()

  for (const { result, file } of parsed)
    if ("error" in result) invalidIds.add(idOf(file))
    else valid.set(result.id, result)

  const plain = (agent: Parsed): AgentDefinition => ({
    id: agent.id,
    description: agent.fields.description!,
    system: agent.body,
    ...launchFields(agent),
  })

  const on = (agent: Parsed, base: AgentDefinition): AgentDefinition => ({
    ...plain(agent),
    system: `${base.system}\n\n${agent.body}`,
    ...(base.guard !== undefined && { guard: base.guard }),
  })

  const resolve = (agent: Parsed): AgentDefinition | Failed => {
    const target = agent.fields.extends

    if (target === undefined) return plain(agent)

    const file = target === agent.id ? undefined : valid.get(target)

    if (file !== undefined)
      return file.fields.extends === undefined
        ? on(agent, plain(file))
        : failed(`extends ${target}, which itself extends ${file.fields.extends}; only one level is allowed`)

    if (target !== agent.id && invalidIds.has(target)) return failed(`extends ${target}, which is invalid`)
    const base = registered(target)

    return base === undefined ? failed(`extends ${target}, but no registered agent has that id`) : on(agent, base)
  }

  const definitions: Array<AgentDefinition> = []
  const invalid: Array<InvalidAgent> = []

  for (const { file, result } of parsed) {
    const resolved = "error" in result ? result : resolve(result)

    if ("error" in resolved) invalid.push({ id: idOf(file), source: file.path, error: resolved.error })
    else definitions.push(resolved)
  }

  return { definitions, invalid }
}
