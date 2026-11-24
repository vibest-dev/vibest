import {
  type Activity,
  LOCAL,
  loudest,
  type VibestProject,
  type VibestSession,
  type VibestState,
} from "./vibest-model.ts"

export interface MachineMember {
  readonly machine: string
  readonly project: VibestProject
  readonly entry: VibestSession | null
  readonly sessions: readonly VibestSession[]
  readonly activity: Activity
}

export interface ProjectGroup {
  readonly key: string
  readonly label: string
  readonly members: readonly MachineMember[]
  readonly activity: Activity
}

const physicalKey = (p: VibestProject): string => `${p.machine}:${p.directory}`

export const groupKey = (p: VibestProject): string => {
  const identities = p.repositories.flatMap((r) => (r.identity === null ? [] : [r.identity]))

  if (identities.length === 0 || identities.length < p.repositories.length) return physicalKey(p)

  return [...new Set(identities)].sort().join("+")
}

const lastSegment = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path

const singleIdentity = (key: string, p: VibestProject): string | null => {
  const single = p.repositories.length === 1 ? (p.repositories[0]?.identity ?? null) : null

  return single === key ? single : null
}

const labelOf = (key: string, p: VibestProject): string => {
  const single = singleIdentity(key, p)

  return single ? lastSegment(single) : lastSegment(p.directory)
}

const ownerAndName = (key: string, p: VibestProject): string => {
  const single = singleIdentity(key, p)

  return single ? single.split("/").filter(Boolean).slice(-2).join("/") : p.directory
}

const distinct = (groups: ProjectGroup[]): ProjectGroup[] => {
  const count = new Map<string, number>()

  for (const g of groups) count.set(g.label, (count.get(g.label) ?? 0) + 1)

  return groups.map((g) =>
    (count.get(g.label) ?? 0) > 1 ? { ...g, label: ownerAndName(g.key, g.members[0]!.project) } : g,
  )
}

const byMachine = (a: MachineMember, b: MachineMember): number =>
  a.machine === b.machine ? 0 : a.machine === LOCAL ? -1 : b.machine === LOCAL ? 1 : a.machine.localeCompare(b.machine)

const recent = (a: VibestSession, b: VibestSession): number => (b.lastActive ?? 0) - (a.lastActive ?? 0)

export const projectGroups = (state: VibestState): ProjectGroup[] => {
  const sessionsOf = new Map<string, VibestSession[]>()

  for (const s of state.sessions) {
    const key = `${s.machine}:${s.projectId}`
    const list = sessionsOf.get(key)

    if (list) list.push(s)
    else sessionsOf.set(key, [s])
  }

  const groups = new Map<string, MachineMember[]>()

  for (const project of state.projects) {
    const all = sessionsOf.get(`${project.machine}:${project.id}`) ?? []
    const entry = all.find((s) => s.id === project.entrySessionId) ?? null
    const sessions = all.filter((s) => s !== entry).sort(recent)

    const member: MachineMember = {
      machine: project.machine,
      project,
      entry,
      sessions,
      activity: loudest([project.activity, ...all.map((s) => s.status)]),
    }

    const key = groupKey(project)
    const list = groups.get(key)

    if (list) list.push(member)
    else groups.set(key, [member])
  }

  return distinct(
    [...groups].map(([key, members]) => {
      const sorted = members.sort(byMachine)

      return {
        key,
        label: labelOf(key, sorted[0]!.project),
        members: sorted,
        activity: loudest(sorted.map((m) => m.activity)),
      }
    }),
  )
}
