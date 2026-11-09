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
  parseHookRoute,
  POLL_ROUTE,
  PROTOCOL,
  PROTOCOL_HEADER,
  protocolMismatch,
  SESSION_HEADER,
} from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { Clock, ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import * as Headers from "effect/http/Headers"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

import { noteIntegration } from "./gates.ts"
import * as Hooks from "./hooks.ts"

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
const ReadyBody = Schema.fromJsonString(Schema.Struct({ pid: Schema.optional(Schema.Int) }))

export const make = Effect.gen(function* () {
  const db = yield* Db
  const inbox = yield* Inbox
  const sessions = yield* Sessions
  const drain = yield* Drain
  const harnesses = yield* Harnesses
  const layout = yield* Layout
  const header = (headers: Headers.Headers, name: string) => Option.getOrUndefined(Headers.get(headers, name))

  const identify = (headers: Headers.Headers) =>
    Effect.gen(function* () {
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
      if (project !== row.projectId)
        return failure(403, `session ${row.id} is not in project ${project ?? "(no vibest-project-id)"}`)
      const harness = header(headers, HARNESS_HEADER)
      if (harness !== row.harness)
        return failure(403, `session ${row.id} runs ${row.harness}, not ${harness ?? "(no vibest-harness)"}`)
      const conversation = header(headers, HARNESS_SESSION_HEADER)
      if (conversation && (yield* db.noteHarnessSession(row.id, conversation)))
        yield* Effect.logInfo(`session ${row.id} is in conversation ${conversation}`)
      return row
    })

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
        if (harnesses.find(who.harness)?.inbox !== "poll")
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
      if (request.path === "/session/ready") {
        const pid = Option.getOrUndefined(
          yield* Schema.decodeUnknownEffect(ReadyBody)(request.body).pipe(Effect.option),
        )?.pid
        yield* db.patchLive(who.id, { ready: yield* Clock.currentTimeMillis, ...(pid === undefined ? {} : { pid }) })
        return ok()
      }
      const hook = parseHookRoute(request.path)
      const adapter = hook && harnesses.find(hook.harness)
      if (!hook || adapter === undefined) return failure(404, `no route ${request.path}`)
      if (hook.harness !== who.harness)
        return failure(403, `session ${who.id} runs ${who.harness}, not ${hook.harness}`)
      if (hook.hook === "turn-end")
        return yield* admitted(
          "hook turn-end",
          true,
          Hooks.turnEnd(db, adapter, who, request.body).pipe(Effect.as(ok())),
        )
      if (hook.hook === "prompt")
        return yield* admitted(
          "hook prompt",
          true,
          Hooks.prompt(sessions, db, adapter, who, request.body).pipe(Effect.as(ok())),
        )
      const own = { VIBEST_PROJECT_DIR: layout.project(who.projectId) }
      return yield* Guard.check(who.agent, request.body).pipe(
        Effect.provideService(Harnesses, harnesses),
        Effect.provide(ConfigProvider.layerAdd(ConfigProvider.fromEnv({ env: own }), { asPrimary: true })),
        Effect.map((reason) => ok(reason === undefined ? {} : { deny: reason })),
        Effect.catch((e) =>
          Effect.succeed(ok({ deny: `vibest could not check this tool call (${String(e)}); it is refused.` })),
        ),
      )
    })

  return handle
})

export const layer = Layer.unwrap(
  Effect.map(make, (handle) =>
    HttpServer.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.method !== "POST") return HttpServerResponse.jsonUnsafe({ error: "POST only" }, { status: 405 })
        const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""))
        const reply = yield* handle({
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
