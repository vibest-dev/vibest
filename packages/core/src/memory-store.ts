// The storage port in memory (db.ts `DbShape`): the engine's own tests and a product with nothing to keep across
// restarts (apps/vibest/test/engine-only.test.ts) use it. The same facts the SQLite store keeps (sessions, inbox rows,
// append-only events, the owner of each scope), held in arrays; every read derives its rows through the shared read
// model (read-model.ts), so both stores answer alike and pass the same contract suite (test/store-contract.ts).
// One lock around every operation makes each atomic.
import { Clock, Effect, Layer, Schema, Semaphore } from "effect"

import {
  Db,
  type DbShape,
  encodeAddress,
  type EndReason,
  failureOf,
  type InboxKind,
  InboxRow,
  type InboxStatus,
  type Integration,
  type NewInboxRow,
  OwnerRow,
  type RuntimeAddress,
  type SessionBrief,
  type SessionPatch,
  type SessionRow,
  type TurnEnd,
  type TurnState,
  type AgentStatus,
  type MessageStatusName,
} from "./db.ts"
import {
  type Current,
  currentOf,
  decodeSessions,
  fromColumns,
  MESSAGE_STATUSES,
  newId,
  type ProcessStart,
  roundStatus,
  type SessionFacts,
  storedStatus,
  summaryIn,
  toInbox,
} from "./read-model.ts"

type Session = {
  readonly id: string
  readonly scope: string
  readonly parent: string | null
  readonly reportTo: string | null
  readonly role: string
  name: string
  readonly machine: string
  directory: string
  readonly archive: boolean
  readonly createdAt: number
  endedAt: number | null
  /** Insertion order (SQLite's rowid). */
  readonly seq: number
}

type Event = {
  readonly id: number
  readonly at: number
  readonly sessionId: string
  readonly type: string
  readonly processId: number | null
  readonly turnId: number | null
  readonly inboxId: number | null
  readonly data: Readonly<Record<string, unknown>>
}

type Row = {
  readonly id: number
  readonly recipient: string | null
  readonly kind: InboxKind
  readonly sender: string | null
  readonly content: string
  readonly resultEventId: number | null
  /** As stored: `delivering` is the public `sending`. */
  status: string
}

const TO_SESSION: ReadonlyArray<string> = ["task", "send"]

