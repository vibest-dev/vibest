export const PROVEN_BY_HAND: Readonly<Record<string, string>> = {
  D9: "needs a newer release published to npm",
  I5: "needs the user's own Cursor login",
  I10: "needs the user's own Cursor login",
  S39: "depends on when the reports are queued",
}

export const PROVEN_BY_UNIT_TEST: Readonly<Record<string, string>> = {
  U3: "rpc.test.ts",
}

export type Feature = { readonly id: string; readonly title: string; readonly file: string }

export type ListedCheck = { readonly id: string; readonly tier: string; readonly covers: ReadonlyArray<string> }

export const readFeatures = (files: ReadonlyArray<{ readonly file: string; readonly text: string }>) => {
  const features: Array<Feature> = []
  const problems: Array<string> = []
  for (const { file, text } of files)
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.startsWith("## ")) continue
      const m = /^## ([A-Z]+\d+)\. (\S.*)$/.exec(line)
      if (m === null) problems.push(`${file}:${index + 1}: a capability heading is "## <ID>. <name>", not "${line}"`)
      else if (features.some((f) => f.id === m[1]))
        problems.push(`${file}:${index + 1}: ${m[1]} is already a capability`)
      else features.push({ id: m[1]!, title: m[2]!, file })
    }
  return { features, problems }
}

const featureIdOf = (checkId: string) => checkId.replace(/-.*$/, "")

export const provedIds = (check: ListedCheck) => [featureIdOf(check.id), ...check.covers]

export const consistency = (features: ReadonlyArray<Feature>, checks: ReadonlyArray<ListedCheck>) => {
  const problems: Array<string> = []
  const known = new Set(features.map((f) => f.id))
  const proven = new Set(checks.filter((c) => c.tier === "gate").flatMap(provedIds))
  const notByScript = { ...PROVEN_BY_HAND, ...PROVEN_BY_UNIT_TEST }
  for (const f of features)
    if (!proven.has(f.id) && !(f.id in notByScript))
      problems.push(`${f.id} (${f.file}) has no gate E2E check proving it and is not proven by hand`)
  for (const id of Object.keys(notByScript)) {
    if (!known.has(id)) problems.push(`${id} is listed in tools/verify as proven by hand, but no feature file has it`)
    if (proven.has(id))
      problems.push(`${id} is listed in tools/verify as proven by hand, but a gate E2E check proves it`)
  }
  for (const c of checks)
    for (const id of provedIds(c))
      if (!known.has(id)) problems.push(`E2E check ${c.id} names ${id}, which no file in docs/features has`)
  return problems
}
