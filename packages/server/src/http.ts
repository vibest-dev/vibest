// vibestd's HTTP API (`vibest-http.sock`, beside vibest.sock): what a harness integration that can only make HTTP requests
// calls (the Claude plugin's `$.http.fetch`). Every route is `POST /<route>` with a JSON body, answered at once. The caller is
// a session, named by the shared session headers (@vibest/protocol `sessionHeaders`); the transport is not part of it.
// Paths carry no version: the only one is PROTOCOL in the `vibest-protocol` header, as for RPC.
//
//   /inbox/poll                  → { ids, line, text }  the main agent's next batch, each row leased (Inbox.poll)
//   /inbox/ack { ids, release? } → { acked }            delivered, or given back (Inbox.ack); a settlement, so still
//                                                       taken while stopping
//   /events IntegrationEvent     → 204                  ready, conversation, turn.start, turn.end, blocked (hooks.ts);
//                                                       a settlement, so still taken while stopping
//   /guard { tool }              → { deny? }            Guard.check of the neutral ToolCall with the session's own agent
//   /hook { hook, payload }      → { output? }          a shell-hook CLI's raw hook: its adapter's decode turns it into
//                                                       events (as /events) or a tool call (as /guard, answered in
//                                                       the CLI's own format); a settlement
//
// Errors are `{ error }`: 409 another protocol (with @vibest/protocol `ProtocolMismatch`: protocol, version, message,
// action), 404 no such session or route, 403 another project, another harness than the session's, or a poll from what is
// not a main agent whose harness polls, 503 vibestd is stopping.
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import * as Guard from "@vibest/core/guard"
import { Harnesses } from "@vibest/core/harness"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import {
  HARNESS_HEADER,
  HARNESS_SESSION_HEADER,
  PLUGIN_VERSION_HEADER,
  PROJECT_HEADER,
  ACK_ROUTE,
  EVENTS_ROUTE,
  GUARD_ROUTE,
  HOOK_ROUTE,
  type IntegrationEvent,
  POLL_ROUTE,
  PROTOCOL,
  PROTOCOL_HEADER,
  protocolMismatch,
  SESSION_HEADER,
} from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import * as Headers from "effect/http/Headers"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

import * as Hooks from "./hooks.ts"
import { noteIntegration } from "./server.ts"

export type Request = {
  readonly path: string
  readonly headers: Headers.Headers
  readonly body: string
}
export type Reply = { readonly status: number; readonly body?: unknown }

const failure = (status: number, error: string): Reply => ({ status, body: { error } })
const ok = (body?: unknown): Reply => (body === undefined ? { status: 204 } : { status: 200, body })

const AckBody = Schema.fromJsonString(
  Schema.Struct({ ids: Schema.Array(Schema.Number), release: Schema.optional(Schema.Array(Schema.Number)) }),
)
const EventBody = Schema.fromJsonString(Hooks.IntegrationEventSchema)
const GuardBody = Schema.fromJsonString(Schema.Struct({ tool: Hooks.ToolCallSchema }))
const HookBody = Schema.fromJsonString(
  Schema.Struct({ hook: Schema.String, payload: Schema.Record(Schema.String, Schema.Unknown) }),
)

