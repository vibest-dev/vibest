import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { makeRepository, projectOf, runVibest, testLayer } from "@vibest/platform-bun/test/lib/fakes"
import { Plugin } from "@vibest/plugin/effect"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Layout } from "@vibest/schema/layout"
import * as Server from "@vibest/server/server"
import { Effect, FileSystem, Layer, Path } from "effect"

import * as Platform from "#platform"

import { FILE_CAP } from "../src/input.ts"

interface Seen {
  prompt: string
  files: ReadonlyArray<string>
}

const seen: Seen = { prompt: "", files: [] }

const capture = Plugin.define({
  id: "see-prompt",
  effect: (ctx) =>
    ctx.session.hook("start.before", (event) =>
      Effect.sync(() => {
        seen.prompt = event.prompt
        seen.files = event.files
      }),
    ),
})

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
  Layer.provideMerge(testLayer({ plugins: [capture] })),
)

const agentEnv = (home: string, sessionId: string, projectId: string) => ({
  HOME: home,
  VIBEST_HOME: home,
  VIBEST_AGENT: "coordinator",
  VIBEST_SESSION_ID: sessionId,
  VIBEST_PROJECT_ID: projectId,
})

describe("vibest run --file", () => {
  it.effect(
    "each --file is copied into the session's files folder, two of one name both kept, and the task ends with one line naming the copies",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const db = yield* Db.Service
        const layout = yield* Layout
        const repo = yield* makeRepository
        const task = path.join(repo, "task.md")
        const other = path.join(repo, "other", "task.md")
        const binary = path.join(repo, "data.bin")
        yield* fs.makeDirectory(path.dirname(other))
        yield* fs.writeFileString(task, "first\n")
        yield* fs.writeFileString(other, "second\n")
        yield* fs.writeFile(binary, new Uint8Array([0x68, 0x00, 0xff]))

        const entry = yield* db.session.startRoot(
          yield* projectOf(repo),
          "pi",
          false,
          { runtime: RUNTIME, target: { id: "test/coord" } },
          { agent: "coordinator" },
        )

        const env = agentEnv(layout.home, entry.sessionId, String(entry.projectId))

        const spawned = yield* runVibest(repo, env, [
          "run",
          "--runtime",
          "herdr",
          "--file",
          task,
          "--file",
          other,
          "--file",
          binary,
          "--",
          "do the task",
        ])

        assert.strictEqual(spawned.code, 0, spawned.stderr)
        const { id } = JSON.parse(spawned.stdout) as { id: string }
        const folder = path.join(layout.sessionFolder(String(entry.projectId), id), "files")
        const copies = ["task.md", "task-2.md", "data.bin"].map((name) => path.join(folder, name))
        assert.deepStrictEqual(seen.files, copies)
        assert.strictEqual(seen.prompt, `do the task\n\nAttached files: ${copies.join(", ")}`)
        assert.strictEqual(yield* fs.readFileString(copies[0]!), "first\n")
        assert.strictEqual(yield* fs.readFileString(copies[1]!), "second\n")
        assert.deepStrictEqual([...(yield* fs.readFile(copies[2]!))], [0x68, 0x00, 0xff])
      }).pipe(Effect.provide(served)),
    30_000,
  )

  it.effect(
    "a file over 10 MiB, a missing file or a directory refuses the run",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-run-file-" })
        const home = path.join(dir, "home")
        yield* fs.makeDirectory(home)

        const env = {
          HOME: home,
          VIBEST_HOME: home,
          VIBEST_AGENT: "general",
          VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
        }

        const run = (args: ReadonlyArray<string>) => runVibest(dir, env, ["run", ...args, "--", "task"])
        const missing = yield* run(["--file", path.join(dir, "missing.md")])
        assert.strictEqual(missing.code, 1)
        assert.match(missing.stderr, /^FileInput: cannot read --file /)
        const folder = yield* run(["--file", dir])
        assert.strictEqual(folder.code, 1)
        assert.match(folder.stderr, /^FileInput: --file .* is not a regular file/)
        const big = path.join(dir, "big.txt")
        yield* fs.writeFile(big, new Uint8Array(FILE_CAP + 1))
        const over = yield* run(["--file", big])
        assert.strictEqual(over.code, 1)
        assert.match(over.stderr, /^FileInput: --file .* is larger than 10 MiB/)
      }).pipe(Effect.provide(Platform.services)),
    30_000,
  )
})
