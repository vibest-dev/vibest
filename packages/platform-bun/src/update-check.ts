import { installMethod, latestOf } from "@vibest/client/release"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { VibestCommand } from "@vibest/core/paths"
import { NOT_CHECKED, UpdateCheck } from "@vibest/server/update-check"
import { Clock, Config, Duration, Effect, Exit, Layer, Option, Ref, Schedule } from "effect"

export const UPDATE_CHECK_EVERY = Duration.hours(1)

export const checkEveryHour = <R>(lookup: Effect.Effect<string, unknown, R>) =>
  Effect.gen(function* () {
    const status = yield* Ref.make(NOT_CHECKED)
    const check = Effect.gen(function* () {
      yield* Ref.update(status, (s) => ({ ...s, checking: true }))
      const found = yield* Effect.exit(lookup)
      const now = yield* Clock.currentTimeMillis
      yield* Ref.update(status, (s) =>
        Exit.isSuccess(found)
          ? { checked: now, latest: found.value, checking: false }
          : { ...s, checked: null, checking: false },
      )
    })
    yield* Effect.forkScoped(Effect.repeat(check, Schedule.spaced(UPDATE_CHECK_EVERY)))
    return Ref.get(status)
  })

export const layer = Layer.effect(
  UpdateCheck,
  Effect.gen(function* () {
    if (Option.isSome(yield* Config.option(Config.String("VIBEST_NO_UPDATE_CHECK")))) return Effect.succeed(NOT_CHECKED)
    const method = installMethod(
      yield* VibestCommand,
      Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_HARNESSES"))),
    )
    if (!method) return Effect.succeed(NOT_CHECKED)
    return yield* checkEveryHour(latestOf(method))
  }).pipe(Effect.orDie),
)

export const node = LayerNode.make({ service: UpdateCheck, layer, deps: [PlatformNode.httpClient] })
