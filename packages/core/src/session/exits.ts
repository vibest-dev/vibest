import { Context, Effect, Layer } from "effect"

import { type SessionRow, harnessIdOf, runtimeOf, terminalOf, exitedAt, executionStateOf } from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { Inbox } from "../inbox.ts"
import type { Runtime, Terminal } from "../runtimes.ts"
import { Archive } from "./archive.ts"
import { Move } from "./move.ts"
import { Placement } from "./placement.ts"

export * as Exits from "./exits.ts"

export interface LimitedExecution {
  readonly execution: number
  readonly process: number | null
  readonly failure: string
}

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const inbox = yield* Inbox.Service
  const move = yield* Move.Service
  const { undoCutOffStart } = yield* Archive.Service
  const { notice, handTask, recount } = yield* Placement.Service

  const limitOf = Effect.fn("Exits.limitOf")(function* (session: SessionRow) {
    if (executionStateOf(session) !== "failed" || (yield* db.session.creatorOf(session.id)) === undefined)
      return undefined
    return yield* db.session.limitedExecution(session.id)
  })

  const afterLimit = Effect.fn("Exits.afterLimit")(function* (
    h: Runtime,
    session: SessionRow,
    limited: LimitedExecution,
    exited: boolean,
  ) {
    const rerun = (terminal: Terminal | undefined) =>
      move.rerun(h, session, terminal, "", false, limited.failure, limited.execution)
    if (exitedAt(session) !== null) return yield* rerun(undefined)
    const successor = (yield* db.session.currentProcessId(session.id)) !== limited.process
    if (!successor || exited) return yield* rerun(terminalOf(session).id === "" ? undefined : terminalOf(session))
    const source = yield* db.session.limitSource(session.id, limited.execution)
    const task = source === undefined ? "" : source.working || source.delivered
    if (task === "") return false
    yield* handTask(h, session, terminalOf(session), task)
    return true
  })

  const announceExit = (session: SessionRow, execution: number | undefined) =>
    Effect.gen(function* () {
      const queued = yield* db.inbox.pendingInbox(session.id)
      const signed = queued.filter((r) => r.kind === "send" && r.sender)
      const unsigned = queued.filter((r) => !signed.includes(r))
      if (signed.length > 0) yield* inbox.undelivered(session, signed, `${session.id} exited before it was delivered`)
      yield* db.inbox.setInboxStatus(
        session.id,
        unsigned.map((r) => r.id),
        "failed",
      )
      const lost = unsigned.map((r) => r.message).join("\n\n")
      const text = (how: string) =>
        `${session.id} (${harnessIdOf(session)}) exited${how}; vibest peek ${session.id} shows its terminal; vibest send ${session.id} resumes it${lost === "" ? "" : `\n\nNot delivered:\n\n${lost}`}`
      if (
        execution !== undefined &&
        (yield* db.session.closeExecution(session.id, execution, "failed", {
          failure: "the harness exited",
          notice: text(" during an execution"),
        }))
      )
        return
      const last = yield* db.session.latestReply(session.id)
      yield* notice(
        session,
        text(last?.status === "failed" ? ` after its execution ended with an error: ${last.failure ?? ""}` : ""),
      )
    })

  const recordExit = Effect.fn("Exits.recordExit")(function* (
    h: Runtime,
    session: SessionRow,
    execution: number | undefined,
  ) {
    const cutOff = (session.process?.placedAt ?? null) === null
    const announce = !cutOff && (executionStateOf(session) === "open" || exitedAt(session) === null)
    if (announce && session.entry) {
      if (execution !== undefined)
        yield* db.session.closeExecution(session.id, execution, "failed", { failure: "the harness exited" })
    } else if (announce) yield* announceExit(session, execution)
    if (exitedAt(session) === null) {
      yield* db.session.endProcess(session.id, cutOff ? "launch_failed" : "exited")
      yield* db.session.setStatus(session.id, "unknown")
      yield* recount(runtimeOf(session), session.projectId).pipe(Effect.ignore)
    }
    if (cutOff) yield* undoCutOffStart(h, session)
    if (!announce)
      yield* inbox.dropQueue(
        session,
        `${session.id} exited before it was delivered; send it again to resume the session`,
      )
  })

  const settle = Effect.fn("Exits.settle")(function* (h: Runtime, id: string) {
    const session = yield* db.session.getSession(id)
    if (session === undefined) return
    const execution = executionStateOf(session) === "open" ? yield* db.session.openExecution(session.id) : undefined
    const limited = yield* limitOf(session)
    if (limited !== undefined && (yield* afterLimit(h, session, limited, true))) return
    yield* recordExit(h, session, execution)
  })

  return { limitOf, afterLimit, recordExit, settle }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Exits") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Archive.node, Db.node, Inbox.node, Move.node, Placement.node],
})
