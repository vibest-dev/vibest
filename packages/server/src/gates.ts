import { App } from "@vibest/core/app"
import { RemoteStore } from "@vibest/core/remote/store"
import { Drain } from "@vibest/core/runtime/drain"
import { NoSuchSession } from "@vibest/core/session"
import { SessionStore } from "@vibest/core/session/store"
import { FORWARDED_CALLS, REMOTE_CALLS } from "@vibest/protocol/access"
import { DaemonStopping, InvalidCaller, ProtocolRejected } from "@vibest/protocol/errors"
import {
  AdmissionMiddleware,
  Caller,
  CallerMiddleware,
  ProtocolMiddleware,
  type CallerIdentity,
} from "@vibest/protocol/middleware"
import {
  CALLER_HEADER,
  CWD_HEADER,
  HARNESS_HEADER,
  HARNESS_SESSION_HEADER,
  PLUGIN_VERSION_HEADER,
  PROCESS_HEADER,
  PROJECT_HEADER,
  PROTOCOL_HEADER,
  protocolMismatch,
  REMOTE_BY_HEADER,
  REMOTE_BY_USER,
  REMOTE_HEADER,
  REMOTE_PROJECT_HEADER,
  REPOSITORY_HEADER,
  RUNTIME_HEADER,
  SESSION_HEADER,
} from "@vibest/protocol/protocol"
import { ID } from "@vibest/schema/id"
import { PROTOCOL } from "@vibest/schema/version"
import { Data, Effect, Layer, Option, Predicate } from "effect"
import * as Headers from "effect/http/Headers"
import * as HttpServerRequest from "effect/http/HttpServerRequest"

const SETTLEMENTS: ReadonlySet<string> = new Set(["hook.executionEnd", "hook.prompt"])

export type Read = (name: string) => string | undefined

export const reader =
  (headers: Headers.Headers): Read =>
  (name) =>
    Option.getOrUndefined(Headers.get(headers, name))

export const processOf = (read: Read) => {
  const process = Number(read(PROCESS_HEADER))

  return Number.isSafeInteger(process) && process > 0 ? process : undefined
}

export const admit = <A, E, R, A2, E2>(
  drain: Drain.Interface,
  label: string,
  settlement: boolean,
  effect: Effect.Effect<A, E, R>,
  stopping: Effect.Effect<A2, E2>,
) =>
  Effect.acquireUseRelease(
    drain.admit(label, settlement),
    (leave): Effect.Effect<A | A2, E | E2, R> => (leave ? effect : stopping),
    (leave) => leave ?? Effect.void,
  )

export const AdmissionLive = Layer.effect(
  AdmissionMiddleware,
  Effect.gen(function* () {
    const drain = yield* Drain.Service

    return AdmissionMiddleware.of((effect, { endpoint }) =>
      admit(
        drain,
        endpoint.identifier,
        SETTLEMENTS.has(endpoint.identifier),
        effect,
        Effect.fail(new DaemonStopping({ method: endpoint.identifier })),
      ),
    )
  }),
)

const noteConversation = (sessionStore: SessionStore.Interface, read: Read, row: { id: string; harness: string }) =>
  Effect.gen(function* () {
    const conversation = read(HARNESS_SESSION_HEADER)

    if (!conversation || read(HARNESS_HEADER) !== row.harness) return

    if (yield* sessionStore.noteConversation(row.id, conversation, processOf(read)))
      yield* Effect.logInfo(`session ${row.id} is in conversation ${conversation}`)
  })

type IdentityRow = NonNullable<Effect.Success<ReturnType<SessionStore.Interface["sessionIdentity"]>>>

type Identity = Data.TaggedEnum<{
  NoSession: { readonly id: string | undefined }
  NoProject: { readonly row: IdentityRow }
  WrongProject: { readonly row: IdentityRow; readonly project: string }
  Known: { readonly row: IdentityRow }
}>

const Identity = Data.taggedEnum<Identity>()

const Callers = Data.taggedEnum<CallerIdentity>()

export const identify = (sessionStore: SessionStore.Interface, read: Read) =>
  Effect.gen(function* () {
    const id = read(SESSION_HEADER)
    const row = id ? yield* sessionStore.sessionIdentity(id) : undefined

    if (!row) return Identity.NoSession({ id })
    const project = read(PROJECT_HEADER)

    if (project === undefined) return Identity.NoProject({ row })

    if (project !== row.projectId) return Identity.WrongProject({ row, project })
    yield* noteConversation(sessionStore, read, row)

    return Identity.Known({ row })
  })

export const noteOpen = (sessionStore: SessionStore.Interface, read: Read, sessionId: string) =>
  read(SESSION_HEADER) === sessionId ? Effect.asVoid(identify(sessionStore, read)) : Effect.void

export const checkProtocol = (sessionStore: SessionStore.Interface, read: Read, version: string) =>
  Effect.gen(function* () {
    yield* noteIntegration(sessionStore, read)
    const sent = read(PROTOCOL_HEADER)

    if (sent === String(PROTOCOL)) return undefined

    return {
      sent: sent ?? null,
      mismatch: protocolMismatch(
        sent === undefined ? undefined : Number(sent),
        PROTOCOL,
        version,
        read(PLUGIN_VERSION_HEADER),
      ),
    }
  })

