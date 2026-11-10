export const METHODS = ["script", "unit", "agent", "slow"] as const

export type Method = (typeof METHODS)[number]

export type Row = {
  readonly id: string
  readonly method: Method
  readonly section: string
  readonly capability: string
}

export type ListedCheck = { readonly id: string; readonly tier: string; readonly covers: ReadonlyArray<string> }

export const provenByVerify = (method: Method) => method === "script" || method === "unit"

const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())

export const parseFeatureMap = (text: string) => {
  const rows: Array<Row> = []
  const problems: Array<string> = []
  let section = ""
  let methodAt: number | undefined
  for (const [index, line] of text.split("\n").entries()) {
    const at = `feature-map.md:${index + 1}`
    if (line.startsWith("## ")) section = line.slice(3).trim()
    if (!line.startsWith("|")) {
      methodAt = undefined
      continue
    }
    const cells = cellsOf(line)
    if (cells[0] === "ID") {
      methodAt = cells.indexOf("Method")
      if (methodAt === -1) problems.push(`${at}: a table without a Method column`)
      continue
    }
    if (cells.every((c) => /^:?-+:?$/.test(c)) || methodAt === undefined || methodAt === -1) continue
    const [id = "", capability = ""] = cells
    const method = cells[methodAt] ?? ""
    if (!/^[A-Z]+\d+$/.test(id)) problems.push(`${at}: malformed id "${id}"`)
    if (!(METHODS as ReadonlyArray<string>).includes(method))
      problems.push(`${at}: ${id}'s method "${method}" is not one of ${METHODS.join(", ")}`)
    else if (rows.some((r) => r.id === id)) problems.push(`${at}: ${id} appears twice`)
    else rows.push({ id, method: method as Method, section, capability: capability.replaceAll("`", "") })
  }
  return { rows, problems }
}

const rowIdOf = (checkId: string) => checkId.replace(/-.*$/, "")

export const consistency = (rows: ReadonlyArray<Row>, checks: ReadonlyArray<ListedCheck>) => {
  const problems: Array<string> = []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const gate = checks.filter((c) => c.tier === "gate")
  for (const r of rows)
    if (r.method === "script" && !gate.some((c) => rowIdOf(c.id) === r.id || c.covers.includes(r.id)))
      problems.push(`${r.id} is script, but no gate E2E check has its id or covers it`)
  for (const c of checks)
    for (const id of [rowIdOf(c.id), ...c.covers]) {
      const r = byId.get(id)
      if (r === undefined) problems.push(`E2E check ${c.id} names ${id}, which is not in the feature map`)
      else if (c.tier === "gate" && r.method !== "script")
        problems.push(`gate E2E check ${c.id} proves ${id}, whose method is ${r.method}, not script`)
    }
  return problems
}
