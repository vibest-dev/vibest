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

const seen = { prompt: "" }

const capture = Plugin.define({
  id: "see-prompt",
  effect: (ctx) =>
    ctx.agent.hook("start.before", (event) =>
      Effect.sync(() => {
        seen.prompt = event.prompt
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
    "--file content reaches agent.start.before.prompt whole, a UTF-8 BOM dropped, including a prompt from stdin; a path only in the prompt is not read",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const db = yield* Db.Service
        const layout = yield* Layout
        const repo = yield* makeRepository
        const task = path.join(repo, "task.md")
        const notes = path.join(repo, "notes.txt")
        const secret = path.join(repo, "secret.txt")
        const taskBody = "line one\nline two with 'quotes' and $HOME\n"
        yield* fs.writeFileString(task, taskBody)
        yield* fs.writeFileString(notes, "\uFEFFsecond file\n")
        yield* fs.writeFileString(secret, "do not read this\n")
        const entry = yield* db.session.startEntry(
          yield* projectOf(repo),
          "pi",
          false,
          { runtime: RUNTIME, address: { machine: "local", id: "test/coord" } },
          { agent: "coordinator" },
        )
        const env = agentEnv(layout.home, entry.sessionId, String(entry.projectId))
        const run = (args: ReadonlyArray<string>, stdin = "") => runVibest(repo, env, [...args], stdin)
        const spawned = yield* run(["run", "--runtime", "herdr", "--file", task, "--file", notes, "--", "do the task"])
        assert.strictEqual(spawned.code, 0, spawned.stderr)
        assert.strictEqual(
          seen.prompt,
          `do the task\n\nFile: ${task}\n\n${taskBody}\n\nFile: ${notes}\n\nsecond file\n`,
        )
        const piped = yield* run(["run", "--runtime", "herdr", "--file", task, "--", "-"], "from stdin\n")
        assert.strictEqual(piped.code, 0, piped.stderr)
        assert.strictEqual(seen.prompt, `from stdin\n\nFile: ${task}\n\n${taskBody}`)
        const named = yield* run(["run", "--runtime", "herdr", "--", `read ${secret}`])
        assert.strictEqual(named.code, 0, named.stderr)
        assert.strictEqual(seen.prompt, `read ${secret}`)
        assert.notInclude(seen.prompt, "do not read this")
      }).pipe(Effect.provide(served)),
    30_000,
  )

  it.effect(
    "a file over 10 MiB, a missing file, a directory, or a file that is not text refuses the run",
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
        assert.match(folder.stderr, /^FileInput: --file .* is not a text file/)
        const binary = path.join(dir, "binary.bin")
        yield* fs.writeFile(binary, new Uint8Array([0x68, 0x00, 0x69]))
        const notText = yield* run(["--file", binary])
        assert.strictEqual(notText.code, 1)
        assert.match(notText.stderr, /^FileInput: --file .* is not text/)
        const big = path.join(dir, "big.txt")
        yield* fs.writeFile(big, new Uint8Array(FILE_CAP + 1))
        const over = yield* run(["--file", big])
        assert.strictEqual(over.code, 1)
        assert.match(over.stderr, /^FileInput: --file .* is larger than 10 MiB/)
      }).pipe(Effect.provide(Platform.services)),
    30_000,
  )
})
