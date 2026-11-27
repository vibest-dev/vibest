import { type Sender } from "@vibest/schema/event"
import { AmbiguousSession, NoSuchSession } from "@vibest/schema/session"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"

import { archived } from "../database/rows.ts"
import { PlatformNode } from "../effect/platform.ts"
import { InboxStore } from "../inbox/store.ts"
import { RemoteStore } from "../remote/store.ts"
import { SessionStore } from "./store.ts"

export * as Sends from "./sends.ts"

export class SendRefused extends Schema.TaggedError<SendRefused>()("SendRefused", {
  message: Schema.String,
}) {}

export const make = Effect.gen(function* () {
  const sessionStore = yield* SessionStore.Service
  const inboxStore = yield* InboxStore.Service
  const remoteStore = yield* RemoteStore.Service
  const fs = yield* FileSystem.FileSystem

  const getRow = (id: string) =>
    sessionStore
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

    if (request !== undefined && (yield* inboxStore.queuedFrom(sender, request))) return
    const directory = yield* sessionStore.sessionDirectory(id)

    if (
      archived(session) ||
      (directory !== undefined && directory !== "" && !(yield* fs.exists(directory).pipe(Effect.orDie)))
    )
      return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
    const row = yield* inboxStore.insertSend(id, message, sender, request)

    if (!row) return yield* new NoSuchSession({ id, message: `${id} was archived; run a new session` })
  })

  const admit = Effect.fn("Sends.admit")(function* (
    sender: { readonly sessionId: string; readonly projectId: string },
    input: string,
    message: string,
    request?: string,
  ) {
    const toRemote = yield* remoteStore.sendToLinkedRemote(sender.sessionId, input, message, request)

    if (toRemote === "unknown")
      return yield* new NoSuchSession({
        id: input,
        message: `${input} is on another machine that vibestd does not know; nothing was sent`,
      })

    if (toRemote !== undefined && "ambiguous" in toRemote)
      return yield* new AmbiguousSession({ prefix: input, matches: toRemote.ambiguous })

    if (toRemote !== undefined && "sent" in toRemote) return { id: toRemote.sent }
    const id = yield* sessionStore.resolveSession(input)

    if (id === sender.sessionId)
      return yield* new SendRefused({ message: `${id} is you; a session does not send to itself` })
    const target = yield* sessionStore.sessionIdentity(id)

    if (target?.projectId !== sender.projectId)
      return yield* new SendRefused({
        message: `${id} belongs to another project; a message goes only to an agent of your own project`,
      })
    const creator = (yield* sessionStore.creatorOf(sender.sessionId)) ?? undefined
    const mine = creator !== undefined && "local" in creator ? creator.local : undefined

    if (!(yield* inboxStore.maySend(sender.sessionId, id)))
      return yield* new SendRefused({
        message: `${id} is not linked from this session; link them with vibest session link${mine === undefined || mine === id ? "" : ` (you may send to ${mine})`}`,
      })
    const session = yield* sessionStore.getSession(id)
    const stopped = !session || archived(session)
    const from = { type: "agent" as const, session: sender.sessionId }

    if (!(stopped && mine === id)) {
      if (stopped) return yield* new NoSuchSession({ id, message: `${id} was archived` })
      yield* send(id, message, from, request)

      return { id }
    }

    const heir = yield* sessionStore.nearestAlive(sender.sessionId)

    if (heir === undefined)
      return yield* new NoSuchSession({
        id,
        message: `${id} has ended and no session above it is running; the user reads your last reply with vibest result`,
      })

    if ("remote" in heir) {
      if (!(yield* remoteStore.sendToRemote(sender.sessionId, heir.remote, heir.session, message, request)))
        return yield* new NoSuchSession({
          id,
          message: `${id} has ended and the session above it is on another machine that vibestd does not know; nothing was sent`,
        })

      return { id: heir.session }
    }

    yield* send(heir.local, message, from, request)

    return { id: heir.local }
  })

  const relay = Effect.fn("Sends.relay")(function* (to: string, message: string, sender: Sender, request?: string) {
    const target = yield* sessionStore.sessionIdentity(to)

    if (target === undefined) return yield* new NoSuchSession({ id: to, message: `no session ${to}` })
    const session = yield* sessionStore.getSession(to)

    if (session !== undefined && !archived(session)) {
      yield* send(to, message, sender, request)

      return { id: to }
    }

    const heir = yield* sessionStore.nearestAlive(to)

    if (heir === undefined)
      return yield* new NoSuchSession({ id: to, message: `${to} has ended and no session above it is running` })

    if ("remote" in heir)
      return yield* new SendRefused({
        message: `${to} has ended and the session above it is on another machine; this send goes only to sessions on this machine`,
      })
    yield* send(heir.local, message, sender, request)

    return { id: heir.local }
  })

  return { send, admit, relay }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Sends") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SessionStore.node, InboxStore.node, RemoteStore.node, PlatformNode.fileSystem],
})
