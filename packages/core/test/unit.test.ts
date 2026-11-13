import { assert, describe, it } from "@effect/vitest"
import { privateTmp, UserPlatform } from "@vibest/core/system-prompt"
import { Cause, Effect, Exit, FileSystem } from "effect"

import { tempDirectory } from "./lib/directory.ts"
import * as Platform from "./platform/bun.ts"

describe("System prompt directory", () => {
  const refused = <A, E, R>(e: Effect.Effect<A, E, R>) =>
    e.pipe(
      Effect.exit,
      Effect.map((exit) => {
        assert.isTrue(Exit.isFailure(exit))
        assert.match(String(Exit.isFailure(exit) && Cause.pretty(exit.cause)), /not a private directory/)
      }),
    )

  it.effect(
    "under TMPDIR: <TMPDIR>/vibest, made 0700; no TMPDIR: <parent>/vibest-<uid>, made 0700 and used again; a wrong mode, a symlink or another owner is refused",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* tempDirectory("vibest-tmpdir-")
        assert.strictEqual(yield* privateTmp(tmp, "/nowhere"), `${tmp}/vibest`)
        assert.strictEqual((yield* fs.stat(`${tmp}/vibest`)).mode & 0o777, 0o700)
        const user = yield* UserPlatform
        const uid = user.uid!
        const parent = yield* tempDirectory("vibest-fallback-")
        const dir = `${parent}/vibest-${uid}`
        assert.strictEqual(yield* privateTmp("", parent), dir)
        assert.strictEqual((yield* fs.stat(dir)).mode & 0o777, 0o700)
        assert.strictEqual(yield* privateTmp("", parent), dir, "an existing private directory is used again")

        yield* fs.chmod(dir, 0o755)
        yield* refused(privateTmp("", parent))

        yield* fs.remove(dir, { recursive: true })
        const target = `${parent}/elsewhere`
        yield* fs.makeDirectory(target, { mode: 0o700 })
        yield* fs.symlink(target, dir)
        yield* refused(privateTmp("", parent))

        yield* fs.remove(dir)
        const asAnotherUid = { ...user, uid: uid + 1 }
        yield* refused(privateTmp("", parent).pipe(Effect.provideService(UserPlatform, asAnotherUid)))
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
