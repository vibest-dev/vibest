import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { terminalOf } from "@vibest/core/database/db-rows"
import { Project } from "@vibest/core/project"
import {
  ACTIONS,
  formatUsage,
  type HerdrDaemon,
  type LiveSession,
  type PluginContext,
  type UsageWindow,
  VERBS,
  paletteMenu,
  parsePluginContext,
  perform,
  projectDirectory,
  type Verb,
} from "@vibest/runtime-herdr/commands"
import { Layout } from "@vibest/schema/layout"
import * as Server from "@vibest/server/server"
import { Effect, FileSystem, Layer } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { ARCHIVE_ROOTS, copyHerdrPlugin } from "../scripts/archive-layout.ts"
import { FakeRuntime, makeRepository, projectOf, runVibest, stopRecorded, tempDirectory, testLayer } from "./fakes.ts"

const ctx = (patch: Partial<PluginContext> = {}): PluginContext => ({
  workspaceId: undefined,
  workspaceCwd: undefined,
  focusedPaneId: undefined,
  focusedPaneCwd: undefined,
  focusedPaneAgent: undefined,
  ...patch,
})

const session = (patch: Partial<LiveSession> = {}): LiveSession => ({
  id: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
  agent: "general",
  harness: "pi",
  status: "working",
  paneId: "w1:p2",
  ...patch,
})

const fake = (over: Partial<HerdrDaemon> = {}): HerdrDaemon => ({
  republish: () => Effect.succeed(0),
  openEntry: () => Effect.succeed({ action: "focused", place: "w1:p1" }),
  spawn: () => Effect.succeed("abcd1234-abcd-4abc-8abc-abcd1234abcd"),
  interrupt: () => Effect.void,
  list: () => Effect.succeed([]),
  usage: () => Effect.succeed(undefined),
  ...over,
})

const shown = (verb: Verb, context: PluginContext, daemon: HerdrDaemon, lines: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const written: Array<string> = []
    let next = 0
    const result = yield* perform(
      verb,
      context,
      daemon,
      () => Effect.sync(() => lines[next++] ?? ""),
      (text) => Effect.sync(() => void written.push(text)),
    )
    return [...written, result].join("\n")
  })

const project = ctx({ focusedPaneId: "w1:p1", focusedPaneCwd: "/repo", workspaceCwd: "/plugin-directory" })

describe("subscription lines", () => {
  const window = (patch: Partial<UsageWindow>): UsageWindow => ({
    harness: "cursor",
    window: "monthly",
    percent: 100,
    status: "limited",
    resetTime: null,
    ...patch,
  })

  it("uses the start verdict and keeps a row error", () => {
    const passed = Date.now() - 1_000
    const future = Date.now() + 60_000
    assert.strictEqual(
      formatUsage([
        window({ resetTime: passed }),
        window({ window: "monthly-auto", resetTime: future }),
        window({ status: "available", resetTime: future, error: "GetHardLimit answered 500" }),
        window({ resetTime: future }),
      ]),
      [
        "cursor  monthly  100%  available",
        "cursor  monthly-auto  100%  available",
        "cursor  monthly  100%  available  GetHardLimit answered 500",
        "cursor  monthly  100%  limited",
      ].join("\n"),
    )
  })
})

describe("herdr plugin context", () => {
  it.effect("the project directory is the focused pane, never the workspace or the process", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({
        workspace_id: "w1",
        workspace_label: "shop",
        workspace_cwd: "/plugin-directory",
        tab_id: "w1:t1",
        focused_pane_id: "w1:p1",
        focused_pane_cwd: "/repo",
        focused_pane_status: "unknown",
        focused_pane_agent: "s-abcd1234abcd4abc8abcabcd1234ab",
        worktree: { root: "/repo", checkout_path: "/repo", linked: false },
        selected_text: null,
      })
      const parsed = yield* parsePluginContext(raw)
      assert.strictEqual(projectDirectory(parsed), "/repo")
      assert.strictEqual(parsed.focusedPaneId, "w1:p1")
      assert.strictEqual(parsed.focusedPaneAgent, "s-abcd1234abcd4abc8abcabcd1234ab")
      assert.notStrictEqual(projectDirectory(parsed), process.cwd())
    }),
  )

  it.effect("a missing focused pane cwd falls back to the workspace cwd; null is missing", () =>
    Effect.gen(function* () {
      const parsed = yield* parsePluginContext(
        JSON.stringify({ focused_pane_cwd: null, workspace_cwd: "/repo", focused_pane_id: "" }),
      )
      assert.strictEqual(projectDirectory(parsed), "/repo")
      assert.isUndefined(parsed.focusedPaneId)
    }),
  )

  it.effect("context that is not the documented object is refused", () =>
    Effect.gen(function* () {
      for (const raw of ["", "not json", "null", "[]", "42"]) {
        const error = yield* Effect.flip(parsePluginContext(raw))
        assert.strictEqual(error._tag, "BadPluginContext")
      }
    }),
  )
})

