import {
  MachineAdded,
  MachineConnected,
  MachineRemoved,
  OutboxAcked,
  OutboxQueued,
  RemoteSeen,
  type AgentFrom,
} from "@vibest/schema/event"
import { randomId } from "@vibest/schema/id"
import { Effect } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { Bus } from "../bus.ts"
import { noticeEnvelope, sessionEnvelope } from "../replies.ts"
import type * as Inbox from "./inbox.ts"
import { ledgerReads } from "./ledger-read.ts"
import { queryRemoteEdges } from "./session-edges.ts"
import type * as Session from "./session-statements.ts"

export type RemoteScope = { readonly remote: string; readonly project: string; readonly session?: string }

export type MachineRow = {
  readonly name: string
  readonly target: string
  readonly remoteId: string
  readonly connectedAt: number
  readonly createdAt: number
}

export type RemoteStart = {
  readonly remote: string
  readonly project: string
  readonly reportTo?: string | undefined
}

export type OutboxRow = {
  readonly id: string
  readonly seq: number
  readonly sessionId: string
  readonly content: string
  readonly kind: "send" | "notice"
  readonly from: AgentFrom | null
  readonly createdAt: number
  readonly reportTo: string
}

export const statements = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { publish } = yield* Bus.Service

  const ofRemote = (session: Statement.Fragment, scope: RemoteScope) =>
    scope.session === undefined
      ? sql`EXISTS (SELECT 1 FROM session o WHERE o.id = ${session} AND o.origin_remote = ${scope.remote}
          AND o.origin_project = ${scope.project})`
      : sql`EXISTS (WITH RECURSIVE line(id) AS (
          SELECT ${session} UNION SELECT a.parent_session_id FROM session a JOIN line ON a.id = line.id
            WHERE a.parent_session_id IS NOT NULL)
        SELECT 1 FROM session o WHERE o.id IN (SELECT id FROM line) AND o.origin_remote = ${scope.remote}
          AND o.origin_project = ${scope.project} AND o.origin_session = ${scope.session})`

  const origins = (sessionId: string) =>
    sql<{
      remote: string | null
      project: string | null
      session: string | null
    }>`SELECT origin_remote AS remote, origin_project AS project, origin_session AS session
      FROM session WHERE id = ${sessionId}`.pipe(Effect.map((rows) => rows[0]))

  const queueForRemote = (
    remote: string,
    recipientSession: string | null,
    row: {
      readonly sessionId: string
      readonly content: string
      readonly kind: "send" | "notice"
      readonly from?: AgentFrom | undefined
      readonly at?: number
      readonly request?: string | undefined
      readonly id?: string | undefined
    },
  ) =>
    Effect.gen(function* () {
      if (recipientSession === null) return false

      let viaRemote = remote
      let recipient = recipientSession

      if ((yield* sql`SELECT 1 FROM remote WHERE id = ${remote}`).length === 0) {
        const origin = yield* origins(row.sessionId)

        if (!origin?.remote || (yield* sql`SELECT 1 FROM remote WHERE id = ${origin.remote}`).length === 0) return false
        viaRemote = origin.remote
        recipient = `${remote}:${recipientSession}`
      }

      const id = row.id ?? row.request ?? randomId()

      if ((yield* sql`SELECT 1 FROM outbox WHERE id = ${id}`).length > 0) return true

      const [open] =
        row.kind === "send"
          ? yield* sql<{ id: number }>`SELECT id FROM execution WHERE session_id = ${row.sessionId} AND owner = 1`
          : []

      yield* publish(OutboxQueued, {
        ...(row.at !== undefined && { at: row.at }),
        data: {
          id,
          remote: viaRemote,
          session: row.sessionId,
          recipient,
          kind: row.kind,
          content: row.content,
          ...(row.from !== undefined && { from: row.from }),
          ...(open !== undefined && { execution: open.id }),
        },
      })

      return true
    })

  const senderOf = (sessionId: string) =>
    sql<{ agent: string; name: string }>`SELECT agent, name FROM session WHERE id = ${sessionId}`.pipe(
      Effect.map(([row]): AgentFrom | undefined => row && { session: sessionId, agent: row.agent, title: row.name }),
    )

  const remoteName = (id: string) =>
    sql<{ name: string }>`SELECT name FROM machine WHERE remote_id = ${id}
      UNION ALL SELECT name FROM remote WHERE id = ${id}`.pipe(Effect.map((rows) => rows[0]?.name))

  return { ofRemote, origins, queueForRemote, senderOf, remoteName }
})

