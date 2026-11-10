import { assert, layer } from "@effect/vitest"
import { spawnDaemon } from "@vibest/client/client"
import { Layout } from "@vibest/core/paths"
import { Effect, FileSystem } from "effect"

import * as Platform from "#platform"

import { tempDirectory, until } from "./fakes.ts"

layer(Platform.services)("spawnDaemon: the shell that starts vibestd in the background", (it) => {
  it.effect("a VIBEST_HOME with quotes, dollar signs and backticks gets vibestd's output in its own vibestd.log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = `${yield* tempDirectory("vibest-home-")}/a "b" $c \`d\` 'e'`
      const layout = yield* Layout.make(home)
      yield* spawnDaemon(["sh", "-c", 'echo "started $*"', "vibest"]).pipe(Effect.provideService(Layout, layout))
      const log = yield* until(fs.readFileString(`${home}/vibestd.log`).pipe(Effect.orElseSucceed(() => "")), (text) =>
        text.includes("started"),
      )
      assert.strictEqual(log.trim(), "started daemon --foreground")
    }),
  )

  it.effect("a VIBEST_HOME that cannot be made fails with the shell's own words", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = `${yield* tempDirectory("vibest-home-")}/a-file`
      yield* fs.writeFileString(file, "")
      const layout = yield* Layout.make(`${file}/home`)
      const failed = yield* Effect.flip(spawnDaemon(["true"]).pipe(Effect.provideService(Layout, layout)))
      assert.strictEqual(failed._tag, "DaemonUnavailable")
      assert.match(failed.message, /^vibestd was not started \(exit 1\): mkdir:.*Not a directory/)
    }),
  )
})
