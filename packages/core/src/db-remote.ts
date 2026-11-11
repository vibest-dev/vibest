import { MachineAdded, MachineConnected, MachineRemoved, OutboxAcked, PeerSeen } from "@vibest/schema/event"
import { Effect } from "effect"
import type { Statement } from "effect/sql"

import type { Store } from "./db-store.ts"

export type MachineRow = {
  readonly name: string
  readonly target: string
  readonly vibestdId: string
  readonly connectedAt: number
  readonly createdAt: number
}

export type PeerStart = {
  readonly peer: string
  readonly project: string
  readonly reportTo?: string | undefined
}

export type OutboxRow = {
  readonly id: string
  readonly sessionId: string
  readonly content: string
  readonly createdAt: number
  readonly reportTo: string
}

export const remoteQueries = ({ sql, reads, tx, emit, queueInbox, placed, currentProcess }: Store) => {
  const machineColumns = sql`name, target, vibestd_id, connected_at, created_at`
  const machineNamed = (name: string) =>
    sql<MachineRow>`SELECT ${machineColumns} FROM machine WHERE name = ${name}`.pipe(Effect.map((rows) => rows[0]))

  return {
    ofPeer: (session: Statement.Fragment, scope: { readonly peer: string; readonly project: string }) =>
      sql`EXISTS (SELECT 1 FROM session o WHERE o.id = ${session} AND o.origin_peer = ${scope.peer}
        AND o.origin_project = ${scope.project})`,

    queries: {
      machines: reads.machines.pipe(Effect.orDie),

      machineNamed: (name: string) => machineNamed(name).pipe(Effect.orDie),

      machineWithVibestd: (id: string) =>
        sql<MachineRow>`SELECT ${machineColumns} FROM machine WHERE vibestd_id = ${id}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie,
        ),

      addMachine: (row: { readonly name: string; readonly target: string; readonly vibestdId: string }) =>
        tx(
          Effect.gen(function* () {
            const taken = yield* sql`SELECT 1 FROM machine WHERE name = ${row.name} OR vibestd_id = ${row.vibestdId}`
            if (taken.length > 0) return undefined
            yield* emit(MachineAdded, { data: { name: row.name, target: row.target, vibestd: row.vibestdId } })
            return yield* machineNamed(row.name)
          }),
        ).pipe(Effect.orDie),

      removeMachine: (name: string) =>
        tx(
          Effect.gen(function* () {
            if ((yield* machineNamed(name)) === undefined) return false
            yield* emit(MachineRemoved, { data: { name } })
            return true
          }),
        ).pipe(Effect.orDie),

      machineConnected: (name: string) =>
        tx(
          Effect.gen(function* () {
            if ((yield* machineNamed(name)) !== undefined) yield* emit(MachineConnected, { data: { name } })
          }),
        ).pipe(Effect.orDie),

      projectRemote: (projectId: string) =>
        sql<{ path: string; remote: string | null }>`SELECT path, remote_url AS remote FROM project_repository
          WHERE project_id = ${projectId} ORDER BY rowid`.pipe(Effect.orDie),

      receivePeerItem: (item: {
        readonly id: string
        readonly recipient: string
        readonly content: string
      }): Effect.Effect<"unknown" | "duplicate" | "queued"> =>
        tx(
          Effect.gen(function* () {
            const [route] = yield* sql<{ project: string; recipient: string | null; entry: string | null }>`SELECT
                s.project_id AS project, p.entry_session_id AS entry,
                CASE WHEN s.ended_at IS NULL THEN s.id ELSE p.entry_session_id END AS recipient
              FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ${item.recipient}`
            if (route === undefined) return "unknown" as const
            if (yield* reads.hasPeerItem(item.id)) return "duplicate" as const
            const recipient = route.recipient
            const here =
              recipient !== null &&
              (recipient !== route.entry || placed(route.project, yield* currentProcess(recipient)))
            yield* queueInbox({
              recipient: recipient ?? item.recipient,
              kind: "notice",
              sender: null,
              content: item.content,
              status: here ? "pending" : "dropped",
              peerItem: item.id,
            })
            return "queued" as const
          }),
        ).pipe(Effect.orDie),

      remoteProjects: sql<{ id: string; directory: string | null; repositories: number; remote: string }>`SELECT
            p.id, p.directory, r.remote_url AS remote,
            (SELECT count(*) FROM project_repository c WHERE c.project_id = p.id) AS repositories
          FROM project p JOIN project_repository r ON r.project_id = p.id
          WHERE r.remote_url IS NOT NULL ORDER BY p.rowid, r.rowid`.pipe(Effect.orDie),

      outboxOf: (peer: string) => reads.outboxOf(peer).pipe(Effect.orDie),

      ackOutbox: (peer: string, ids: ReadonlyArray<string>) =>
        (ids.length === 0
          ? Effect.void
          : tx(
              Effect.gen(function* () {
                const found = yield* sql<{ id: string }>`SELECT id FROM outbox WHERE peer_id = ${peer}
                  AND ${sql.in("id", ids)} ORDER BY seq`
                const [first, ...rest] = found.map((row) => row.id)
                if (first !== undefined) yield* emit(OutboxAcked, { data: { peer, ids: [first, ...rest] } })
              }),
            )
        ).pipe(Effect.orDie),

      notePeer: (peer: { readonly id: string; readonly name: string }) =>
        tx(emit(PeerSeen, { data: { id: peer.id, name: peer.name } })).pipe(Effect.asVoid, Effect.orDie),

      peerKnown: (id: string) =>
        sql`SELECT 1 FROM peer WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
    },
  }
}