export const make = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1)
  const now = Clock.currentTimeMillis
  const decodeInbox = Schema.decodeUnknownEffect(Schema.Array(InboxRow))
  const decodeOwners = Schema.decodeUnknownEffect(Schema.Array(OwnerRow))

  const sessions = new Map<string, Session>()
  const events: Array<Event> = []
  const inbox: Array<Row> = []
  /** Each scope's owner session (none yet: absent). */
  const owner = new Map<string, string>()
  // Memory only, as in the SQLite store.
  const statuses = new Map<string, AgentStatus>()
  const integrations = new Map<string, Integration>()
  const prompted = new Map<number, number>()
  const moving = new Set<string>()

  const remember = (row: Pick<SessionRow, "id" | "status" | "metadata">) => {
    if (row.metadata.archived || row.metadata.removed) integrations.delete(row.id)
    if (row.status === "unknown" || row.metadata.archived || row.metadata.removed) statuses.delete(row.id)
    else statuses.set(row.id, row.status)
  }

  const appendEvent = (event: {
    readonly sessionId: string
    readonly type: string
    readonly processId?: number | undefined
    readonly turnId?: number | undefined
    readonly inboxId?: number | undefined
    readonly data?: Readonly<Record<string, unknown>>
    readonly at?: number
  }) =>
    Effect.gen(function* () {
      const id = events.length + 1
      events.push({
        id,
        at: event.at ?? (yield* now),
        sessionId: event.sessionId,
        type: event.type,
        processId: event.processId ?? null,
        turnId: event.turnId ?? null,
        inboxId: event.inboxId ?? null,
        data: event.data ?? {},
      })
      return id
    })

  const latest = (match: (e: Event) => boolean) => {
    for (let i = events.length - 1; i >= 0; i--) if (match(events[i]!)) return events[i]
    return undefined
  }
  const ended = (processId: number) => events.find((e) => e.processId === processId && e.type === "process.end")
  const turnEnd = (turnId: number) => events.find((e) => e.turnId === turnId && e.type === "turn.end")
  const isOwner = (id: string) => [...owner.values()].includes(id)

  /** The current process: the latest start, passing over a start that never got its terminal (`launch_failed`). */
  const currentStart = (sessionId: string) => {
    const starts = events.filter((e) => e.sessionId === sessionId && e.type === "process.start")
    const failed = (e: Event) =>
      e.data.terminal === "" &&
      events.some((f) => f.processId === e.id && f.type === "process.end" && f.data.reason === "launch_failed")
    return starts.sort((a, b) => Number(failed(a)) - Number(failed(b)) || b.id - a.id)[0]
  }

  const facts = (s: Session): SessionFacts => {
    const p = currentStart(s.id)
    const fromP = (type: ReadonlyArray<string>, has: (e: Event) => boolean) =>
      p === undefined ? undefined : latest((e) => e.processId === p.id && type.includes(e.type) && has(e))
    const t = latest((e) => e.sessionId === s.id && e.type === "turn.start")
    const mine = events.filter((e) => e.sessionId === s.id)
    const attempts = mine
      .filter((e) => e.type === "process.end" && e.data.reason === "limited")
      .map((e) => {
        const start = events[e.processId! - 1]!
        return { harness: start.data.harness, provider: start.data.provider ?? null, at: e.at }
      })
    const integration = fromP(["process.ready"], (e) => e.data.integration !== undefined)
    return {
      id: s.id,
      scope: s.scope,
      role: s.role,
      name: s.name,
      machine: s.machine,
      archive: s.archive ? 1 : 0,
      createdAt: s.createdAt,
      endedAt: s.endedAt,
      pId: p?.id ?? null,
      pAt: p?.at ?? null,
      pData: p === undefined ? null : JSON.stringify(p.data),
      pEnded: p === undefined ? null : (ended(p.id)?.at ?? null),
      pid: (fromP(["process.ready"], (e) => typeof e.data.pid === "number")?.data.pid as number | undefined) ?? null,
      readyAt: fromP(["process.ready"], (e) => e.data.pidOnly === undefined)?.at ?? null,
      integration: integration === undefined ? null : JSON.stringify(integration.data.integration),
      conversation:
        (fromP(["process.ready", "process.conversation"], (e) => typeof e.data.conversation === "string")?.data
          .conversation as string | undefined) ?? null,
      tId: t?.id ?? null,
      tAt: t?.at ?? null,
      tEnd: t === undefined ? null : ((turnEnd(t.id)?.data.status as string | undefined) ?? null),
      lastAt: mine.length === 0 ? null : Math.max(...mine.map((e) => e.at)),
      attempts: JSON.stringify(attempts),
    }
  }

  const ordered = (filter: (s: Session) => boolean) =>
    [...sessions.values()]
      .filter(filter)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const decodeRows = (rows: ReadonlyArray<SessionFacts>) =>
    decodeSessions(
      rows.map((row) => {
        const decoded = fromColumns(row, statuses.get(row.id) ?? "unknown", integrations.get(row.id))
        const at = row.tId === null || row.tEnd !== null ? undefined : prompted.get(row.tId)
        return at === undefined ? decoded : { ...decoded, turnPromptedAt: at }
      }),
    ).pipe(Effect.orDie)
  const notMain = (s: Session) => s.role !== "main"
  const endedMain = (s: Session) => s.role === "main" && !isOwner(s.id)
  const selectSessions = (filter: (s: Session) => boolean, endedMains = false, running = false) =>
    decodeRows(
      ordered((s) => (endedMains ? notMain(s) || endedMain(s) : notMain(s)) && filter(s))
        .map(facts)
        .filter((f) => !running || f.pEnded === null),
    )
  const findSession = (id: string) => selectSessions((s) => s.id === id).pipe(Effect.map((rows) => rows[0]))
  const readSession = (id: string) => selectSessions((s) => s.id === id, true).pipe(Effect.map((rows) => rows[0]))
  const anySession = (id: string) => {
    const s = sessions.get(id)
    if (s === undefined) return undefined
    const row = facts(s)
    return { row, current: currentOf(row) }
  }

  const placed = (scope: string, current: Current | undefined) =>
    current !== undefined && current.ended === null && current.start.terminal !== "" && !moving.has(scope)

  const findOwners = (scope?: string) =>
    decodeOwners(
      ordered((s) => (scope === undefined ? isOwner(s.id) : owner.get(scope) === s.id)).map((s) => {
        const row = facts(s)
        const current = currentOf(row)
        const start = current?.start
        const integration =
          integrations.get(row.id) ??
          (row.integration !== null ? (JSON.parse(row.integration) as Integration) : undefined)
        const pid = row.pid ?? start?.pid
        const here = placed(row.scope, current)
        return {
          id: row.id,
          scope: row.scope,
          harnessId: start?.harness ?? "",
          harnessSessionId: row.conversation ?? start?.resume ?? null,
          runtime: here ? start!.runtime : null,
          address: here ? JSON.stringify({ machine: start!.machine, id: start!.terminal }) : null,
          ...(s.directory ? { directory: s.directory } : {}),
          createdAt: row.createdAt,
          provider: start?.provider ?? null,
          model: start?.model ?? null,
          ...(start?.routing === undefined ? {} : { routing: start.routing }),
          ...(integration === undefined ? {} : { integration }),
          ...(pid === null || pid === undefined ? {} : { pid }),
          ...(row.readyAt === null ? {} : { ready: row.readyAt }),
        }
      }),
    ).pipe(Effect.orDie)

  const rowsOf = (rows: ReadonlyArray<Row>) =>
    decodeInbox(
      rows.map((r) =>
        toInbox({
          id: r.id,
          recipientSessionId: r.recipient,
          kind: r.kind,
          senderSessionId: r.sender,
          content: r.content,
          status: r.status,
          turnEnd: r.resultEventId === null ? null : JSON.stringify(events[r.resultEventId - 1]!.data),
        }),
      ),
    ).pipe(Effect.orDie)
  const select = (where: (r: Row) => boolean) => rowsOf(inbox.filter(where))
  const byId = (ids: ReadonlyArray<number>) => select((r) => ids.includes(r.id))
  const findSend = (sessionId: string, status: InboxStatus) =>
    select((r) => r.recipient === sessionId && r.kind === "send" && r.status === storedStatus(status))
  const scopeOfSession = (id: string) => sessions.get(id)?.scope
  const entryOfSession = (id: string) => {
    const scope = scopeOfSession(id)
    return scope === undefined ? undefined : owner.get(scope)
  }
  const ownerBound = (scope: string) => (r: Row) =>
    !TO_SESSION.includes(r.kind) && r.recipient !== null && r.recipient === owner.get(scope)

  const findPending = (sessionId: string) =>
    select(
      (r) =>
        r.recipient === sessionId &&
        r.status === "pending" &&
        (TO_SESSION.includes(r.kind) || (r.kind !== "task" && r.recipient !== entryOfSession(sessionId))),
    )

  const openTurn = (sessionId: string) => {
    const t = latest((e) => e.sessionId === sessionId && e.type === "turn.start")
    return t === undefined || turnEnd(t.id) !== undefined ? undefined : t.id
  }
  const turnRows = (open: number) => {
    const ids = new Set(
      events
        .filter((e) => e.type === "inbox.status" && e.data.to === "delivered" && e.turnId === open)
        .map((e) => e.inboxId),
    )
    return inbox
      .filter((r) => ids.has(r.id))
      .map((r) => ({ content: r.content, kind: r.kind as string, sender: r.sender }))
  }

  const live = (id: string) => sessions.get(id)?.endedAt === null

  const replyTo = (id: string): ReadonlyArray<string | null> => {
    const s = sessions.get(id)
    if (s === undefined) return []
    const entry = owner.get(s.scope) ?? null
    const fallback = entry !== null && entry !== id && live(entry) ? entry : null
    const to = (x: string) => (live(x) ? x : fallback)
    const open = openTurn(id)
    const rows = (open === undefined ? [] : turnRows(open)).filter((r) => r.kind === "task" || r.kind === "send")
    const senders = [...new Set(rows.flatMap((r) => (r.sender === null || r.sender === id ? [] : [r.sender])))]
    if (senders.length > 0) return [...new Set(senders.map(to))]
    const target = s.reportTo ?? entry
    if (target !== null && target !== id) {
      const t = to(target)
      if (t !== null) return [t]
    }
    return rows.some((r) => r.sender === null) ? [null] : []
  }

  const moveInbox = (where: (r: Row) => boolean, to: string) =>
    Effect.gen(function* () {
      const moved = inbox.filter((r) => where(r) && r.status !== to)
      if (moved.length === 0) return [] as ReadonlyArray<number>
      const at = yield* now
      for (const r of moved) {
        r.status = to
        const turnId = to === "delivered" && r.recipient !== null ? openTurn(r.recipient) : undefined
        yield* appendEvent({
          sessionId: r.recipient ?? r.sender!,
          type: "inbox.status",
          inboxId: r.id,
          turnId,
          at,
          data: { to },
        })
      }
      return moved.map((r) => r.id)
    })

  const insertRow = (row: Omit<Row, "id">) =>
    Effect.gen(function* () {
      const id = inbox.length + 1
      inbox.push({ ...row, id })
      const at = yield* now
      const sessionId = row.recipient ?? row.sender!
      yield* appendEvent({ sessionId, type: "inbox.queued", inboxId: id, at, data: {} })
      if (row.status !== "pending" && row.kind !== "task")
        yield* appendEvent({ sessionId, type: "inbox.status", inboxId: id, at, data: { to: row.status } })
      return id
    })

  const linkTask = (sessionId: string, turnId: number, at: number) =>
    Effect.gen(function* () {
      const task = inbox.find(
        (r) =>
          r.recipient === sessionId &&
          r.kind === "task" &&
          r.status === "delivered" &&
          !events.some((e) => e.inboxId === r.id && e.type === "inbox.status"),
      )
      if (task !== undefined)
        yield* appendEvent({ sessionId, type: "inbox.status", inboxId: task.id, turnId, at, data: { to: "delivered" } })
    })

  const endProcess = (id: string, reason: EndReason, at?: number) =>
    Effect.gen(function* () {
      const current = anySession(id)?.current
      if (current === undefined || current.ended !== null) return false
      yield* appendEvent({
        sessionId: id,
        type: "process.end",
        processId: current.id,
        ...(at === undefined ? {} : { at }),
        data: { reason },
      })
      integrations.delete(id)
      return true
    })

  const startProcess = (id: string, start: ProcessStart, at?: number) =>
    Effect.gen(function* () {
      const before = anySession(id)?.current
      const opening =
        before !== undefined && before.ended === null && before.start.terminal === "" && start.terminal !== ""
      const data: Record<string, unknown> = {
        harness: start.harness,
        runtime: start.runtime,
        machine: start.machine,
        terminal: start.terminal,
        ...(start.provider ? { provider: start.provider } : {}),
        ...(start.model ? { model: start.model } : {}),
        ...(start.routing === undefined ? {} : { routing: start.routing }),
        ...(start.resume ? { resume: start.resume } : {}),
        ...(start.pid === undefined ? {} : { pid: start.pid }),
      }
      const processId = yield* appendEvent({
        sessionId: id,
        type: "process.start",
        data,
        ...(at === undefined ? {} : { at }),
      })
      if (opening) {
        const carried = events.filter(
          (e) => e.processId === before.id && (e.type === "process.ready" || e.type === "process.conversation"),
        )
        for (const e of carried)
          yield* appendEvent({ sessionId: e.sessionId, type: e.type, processId, at: e.at, data: e.data })
      } else integrations.delete(id)
      return processId
    })

  const endTurn = (id: string, end: TurnEnd, at?: number) =>
    Effect.gen(function* () {
      const processId = anySession(id)?.current?.id
      const t = at ?? (yield* now)
      let turnId = openTurn(id)
      if (turnId === undefined)
        turnId = yield* appendEvent({ sessionId: id, type: "turn.start", processId, at: t, data: {} })
      prompted.delete(turnId)
      return yield* appendEvent({
        sessionId: id,
        type: "turn.end",
        processId,
        turnId,
        at: t,
        data: {
          status: end.status,
          ...(end.output === undefined ? {} : { output: end.output }),
          ...(end.failure === undefined ? {} : { failure: end.failure }),
        },
      })
    })

  const noticeTo = (id: string): Array<string | null> => {
    const s = sessions.get(id)
    if (s === undefined) return [null]
    if (s.reportTo !== null && live(s.reportTo)) return [s.reportTo]
    return [owner.get(s.scope) ?? null]
  }

  const insertTo = (row: NewInboxRow, recipients: ReadonlyArray<string | null>, resultEventId?: number) =>
    Effect.gen(function* () {
      const scope = scopeOfSession(row.sessionId)
      const entry = scope === undefined ? undefined : owner.get(scope)
      const ids: Array<number> = []
      for (const recipient of recipients.length === 0 ? [undefined] : recipients) {
        const present =
          recipient === null ||
          (recipient !== undefined && (recipient !== entry || placed(scope!, anySession(recipient)?.current)))
        ids.push(
          yield* insertRow({
            recipient: recipient === undefined ? row.sessionId : recipient,
            kind: row.kind,
            sender: row.sessionId,
            content: row.message,
            resultEventId: resultEventId ?? null,
            status: present ? "pending" : "dropped",
          }),
        )
      }
      return yield* byId(ids)
    })

  const insertInboxRow = (
    row: NewInboxRow,
    end?: TurnEnd,
    at?: number,
    to?: ReadonlyArray<string | null>,
    from?: string,
  ) =>
    Effect.gen(function* () {
      if (row.kind === "send") {
        const id = yield* insertRow({
          recipient: row.sessionId,
          kind: "send",
          sender: from ?? null,
          content: row.message,
          resultEventId: null,
          status: "pending",
        })
        return yield* byId([id])
      }
      if (row.kind === "result") {
        const recipients = to ?? replyTo(row.sessionId)
        const resultEventId = yield* endTurn(
          row.sessionId,
          end ?? {
            status: roundStatus(row.details.status),
            ...(typeof row.details.error === "string" && row.details.error !== ""
              ? { failure: failureOf(row.details.error)! }
              : {}),
          },
          at,
        )
        return yield* insertTo(row, recipients, resultEventId)
      }
      return yield* insertTo(row, to ?? noticeTo(row.sessionId))
    })

  const updateSession = (id: string, patch: SessionPatch) =>
    Effect.gen(function* () {
      if (Object.keys(patch).length === 0) return
      const current = yield* findSession(id)
      const stored = sessions.get(id)
      if (current === undefined || stored === undefined) return
      const next = { ...current, ...patch }
      remember(next)
      if (patch.name !== undefined && patch.name !== current.name) stored.name = patch.name
      const ending = !!(next.metadata.archived || next.metadata.removed)
      if (ending && !(current.metadata.archived || current.metadata.removed) && stored.endedAt === null)
        stored.endedAt = yield* now
      const p = anySession(id)!.current
      const routing = patch.metadata?.routing
      const choicePatched =
        (patch.harnessId !== undefined && patch.harnessId !== current.harnessId) ||
        (patch.provider !== undefined && patch.provider !== current.provider) ||
        (patch.model !== undefined && patch.model !== current.model) ||
        (patch.metadata !== undefined && JSON.stringify(routing) !== JSON.stringify(current.metadata.routing))
      const opened =
        (patch.startedAt !== undefined && patch.startedAt !== null) ||
        (patch.address !== undefined &&
          (patch.address.id !== current.address.id || patch.address.machine !== current.address.machine))
      if (p === undefined || choicePatched || opened) {
        const harnessChanged = next.harnessId !== current.harnessId
        const resume =
          patch.harnessSessionId !== undefined
            ? patch.harnessSessionId
            : harnessChanged
              ? null
              : current.harnessSessionId
        const nextRouting = patch.metadata !== undefined ? routing : current.metadata.routing
        yield* startProcess(
          id,
          {
            harness: next.harnessId,
            ...(next.provider ? { provider: next.provider } : {}),
            ...(next.model ? { model: next.model } : {}),
            ...(nextRouting === undefined ? {} : { routing: nextRouting }),
            runtime: current.runtime,
            machine: next.address.machine,
            terminal: next.address.id,
            ...(resume ? { resume } : {}),
          },
          patch.startedAt ?? undefined,
        )
      } else if (
        patch.harnessSessionId !== undefined &&
        patch.harnessSessionId !== null &&
        patch.harnessSessionId !== current.harnessSessionId
      ) {
        yield* appendEvent({
          sessionId: id,
          type: "process.conversation",
          processId: p.id,
          data: { conversation: patch.harnessSessionId },
        })
      }
      if (patch.exitedAt !== undefined && patch.exitedAt !== null && current.exitedAt === null)
        yield* endProcess(id, patch.end ?? "exited", patch.exitedAt)
      if (patch.turnState === "open") {
        const open = openTurn(id)
        const at = next.turnPromptedAt || (yield* now)
        if (open !== undefined) {
          if (patch.turnPromptedAt !== undefined) prompted.set(open, at)
        } else {
          const turnId = yield* appendEvent({
            sessionId: id,
            type: "turn.start",
            processId: anySession(id)!.current?.id,
            at,
            data: {},
          })
          yield* linkTask(id, turnId, at)
        }
      } else if (patch.turnState !== undefined && patch.turnState !== "none" && current.turnState === "open") {
        const open = openTurn(id)
        if (open !== undefined) {
          prompted.delete(open)
          yield* appendEvent({
            sessionId: id,
            type: "turn.end",
            processId: anySession(id)!.current?.id,
            turnId: open,
            data: { status: patch.turnState },
          })
        }
      }
    })

  const dropWaiting = (scope: string, guard?: { readonly runtime: string; readonly address: string } | "absent") =>
    Effect.gen(function* () {
      if (guard !== undefined) {
        const [main] = yield* findOwners(scope)
        if (guard === "absent") {
          if (main?.runtime || moving.has(scope)) return
        } else if (
          !main?.runtime ||
          !main.address ||
          main.runtime !== guard.runtime ||
          encodeAddress(main.address) !== guard.address
        )
          return
      }
      const bound = ownerBound(scope)
      yield* moveInbox((r) => r.status === "pending" && bound(r), "dropped")
    })

  const ownersAt = (runtime: string, address: RuntimeAddress, except?: string) =>
    [...owner.entries()].flatMap(([scope, id]) => {
      if (scope === except || moving.has(scope)) return []
      const p = currentStart(id)
      if (
        p === undefined ||
        p.data.runtime !== runtime ||
        p.data.machine !== address.machine ||
        p.data.terminal !== address.id ||
        ended(p.id) !== undefined
      )
        return []
      return [{ id, scope }]
    })

  const clearOwnerAt = (runtime: string, address: RuntimeAddress, except?: string) =>
    Effect.gen(function* () {
      for (const main of ownersAt(runtime, address, except)) {
        yield* endProcess(main.id, "exited")
        yield* dropWaiting(main.scope)
      }
    })

  const unusedId = newId.pipe(Effect.repeat({ until: (id) => !sessions.has(id) }))

  const conversationOf = (id: string) => {
    const found = anySession(id)
    return {
      current: found?.current,
      conversation: found === undefined ? null : (found.row.conversation ?? found.current?.start.resume ?? null),
    }
  }

  const sharers = (id: string) => {
    const s = sessions.get(id)
    if (s === undefined || s.directory === "") return []
    return [...sessions.values()].filter(
      (o) => o.id !== s.id && o.machine === s.machine && o.directory === s.directory && o.endedAt === null,
    )
  }

  const engine: DbShape = {
    sessionDirectory: (id) => Effect.sync(() => sessions.get(id)?.directory),
    liveSharers: (id) =>
      Effect.sync(() =>
        sharers(id)
          .map((o) => o.id)
          .sort(),
      ),
    earlierSharer: (id) =>
      Effect.sync(() => {
        const s = sessions.get(id)
        if (s === undefined) return undefined
        return sharers(id)
          .filter((o) => o.createdAt < s.createdAt || (o.createdAt === s.createdAt && o.seq < s.seq))
          .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)[0]?.id
      }),

    insertSession: (row, scope, max, cwd = "", task, parentSessionId, reportToSessionId, taskPending = false) =>
      Effect.gen(function* () {
        if (max !== undefined) {
          const n = (yield* selectSessions((s) => s.endedAt === null, false, true)).length
          if (n >= max) return false
        }
        const entry = owner.get(scope)
        const reportTo = reportToSessionId ?? parentSessionId ?? (row.agent === "main" ? undefined : entry)
        const stopped = row.metadata.archived || row.metadata.removed
        sessions.set(row.id, {
          id: row.id,
          scope,
          parent: parentSessionId ?? null,
          reportTo: reportTo ?? null,
          role: row.agent,
          name: row.name,
          machine: row.address.machine,
          directory: cwd,
          archive: row.metadata.archive === true,
          createdAt: row.createdAt,
          endedAt: stopped ? row.lastActive : null,
          seq: sessions.size + 1,
        })
        const processAt = row.startedAt ?? row.createdAt
        const processId = yield* startProcess(
          row.id,
          {
            harness: row.harnessId,
            ...(row.provider ? { provider: row.provider } : {}),
            ...(row.model ? { model: row.model } : {}),
            ...(row.metadata.routing === undefined ? {} : { routing: row.metadata.routing }),
            runtime: row.runtime,
            machine: row.address.machine,
            terminal: row.address.id,
            ...(row.harnessSessionId ? { resume: row.harnessSessionId } : {}),
          },
          processAt,
        )
        if (row.metadata.pid !== undefined || row.metadata.integration !== undefined)
          yield* appendEvent({
            sessionId: row.id,
            type: "process.ready",
            processId,
            at: row.metadata.ready ?? processAt,
            data: {
              ...(row.metadata.pid === undefined ? {} : { pid: row.metadata.pid }),
              ...(row.metadata.integration === undefined ? {} : { integration: row.metadata.integration }),
            },
          })
        if (row.exitedAt !== null)
          yield* appendEvent({
            sessionId: row.id,
            type: "process.end",
            processId,
            at: row.exitedAt,
            data: { reason: "exited" },
          })
        if (task !== undefined)
          yield* insertRow({
            recipient: row.id,
            kind: "task",
            sender: parentSessionId ?? null,
            content: task,
            resultEventId: null,
            status: taskPending ? "pending" : "delivered",
          })
        if (row.turnState !== "none") {
          const turnId = yield* appendEvent({
            sessionId: row.id,
            type: "turn.start",
            processId,
            at: row.turnPromptedAt,
            data: {},
          })
          yield* linkTask(row.id, turnId, row.turnPromptedAt)
          if (row.turnState !== "open")
            yield* appendEvent({
              sessionId: row.id,
              type: "turn.end",
              processId,
              turnId,
              at: row.turnPromptedAt,
              data: { status: row.turnState },
            })
        }
        remember(row)
        return true
      }),

    sessionExists: (id) => Effect.sync(() => sessions.has(id)),
    sessionIdentity: (id) =>
      Effect.sync(() => {
        const s = sessions.get(id)
        if (s === undefined) return undefined
        const harness = currentStart(id)?.data.harness
        return {
          id,
          scope: s.scope,
          agent: s.role,
          harness: typeof harness === "string" ? harness : "",
          owner: owner.get(s.scope) === id,
        }
      }),
    getSession: (id) => readSession(id),
    descends: (id, ancestor) =>
      Effect.sync(() => {
        const seen = new Set<string>()
        for (let at = sessions.get(id); at !== undefined && !seen.has(at.id); at = sessions.get(at.parent ?? "")) {
          seen.add(at.id)
          if (at.parent === ancestor) return true
        }
        return false
      }),
    parentOf: (id) => Effect.sync(() => sessions.get(id)?.parent ?? undefined),
    liveStatuses: Effect.sync(() => statuses.size),
    updateSession: (id, patch) => updateSession(id, patch),
    listSessions: (filter = {}) =>
      selectSessions(
        (s) => filter.scope === undefined || s.scope === filter.scope,
        filter.stopped === true,
        !filter.stopped,
      ),
    sessionBriefs: (ids) =>
      Effect.sync(() => {
        const briefs = new Map<string, SessionBrief>()
        for (const id of ids) {
          if (!sessions.has(id)) continue
          const task = inbox.find((r) => r.recipient === id && r.kind === "task")?.content ?? null
          const t = latest((e) => e.sessionId === id && e.type === "turn.start")
          const te = t === undefined ? undefined : turnEnd(t.id)
          const end = te?.data as TurnEnd | undefined
          const raw = t === undefined ? undefined : (end?.status ?? "working")
          const status = raw !== undefined && MESSAGE_STATUSES.has(raw) ? (raw as MessageStatusName) : undefined
          const result = te === undefined ? undefined : inbox.find((r) => r.resultEventId === te.id)
          const summary =
            (result === undefined ? undefined : summaryIn(result.content)) ?? end?.output?.split("\n")[0] ?? ""
          briefs.set(id, { task, latest: status === undefined ? null : { status, summary, endedAt: te?.at ?? null } })
        }
        return briefs
      }),

    owners: Effect.suspend(() => findOwners()),
    ownerOf: (scope) => findOwners(scope).pipe(Effect.map((rows) => rows[0])),
    ownerAt: (runtime, address) => Effect.sync(() => ownersAt(runtime, address)[0]?.scope),
    startOwner: (scope, harness, fresh, location, start = {}) =>
      Effect.gen(function* () {
        const id = yield* unusedId
        yield* clearOwnerAt(location.runtime, location.address, scope)
        const movingHere = moving.has(scope)
        const existing = owner.get(scope)
        const at = yield* now
        if (existing === undefined || fresh) {
          if (existing !== undefined) {
            yield* endProcess(existing, "archived", at)
            sessions.get(existing)!.endedAt = at
          }
          sessions.set(id, {
            id,
            scope,
            parent: null,
            reportTo: null,
            role: "main",
            name: "main",
            machine: location.address.machine,
            directory: start.directory ?? "",
            archive: false,
            createdAt: at,
            endedAt: null,
            seq: sessions.size + 1,
          })
          owner.set(scope, id)
        }
        const mainId = existing === undefined || fresh ? id : existing
        const main = sessions.get(mainId)!
        if (start.directory && main.directory === "") main.directory = start.directory
        const { current, conversation } = conversationOf(mainId)
        if (current !== undefined && current.ended === null)
          yield* endProcess(mainId, movingHere ? "move" : "exited", at)
        const resume = !fresh && current?.start.harness === harness ? (conversation ?? undefined) : undefined
        yield* startProcess(
          mainId,
          {
            harness,
            ...(start.provider ? { provider: start.provider } : {}),
            ...(start.model ? { model: start.model } : {}),
            ...(start.routing ? { routing: start.routing } : {}),
            runtime: location.runtime,
            machine: location.address.machine,
            terminal: location.address.id,
            ...(resume === undefined ? {} : { resume }),
            ...(start.pid === undefined ? {} : { pid: start.pid }),
          },
          at,
        )
        moving.delete(scope)
        if (!movingHere || fresh) yield* dropWaiting(scope)
        return { sessionId: mainId, harnessSessionId: resume ?? null }
      }),
    reportOwnerConversation: (sessionId, harness, harnessSessionId) =>
      Effect.gen(function* () {
        const { current, conversation } = conversationOf(sessionId)
        if (!isOwner(sessionId) || current === undefined || current.start.harness !== harness) return
        if (conversation === harnessSessionId) return
        yield* appendEvent({
          sessionId,
          type: "process.conversation",
          processId: current.id,
          data: { conversation: harnessSessionId },
        })
      }),
    detachOwner: (scope, runtime, address) =>
      Effect.sync(() => {
        const here = ownersAt(runtime, address).some((m) => m.scope === scope)
        if (here) moving.add(scope)
        return here
      }),
    reattachOwner: (scope) => Effect.sync(() => void moving.delete(scope)),
    clearOwnerAt: (runtime, address) => clearOwnerAt(runtime, address),

    noteHarnessSession: (id, harnessSessionId) =>
      Effect.gen(function* () {
        const { current, conversation } = conversationOf(id)
        if (current === undefined || conversation === harnessSessionId) return false
        yield* appendEvent({
          sessionId: id,
          type: "process.conversation",
          processId: current.id,
          data: { conversation: harnessSessionId },
        })
        return true
      }),
    noteIntegration: (id, integration) =>
      Effect.sync(() => {
        const found = anySession(id)
        if (found === undefined) return false
        const known =
          integrations.get(id) ??
          (found.row.integration === null ? undefined : (JSON.parse(found.row.integration) as Integration))
        if (known?.version === integration.version && known.protocol === integration.protocol) return false
        integrations.set(id, integration)
        return true
      }),
    patchLive: (id, patch) =>
      Effect.gen(function* () {
        const ready = typeof patch.ready === "number"
        if (!ready && typeof patch.pid !== "number") return
        const current = anySession(id)?.current
        if (current === undefined) return
        const integration = integrations.get(id)
        yield* appendEvent({
          sessionId: id,
          type: "process.ready",
          processId: current.id,
          ...(ready ? { at: patch.ready as number } : {}),
          data: {
            ...(typeof patch.pid === "number" ? { pid: patch.pid } : {}),
            ...(ready ? {} : { pidOnly: true }),
            ...(!ready || integration === undefined ? {} : { integration }),
          },
        })
      }),
    readyAt: (id) => Effect.sync(() => anySession(id)?.row.readyAt ?? undefined),
    restartProcess: (id) =>
      Effect.gen(function* () {
        const { current, conversation } = conversationOf(id)
        if (current === undefined) return
        yield* endProcess(id, "restart")
        const { resume: _, pid: __, ...start } = current.start
        yield* startProcess(id, { ...start, ...(conversation ? { resume: conversation } : {}) })
      }),
    endProcess: (id, reason) => endProcess(id, reason),

    insertInbox: (row, to) => insertInboxRow(row, undefined, undefined, to),
    noticeTo: (id) => Effect.sync(() => noticeTo(id)),
    insertSend: (sessionId, message, from) =>
      Effect.gen(function* () {
        const s = yield* findSession(sessionId)
        if (s === undefined || s.metadata.archived || s.metadata.removed) return undefined
        const [sent] = yield* insertInboxRow(
          { sessionId, kind: "send", message, details: {} },
          undefined,
          undefined,
          undefined,
          from,
        )
        return sent
      }),
    archiveIfNoPending: (id) =>
      Effect.gen(function* () {
        const s = yield* findSession(id)
        if (s === undefined || (yield* findSend(id, "pending")).length > 0) return false
        yield* updateSession(id, { metadata: { ...s.metadata, archived: true, removed: true } })
        return true
      }),
    closeTurn: (id, end: TurnState, patch) => updateSession(id, { turnState: end, ...patch }),
    turnTaken: (id) =>
      Effect.sync(() => {
        const turn = openTurn(id)
        if (turn === undefined) return false
        return (
          events[turn - 1]!.data.typed !== undefined ||
          events.some((e) => e.turnId === turn && e.type === "inbox.status" && e.data.to === "delivered")
        )
      }),
    latestRoundAt: (sessionId) =>
      Effect.sync(() => {
        const ats = events
          .filter((e) => e.sessionId === sessionId && (e.type === "turn.start" || e.type === "turn.end"))
          .map((e) => e.at)
        return ats.length === 0 ? undefined : Math.max(...ats)
      }),
    rescheduleSource: (id) =>
      Effect.sync(() => {
        const s = sessions.get(id)
        if (s === undefined) return { working: "", delivered: "", parentSessionId: undefined }
        const open = openTurn(id)
        let working = ""
        if (open !== undefined) {
          const typed = events[open - 1]!.data.typed
          working =
            typeof typed === "string"
              ? typed
              : turnRows(open)
                  .map((r) => r.content)
                  .join("\n\n")
        }
        const linked = Math.max(
          0,
          ...events
            .filter((e) => e.sessionId === id && e.type === "inbox.status" && e.turnId !== null)
            .map((e) => e.inboxId ?? 0),
        )
        const rows = inbox.filter(
          (r) => r.recipient === id && r.status === "delivered" && TO_SESSION.includes(r.kind) && r.id > linked,
        )
        const last = rows.at(-1)
        let from = rows.length
        if (last !== undefined) {
          from = rows.length - 1
          while (from > 0 && rows[from - 1]!.sender === last.sender) from--
        }
        return {
          working,
          delivered: rows
            .slice(from)
            .map((r) => r.content)
            .join("\n\n"),
          parentSessionId: s.parent ?? undefined,
        }
      }),
    beginUserTurn: (id, text, patch) =>
      Effect.gen(function* () {
        if (openTurn(id) !== undefined) return false
        const at = patch.turnPromptedAt ?? (yield* now)
        const { turnState: _s, turnPromptedAt: _a, ...rest } = patch
        yield* appendEvent({
          sessionId: id,
          type: "turn.start",
          processId: anySession(id)?.current?.id,
          at,
          data: { typed: text },
        })
        yield* updateSession(id, rest)
        return true
      }),
    finishTurn: (id, end, patch, row, at, to) =>
      Effect.gen(function* () {
        const stamp = at === undefined ? undefined : Math.max(at, yield* now)
        const inserted = yield* insertInboxRow(row, row.kind === "result" ? end : undefined, stamp, to)
        const { turnState: _, ...rest } = patch
        yield* updateSession(id, row.kind === "result" ? rest : patch)
        return inserted
      }),
    pendingInbox: (sessionId) => findPending(sessionId),
    ownInbox: (sessionId, ids) =>
      Effect.sync(() =>
        inbox
          .filter(
            (r) =>
              r.recipient === sessionId && ids.includes(r.id) && (r.status === "pending" || r.status === "delivering"),
          )
          .map((r) => r.id),
      ),
    replyTo: (id) => Effect.sync(() => replyTo(id)),
    userInbox: (scope, read) =>
      Effect.gen(function* () {
        const rows = inbox.filter(
          (r) =>
            r.recipient === null && r.status === "pending" && r.sender !== null && scopeOfSession(r.sender) === scope,
        )
        const decoded = yield* rowsOf(rows)
        if (read && rows.length > 0) {
          const ids = rows.map((r) => r.id)
          yield* moveInbox((r) => ids.includes(r.id), "delivered")
        }
        return decoded
      }),
    inboxWithStatus: (sessionId, status) => findSend(sessionId, status),
    ownerPending: (scope) => {
      const bound = ownerBound(scope)
      return select((r) => r.status === "pending" && bound(r))
    },
    releaseLeased: (scope, ids) => {
      const main = owner.get(scope)
      return moveInbox(
        (r) => ids.includes(r.id) && r.status === "delivering" && main !== undefined && r.recipient === main,
        "pending",
      )
    },
    settleLeased: (scope, ids, release) =>
      Effect.gen(function* () {
        const main = owner.get(scope)
        if (main === undefined) return []
        if (release.length > 0)
          yield* moveInbox(
            (r) => release.includes(r.id) && r.status === "delivering" && r.recipient === main,
            "pending",
          )
        if (ids.length === 0) return []
        const done = yield* moveInbox(
          (r) =>
            ids.includes(r.id) &&
            (r.status === "delivering" || r.status === "pending") &&
            !TO_SESSION.includes(r.kind) &&
            r.recipient === main,
          "delivered",
        )
        return done.length === 0 ? [] : yield* byId(done)
      }),
    recoverSending: (pollHarnesses) =>
      Effect.gen(function* () {
        const polling = (r: Row) => {
          if (r.recipient === null || !isOwner(r.recipient)) return false
          const harness = currentStart(r.recipient)?.data.harness
          return typeof harness === "string" && pollHarnesses.includes(harness)
        }
        const claimed = (r: Row) => r.status === "delivering" && !TO_SESSION.includes(r.kind)
        yield* moveInbox((r) => claimed(r) && polling(r), "pending")
        yield* moveInbox(claimed, "failed")
      }),
    sendingInbox: Effect.suspend(() => select((r) => r.status === "delivering")).pipe(
      Effect.map((rows) => rows.map((r) => ({ id: r.id, sessionId: r.sessionId, kind: r.kind }))),
    ),
    pendingScopes: Effect.sync(() => [
      ...new Set(
        inbox.flatMap((r) =>
          r.status === "pending" && !TO_SESSION.includes(r.kind) && r.recipient !== null && sessions.has(r.recipient)
            ? [sessions.get(r.recipient)!.scope]
            : [],
        ),
      ),
    ]),
    dropWaiting: (scope, guard) => dropWaiting(scope, guard),
    claim: (ids, guard) =>
      Effect.gen(function* () {
        if (ids.length === 0) return []
        if (guard) {
          const [main] = yield* findOwners(guard.scope)
          if (
            !main?.runtime ||
            !main.address ||
            main.runtime !== guard.runtime ||
            encodeAddress(main.address) !== guard.address ||
            (guard.harnessId !== undefined && guard.harnessId !== "" && main.harnessId !== guard.harnessId)
          )
            return []
        }
        return yield* moveInbox((r) => ids.includes(r.id) && r.status === "pending", "delivering")
      }),
    setInboxStatus: (ids, status, from) =>
      Effect.gen(function* () {
        if (ids.length === 0) return []
        const moved = yield* moveInbox(
          (r) => ids.includes(r.id) && (from === undefined || r.status === storedStatus(from)),
          storedStatus(status),
        )
        return moved.length === 0 ? [] : yield* byId(moved)
      }),
    latestInbox: (sessionId, kind) =>
      Effect.gen(function* () {
        const match =
          kind === "send"
            ? inbox.filter((r) => r.recipient === sessionId && r.kind === "send")
            : inbox.filter((r) => r.kind === kind && r.sender === sessionId)
        const last = match.at(-1)
        return last === undefined ? undefined : (yield* rowsOf([last]))[0]
      }),
    scopeOf: (id) => Effect.sync(() => scopeOfSession(id)),
  }

  // Every operation under the one lock, and read only once it holds it: atomic, never interleaved with another.
  return Object.fromEntries(
    Object.entries(engine).map(([name, op]) => [
      name,
      Effect.isEffect(op)
        ? lock.withPermits(1)(op)
        : (...args: ReadonlyArray<unknown>) =>
            lock.withPermits(1)(
              Effect.suspend(() => (op as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args)),
            ),
    ]),
  ) as unknown as DbShape
})

/** The engine's `Db`, in memory: empty at start, gone with the layer. */
export const layer = Layer.effect(Db, make)