export const resolveCaller = (
  sessionStore: SessionStore.Interface,
  remoteStore: RemoteStore.Interface,
  headers: Headers.Headers,
  method: string,
) =>
  Effect.gen(function* () {
    const read = reader(headers)
    const kind = Headers.get(headers, CALLER_HEADER)
    const sessionId = Headers.get(headers, SESSION_HEADER)
    const repository = Headers.get(headers, REPOSITORY_HEADER)
    const bad = (message: string) => new InvalidCaller({ method, message })

    if (Option.isNone(kind))
      return yield* bad(`${method} needs an ${CALLER_HEADER} header (cli or session); it does not default to cli`)

    if (kind.value === "remote") {
      const remote = read(REMOTE_HEADER)

      if (remote === undefined || !ID.test(remote))
        return yield* bad(`${method} claims remote without a valid ${REMOTE_HEADER}`)

      if (Option.isSome(sessionId)) return yield* bad(`${method} claims remote and a session id`)

      if (!REMOTE_CALLS.has(method)) return yield* bad(`a remote vibestd may not call ${method}`)

      if (method !== "remote.hello" && !(yield* remoteStore.remoteKnown(remote)))
        return yield* bad(`remote ${remote} has not said remote.hello; call it first`)
      const by = read(REMOTE_BY_HEADER)

      if (
        (by === undefined && FORWARDED_CALLS.has(method)) ||
        (by !== undefined && by !== REMOTE_BY_USER && !ID.test(by))
      )
        return yield* bad(`${method} is forwarded for the user or for a session; ${REMOTE_BY_HEADER} says neither`)
      const project = read(REMOTE_PROJECT_HEADER)

      return Callers.Remote({
        remoteId: remote,
        ...(project !== undefined && { projectId: project }),
        ...(by !== undefined && by !== REMOTE_BY_USER && { session: by }),
      })
    }

    if (kind.value === "cli") {
      if (Option.isSome(sessionId)) return yield* bad(`${method} claims cli and a session id`)

      if (Option.isNone(repository) || repository.value.trim() === "")
        return yield* bad(`${method} claims cli without a repository`)

      return Callers.Cli({ repositoryRoot: repository.value })
    }

    if (kind.value === "session") {
      if (Option.isNone(sessionId) || sessionId.value.trim() === "")
        return yield* bad(`${method} claims session without a session id`)

      if (Option.isSome(repository) && repository.value.trim() === "")
        return yield* bad(`${method} has an empty repository`)
      const who = yield* identify(sessionStore, read)

      if (Predicate.isTagged(who, "NoSession"))
        return yield* new NoSuchSession({ id: sessionId.value, message: `no session ${sessionId.value}` })

      if (Predicate.isTagged(who, "NoProject"))
        return yield* bad(`${method} claims session ${who.row.id} without ${PROJECT_HEADER} (VIBEST_PROJECT_ID)`)

      if (Predicate.isTagged(who, "WrongProject"))
        return yield* bad(
          `${method} claims project ${who.project}; session ${who.row.id} is in project ${who.row.projectId}`,
        )

      return Callers.Session({
        sessionId: who.row.id,
        projectId: who.row.projectId,
        ...(Option.isSome(repository) && { repositoryRoot: repository.value }),
      })
    }

    return yield* bad(`${method} has caller ${kind.value}; expected cli or session`)
  })

export const integrationOf = (read: Read) => {
  const version = read(PLUGIN_VERSION_HEADER)

  if (!version) return undefined
  const protocol = Number(read(PROTOCOL_HEADER) ?? "0")

  return { version, protocol: Number.isFinite(protocol) ? protocol : 0 }
}

const safeDecodeUri = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const noteIntegration = (sessionStore: SessionStore.Interface, read: Read): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sessionId = read(SESSION_HEADER)
    const integration = integrationOf(read)

    if (!sessionId || !integration) return

    if (yield* sessionStore.noteIntegration(sessionId, integration, processOf(read)))
      yield* Effect.logInfo(
        `session ${sessionId} runs integration ${integration.version} (protocol ${integration.protocol})`,
      ).pipe(
        Effect.annotateLogs({
          harness: read(HARNESS_HEADER) ?? "",
          cwd: safeDecodeUri(read(CWD_HEADER) ?? ""),
          runtime: read(RUNTIME_HEADER) ?? "",
        }),
      )
  })

export const ProtocolMiddlewareLive = Layer.effect(
  ProtocolMiddleware,
  Effect.gen(function* () {
    const sessionStore = yield* SessionStore.Service
    const { version } = yield* App.Service

    return ProtocolMiddleware.of((effect, { endpoint }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const rejected = yield* checkProtocol(sessionStore, reader(request.headers), version)

        if (rejected)
          return yield* new ProtocolRejected({
            ...rejected.mismatch,
            method: endpoint.identifier,
            callerProtocol: rejected.sent,
          })

        return yield* effect
      }),
    )
  }),
)

export const CallerMiddlewareLive = Layer.effect(
  CallerMiddleware,
  Effect.gen(function* () {
    const sessionStore = yield* SessionStore.Service
    const remoteStore = yield* RemoteStore.Service

    return CallerMiddleware.of((effect, { endpoint }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const caller = yield* resolveCaller(sessionStore, remoteStore, request.headers, endpoint.identifier)

        return yield* Effect.provideService(effect, Caller, caller)
      }),
    )
  }),
)
