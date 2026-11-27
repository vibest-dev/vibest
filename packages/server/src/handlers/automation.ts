import { Automation } from "@vibest/core/automation"
import { VibestApi } from "@vibest/protocol/api"
import { Caller } from "@vibest/protocol/middleware"
import { Effect, Predicate } from "effect"
import { HttpApiBuilder } from "effect/http-api"

export const AutomationHandler = HttpApiBuilder.group(VibestApi, "server.automation", (handlers) =>
  Effect.gen(function* () {
    const automation = yield* Automation.Service

    return handlers
      .handle("automation.create", ({ payload }) =>
        Effect.gen(function* () {
          const caller = yield* Caller

          if (Predicate.isTagged(caller, "Session")) {
            return yield* automation.create({
              ...payload,
              sessionId: caller.sessionId,
              projectId: caller.projectId,
            })
          }

          return yield* automation.create(payload)
        }),
      )
      .handle("automation.list", ({ query }) =>
        automation.list({
          ...(query.projectId !== undefined && { projectId: query.projectId }),
          ...(query.sessionId !== undefined && { sessionId: query.sessionId }),
          ...(query.status !== undefined && { status: query.status }),
        }),
      )
      .handle("automation.get", ({ params }) => automation.get(params.id))
      .handle("automation.pause", ({ params }) => automation.pause(params.id))
      .handle("automation.resume", ({ params }) => automation.resume(params.id))
      .handle("automation.remove", ({ params }) => automation.remove(params.id))
      .handle("automation.tick", () => automation.tick)
      .handle("automation.runNow", ({ params }) => automation.runNow(params.id))
  }),
)
