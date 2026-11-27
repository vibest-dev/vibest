import { sessionLabel } from "@vibest/schema/id"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer } from "effect"

import {
  type SessionRow,
  harnessIdOf,
  localSessionOf,
  runtimeOf,
  terminalOf,
  exitedAt,
  executionStateOf,
} from "../database/rows.ts"
import { Inbox } from "../inbox.ts"
import { InboxStore } from "../inbox/store.ts"
import { paneTail, type Runtime } from "../runtime/registry.ts"
import { Archive } from "./archive.ts"
import { Placement } from "./placement.ts"
import { SessionStore } from "./store.ts"

export * as Exits from "./exits.ts"

const TAIL_LINES = 10

const LINE_CHARS = 200

const TAIL_CHARS = 2000

const shownTail = (text: string) =>
  text
    .split("\n")
    .slice(-TAIL_LINES)
    .map((line) => line.slice(0, LINE_CHARS))
    .join("\n")
    .slice(0, TAIL_CHARS)

export const make = Effect.gen(function* () {
  const sessionStore = yield* SessionStore.Service
  const inboxStore = yield* InboxStore.Service
  const inbox = yield* Inbox.Service
  const { undoCutOffStart } = yield* Archive.Service
  const { notice, recount } = yield* Placement.Service

  const lastScreen = (h: Runtime, session: SessionRow, execution: number | undefined) =>
    Effect.gen(function* () {
      const tail = shownTail(yield* paneTail(h, terminalOf(session)?.target, TAIL_LINES))
      const output = tail === "" ? "" : `\n\nIts terminal shows:\n\n${tail}`
      const beforeWork = execution !== undefined && !(yield* sessionStore.executionTaken(session.id))

      return { how: beforeWork ? " before it started working" : "", output }
    })

  const announceExit = (h: Runtime, session: SessionRow, execution: number | undefined) =>
    Effect.gen(function* () {
      const failed = yield* lastScreen(h, session, execution)
      const queued = yield* inboxStore.pendingInbox(session.id)
      const signed = queued.filter((r) => localSessionOf(r.sender) !== undefined)
      const unsigned = queued.filter((r) => !signed.includes(r))

      if (signed.length > 0) yield* inbox.undelivered(session, signed, "it exited")
      yield* inboxStore.setInboxStatus(
        session.id,
        unsigned.map((r) => r.id),
        "failed",
        undefined,
        undefined,
        "it exited",
      )
      const lost = unsigned.map((r) => r.message).join("\n\n")

      const text = (how: string) =>
        `${sessionLabel(session)} (${harnessIdOf(session)}) exited${failed.how}${how}${failed.output}${lost === "" ? "" : `\n\nNot delivered:\n\n${lost}`}`

      if (
        execution !== undefined &&
        (yield* sessionStore.executionAccepted(session.id)) &&
        (yield* sessionStore.closeExecution(session.id, execution, "failed", {
          failure: { message: "the harness exited" },
          notice: text(" during an execution"),
        }))
      )
        return

      if (execution !== undefined) yield* sessionStore.closeExecution(session.id, execution, "not_started")
      const last = yield* sessionStore.latestReply(session.id)
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
    const root = (yield* sessionStore.creatorOf(session.id)) === undefined

    if (announce && root) {
      if (execution !== undefined && (yield* sessionStore.executionAccepted(session.id)))
        yield* sessionStore.closeExecution(session.id, execution, "failed", {
          failure: { message: "the harness exited" },
        })
      else if (execution !== undefined) yield* sessionStore.closeExecution(session.id, execution, "not_started")
    } else if (announce) yield* announceExit(h, session, execution)

    if (
      exitedAt(session) === null &&
      (yield* sessionStore.endProcess(session.id, cutOff ? "launch_failed" : "exited", session.process?.id))
    )
      yield* recount(runtimeOf(session), session.projectId).pipe(Effect.ignore)

    if (cutOff) yield* undoCutOffStart(h, session)

    if (!announce && !root) yield* inbox.dropQueue(session, "it exited; send it again to resume it")
  })

  const settle = Effect.fn("Exits.settle")(function* (h: Runtime, id: string, process: number | undefined) {
    const session = yield* sessionStore.getSession(id)

    if (session === undefined || session.process?.id !== process) return
    const execution = executionStateOf(session) === "open" ? yield* sessionStore.openExecution(session.id) : undefined
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
  deps: [Archive.node, SessionStore.node, InboxStore.node, Inbox.node, Placement.node],
})
