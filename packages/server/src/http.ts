import { App } from "@vibest/core/app"
import { Db } from "@vibest/core/database/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Harnesses } from "@vibest/core/harness"
import { Inbox } from "@vibest/core/inbox"
import { Integration } from "@vibest/core/integration"
import { HARNESS_HEADER, parseHookRoute, PROJECT_HEADER, TAKE_ROUTE } from "@vibest/protocol/protocol"
import { Context, Effect, Layer, Schema } from "effect"
import * as Headers from "effect/http/Headers"
import * as HttpServer from "effect/http/HttpServer"
import type { ServeError } from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

import { admit, checkProtocol, identify, integrationOf, processOf, reader } from "./gates.ts"
import { services } from "./services.ts"

export type Request = {
  readonly path: string
  readonly headers: Headers.Headers
  readonly body: string
}
export type Reply = { readonly status: number; readonly body?: unknown }

const failure = (status: number, error: string): Reply => ({ status, body: { error } })
const ok = (body?: unknown): Reply => (body === undefined ? { status: 204 } : { status: 200, body })

const REASON_LIMIT = 1024
const boundReason = (reason: string) =>
  reason.length <= REASON_LIMIT
    ? reason
    : reason.slice(0, REASON_LIMIT) + `... (${reason.length - REASON_LIMIT} more chars)`

const schemaRejection = (reason: string) =>
  Effect.logWarning("schema rejection").pipe(
    Effect.annotateLogs({ kind: "Payload", reason }),
    Effect.as({
      status: 400,
      body: { _tag: "InvalidRequestError", message: reason, kind: "Payload" },
    } satisfies Reply),
  )

const ReadyBody = Schema.fromJsonString(Schema.Struct({ pid: Schema.optional(Schema.Int) }))

export const make = Effect.gen(function* () {
  const db = yield* Db
  const inbox = yield* Inbox
  const integration = yield* Integration
  const drain = yield* Drain
  const harnesses = yield* Harnesses
  const { version } = yield* App
  const caller = (headers: Headers.Headers) =>
    Effect.gen(function* () {
      const read = reader(headers)
      const rejected = yield* checkProtocol(db, read, version)
      if (rejected)
        return {
          status: 409,
          body: { error: rejected.mismatch.message, ...rejected.mismatch },
        } satisfies Reply
      const who = yield* identify(db, read)
      if (who._tag === "NoSession") return failure(404, `no session ${who.id ?? "(no vibest-session-id)"}`)
      if (who._tag !== "Known")
        return failure(
          403,
          `session ${who.row.id} is not in project ${read(PROJECT_HEADER) ?? "(no vibest-project-id)"}`,
        )
      const harness = read(HARNESS_HEADER)
      if (harness !== who.row.harness)
        return failure(403, `session ${who.row.id} runs ${who.row.harness}, not ${harness ?? "(no vibest-harness)"}`)
      return { ...who.row, process: processOf(read) }
    })

  const admitted = <R>(label: string, settlement: boolean, body: Effect.Effect<Reply, never, R>) =>
    admit(drain, label, settlement, body, Effect.succeed(failure(503, "vibestd is stopping")))

  const handle = (request: Request) =>
    Effect.gen(function* () {
      const who = yield* caller(request.headers)
      if ("status" in who) return who
      if (request.path === TAKE_ROUTE) {
        if (!inbox.pulls(who.harness)) return failure(403, `session ${who.id} runs ${who.harness}, which does not pull`)
        return ok(yield* inbox.take(who.id, who.process))
      }
      if (request.path === "/session/ready") {
        const decoded = yield* Effect.result(Schema.decodeUnknownEffect(ReadyBody)(request.body))
        if (decoded._tag === "Failure") return yield* schemaRejection(boundReason(decoded.failure.message))
        const current = yield* integration.ready(
          who.id,
          decoded.success.pid,
          integrationOf(reader(request.headers)),
          who.process,
        )
        return ok(current === undefined ? undefined : { process: current })
      }
      const hook = parseHookRoute(request.path)
      const adapter = hook && harnesses.find(hook.harness)
      if (!hook || adapter === undefined) return failure(404, `no route ${request.path}`)
      if (hook.harness !== who.harness)
        return failure(403, `session ${who.id} runs ${who.harness}, not ${hook.harness}`)
      if (hook.hook === "execution-end")
        return yield* admitted(
          "hook execution-end",
          true,
          integration.executionEnd(who, request.body).pipe(Effect.as(ok())),
        )
      if (hook.hook === "prompt")
        return yield* admitted("hook prompt", true, integration.prompt(who, request.body).pipe(Effect.as(ok())))
      return yield* integration.guard(who.id, request.body).pipe(
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
        const read = yield* Effect.result(request.text)
        if (read._tag === "Failure")
          return HttpServerResponse.jsonUnsafe({ error: read.failure.message }, { status: 400 })
        const body = read.success
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

export class HttpServerLayer extends Context.Service<HttpServerLayer, Layer.Layer<HttpServer.HttpServer, ServeError>>()(
  "vibest/HttpServerLayer",
) {}
export const httpServerLayer = LayerNode.unbound(HttpServerLayer)
export const httpServer = LayerNode.make({
  service: HttpServer.HttpServer,
  layer: Layer.unwrap(Effect.map(HttpServerLayer, (layer) => layer)),
  deps: [httpServerLayer],
})

export const node = LayerNode.make({
  name: "vibest/HttpServer",
  layer,
  deps: [services, Db.node, Drain.node, Harnesses.node, Inbox.node, Integration.node, httpServer, App.node],
})