export type Statements = Effect.Success<typeof statements>

export const make = (session: Session.Statements, inbox: Inbox.Statements, remote: Statements) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { publish, transaction: tx } = yield* Bus.Service
    const reads = ledgerReads(sql)
    const { queueForRemote } = remote
    const machineColumns = sql`name, target, remote_id, connected_at, created_at`

    const machineNamed = (name: string) =>
      sql<MachineRow>`SELECT ${machineColumns} FROM machine WHERE name = ${name}`.pipe(Effect.map((rows) => rows[0]))

    return {
      machines: reads.machines.pipe(Effect.orDie),

      machineNamed: Effect.fn("Db.remote.machineNamed")((name: string) => machineNamed(name).pipe(Effect.orDie)),

      machineWithRemote: Effect.fn("Db.remote.machineWithRemote")((id: string) =>
        sql<MachineRow>`SELECT ${machineColumns} FROM machine WHERE remote_id = ${id}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie,
        ),
      ),

      addMachine: Effect.fn("Db.remote.addMachine")(
        (row: { readonly name: string; readonly target: string; readonly remoteId: string }) =>
          tx(
            Effect.gen(function* () {
              const taken = yield* sql`SELECT 1 FROM machine WHERE name = ${row.name} OR remote_id = ${row.remoteId}`

              if (taken.length > 0) return undefined
              yield* publish(MachineAdded, { data: { name: row.name, target: row.target, remote: row.remoteId } })

              return yield* machineNamed(row.name)
            }),
          ).pipe(Effect.orDie),
      ),

      removeMachine: Effect.fn("Db.remote.removeMachine")((name: string) =>
        tx(
          Effect.gen(function* () {
            if ((yield* machineNamed(name)) === undefined) return false
            yield* publish(MachineRemoved, { data: { name } })

            return true
          }),
        ).pipe(Effect.orDie),
      ),

      machineConnected: Effect.fn("Db.remote.machineConnected")((name: string) =>
        tx(
          Effect.gen(function* () {
            if ((yield* machineNamed(name)) !== undefined) yield* publish(MachineConnected, { data: { name } })
          }),
        ).pipe(Effect.orDie),
      ),

      receiveRemoteItem: Effect.fn("Db.remote.receiveRemoteItem")(
        (item: {
          readonly id: string
          readonly recipient: string
          readonly kind: "send" | "notice"
          readonly sender: string
          readonly from: AgentFrom
          readonly content: string
        }): Effect.Effect<"unknown" | "duplicate" | "queued"> =>
          tx(
            Effect.gen(function* () {
              const [route] = yield* sql<{ alive: number }>`SELECT s.ended_at IS NULL AS alive
                FROM session s WHERE s.id = ${item.recipient}`

              if (route === undefined) return "unknown" as const

              if (yield* reads.hasRemoteItem(item.id)) return "duplicate" as const

              const [forwarded] = yield* sql<{ session: string }>`SELECT session_id AS session FROM outbox
                WHERE id = ${item.id}`

              if (forwarded !== undefined && forwarded.session === item.recipient) return "duplicate" as const

              const heir = route.alive === 1 ? { local: item.recipient } : yield* session.nearestAlive(item.recipient)

              const noticeSender = item.from.machine ? `${item.sender} (on ${item.from.machine})` : item.sender

              const content =
                item.kind === "send"
                  ? sessionEnvelope(item.from.session, item.content, item.from.machine)
                  : noticeEnvelope(`${noticeSender}: ${item.content}`)

              if (heir !== undefined && "remote" in heir) {
                const [leg] = yield* sql<{
                  session: string
                }>`SELECT session_id AS session FROM outbox WHERE id = ${item.id}`

                if (leg !== undefined && leg.session === item.recipient) return "duplicate" as const

                const id = leg === undefined ? item.id : randomId()

                const queued = yield* queueForRemote(heir.remote, heir.session, {
                  id,
                  sessionId: item.recipient,
                  kind: item.kind,
                  from: item.from,
                  content: item.kind === "send" ? item.content : `${noticeSender}: ${item.content}`,
                })

                if (!queued) return "unknown" as const

                if (id !== item.id) {
                  const receipt = yield* inbox.queueInbox({
                    recipient: item.recipient,
                    sender: item.kind === "send" ? { type: "agent", ...item.from } : { type: "vibest" },
                    content,
                    transfer: item.id,
                  })

                  yield* inbox.moveInbox(sql`recipient_session_id = ${item.recipient} AND id = ${receipt}`, "dropped", {
                    reason: "forwarded",
                  })
                }

                return "queued" as const
              }

              const target = heir !== undefined && "local" in heir ? heir.local : undefined

              if (target === undefined) {
                const queued = yield* inbox.queueInbox({
                  recipient: item.recipient,
                  sender: item.kind === "send" ? { type: "agent", ...item.from } : { type: "vibest" },
                  content,
                  transfer: item.id,
                })

                yield* inbox.moveInbox(sql`recipient_session_id = ${item.recipient} AND id = ${queued}`, "dropped", {
                  reason: "the session was archived",
                })

                return "queued" as const
              }

              yield* inbox.queueInbox({
                recipient: target,
                sender: item.kind === "send" ? { type: "agent", ...item.from } : { type: "vibest" },
                content,
                transfer: item.id,
              })

              return "queued" as const
            }),
          ).pipe(Effect.orDie),
      ),

      projectCheckouts: sql<{ id: string; directory: string | null; path: string }>`SELECT p.id, p.directory, r.path
          FROM project p JOIN project_repository r ON r.project_id = p.id ORDER BY p.rowid, r.rowid`.pipe(Effect.orDie),

      outboxOf: Effect.fn("Db.remote.outboxOf")((remoteId: string, after = 0, limit = -1) =>
        reads.outboxOf(remoteId, after, limit).pipe(Effect.orDie),
      ),

      ackOutbox: Effect.fn("Db.remote.ackOutbox")((remoteId: string, ids: ReadonlyArray<string>) =>
        (ids.length === 0
          ? Effect.void
          : tx(
              Effect.gen(function* () {
                const found = yield* sql<{ id: string }>`SELECT id FROM outbox WHERE remote_id = ${remoteId}
                  AND acked_at IS NULL AND ${sql.in("id", ids)} ORDER BY seq`

                const [first, ...rest] = found.map((row) => row.id)

                if (first !== undefined)
                  yield* publish(OutboxAcked, { data: { remote: remoteId, ids: [first, ...rest] } })
              }),
            )
        ).pipe(Effect.orDie),
      ),

      noteRemote: Effect.fn("Db.remote.noteRemote")((row: { readonly id: string; readonly name: string }) =>
        tx(
          Effect.gen(function* () {
            const rows = yield* sql<{ name: string }>`SELECT name FROM remote WHERE id = ${row.id}`

            if (rows[0]?.name === row.name) return
            yield* publish(RemoteSeen, { data: { id: row.id, name: row.name } })
          }),
        ).pipe(Effect.orDie),
      ),

      senderOf: Effect.fn("Db.remote.senderOf")((sessionId: string) => remote.senderOf(sessionId).pipe(Effect.orDie)),

      nameForRemote: Effect.fn("Db.remote.nameForRemote")((id: string) => remote.remoteName(id).pipe(Effect.orDie)),

      remoteKnown: Effect.fn("Db.remote.remoteKnown")((id: string) =>
        sql`SELECT 1 FROM remote WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      ),

      sendToLinkedRemote: Effect.fn("Db.remote.sendToLinkedRemote")(
        (sessionId: string, target: string, message: string, request?: string) =>
          tx(
            Effect.gen(function* () {
              const matches = yield* queryRemoteEdges(sql, sessionId, target)

              if (matches.length === 0) return undefined

              if (matches.length > 1) return { ambiguous: matches.map((m) => m.session) } as const
              const [match] = matches

              const queued = yield* queueForRemote(match!.remote, match!.session, {
                sessionId,
                kind: "send",
                content: message,
                request,
                from: yield* remote.senderOf(sessionId),
              })

              return queued ? ({ sent: match!.session } as const) : ("unknown" as const)
            }),
          ).pipe(Effect.orDie),
      ),

      sendToRemote: Effect.fn("Db.remote.sendToRemote")(
        (sender: string, remoteId: string, recipient: string, message: string, request?: string) =>
          tx(
            Effect.gen(function* () {
              return yield* queueForRemote(remoteId, recipient, {
                sessionId: sender,
                kind: "send",
                content: message,
                request,
                from: yield* remote.senderOf(sender),
              })
            }),
          ).pipe(Effect.orDie),
      ),
    }
  })

export type Interface = Effect.Success<ReturnType<typeof make>>
