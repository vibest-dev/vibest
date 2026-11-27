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
  readonly main: VibestSession | null
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

const shown = (s: VibestSession): number => (s.terminal === null ? 0 : 1)

export const mainSession = (sessions: readonly VibestSession[]): VibestSession | null =>
  sessions.filter((s) => s.parentId === null).sort((a, b) => shown(b) - shown(a) || recent(a, b))[0] ?? null

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
    const main = mainSession(all)
    const sessions = all.filter((s) => s !== main).sort(recent)

    const member: MachineMember = {
      machine: project.machine,
      project,
      main,
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

export interface AgentRow {
  readonly session: VibestSession
  readonly depth: number
}

const MAX_DEPTH = 3

export const agentTree = (sessions: readonly VibestSession[]): AgentRow[] => {
  const ids = new Set(sessions.map((s) => s.id))

  const walk = (parentId: string | null, depth: number): AgentRow[] =>
    sessions
      .filter((s) => (depth === 0 ? s.parentId === null || !ids.has(s.parentId) : s.parentId === parentId))
      .flatMap((s) => [{ session: s, depth: Math.min(depth, MAX_DEPTH) }, ...walk(s.id, depth + 1)])

  return walk(null, 0)
}

export const groupAgents = (group: ProjectGroup): AgentRow[] => {
  const [primary] = group.members

  return agentTree(group.members.flatMap((m) => (m === primary || !m.main ? m.sessions : [m.main, ...m.sessions])))
}

export const extraLinks = (session: VibestSession, sessions: readonly VibestSession[]): string[] => {
  const tree = new Set(sessions.flatMap((s) => (s.parentId === session.id ? [s.id] : [])))

  if (session.parentId !== null) tree.add(session.parentId)

  const names = new Map(sessions.map((s) => [s.id, s.name]))

  return session.to.flatMap((id) => (tree.has(id) ? [] : [names.get(id) ?? id.slice(0, 8)]))
}
