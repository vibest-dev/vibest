import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { terminalOf } from "@vibest/core/database/rows"
import { Project } from "@vibest/core/project"
import { SessionStore } from "@vibest/core/session/store"
import { VERBS } from "@vibest/runtime-herdr/commands"
import { Layout } from "@vibest/schema/layout"
import * as Server from "@vibest/server/server"
import {
  FakeRuntime,
  makeRepository,
  projectOf,
  runVibest,
  stopRecorded,
  tempDirectory,
  testLayer,
} from "@vibest/testkit/fakes"
import * as Platform from "@vibest/testkit/platform"
import { Effect, FileSystem, Layer } from "effect"
import { TestClock } from "effect/testing"

import { materializeAssets, packDirectoryArchive } from "../src/assets-archive.ts"

describe("herdr plugin package", () => {
  it("embedded assets pack and materialize herdr-plugin/ with executable mode and stable symlink", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-assets-"))
    const execSrc = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-exec-"))

    try {
      fs.writeFileSync(path.join(execSrc, "hook.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 })

      const archive = packDirectoryArchive([
        { prefix: "harnesses", dir: execSrc },
        { prefix: "herdr-plugin", dir: path.join(import.meta.dirname, "../herdr-plugin") },
      ])

      const materialized = materializeAssets(home, "1.2.3", archive)
      assert.isTrue(fs.existsSync(path.join(materialized.herdrPlugin, "herdr-plugin.toml")))
      assert.isTrue(fs.existsSync(path.join(materialized.herdrPlugin, "bin/vibest.sh")))
      assert.isTrue(fs.existsSync(path.join(materialized.herdrPlugin, "README.md")))
      assert.strictEqual(fs.statSync(path.join(materialized.harnesses, "hook.sh")).mode & 0o111, 0o111)
      assert.strictEqual(fs.readlinkSync(path.join(home, "herdr-plugin")), materialized.herdrPlugin)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(execSrc, { recursive: true, force: true })
    }
  })

  it.effect(
    "the vibest herdr group reads the context and does not start vibestd from the working directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* tempDirectory("herdr-plugin-")
        const cwd = `${home}/plugin`
        yield* fs.makeDirectory(cwd)
        const env = { HOME: home, VIBEST_HOME: `${home}/vibest` }
        yield* Effect.addFinalizer(() => TestClock.withLive(stopRecorded(`${home}/vibest/vibestd.pid`)))
        const missing = yield* runVibest(cwd, env, ["herdr", "startup"])
        assert.strictEqual(missing.code, 1, missing.stderr)
        assert.match(missing.stderr, /^BadPluginContext: /)
        assert.isFalse(yield* fs.exists(`${home}/vibest`))

        const context = JSON.stringify({
          focused_pane_cwd: `${home}/project`,
          workspace_cwd: cwd,
          focused_pane_id: "w1:p1",
        })

        const usage = yield* runVibest(cwd, { ...env, HERDR_PLUGIN_CONTEXT_JSON: context }, ["herdr", "subscriptions"])
        assert.strictEqual(usage.code, 0, usage.stderr)
        assert.strictEqual(usage.stdout, "unknown\n")

        const picked = yield* runVibest(
          cwd,
          { ...env, HERDR_PLUGIN_CONTEXT_JSON: context },
          ["herdr", "palette"],
          "5\n",
        )

        assert.strictEqual(picked.code, 0, picked.stderr)
        assert.match(picked.stdout, /subscriptions  Subscription usage/)
        assert.strictEqual(picked.stdout.trim().split("\n").at(-1), "unknown")
        const empty = yield* runVibest(cwd, { ...env, HERDR_PLUGIN_CONTEXT_JSON: context }, ["herdr", "run"], "\n")
        assert.strictEqual(empty.code, 1, empty.stderr)
        assert.match(empty.stderr, /^EmptyInput: /)
        assert.match(empty.stdout, /^Prompt:/)

        const agent = yield* runVibest(cwd, { ...env, VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" }, [
          "herdr",
          "stop",
        ])

        assert.strictEqual(agent.code, 1, agent.stderr)
        assert.match(agent.stderr, /^Forbidden: /)
        const help = yield* runVibest(cwd, env, ["herdr", "--help"])
        assert.strictEqual(help.code, 0, help.stderr)

        for (const name of VERBS) assert.match(help.stdout, new RegExp(`\\b${name}\\b`))
      }).pipe(Effect.provide(Platform.services)),
    30_000,
  )
})

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.httpServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer()),
)

describe("herdr open-entry", () => {
  it.effect(
    "refuses a project that never had an entry session, launches the last one's harness, and focuses it when running",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const sessionStore = yield* SessionStore.Service
        const herdr = yield* FakeRuntime
        const repo = yield* makeRepository

        const env = {
          HOME: layout.home,
          VIBEST_HOME: layout.home,
          HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: repo }),
        }

        const never = yield* runVibest(repo, env, ["herdr", "open-entry"])
        assert.notStrictEqual(never.code, 0)
        assert.match(never.stderr, /no harness to inherit/)
        assert.strictEqual((yield* herdr.callsTo("open")).length, 0)
        const projectId = yield* projectOf(repo)
        yield* sessionStore.startRoot(
          projectId,
          "pi",
          false,
          {
            runtime: "herdr",
            target: { id: "test/main" },
          },
          { agent: "coordinator" },
        )
        const stopped = yield* runVibest(repo, env, ["herdr", "open-entry"])
        assert.strictEqual(stopped.code, 0, stopped.stderr)
        assert.match(stopped.stdout, /^opened /)
        const opensBefore = (yield* herdr.callsTo("open")).length
        assert.ok(opensBefore > 0)
        const entryId = terminalOf((yield* sessionStore.latestRoot(projectId))!)!.target["id"]!
        yield* herdr.seedAgent(entryId)
        const again = yield* runVibest(repo, env, ["herdr", "open-entry"])
        assert.strictEqual(again.code, 0, again.stderr)
        assert.match(again.stdout, /^focused /)
        assert.strictEqual((yield* herdr.callsTo("open")).length, opensBefore)
        assert.strictEqual((yield* herdr.callsTo("focus")).length, 1)
      }).pipe(Effect.provide(served)),
  )
})
