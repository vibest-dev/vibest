import type { Fact, FactType } from "@vibest/schema/event"
import { Schema } from "effect"

import { LOCAL_MACHINE } from "../ledger-read.ts"
import { peerStartOf, type Snapshot, type V1Event, type V1Session } from "./v1-read.ts"

export class ImportFailed extends Schema.TaggedError<ImportFailed>()("ImportFailed", { message: Schema.String }) {}

export type Counts = {
  readonly endsOfEndedProcesses: number
  readonly turnsLost: number
  readonly duplicatePeerKeys: number
  readonly undecodablePeerStarts: number
}

export type Translation = {
  readonly facts: ReadonlyArray<Fact>
  readonly eventSeq: ReadonlyMap<number, number>
  readonly inboxSeq: ReadonlyMap<number, number>
  readonly sources: ReadonlyMap<number, string>
  readonly counts: Counts
}

const fail = (message: string): never => {
  throw new ImportFailed({ message })
}

type Json = Record<string, unknown>

const parse = (event: V1Event): Json => {
  try {
    const data = JSON.parse(event.data) as unknown
    if (data !== null && typeof data === "object" && !Array.isArray(data)) return data as Json
  } catch {}
  return fail(`v1 event ${event.id} (${event.type}): its data is not a JSON object`)
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined)

const present = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }

