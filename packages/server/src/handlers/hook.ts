import { Db } from "@vibest/core/database/db"
import { Harnesses, unprovided } from "@vibest/core/harnesses"
import { Integration } from "@vibest/core/integration"
import { guardInputOf } from "@vibest/core/replies"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
import { Caller } from "@vibest/protocol/middleware"
import { SESSION_HEADER } from "@vibest/protocol/protocol"
import { NoSuchSession } from "@vibest/schema/session"
import { Effect, Predicate } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"

import { integrationOf, noteOpen, processOf, reader } from "../gates.ts"

export const HookHandler = HttpApiBuilder.group(VibestApi, "server.hook", (handlers) =>
  Effect.gen(function* () {
    const db = yield* Db.Service
    const harnesses = yield* Harnesses.Service
    const integration = yield* Integration.Service

    const sessionCaller = (method: string) =>
      Effect.gen(function* () {
        const caller = yield* Caller

        if (!Predicate.isTagged(caller, "Session"))
          return yield* new Forbidden({ method, message: `${method} is a session's own` })

        return caller
      })

    const checkedHarness = (method: string, harness: string) =>
      Effect.gen(function* () {
        const caller = yield* sessionCaller(method)
        const adapter = harnesses.find(harness)

        if (adapter === undefined) return yield* unprovided(harness, harnesses.all)
        const row = yield* db.session.sessionIdentity(caller.sessionId)

        if (!row) return yield* new Forbidden({ method, message: `no session ${caller.sessionId}` })

        if (row.harness !== harness)
          return yield* new Forbidden({
            method,
            message: `session ${row.id} runs ${row.harness}, not ${harness}`,
          })

        return { row, adapter }
      })

    return handlers
      .handle("hook.ready", ({ payload: { pid, conversation } }) =>
        Effect.gen(function* () {
          const caller = yield* sessionCaller("hook.ready")
          const request = yield* HttpServerRequest.HttpServerRequest
          const read = reader(request.headers)
          const row = yield* db.session.sessionIdentity(caller.sessionId)

          if (!row) return yield* new NoSuchSession({ id: caller.sessionId, message: `no session ${caller.sessionId}` })

          if (conversation !== undefined) {
            if (row.parentId === null && conversation.harness === row.harness)
              yield* integration.conversation(caller.sessionId, conversation.id, processOf(read))

            return {}
          }

          const current = yield* integration.ready(caller.sessionId, pid, integrationOf(read), processOf(read))

          return current === undefined ? {} : { process: current }
        }),
      )
      .handleRaw("hook.prompt", ({ params: { harness }, request }) =>
        Effect.gen(function* () {
          const read = reader(request.headers)
          const id = read(SESSION_HEADER)

          if (id === undefined) return HttpServerResponse.empty({ status: 204 })
          yield* noteOpen(db, read, id)
          const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""))
          yield* integration.prompt({ id, harness, process: processOf(read) }, body)

          return HttpServerResponse.empty({ status: 204 })
        }),
      )
      .handleRaw("hook.executionEnd", ({ params: { harness }, request }) =>
        Effect.gen(function* () {
          const read = reader(request.headers)
          const id = read(SESSION_HEADER)

          if (id === undefined) return HttpServerResponse.empty({ status: 204 })
          yield* noteOpen(db, read, id)
          const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""))
          yield* integration.executionEnd({ id, harness, process: processOf(read) }, body)

          return HttpServerResponse.empty({ status: 204 })
        }),
      )
      .handleRaw("hook.guard", ({ params: { harness }, request }) =>
        Effect.gen(function* () {
          const { row, adapter } = yield* checkedHarness("hook.guard", harness)
          const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""))

          const formatGuard = (reason: string | undefined) =>
            adapter.guardAnswer === undefined
              ? reason === undefined
                ? {}
                : { deny: reason }
              : adapter.guardAnswer(reason)

          const call = guardInputOf(adapter, body)

          if (call === undefined) return HttpServerResponse.jsonUnsafe(formatGuard(undefined))

          const answer = yield* integration.guard(row.id, call).pipe(
            Effect.map(formatGuard),
            Effect.catch((e) =>
              Effect.succeed(formatGuard(`vibest could not check this tool call (${String(e)}); it is refused.`)),
            ),
          )

          return HttpServerResponse.jsonUnsafe(answer)
        }),
      )
  }),
)
