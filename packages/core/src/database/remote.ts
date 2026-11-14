import {
  MachineAdded,
  MachineConnected,
  MachineRemoved,
  OutboxAcked,
  OutboxQueued,
  PeerSeen,
} from "@vibest/schema/event"
import { randomId } from "@vibest/schema/id"
import { Effect } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { Bus } from "../bus.ts"
import { noticeEnvelope, sessionEnvelope } from "../replies.ts"
import type * as Inbox from "./inbox.ts"
import { ledgerReads } from "./ledger-read.ts"
import type * as Session from "./session-statements.ts"

export type PeerScope = { readonly peer: string; readonly project: string; readonly session?: string }

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
  readonly seq: number
  readonly sessionId: string
  readonly content: string
  readonly kind: "send" | "notice"
  readonly createdAt: number
  readonly reportTo: string
}

export const statements = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { publish } = yield* Bus

  const ofPeer = (session: Statement.Fragment, scope: PeerScope) =>
    scope.session === undefined
      ? sql`EXISTS (SELECT 1 FROM session o WHERE o.id = ${session} AND o.origin_peer = ${scope.peer}
          AND o.origin_project = ${scope.project})`
      : sql`EXISTS (WITH RECURSIVE line(id) AS (
          SELECT ${session} UNION SELECT a.parent_session_id FROM session a JOIN line ON a.id = line.id
            WHERE a.parent_session_id IS NOT NULL)
        SELECT 1 FROM session o WHERE o.id IN (SELECT id FROM line) AND o.origin_peer = ${scope.peer}
          AND o.origin_project = ${scope.project} AND o.origin_session = ${scope.session})`

  const origins = (sessionId: string) =>
    sql<{
      peer: string | null
      project: string | null
      session: string | null
    }>`SELECT origin_peer AS peer, origin_project AS project, origin_session AS session
      FROM session WHERE id = ${sessionId}`.pipe(Effect.map((rows) => rows[0]))

  const queueForPeer = (
    peer: string,
    recipientSession: string | null,
    row: {
      readonly sessionId: string
      readonly content: string
      readonly kind: "send" | "notice"
      readonly at?: number
      readonly request?: string | undefined
    },
  ) =>
    Effect.gen(function* () {
      if (recipientSession === null) return false
      if ((yield* sql`SELECT 1 FROM peer WHERE id = ${peer}`).length === 0) return false
      const id = row.request ?? randomId()
      if ((yield* sql`SELECT 1 FROM outbox WHERE id = ${id}`).length > 0) return true
      yield* publish(OutboxQueued, {
        ...(row.at === undefined ? {} : { at: row.at }),
        data: {
          id,
          peer,
          session: row.sessionId,
          recipient: recipientSession,
          kind: row.kind,
          content: row.content,
        },
      })
      return true
    })

  return { ofPeer, origins, queueForPeer }
})

export type Statements = Effect.Success<typeof statements>

export const make = (session: Session.Statements, inbox: Inbox.Statements, remote: Statements) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { publish, transaction: tx } = yield* Bus
    const reads = ledgerReads(sql)
    const { queueForPeer, origins } = remote
    const machineColumns = sql`name, target, vibestd_id, connected_at, created_at`
    const machineNamed = (name: string) =>
      sql<MachineRow>`SELECT ${machineColumns} FROM machine WHERE name = ${name}`.pipe(Effect.map((rows) => rows[0]))

    return {
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
            yield* publish(MachineAdded, { data: { name: row.name, target: row.target, vibestd: row.vibestdId } })
            return yield* machineNamed(row.name)
          }),
        ).pipe(Effect.orDie),

      removeMachine: (name: string) =>
        tx(
          Effect.gen(function* () {
            if ((yield* machineNamed(name)) === undefined) return false
            yield* publish(MachineRemoved, { data: { name } })
            return true
          }),
        ).pipe(Effect.orDie),

      machineConnected: (name: string) =>
        tx(
          Effect.gen(function* () {
            if ((yield* machineNamed(name)) !== undefined) yield* publish(MachineConnected, { data: { name } })
          }),
        ).pipe(Effect.orDie),

      receivePeerItem: (item: {
        readonly id: string
        readonly recipient: string
        readonly kind: "send" | "notice"
        readonly sender: string
        readonly content: string
      }): Effect.Effect<"unknown" | "duplicate" | "queued"> =>
        tx(
          Effect.gen(function* () {
            const [route] = yield* sql<{ project: string; entry: string | null; alive: number }>`SELECT
                s.project_id AS project, p.entry_session_id AS entry, s.ended_at IS NULL AS alive
              FROM session s JOIN project p ON p.id = s.project_id WHERE s.id = ${item.recipient}`
            if (route === undefined) return "unknown" as const
            if (yield* reads.hasPeerItem(item.id)) return "duplicate" as const
            const heir = route.alive === 1 ? { local: item.recipient } : yield* session.nearestAlive(item.recipient)
            const content =
              item.kind === "send"
                ? sessionEnvelope({ id: item.sender }, item.content)
                : noticeEnvelope(`${item.sender}: ${item.content}`)
            if (heir !== undefined && "peer" in heir) {
              yield* inbox.queueInbox({
                recipient: item.recipient,
                kind: item.kind,
                sender: null,
                content,
                status: "dropped",
                peerItem: item.id,
              })
              yield* queueForPeer(heir.peer, heir.session, {
                sessionId: item.recipient,
                kind: item.kind,
                content: `${item.sender}: ${item.content}`,
              })
              return "queued" as const
            }
            const target = heir !== undefined && "local" in heir ? heir.local : undefined
            const here =
              target !== undefined &&
              (target !== route.entry || session.placed(route.project, yield* session.currentProcess(target)))
            yield* inbox.queueInbox({
              recipient: target ?? item.recipient,
              kind: item.kind,
              sender: null,
              content,
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

      outboxOf: (peer: string, after = 0, limit = -1) => reads.outboxOf(peer, after, limit).pipe(Effect.orDie),

      ackOutbox: (peer: string, ids: ReadonlyArray<string>) =>
        (ids.length === 0
          ? Effect.void
          : tx(
              Effect.gen(function* () {
                const found = yield* sql<{ id: string }>`SELECT id FROM outbox WHERE peer_id = ${peer}
                  AND ${sql.in("id", ids)} ORDER BY seq`
                const [first, ...rest] = found.map((row) => row.id)
                if (first !== undefined) yield* publish(OutboxAcked, { data: { peer, ids: [first, ...rest] } })
              }),
            )
        ).pipe(Effect.orDie),

      notePeer: (peer: { readonly id: string; readonly name: string }) =>
        tx(publish(PeerSeen, { data: { id: peer.id, name: peer.name } })).pipe(Effect.asVoid, Effect.orDie),

      peerKnown: (id: string) =>
        sql`SELECT 1 FROM peer WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),

      sendToOrigin: (sessionId: string, target: string, message: string, request?: string) =>
        tx(
          Effect.gen(function* () {
            const origin = yield* origins(sessionId)
            const creator = origin?.session
            if (!origin?.peer || !creator || target.length < 8 || !creator.startsWith(target)) return undefined
            return yield* queueForPeer(origin.peer, creator, {
              sessionId,
              kind: "send",
              content: message,
              request,
            })
          }),
        ).pipe(Effect.orDie),

      sendToPeer: (sender: string, peer: string, session: string, message: string, request?: string) =>
        tx(queueForPeer(peer, session, { sessionId: sender, kind: "send", content: message, request })).pipe(
          Effect.orDie,
        ),
    }
  })

export type Interface = Effect.Success<ReturnType<typeof make>>
