import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { NoSuchSession } from "@vibest/core/sessions"
import {
  AGENT_HEADER,
  CALLER_HEADER,
  CWD_HEADER,
  HARNESS_HEADER,
  HARNESS_SESSION_HEADER,
  PEER_BY_HEADER,
  PEER_BY_USER,
  PEER_HEADER,
  PEER_PROJECT_HEADER,
  PLUGIN_VERSION_HEADER,
  PROCESS_HEADER,
  PROJECT_HEADER,
  PROTOCOL,
  PROTOCOL_HEADER,
  protocolMismatch,
  REPOSITORY_HEADER,
  RUNTIME_HEADER,
  SESSION_HEADER,
} from "@vibest/protocol/protocol"
import {
  Admission,
  Caller,
  CallerGate,
  DaemonStopping,
  FORWARDED_CALLS,
  InvalidCaller,
  PEER_CALLS,
  ProtocolGate,
  ProtocolRejected,
  VERSION,
  type CallerShape,
} from "@vibest/protocol/rpc"
import { ID } from "@vibest/schema/id"
import { Effect, Layer, Option } from "effect"
import * as Headers from "effect/http/Headers"

const SETTLEMENTS: ReadonlySet<string> = new Set(["ExecutionEnd", "Prompt"])

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
  drain: Drain["Service"],
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
  Admission,
  Effect.gen(function* () {
    const drain = yield* Drain
    return Admission.of((effect, { rpc }) =>
      admit(drain, rpc._tag, SETTLEMENTS.has(rpc._tag), effect, Effect.fail(new DaemonStopping({ method: rpc._tag }))),
    )
  }),
)

const noteConversation = (db: Db["Service"], read: Read, row: { id: string; harness: string }) =>
  Effect.gen(function* () {
    const conversation = read(HARNESS_SESSION_HEADER)
    if (!conversation || read(HARNESS_HEADER) !== row.harness) return
    if (yield* db.noteConversation(row.id, conversation, processOf(read)))
      yield* Effect.logInfo(`session ${row.id} is in conversation ${conversation}`)
  })

export const identify = (db: Db["Service"], read: Read) =>
  Effect.gen(function* () {
    const id = read(SESSION_HEADER)
    const row = id ? yield* db.sessionIdentity(id) : undefined
    if (!row) return { _tag: "NoSession", id } as const
    const project = read(PROJECT_HEADER)
    if (project === undefined) return { _tag: "NoProject", row } as const
    if (project !== row.projectId) return { _tag: "WrongProject", row, project } as const
    yield* noteConversation(db, read, row)
    return { _tag: "Known", row } as const
  })

export const noteOpen = (db: Db["Service"], read: Read, sessionId: string) =>
  read(SESSION_HEADER) === sessionId ? Effect.asVoid(identify(db, read)) : Effect.void

export const checkProtocol = (db: Db["Service"], read: Read) =>
  Effect.gen(function* () {
    yield* noteIntegration(db, read)
    const sent = read(PROTOCOL_HEADER)
    if (sent === String(PROTOCOL)) return undefined
    return {
      sent: sent ?? null,
      mismatch: protocolMismatch(
        sent === undefined ? undefined : Number(sent),
        PROTOCOL,
        VERSION,
        read(PLUGIN_VERSION_HEADER),
      ),
    }
  })

