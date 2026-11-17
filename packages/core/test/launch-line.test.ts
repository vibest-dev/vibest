import { assert, describe, it } from "@effect/vitest"
import { launchLine } from "@vibest/core/launch"
import { Effect, FileSystem, Path } from "effect"

import { tempDirectory } from "./lib/directory.ts"
import * as Platform from "./platform/bun.ts"

describe("launchLine", () => {
  it.effect("run through sh yields exactly launch.argv, including newlines, quotes and $", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* tempDirectory("vibest-launch-line-")
      const script = path.join(dir, "argv.py")
      yield* fs.writeFileString(script, "#!/usr/bin/env python3\nimport json, sys\nprint(json.dumps(sys.argv))\n")
      yield* fs.chmod(script, 0o755)
      const message = "line1\nline2 with 'quotes' and $HOME and \"double\""
      const id = "abcd1234-abcd-4abc-8abc-abcd1234abcd"

      const launch = {
        harness: "test",
        argv: [script, "--", message],
        prompt: message,
        env: { VIBEST_SESSION_ID: id, VIBEST_PROCESS: "4", VIBEST_HOME: dir },
      }

      const line = yield* launchLine(launch)
      assert.strictEqual(line[0], "env")
      assert.ok(line.includes("VIBEST_PROCESS=4"))
      assert.isFalse("systemPromptFile" in launch)
      const child = Bun.spawn(line, { stdout: "pipe", stderr: "pipe" })

      const [stdout, stderr, code] = yield* Effect.all(
        [
          Effect.promise(() => new Response(child.stdout).text()),
          Effect.promise(() => new Response(child.stderr).text()),
          Effect.promise(() => child.exited),
        ],
        { concurrency: 3 },
      )

      assert.strictEqual(code, 0, stderr)
      assert.deepStrictEqual(JSON.parse(stdout), launch.argv)
    }).pipe(Effect.provide(Platform.services)),
  )
})
