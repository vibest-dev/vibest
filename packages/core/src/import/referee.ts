import { Effect } from "effect"

import type { MachineRow, OutboxRow } from "../db-remote.ts"
import type { CoordinatorRow, SessionBrief, SessionRow, SpawnedBefore, TurnReport } from "../db-rows.ts"
import type { PeerRow, RescheduleSource } from "../ledger-read.ts"

export type SessionColumns = {
  readonly projectId: string
  readonly parentSessionId: string | null
  readonly reportToSessionId: string | null
  readonly role: string
  readonly name: string
  readonly directory: string
  readonly archiveOnCompletion: number
  readonly createdAt: number
  readonly endedAt: number | null
  readonly originPeer: string | null
  readonly originProject: string | null
  readonly originParent: string | null
  readonly originReportTo: string | null
}

export type InboxColumns = {
  readonly id: number
  readonly kind: string
  readonly recipient: string | null
  readonly sender: string | null
  readonly content: string
  readonly status: string
  readonly turn: number | null
}

export type ProjectView = {
  readonly id: string
  readonly directory: string | null
  readonly entrySessionId: string | null
  readonly repositories: ReadonlyArray<{ readonly path: string; readonly remoteUrl: string | null }>
}

export type InboxView = {
  readonly row: unknown
  readonly id: number
  readonly recipient: string | null
  readonly sender: string | null
  readonly resultTurn: number | null
}

type Read<A> = Effect.Effect<A, unknown>

export interface Reader {
  readonly sessions: Read<ReadonlyArray<SessionRow>>
  readonly sessionColumns: Read<ReadonlyArray<SessionColumns & { readonly id: string }>>
  readonly projects: Read<ReadonlyArray<ProjectView>>
  readonly coordinators: Read<ReadonlyArray<CoordinatorRow>>
  readonly inbox: Read<ReadonlyArray<InboxView>>
  readonly inboxColumns: Read<ReadonlyArray<InboxColumns>>
  readonly briefs: (ids: ReadonlyArray<string>) => Read<ReadonlyMap<string, SessionBrief>>
  readonly latestReport: (id: string, fence: "ready" | "start") => Read<TurnReport | undefined>
  readonly hadTerminal: (id: string) => Read<boolean>
  readonly untakenTask: (id: string) => Read<string | undefined>
  readonly rescheduleSource: (id: string) => Read<RescheduleSource>
  readonly queuedBy: (session: string, request: string) => Read<number | undefined>
  readonly spawnedBy: (project: string, request: string) => Read<SpawnedBefore | undefined>
  readonly machines: Read<ReadonlyArray<MachineRow>>
  readonly peers: Read<ReadonlyArray<PeerRow>>
  readonly outboxOf: (peer: string) => Read<ReadonlyArray<OutboxRow>>
  readonly hasPeerItem: (item: string) => Read<boolean>
}

export type Probes = {
  readonly sessions: ReadonlyArray<string>
  readonly requests: ReadonlyArray<readonly [session: string, request: string]>
  readonly spawns: ReadonlyArray<readonly [project: string, request: string]>
  readonly peers: ReadonlyArray<string>
  readonly peerItems: ReadonlyArray<string>
}

export type View = ReadonlyMap<string, { readonly entity: string; readonly key: string; readonly value: unknown }>

export const viewOf = (reader: Reader, probes: Probes) =>
  Effect.gen(function* () {
    const view = new Map<string, { entity: string; key: string; value: unknown }>()
    const put = (entity: string, key: string | number, value: unknown) =>
      view.set(`${entity}\u0000${key}`, { entity, key: String(key), value })
    for (const row of yield* reader.sessions) put("session", row.id, row)
    for (const { id, ...columns } of yield* reader.sessionColumns) put("session columns", id, columns)
    for (const project of yield* reader.projects) put("project", project.id, project)
    for (const row of yield* reader.coordinators) put("coordinator", row.projectId, row)
    for (const row of yield* reader.inbox) put("inbox", row.id, row)
    for (const row of yield* reader.inboxColumns) put("inbox columns", row.id, row)
    for (const [id, brief] of yield* reader.briefs(probes.sessions)) put("brief", id, brief)
    for (const id of probes.sessions) {
      put("latest report from start", id, (yield* reader.latestReport(id, "start")) ?? null)
      put("latest report from ready", id, (yield* reader.latestReport(id, "ready")) ?? null)
      put("had terminal", id, yield* reader.hadTerminal(id))
      put("untaken task", id, (yield* reader.untakenTask(id)) ?? null)
      put("reschedule source", id, yield* reader.rescheduleSource(id))
    }
    for (const [session, request] of probes.requests)
      put("queued by", `${session} ${request}`, (yield* reader.queuedBy(session, request)) ?? null)
    for (const [project, request] of probes.spawns)
      put("spawned by", `${project} ${request}`, (yield* reader.spawnedBy(project, request)) ?? null)
    for (const row of yield* reader.machines) put("machine", row.name, row)
    for (const row of yield* reader.peers) put("peer", row.id, row)
    for (const peer of probes.peers) put("outbox", peer, yield* reader.outboxOf(peer))
    for (const item of probes.peerItems) put("peer item", item, yield* reader.hasPeerItem(item))
    return view as View
  })

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : inner,
  ) ?? "undefined"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const MAX_DIFFERENCES = 20
const MAX_TEXT = 80

const shown = (value: unknown) => {
  const text = value === undefined ? "absent" : canonical(value)
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

export const compare = (v1: View, v2: View): ReadonlyArray<string> => {
  const differences: Array<string> = []
  const keys = [...new Set([...v1.keys(), ...v2.keys()])].sort()
  for (const key of keys) {
    const a = v1.get(key)
    const b = v2.get(key)
    const { entity, key: id } = (a ?? b)!
    const left = a?.value
    const right = b?.value
    const fields =
      isRecord(left) && isRecord(right) ? [...new Set([...Object.keys(left), ...Object.keys(right)])] : [""]
    for (const field of fields.sort()) {
      const x = field === "" ? left : (left as Record<string, unknown>)[field]
      const y = field === "" ? right : (right as Record<string, unknown>)[field]
      if (canonical(x) === canonical(y)) continue
      differences.push(`${entity} ${id}${field === "" ? "" : ` ${field}`}: v1 ${shown(x)}, v2 ${shown(y)}`)
      if (differences.length === MAX_DIFFERENCES) return differences
    }
  }
  return differences
}