/** The request handler, transport aside: the HTTP server below and the tests call it. */
export const make = Effect.gen(function* () {
  const db = yield* Db
  const inbox = yield* Inbox
  const sessions = yield* Sessions
  const drain = yield* Drain
  const harnesses = yield* Harnesses
  const layout = yield* Layout
  const header = (headers: Headers.Headers, name: string) => Option.getOrUndefined(Headers.get(headers, name))

  /** The calling session, checked: its row, else the reply that refuses the request. */
  const identify = (headers: Headers.Headers) =>
    Effect.gen(function* () {
      // Before the protocol check: an agent left on an old integration is recorded as such.
      yield* noteIntegration(db, (name) => header(headers, name))
      const protocol = header(headers, PROTOCOL_HEADER)
      if (protocol !== String(PROTOCOL)) {
        const mismatch = protocolMismatch(
          protocol === undefined ? undefined : Number(protocol),
          PROTOCOL,
          VERSION,
          header(headers, PLUGIN_VERSION_HEADER),
        )
        return { status: 409, body: { error: mismatch.message, ...mismatch } } satisfies Reply
      }
      const sessionId = header(headers, SESSION_HEADER)
      const row = sessionId ? yield* db.sessionIdentity(sessionId) : undefined
      if (!row) return failure(404, `no session ${sessionId ?? "(no vibest-session-id)"}`)
      const project = header(headers, PROJECT_HEADER)
      if (project !== String(row.projectId))
        return failure(403, `session ${row.id} is not in project ${project ?? "(no vibest-project-id)"}`)
      // A process of another harness under this session id (an old main agent after a switch) changes nothing.
      const harness = header(headers, HARNESS_HEADER)
      if (harness !== row.harness)
        return failure(403, `session ${row.id} runs ${row.harness}, not ${harness ?? "(no vibest-harness)"}`)
      // Kept in the session's row, written only when it changed; vibestd holds nothing per session in memory.
      const conversation = header(headers, HARNESS_SESSION_HEADER)
      if (conversation && (yield* db.noteHarnessSession(row.id, conversation)))
        yield* Effect.logInfo(`session ${row.id} is in conversation ${conversation}`)
      return row
    })

  /** Counted while it runs; refused (503) once a Daemon.Stop drains, except a settlement of work already handed out. */
  const admitted = <R>(label: string, settlement: boolean, body: Effect.Effect<Reply, never, R>) =>
    Effect.acquireUseRelease(
      drain.admit(label, settlement),
      (leave) => (leave ? body : Effect.succeed(failure(503, "vibestd is stopping"))),
      (leave) => leave ?? Effect.void,
    )

  const handle = (request: Request) =>
    Effect.gen(function* () {
      const who = yield* identify(request.headers)
      if ("status" in who) return who
      if (request.path === POLL_ROUTE || request.path === ACK_ROUTE) {
        if (who.agent !== "coordinator") return failure(403, `session ${who.id} is not its project's main agent`)
        if (harnesses.find(who.harness)?.delivery !== "poll")
          return failure(403, `session ${who.id} runs ${who.harness}, which does not poll`)
        if (request.path === POLL_ROUTE) return ok(yield* inbox.poll(who.projectId))
        const body = yield* Schema.decodeUnknownEffect(AckBody)(request.body).pipe(Effect.option)
        if (Option.isNone(body)) return failure(400, "the body is not { ids: number[], release?: number[] }")
        return yield* admitted(
          "inbox ack",
          true,
          Effect.map(inbox.ack(who.projectId, body.value.ids, body.value.release), (acked) => ok({ acked })),
        )
      }
      const caller = { id: who.id, agent: who.agent, harness: who.harness }
      const events = (list: ReadonlyArray<IntegrationEvent>, label: string) =>
        admitted(
          label,
          true,
          Effect.forEach(list, (event) => Hooks.apply(db, sessions, caller, event), { discard: true }).pipe(
            Effect.as(ok()),
            Effect.catch((e) => Effect.succeed(failure(500, `the event was not recorded: ${String(e)}`))),
          ),
        )
      // The guard reads the session's own scratch directory as its terminal's VIBEST_SCRATCH; vibestd has none.
      const guard = (tool: Guard.ToolCall) =>
        Effect.gen(function* () {
          const key = yield* db.projectKey(who.projectId)
          const scratch = key === undefined ? {} : { VIBEST_SCRATCH: layout.scratch(key) }
          return yield* Guard.check(who.agent, tool).pipe(
            Effect.provide(ConfigProvider.layerAdd(ConfigProvider.fromEnv({ env: scratch }), { asPrimary: true })),
            Effect.catch((e) => Effect.succeed(`vibest could not check this tool call (${String(e)}); it is refused.`)),
          )
        })
      if (request.path === EVENTS_ROUTE) {
        const body = yield* Schema.decodeUnknownEffect(EventBody)(request.body).pipe(Effect.option)
        if (Option.isNone(body)) return failure(400, "the body is not an integration event")
        return yield* events([body.value], `event ${body.value.type}`)
      }
      if (request.path === GUARD_ROUTE) {
        const body = yield* Schema.decodeUnknownEffect(GuardBody)(request.body).pipe(Effect.option)
        if (Option.isNone(body)) return ok({ deny: "vibest could not read this tool call; it is refused." })
        const reason = yield* guard(body.value.tool)
        return ok(reason === undefined ? {} : { deny: reason })
      }
      if (request.path === HOOK_ROUTE) {
        const adapter = harnesses.find(who.harness)
        const body = yield* Schema.decodeUnknownEffect(HookBody)(request.body).pipe(Effect.option)
        if (Option.isNone(body)) return failure(400, "the body is not { hook, payload }")
        const decoded = adapter?.decode?.(body.value.hook, body.value.payload)
        if (decoded === undefined) return ok({})
        if ("tool" in decoded) {
          const reason = yield* guard(decoded.tool)
          return ok({ output: adapter?.guardAnswer?.(reason) ?? (reason === undefined ? {} : { deny: reason }) })
        }
        const reply = yield* events(decoded, `hook ${body.value.hook}`)
        return reply.status === 204 ? ok({}) : reply
      }
      return failure(404, `no route ${request.path}`)
    })

  return handle
})

/** Serve `make` on the HttpServer provided (a unix socket, from #platform). */
export const layer = Layer.unwrap(
  Effect.map(make, (handle) =>
    HttpServer.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.method !== "POST") return HttpServerResponse.jsonUnsafe({ error: "POST only" }, { status: 405 })
        const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""))
        const reply = yield* handle({
          // The path alone, whether the server reports it with or without scheme and host.
          path: request.url.replace(/^[a-z]+:\/\/[^/]*/, "").split("?")[0] ?? "",
          headers: request.headers,
          body,
        })
        return reply.body === undefined
          ? HttpServerResponse.empty({ status: reply.status })
          : HttpServerResponse.jsonUnsafe(reply.body, { status: reply.status })
      }),
    ),
  ),
)
