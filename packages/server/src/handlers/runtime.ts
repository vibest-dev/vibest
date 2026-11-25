import { Runtimes } from "@vibest/core/runtimes"
import { VibestApi } from "@vibest/protocol/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"

export const RuntimeHandler = HttpApiBuilder.group(VibestApi, "server.runtime", (handlers) =>
  Effect.gen(function* () {
    const runtimes = yield* Runtimes.Service

    return handlers.handle("runtime.doctor", ({ payload: { harnesses } }) =>
      Effect.flatMap(runtimes.statuses, (rows) =>
        Effect.forEach(rows, ({ runtime, status }) =>
          (runtime.doctor
            ? runtime.doctor(harnesses)
            : Effect.succeed({ name: runtime.name ?? runtime.id, checks: [] })
          ).pipe(
            Effect.map((report) => ({
              kind: runtime.id,
              status: status.status,
              ...("reason" in status && { reason: status.reason }),
              name: report.name,
              checks: report.checks,
            })),
          ),
        ),
      ),
    )
  }),
)
