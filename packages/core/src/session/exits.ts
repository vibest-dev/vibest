import { sessionLabel } from "@vibest/schema/id"
import { Context, Effect, Layer } from "effect"

import {
  type SessionRow,
  harnessIdOf,
  localSessionOf,
  runtimeOf,
  terminalOf,
  exitedAt,
  executionStateOf,
} from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { Inbox } from "../inbox.ts"
import { paneTail, type Runtime } from "../runtimes.ts"
import { Archive } from "./archive.ts"
import { Placement } from "./placement.ts"

export * as Exits from "./exits.ts"

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const inbox = yield* Inbox.Service
  const { undoCutOffStart } = yield* Archive.Service
  const { notice, recount } = yield* Placement.Service

  const startFailure = (h: Runtime, session: SessionRow, execution: number | undefined) =>
    Effect.gen(function* () {
      if (execution === undefined || (yield* db.session.executionTaken(session.id))) return { how: "", output: "" }
      const tail = yield* paneTail(h, terminalOf(session), 10)

      return { how: " before it started working", output: tail === "" ? "" : `\n\nIts terminal shows:\n\n${tail}` }
    })

  const announceExit = (h: Runtime, session: SessionRow, execution: number | undefined) =>
    Effect.gen(function* () {
      const failed = yield* startFailure(h, session, execution)
      const queued = yield* db.inbox.pendingInbox(session.id)
      const signed = queued.filter((r) => r.kind === "send" && localSessionOf(r.sender) !== undefined)
      const unsigned = queued.filter((r) => !signed.includes(r))

      if (signed.length > 0) yield* inbox.undelivered(session, signed, "it exited")
      yield* db.inbox.setInboxStatus(
        session.id,
        unsigned.map((r) => r.id),
        "failed",
      )
      const lost = unsigned.map((r) => r.message).join("\n\n")

      const text = (how: string) =>
        `${sessionLabel(session)} (${harnessIdOf(session)}) exited${failed.how}${how}${failed.output}${lost === "" ? "" : `\n\nNot delivered:\n\n${lost}`}`

      if (
        execution !== undefined &&
        (yield* db.session.closeExecution(session.id, execution, "failed", {
          failure: { message: "the harness exited" },
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
        yield* db.session.closeExecution(session.id, execution, "failed", {
          failure: { message: "the harness exited" },
        })
    } else if (announce) yield* announceExit(h, session, execution)

    if (
      exitedAt(session) === null &&
      (yield* db.session.endExited(session.id, cutOff ? "launch_failed" : "exited", session.process?.id))
    )
      yield* recount(runtimeOf(session), session.projectId).pipe(Effect.ignore)

    if (cutOff) yield* undoCutOffStart(h, session)

    if (!announce) yield* inbox.dropQueue(session, "it exited; send it again to resume it")
  })

  const settle = Effect.fn("Exits.settle")(function* (h: Runtime, id: string, process: number | undefined) {
    const session = yield* db.session.getSession(id)

    if (session === undefined || session.process?.id !== process) return
    const execution = executionStateOf(session) === "open" ? yield* db.session.openExecution(session.id) : undefined
    yield* recordExit(h, session, execution)
  })

  return { recordExit, settle }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Exits") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Archive.node, Db.node, Inbox.node, Placement.node],
})
