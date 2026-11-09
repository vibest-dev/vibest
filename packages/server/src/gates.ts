import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { NoSuchSession } from "@vibest/core/sessions"
import {
  AGENT_HEADER,
  CALLER_HEADER,
  CWD_HEADER,
  HARNESS_HEADER,
  HARNESS_SESSION_HEADER,
  PLUGIN_VERSION_HEADER,
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
  InvalidCaller,
  ProtocolGate,
  ProtocolRejected,
  VERSION,
  type CallerShape,
} from "@vibest/protocol/rpc"
import { Effect, Layer, Option } from "effect"
import * as Headers from "effect/http/Headers"

export const SETTLEMENTS: ReadonlySet<string> = new Set(["TurnEnd", "Prompt"])

export const AdmissionLive = Layer.effect(
  Admission,
  Effect.gen(function* () {
    const drain = yield* Drain
    return Admission.of((effect, { rpc }) =>
      Effect.acquireUseRelease(
        drain.admit(rpc._tag, SETTLEMENTS.has(rpc._tag)),
        (leave) => (leave ? effect : Effect.fail(new DaemonStopping({ method: rpc._tag }))),
        (leave) => leave ?? Effect.void,
      ),
    )
  }),
)

export const header = (headers: Headers.Headers, name: string) => Headers.get(headers, name)

export const noteConversation = (db: Db["Service"], headers: Headers.Headers, row: { id: string; harness: string }) =>
  Effect.gen(function* () {
    const conversation = Option.getOrUndefined(header(headers, HARNESS_SESSION_HEADER))
    if (!conversation || Option.getOrUndefined(header(headers, HARNESS_HEADER)) !== row.harness) return
    if (yield* db.noteHarnessSession(row.id, conversation))
      yield* Effect.logInfo(`session ${row.id} is in conversation ${conversation}`)
  })

export const noteOpen = (db: Db["Service"], headers: Headers.Headers, sessionId: string) =>
  Effect.gen(function* () {
    if (Option.getOrUndefined(header(headers, SESSION_HEADER)) !== sessionId) return
    const row = yield* db.sessionIdentity(sessionId)
    if (row && Option.getOrUndefined(header(headers, PROJECT_HEADER)) === row.projectId)
      yield* noteConversation(db, headers, row)
  })

export const resolveCaller = (db: Db["Service"], headers: Headers.Headers, method: string) =>
  Effect.gen(function* () {
    const kind = header(headers, CALLER_HEADER)
    const sessionId = header(headers, SESSION_HEADER)
    const repository = header(headers, REPOSITORY_HEADER)
    const bad = (message: string) => new InvalidCaller({ method, message })
    if (kind._tag === "None")
      return yield* bad(`${method} needs an ${CALLER_HEADER} header (cli or session); it does not default to cli`)
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
      const row = yield* db.sessionIdentity(sessionId.value)
      if (!row) return yield* new NoSuchSession({ id: sessionId.value, message: `no session ${sessionId.value}` })
      const project = header(headers, PROJECT_HEADER)
      if (project._tag === "None")
        return yield* bad(`${method} claims session ${row.id} without ${PROJECT_HEADER} (VIBEST_PROJECT_ID)`)
      if (project.value !== row.projectId)
        return yield* bad(`${method} claims project ${project.value}; session ${row.id} is in project ${row.projectId}`)
      yield* noteConversation(db, headers, row)
      if (row.agent === "coordinator") {
        return {
          _tag: "Coordinator",
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

export const noteIntegration = (db: Db["Service"], read: (name: string) => string | undefined): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sessionId = read(SESSION_HEADER)
    const version = read(PLUGIN_VERSION_HEADER)
    if (!sessionId || !version) return
    const protocol = Number(read(PROTOCOL_HEADER) ?? "0")
    if (yield* db.noteIntegration(sessionId, { version, protocol: Number.isFinite(protocol) ? protocol : 0 }))
      yield* Effect.logInfo(`session ${sessionId} runs integration ${version} (protocol ${protocol})`).pipe(
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
        yield* noteIntegration(db, (name) => Option.getOrUndefined(header(headers, name)))
        const protocol = header(headers, PROTOCOL_HEADER)
        if (protocol._tag === "None" || protocol.value !== String(PROTOCOL)) {
          const sent = protocol._tag === "None" ? null : protocol.value
          return yield* new ProtocolRejected({
            method: rpc._tag,
            protocol: sent,
            mismatch: protocolMismatch(
              sent === null ? undefined : Number(sent),
              PROTOCOL,
              VERSION,
              Option.getOrUndefined(header(headers, PLUGIN_VERSION_HEADER)),
            ),
          })
        }
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
