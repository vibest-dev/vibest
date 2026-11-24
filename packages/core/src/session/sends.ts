import { type Sender } from "@vibest/schema/event"
import { AmbiguousSession, NoSuchSession } from "@vibest/schema/session"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"

import { archived } from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Placement } from "./placement.ts"

export * as Sends from "./sends.ts"

export class SendRefused extends Schema.TaggedError<SendRefused>()("SendRefused", {
  message: Schema.String,
}) {}

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const fs = yield* FileSystem.FileSystem
  const { worktreeOf } = yield* Placement.Service

  const getRow = (id: string) =>
    db.session
      .getSession(id)
      .pipe(
        Effect.flatMap((session) =>
          session ? Effect.succeed(session) : Effect.fail(new NoSuchSession({ id, message: `no session ${id}` })),
        ),
      )

  const send = Effect.fn("Sends.send")(function* (
    id: string,
    message: string,
    sender: Sender = { type: "user" },
    request?: string,
  ) {
    const session = yield* getRow(id)

    if (request !== undefined && (yield* db.inbox.queuedFrom(sender, request))) return
    const worktree = yield* worktreeOf(session)

    if (archived(session) || !(yield* fs.exists(worktree).pipe(Effect.orDie)))
      return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
    const row = yield* db.inbox.insertSend(id, message, sender, request)

    if (!row) return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
  })

  const toEntry = (id: string, message: string, sender: Sender, request?: string) =>
    Effect.gen(function* () {
      if (!(yield* db.inbox.insertSend(id, message, sender, request)))
        return yield* new NoSuchSession({
          id,
          message: `${id} is the entry session of this project and is not running`,
        })
    })

  const deliverTo = Effect.fn("Sends.deliverTo")(function* (
    id: string,
    message: string,
    sender: Sender = { type: "user" },
    request?: string,
  ) {
    if (!(yield* db.session.sessionIdentity(id))?.entry) return yield* send(id, message, sender, request)

    return yield* toEntry(id, message, sender, request)
  })

  const admit = Effect.fn("Sends.admit")(function* (
    sender: { readonly sessionId: string; readonly projectId: string },
    input: string,
    message: string,
    request?: string,
  ) {
    const toRemote = yield* db.remote.sendToLinkedRemote(sender.sessionId, input, message, request)

    if (toRemote === "unknown")
      return yield* new NoSuchSession({
        id: input,
        message: `${input} is on another machine that vibestd does not know; nothing was sent`,
      })

    if (toRemote !== undefined && "ambiguous" in toRemote)
      return yield* new AmbiguousSession({ prefix: input, matches: toRemote.ambiguous })

    if (toRemote !== undefined && "sent" in toRemote) return { id: toRemote.sent }
    const id = yield* db.session.resolveSession(input)

    if (id === sender.sessionId)
      return yield* new SendRefused({ message: `${id} is you; a session does not send to itself` })
    const target = yield* db.session.sessionIdentity(id)

    if (target?.projectId !== sender.projectId)
      return yield* new SendRefused({
        message: `${id} belongs to another entry session's project; a message goes only to an agent of your own project`,
      })
    const creator = (yield* db.session.creatorOf(sender.sessionId)) ?? undefined
    const mine = creator !== undefined && "local" in creator ? creator.local : undefined

    if (!(yield* db.inbox.maySend(sender.sessionId, id)))
      return yield* new SendRefused({
        message: `${id} is not linked from this session; link them with vibest session link${mine === undefined ? "" : ` (you may send to ${mine})`}`,
      })
    const session = yield* db.session.getSession(id)
    const stopped = !session || archived(session)
    const from = { type: "agent" as const, session: sender.sessionId }

    if (!(stopped && mine === id)) {
      if (stopped && !target.entry) return yield* new NoSuchSession({ id, message: `${id} was archived` })

      if (target.entry) yield* toEntry(id, message, from, request)
      else yield* send(id, message, from, request)

      return { id }
    }

    const heir = yield* db.session.nearestAlive(sender.sessionId)

    if (heir === undefined)
      return yield* new NoSuchSession({
        id,
        message: `${id} has ended and no session above it is running; the user reads your last reply with vibest result`,
      })

    if ("remote" in heir) {
      if (!(yield* db.remote.sendToRemote(sender.sessionId, heir.remote, heir.session, message, request)))
        return yield* new NoSuchSession({
          id,
          message: `${id} has ended and the session above it is on another machine that vibestd does not know; nothing was sent`,
        })

      return { id: heir.session }
    }

    if ((yield* db.session.sessionIdentity(heir.local))?.entry) yield* toEntry(heir.local, message, from, request)
    else yield* send(heir.local, message, from, request)

    return { id: heir.local }
  })

  const toLocal = (id: string, message: string, sender: Sender, request?: string) =>
    db.session
      .sessionIdentity(id)
      .pipe(
        Effect.flatMap((identity) =>
          identity?.entry ? toEntry(id, message, sender, request) : send(id, message, sender, request),
        ),
      )

  const relay = Effect.fn("Sends.relay")(function* (to: string, message: string, sender: Sender, request?: string) {
    const target = yield* db.session.sessionIdentity(to)

    if (target === undefined) return yield* new NoSuchSession({ id: to, message: `no session ${to}` })
    const session = yield* db.session.getSession(to)

    if (target.entry || (session !== undefined && !archived(session))) {
      yield* toLocal(to, message, sender, request)

      return { id: to }
    }

    const heir = yield* db.session.nearestAlive(to)

    if (heir === undefined)
      return yield* new NoSuchSession({ id: to, message: `${to} has ended and no session above it is running` })

    if ("remote" in heir)
      return yield* new SendRefused({
        message: `${to} has ended and the session above it is on another machine; this send goes only to sessions on this machine`,
      })
    yield* toLocal(heir.local, message, sender, request)

    return { id: heir.local }
  })

  return { send, deliverTo, admit, relay }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Sends") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Db.node, Placement.node, PlatformNode.fileSystem],
})
