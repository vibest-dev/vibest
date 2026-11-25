import { channelOf, installMethod, latestOf } from "@vibest/client/release"
import { NOT_CHECKED } from "@vibest/protocol/rpc"
import { VibestCommand } from "@vibest/schema/layout"
import { Clock, Config, Duration, Effect, Exit, FileSystem, Option, Ref, Schedule } from "effect"

import { VERSION } from "./version.ts"

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

export const updater = Effect.gen(function* () {
  if (Option.isSome(yield* Config.option(Config.String("VIBEST_NO_UPDATE_CHECK")))) return Effect.succeed(NOT_CHECKED)

  const self = yield* VibestCommand
  const fs = yield* FileSystem.FileSystem
  const real = self.length === 1 ? yield* fs.realPath(self[0]!).pipe(Effect.orElseSucceed(() => self[0]!)) : undefined
  const method = installMethod(self, real)

  if (!method) return Effect.succeed(NOT_CHECKED)

  return yield* checkEveryHour(Effect.map(latestOf(method, channelOf(VERSION)), (found) => found.version))
}).pipe(Effect.orDie)