export const translate = (snapshot: Snapshot, importedAt: number): Translation => {
  const base = Math.max(0, ...snapshot.events.map((e) => e.id), ...snapshot.inbox.map((i) => i.id))
  const facts: Array<Fact> = []
  const eventSeq = new Map<number, number>()
  const inboxSeq = new Map<number, number>()
  const sources = new Map<number, string>()
  const counts = { endsOfEndedProcesses: 0, turnsLost: 0, duplicatePeerKeys: 0, undecodablePeerStarts: 0 }
  const sessions = new Map(snapshot.sessions.map((s) => [s.id, s]))
  const inbox = new Map(snapshot.inbox.map((i) => [i.id, i]))
  const events = new Map(snapshot.events.map((e) => [e.id, e]))
  const harnessOf = new Map<number, string>()
  const ended = new Set<number>()
  const liveProcess = new Map<string, number>()
  const openTurn = new Map<string, number>()
  const created = new Set<string>()
  const peerKeys = new Set<string>()

  const push = (
    type: FactType,
    at: number,
    envelope: { readonly projectId?: string; readonly sessionId?: string },
    data: Json,
    source: string,
  ) => {
    const seq = base + facts.length + 1
    facts.push({ seq, at, type, ...envelope, data } as Fact)
    sources.set(seq, source)
    return seq
  }

  const sessionNamed = (id: string, source: string): V1Session =>
    sessions.get(id) ?? fail(`${source}: session ${id} is not in the session table`)
  const onSession = (id: string, source: string) => ({ projectId: sessionNamed(id, source).projectId, sessionId: id })
  const mapped = (id: number | null, what: string, source: string) => {
    if (id === null) return undefined
    return eventSeq.get(id) ?? fail(`${source}: its ${what} ${id} is not an earlier event`)
  }

  const local = (machine: unknown, source: string) => {
    if (machine !== LOCAL_MACHINE) fail(`${source}: machine ${JSON.stringify(machine)} is not ${LOCAL_MACHINE}`)
  }

  const origins = new Map<string, Json>()
  for (const event of snapshot.events) {
    if (event.type !== "peer.start" || origins.has(event.sessionId)) continue
    const origin = peerStartOf(event.data)
    if (origin === undefined) counts.undecodablePeerStarts++
    else origins.set(event.sessionId, origin)
  }

  const createSession = (session: V1Session) => {
    if (created.has(session.id)) return
    created.add(session.id)
    const source = `v1 session ${session.id}`
    local(session.machine, source)
    const origin = origins.get(session.id)
    push(
      "session.created",
      session.createdAt,
      { projectId: session.projectId, sessionId: session.id },
      {
        role: session.role,
        name: session.name,
        directory: session.directory,
        ...present("parent", session.parentSessionId ?? undefined),
        ...present("reportTo", session.reportToSessionId ?? undefined),
        archiveOnCompletion: session.archiveOnCompletion === 1,
        ...present(
          "origin",
          origin === undefined
            ? undefined
            : {
                peer: origin["peer"],
                project: origin["project"],
                ...present("parent", text(origin["parent"])),
                ...present("reportTo", text(origin["reportTo"])),
              },
        ),
      },
      source,
    )
  }

  for (const machine of snapshot.machines) {
    const source = `v1 machine ${machine.name}`
    push(
      "machine.added",
      machine.createdAt,
      {},
      { name: machine.name, target: machine.target, vibestd: machine.vibestdId },
      source,
    )
    if (machine.connectedAt !== machine.createdAt)
      push("machine.connected", machine.connectedAt, {}, { name: machine.name }, source)
  }
  for (const peer of snapshot.peers)
    push(
      "peer.seen",
      peer.connectedAt,
      {},
      { id: peer.id, name: peer.name, callsMe: peer.callsMe },
      `v1 peer ${peer.id}`,
    )

  for (const project of snapshot.projects) {
    const first = snapshot.sessions.filter((s) => s.projectId === project.id).map((s) => s.createdAt)
    push(
      "project.created",
      first.length === 0 ? importedAt : Math.min(...first),
      { projectId: project.id },
      {
        ...present("directory", project.directory ?? undefined),
        repositories: snapshot.repositories
          .filter((r) => r.projectId === project.id)
          .map((r) => ({ path: r.path, ...present("remote", r.remoteUrl ?? undefined) })),
      },
      `v1 project ${project.id}`,
    )
  }

  const endProcess = (event: V1Event, process: number, reason: string, source: string) => {
    ended.add(process)
    if (liveProcess.get(event.sessionId) === process) liveProcess.delete(event.sessionId)
    push("process.ended", event.at, onSession(event.sessionId, source), { process, reason }, source)
  }

  const translateEvent = (event: V1Event) => {
    const source = `v1 event ${event.id} (${event.type})`
    const data = parse(event)
    const on = onSession(event.sessionId, source)
    switch (event.type) {
      case "process.start": {
        local(data["machine"], source)
        const live = liveProcess.get(event.sessionId)
        if (live !== undefined) endProcess(event, live, "superseded", source)
        const seq = push(
          "process.started",
          event.at,
          on,
          {
            harness: data["harness"],
            ...present("provider", text(data["provider"])),
            ...present("model", text(data["model"])),
            ...present("routing", data["routing"]),
            ...present("resume", text(data["resume"])),
            runtime: data["runtime"],
            ...present("terminal", text(data["terminal"])),
            ...present("pid", typeof data["pid"] === "number" ? data["pid"] : undefined),
          },
          source,
        )
        eventSeq.set(event.id, seq)
        harnessOf.set(seq, String(data["harness"]))
        liveProcess.set(event.sessionId, seq)
        return
      }
      case "process.ready": {
        const process = mapped(event.processId, "process", source) ?? fail(`${source}: no process`)
        if (data["pidOnly"] !== undefined) {
          push("process.pid", event.at, on, { process, pid: data["pid"] }, source)
          return
        }
        push(
          "process.ready",
          event.at,
          on,
          { process, ...present("pid", data["pid"]), ...present("integration", data["integration"]) },
          source,
        )
        const conversation = text(data["conversation"])
        if (conversation !== undefined) push("process.conversation", event.at, on, { process, conversation }, source)
        return
      }
      case "process.conversation": {
        const process = mapped(event.processId, "process", source) ?? fail(`${source}: no process`)
        push("process.conversation", event.at, on, { process, conversation: data["conversation"] }, source)
        return
      }
      case "process.end": {
        const process = mapped(event.processId, "process", source) ?? fail(`${source}: no process`)
        if (ended.has(process)) {
          counts.endsOfEndedProcesses++
          return
        }
        endProcess(event, process, String(data["reason"]), source)
        return
      }
      case "turn.start": {
        const open = openTurn.get(event.sessionId)
        if (open !== undefined) {
          counts.turnsLost++
          push("turn.ended", event.at, on, { turn: open, status: "lost" }, source)
        }
        const seq = push(
          "turn.started",
          event.at,
          on,
          {
            ...present("process", mapped(event.processId, "process", source)),
            ...present("typed", text(data["typed"])),
          },
          source,
        )
        eventSeq.set(event.id, seq)
        openTurn.set(event.sessionId, seq)
        return
      }
      case "turn.reported": {
        const seq = push(
          "turn.reported",
          event.at,
          on,
          {
            ...present("process", mapped(event.processId, "process", source)),
            harness: data["harness"],
            text: data["text"],
            ...present("error", text(data["error"])),
            ...present("conversation", text(data["conversation"])),
            ...present("interrupted", data["interrupted"] === true ? true : undefined),
          },
          source,
        )
        eventSeq.set(event.id, seq)
        return
      }
      case "turn.end": {
        const turn = mapped(event.turnId, "turn", source) ?? fail(`${source}: no turn`)
        const failure = data["failure"] as { message?: unknown } | undefined
        const output = data["output"]
        const report =
          typeof output === "string" && data["report"] === undefined
            ? push(
                "turn.reported",
                event.at,
                on,
                {
                  harness: harnessOf.get(mapped(event.processId, "process", source) ?? -1) ?? "unknown",
                  text: output,
                },
                source,
              )
            : mapped(typeof data["report"] === "number" ? data["report"] : null, "report", source)
        const seq = push(
          "turn.ended",
          event.at,
          on,
          {
            turn,
            status: data["status"],
            ...present("report", report),
            ...present("failure", text(failure?.message) === undefined ? undefined : { message: failure!.message }),
          },
          source,
        )
        eventSeq.set(event.id, seq)
        if (openTurn.get(event.sessionId) === turn) openTurn.delete(event.sessionId)
        return
      }
      case "inbox.queued": {
        const row =
          inbox.get(event.inboxId ?? -1) ?? fail(`${source}: inbox row ${event.inboxId} is not in the inbox table`)
        const request = text(data["request"])
        const peerItem = request?.startsWith("peer:") ? request.slice("peer:".length) : undefined
        const repeated = peerItem !== undefined && peerKeys.has(peerItem)
        if (peerItem !== undefined) peerKeys.add(peerItem)
        if (repeated) counts.duplicatePeerKeys++
        const resultEnd = row.resultEventId === null ? undefined : events.get(row.resultEventId)
        const seq = push(
          "inbox.queued",
          event.at,
          on,
          {
            kind: row.kind,
            ...present("recipient", row.recipientSessionId ?? undefined),
            ...present("sender", row.senderSessionId ?? undefined),
            content: row.content,
            status: row.kind === "task" ? "delivered" : "pending",
            ...present(
              "turn",
              row.resultEventId === null
                ? undefined
                : mapped(
                    resultEnd?.type === "turn.end" ? resultEnd.turnId : -1,
                    `result turn (of v1 event ${row.resultEventId})`,
                    source,
                  ),
            ),
            ...present("request", peerItem === undefined ? request : undefined),
            ...present("peerItem", repeated ? undefined : peerItem),
          },
          source,
        )
        inboxSeq.set(row.id, seq)
        return
      }
      case "inbox.status": {
        push(
          "inbox.moved",
          event.at,
          on,
          {
            inbox:
              inboxSeq.get(event.inboxId ?? -1) ??
              fail(`${source}: its inbox row ${event.inboxId} was not queued before`),
            to: data["to"],
            ...present("turn", mapped(event.turnId, "turn", source)),
          },
          source,
        )
        return
      }
      case "peer.start":
        return
      default:
        fail(`${source}: this vibest does not know how to import an event of this type`)
    }
  }

  for (const event of snapshot.events) {
    createSession(sessionNamed(event.sessionId, `v1 event ${event.id} (${event.type})`))
    translateEvent(event)
  }
  const queued = new Set(snapshot.events.filter((e) => e.type === "inbox.queued").map((e) => e.inboxId))
  for (const row of snapshot.inbox)
    if (!queued.has(row.id)) fail(`v1 inbox row ${row.id}: it has no inbox.queued event`)

  for (const session of [...snapshot.sessions].sort((a, b) => a.createdAt - b.createdAt)) createSession(session)

  for (const session of snapshot.sessions
    .filter((s) => s.endedAt !== null)
    .sort((a, b) => a.endedAt! - b.endedAt! || (a.id < b.id ? -1 : 1)))
    push(
      "session.ended",
      session.endedAt!,
      { projectId: session.projectId, sessionId: session.id },
      { reason: session.role === "main" ? "replaced" : "archived" },
      `v1 session ${session.id}`,
    )

  for (const project of snapshot.projects)
    if (project.entrySessionId !== null)
      push(
        "project.entry_changed",
        importedAt,
        { projectId: project.id },
        { session: project.entrySessionId },
        `v1 project ${project.id}`,
      )

  for (const row of snapshot.outbox) {
    const source = `v1 outbox ${row.id}`
    push(
      "outbox.queued",
      row.createdAt,
      onSession(row.sessionId, source),
      { id: row.id, peer: row.peerId, kind: row.kind, content: row.content },
      source,
    )
  }

  return { facts, eventSeq, inboxSeq, sources, counts }
}