describe("herdr plugin commands", () => {
  it.effect("open-entry without a directory does not ask to open one", () =>
    Effect.gen(function* () {
      let called = false
      const error = yield* Effect.flip(
        shown(
          "open-entry",
          ctx(),
          fake({
            openEntry: () =>
              Effect.sync(() => {
                called = true
                return { action: "opened" as const, place: "x" }
              }),
          }),
        ),
      )
      assert.strictEqual(error._tag, "BadPluginContext")
      assert.isFalse(called)
    }),
  )

  it.effect("stop stops the session of the focused pane, or of the herdr agent name when the pane id moved", () =>
    Effect.gen(function* () {
      let removed = ""
      let listed: string | undefined = "unset"
      const text = yield* shown(
        "stop",
        ctx({ focusedPaneId: "w1:p2" }),
        fake({
          list: (directory) =>
            Effect.sync(() => {
              listed = directory
              return [session({ id: "aaaa1111-aaaa-4aaa-8aaa-aaaa1111aaaa", paneId: "w1:p1" }), session()]
            }),
          interrupt: (id) =>
            Effect.sync(() => {
              removed = id
            }),
        }),
      )
      assert.strictEqual(text, "stopped abcd1234")
      assert.strictEqual(removed, "abcd1234-abcd-4abc-8abc-abcd1234abcd")
      assert.isUndefined(listed)

      removed = ""
      const moved = yield* shown(
        "stop",
        ctx({ focusedPaneId: "w9:p9", focusedPaneAgent: "s-abcd1234abcd4abc8abcabcd1234ab" }),
        fake({
          list: () => Effect.succeed([session({ paneId: "w1:p2" })]),
          interrupt: (id) =>
            Effect.sync(() => {
              removed = id
            }),
        }),
      )
      assert.strictEqual(moved, "stopped abcd1234")
      assert.strictEqual(removed, "abcd1234-abcd-4abc-8abc-abcd1234abcd")
    }),
  )

  it.effect("stop with no session in the focused pane interrupts nothing", () =>
    Effect.gen(function* () {
      let removed = false
      const daemon = fake({
        list: () => Effect.succeed([session()]),
        interrupt: () =>
          Effect.sync(() => {
            removed = true
          }),
      })
      const missing = yield* Effect.flip(shown("stop", ctx({ focusedPaneId: "w9:p9" }), daemon))
      assert.strictEqual(missing._tag, "NoFocusedSession")
      assert.match(missing.message, /w9:p9/)
      const noPane = yield* Effect.flip(shown("stop", ctx(), daemon))
      assert.match(noPane.message, /no focused pane/)
      assert.isFalse(removed)
    }),
  )

  it.effect("palette prints a numbered menu and runs the chosen action in the context directory", () =>
    Effect.gen(function* () {
      let directory = ""
      const runs = yield* shown(
        "palette",
        project,
        fake({
          list: (dir) =>
            Effect.sync(() => {
              directory = dir ?? ""
              return [session()]
            }),
        }),
        ["4"],
      )
      assert.strictEqual(runs, `${paletteMenu()}\nabcd1234  general  pi  working  w1:p2`)
      assert.strictEqual(directory, "/repo")
      let prompt = ""
      const started = yield* shown(
        "palette",
        project,
        fake({
          spawn: (_dir, text) =>
            Effect.sync(() => {
              prompt = text
              return "abcd1234-abcd-4abc-8abc-abcd1234abcd"
            }),
        }),
        ["2", "fix the login bug"],
      )
      assert.strictEqual(started, `${paletteMenu()}\nPrompt:\nstarted abcd1234`)
      assert.strictEqual(prompt, "fix the login bug")
      assert.strictEqual(
        yield* shown("palette", project, fake(), ["9"]),
        `${paletteMenu()}\npick a number from 1 to ${ACTIONS.length}`,
      )
      assert.strictEqual(
        yield* shown("palette", project, fake(), ["startup"]),
        `${paletteMenu()}\npick a number from 1 to ${ACTIONS.length}`,
      )
    }),
  )
})

describe("herdr plugin package", () => {
  it("the release archive contains herdr-plugin/", () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-archive-"))
    try {
      fs.mkdirSync(path.join(stage, "bin"), { recursive: true })
      fs.writeFileSync(path.join(stage, "bin", "vibest"), "")
      fs.mkdirSync(path.join(stage, "harnesses"))
      copyHerdrPlugin(stage, path.join(import.meta.dirname, "../herdr-plugin"))
      const archive = path.join(stage, "vibest.tar.gz")
      childProcess.execFileSync("tar", ["-czf", archive, "-C", stage, ...ARCHIVE_ROOTS])
      const listed = childProcess.execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
      assert.match(listed, /^herdr-plugin\/herdr-plugin\.toml$/m)
      assert.match(listed, /^herdr-plugin\/bin\/vibest\.sh$/m)
      assert.match(listed, /^herdr-plugin\/README\.md$/m)
      const script = fs.readFileSync(path.join(import.meta.dirname, "../scripts/build-archive.ts"), "utf8")
      assert.match(script, /ARCHIVE_ROOTS/)
      assert.deepStrictEqual([...ARCHIVE_ROOTS], ["bin", "harnesses", "herdr-plugin"])
    } finally {
      fs.rmSync(stage, { recursive: true, force: true })
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
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer()),
)

describe("herdr open-entry", () => {
  it.effect(
    "refuses a project that never had an entry session, launches the last one's harness, and focuses a running one",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const db = yield* Db
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
        yield* db.startEntry(
          projectId,
          "pi",
          false,
          {
            runtime: "herdr",
            address: { machine: "local", id: "test/main" },
          },
          { agent: "coordinator" },
        )
        const stopped = yield* runVibest(repo, env, ["herdr", "open-entry"])
        assert.strictEqual(stopped.code, 0, stopped.stderr)
        assert.match(stopped.stdout, /^opened /)
        assert.ok((yield* herdr.callsTo("open")).length > 0)
        const entryId = terminalOf((yield* db.entryOf(projectId))!)!.id
        yield* herdr.seedAgent(entryId)
        const again = yield* runVibest(repo, env, ["herdr", "open-entry"])
        assert.strictEqual(again.code, 0, again.stderr)
        assert.match(again.stdout, /^focused /)
        assert.strictEqual((yield* herdr.callsTo("focus")).at(-1)?.terminal, entryId)
      }).pipe(Effect.provide(served)),
  )
})
