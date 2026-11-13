import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { Harnesses } from "@vibest/core/harness"
import { Inbox } from "@vibest/core/inbox"
import { Integration } from "@vibest/core/integration"
import { HARNESS_HEADER, parseHookRoute, PROJECT_HEADER, TAKE_ROUTE } from "@vibest/protocol/protocol"
import { App } from "@vibest/schema/app"
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
  deps: [services, Db.node, Drain.node, Harnesses.node, Inbox.node, Integration.node, httpServer, PlatformNode.app],
})
