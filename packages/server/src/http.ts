import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Harnesses } from "@vibest/core/harness"
import { Inbox } from "@vibest/core/inbox"
import { Integration } from "@vibest/core/integration"
import { ACK_ROUTE, HARNESS_HEADER, parseHookRoute, POLL_ROUTE, PROJECT_HEADER } from "@vibest/protocol/protocol"
import { Effect, Layer, Option, Schema } from "effect"
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

const AckBody = Schema.fromJsonString(
  Schema.Struct({ ids: Schema.Array(Schema.Number), release: Schema.optional(Schema.Array(Schema.Number)) }),
)
const ReadyBody = Schema.fromJsonString(Schema.Struct({ pid: Schema.optional(Schema.Int) }))

export const make = Effect.gen(function* () {
  const db = yield* Db
  const inbox = yield* Inbox
  const integration = yield* Integration
  const drain = yield* Drain
  const harnesses = yield* Harnesses
  const caller = (headers: Headers.Headers) =>
    Effect.gen(function* () {
      const read = reader(headers)
      const rejected = yield* checkProtocol(db, read)
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
        const current = yield* integration.ready(who.id, pid, integrationOf(reader(request.headers)), who.process)
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
      return yield* integration.guard(who.agent, request.body, who.projectId).pipe(
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

export const httpServer = LayerNode.unbound<ServeError>()(HttpServer.HttpServer)

export const node = LayerNode.make({
  name: "vibest/HttpServer",
  layer,
  deps: [services, Db.node, Drain.node, Harnesses.node, Inbox.node, Integration.node, httpServer],
})