export const resolveCaller = (db: Db["Service"], headers: Headers.Headers, method: string) =>
  Effect.gen(function* () {
    const read = reader(headers)
    const kind = Headers.get(headers, CALLER_HEADER)
    const sessionId = Headers.get(headers, SESSION_HEADER)
    const repository = Headers.get(headers, REPOSITORY_HEADER)
    const bad = (message: string) => new InvalidCaller({ method, message })
    if (kind._tag === "None")
      return yield* bad(`${method} needs an ${CALLER_HEADER} header (cli or session); it does not default to cli`)
    if (kind.value === "peer") {
      const peer = read(PEER_HEADER)
      if (peer === undefined || !ID.test(peer))
        return yield* bad(`${method} claims peer without a valid ${PEER_HEADER}`)
      if (sessionId._tag === "Some") return yield* bad(`${method} claims peer and a session id`)
      if (!PEER_CALLS.has(method)) return yield* bad(`a peer vibestd may not call ${method}`)
      if (method !== "Peer.Hello" && !(yield* db.peerKnown(peer)))
        return yield* bad(`peer ${peer} has not said Peer.Hello; call it first`)
      const by = read(PEER_BY_HEADER)
      if (
        (by === undefined && FORWARDED_CALLS.has(method)) ||
        (by !== undefined && by !== PEER_BY_USER && !ID.test(by))
      )
        return yield* bad(`${method} is forwarded for the user or for a session; ${PEER_BY_HEADER} says neither`)
      const project = read(PEER_PROJECT_HEADER)
      return {
        _tag: "Peer",
        peerId: peer,
        ...(project === undefined ? {} : { projectId: project }),
        ...(by === undefined || by === PEER_BY_USER ? {} : { session: by }),
      } satisfies CallerShape
    }
    if (kind.value === "cli") {
      if (sessionId._tag === "Some") return yield* bad(`${method} claims cli and a session id`)
      if (repository._tag === "None" || repository.value.trim() === "")
        return yield* bad(`${method} claims cli without a repository`)
      return { _tag: "Cli", repositoryRoot: repository.value } satisfies CallerShape
    }
    if (kind.value === "session") {
      if (sessionId._tag === "None" || sessionId.value.trim() === "")
        return yield* bad(`${method} claims session without a session id`)
      if (repository._tag === "Some" && repository.value.trim() === "")
        return yield* bad(`${method} has an empty repository`)
      const who = yield* identify(db, read)
      if (who._tag === "NoSession")
        return yield* new NoSuchSession({ id: sessionId.value, message: `no session ${sessionId.value}` })
      if (who._tag === "NoProject")
        return yield* bad(`${method} claims session ${who.row.id} without ${PROJECT_HEADER} (VIBEST_PROJECT_ID)`)
      if (who._tag === "WrongProject")
        return yield* bad(
          `${method} claims project ${who.project}; session ${who.row.id} is in project ${who.row.projectId}`,
        )
      const row = who.row
      if (row.entry) {
        return {
          _tag: "Entry",
          sessionId: row.id,
          projectId: row.projectId,
          ...(repository._tag === "Some" ? { repositoryRoot: repository.value } : {}),
        } satisfies CallerShape
      }
      if (repository._tag === "Some") return yield* bad(`${method} is a session; a repository is not its identity`)
      return { _tag: "Session", sessionId: row.id, projectId: row.projectId } satisfies CallerShape
    }
    return yield* bad(`${method} has caller ${kind.value}; expected cli or session`)
  })

export const integrationOf = (read: Read) => {
  const version = read(PLUGIN_VERSION_HEADER)
  if (!version) return undefined
  const protocol = Number(read(PROTOCOL_HEADER) ?? "0")
  return { version, protocol: Number.isFinite(protocol) ? protocol : 0 }
}

const noteIntegration = (db: Db["Service"], read: Read): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sessionId = read(SESSION_HEADER)
    const integration = integrationOf(read)
    if (!sessionId || !integration) return
    if (yield* db.noteIntegration(sessionId, integration, processOf(read)))
      yield* Effect.logInfo(
        `session ${sessionId} runs integration ${integration.version} (protocol ${integration.protocol})`,
      ).pipe(
        Effect.annotateLogs({
          agent: read(AGENT_HEADER) ?? "",
          harness: read(HARNESS_HEADER) ?? "",
          cwd: decodeURIComponent(read(CWD_HEADER) ?? ""),
          runtime: read(RUNTIME_HEADER) ?? "",
        }),
      )
  })

export const ProtocolGateLive = Layer.effect(
  ProtocolGate,
  Effect.gen(function* () {
    const db = yield* Db
    return ProtocolGate.of((effect, { headers, rpc }) =>
      Effect.gen(function* () {
        const rejected = yield* checkProtocol(db, reader(headers))
        if (rejected)
          return yield* new ProtocolRejected({ method: rpc._tag, protocol: rejected.sent, mismatch: rejected.mismatch })
        return yield* effect
      }),
    )
  }),
)

export const CallerGateLive = Layer.effect(
  CallerGate,
  Effect.gen(function* () {
    const db = yield* Db
    return CallerGate.of((effect, { headers, rpc }) =>
      resolveCaller(db, headers, rpc._tag).pipe(
        Effect.flatMap((caller) => Effect.provideService(effect, Caller, caller)),
      ),
    )
  }),
)
