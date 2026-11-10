import { assert, describe, it } from "@effect/vitest"
import { SocketConnector } from "@vibest/client/client"
import { Layout } from "@vibest/core/paths"
import { HANDOFF_TIMEOUT, type Host, run } from "@vibest/server/daemon"
import { Cause, Crypto, Duration, Effect, Exit, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

import { tempDirectory } from "./fakes.ts"

describe("vibestd handoff wait", () => {
  it.live(
    "a handoff that never gets the lock reports the handoff wait, not the ordinary start wait",
    () =>
      Effect.gen(function* () {
        const deps = yield* Effect.gen(function* () {
          const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
          return {
            layout,
            fs: yield* FileSystem.FileSystem,
            path: yield* Path.Path,
            crypto: yield* Crypto.Crypto,
            spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            sockets: yield* SocketConnector,
          }
        }).pipe(Effect.provide(Platform.services))
        const held: Host = { ...Platform.daemon, lock: () => Effect.succeed(undefined) }
        const exit = yield* run(held, Platform.replacements, { handoff: true }).pipe(
          Effect.provideService(Layout, deps.layout),
          Effect.provideService(FileSystem.FileSystem, deps.fs),
          Effect.provideService(Path.Path, deps.path),
          Effect.provideService(Crypto.Crypto, deps.crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.spawner),
          Effect.provideService(SocketConnector, deps.sockets),
          Effect.exit,
        )
        assert.isTrue(Exit.isFailure(exit))
        if (Exit.isFailure(exit)) {
          const message = Cause.pretty(exit.cause)
          assert.include(message, `for ${Duration.format(HANDOFF_TIMEOUT)}`)
          assert.notInclude(message, "for 10s")
        }
      }).pipe(Effect.scoped),
    45_000,
  )
})
