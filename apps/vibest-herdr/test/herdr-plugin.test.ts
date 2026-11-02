import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Platform from "#platform"
import { Effect, FileSystem } from "effect"
import { TestClock } from "effect/testing"
import { ARCHIVE_ROOTS, copyHerdrPlugin } from "../scripts/archive-layout.ts"
import {
  ACTIONS,
  type HerdrDaemon,
  type LiveSession,
  type PluginContext,
  VERBS,
  formatRuns,
  formatUsage,
  paletteMenu,
  parsePluginContext,
  perform,
  projectDirectory,
  type Verb,
} from "../src/herdr-plugin.ts"
import { runVibest, stopRecorded, tempDirectory } from "./fakes.ts"

const ctx = (patch: Partial<PluginContext> = {}): PluginContext => ({
  workspaceId: undefined,
  workspaceCwd: undefined,
  focusedPaneId: undefined,
  focusedPaneCwd: undefined,
  focusedPaneAgent: undefined,
  ...patch,
})

const session = (patch: Partial<LiveSession> = {}): LiveSession => ({
  id: "abcd1234",
  agent: "general",
  harness: "pi",
  status: "working",
  paneId: "w1:p2",
  ...patch,
})

const fake = (over: Partial<HerdrDaemon> = {}): HerdrDaemon => ({
  republish: () => Effect.succeed(0),
  openMain: () => Effect.succeed({ action: "focused", place: "w1:p1" }),
  spawn: () => Effect.succeed("abcd1234"),
  interrupt: () => Effect.void,
  list: () => Effect.succeed([]),
  usage: () => Effect.succeed(undefined),
  ...over,
})

/** What the popup shows: lines written before the read, then the command's result. */
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
        focused_pane_agent: "s-abcd1234",
        worktree: { root: "/repo", checkout_path: "/repo", linked: false },
        selected_text: null,
      })
      const parsed = yield* parsePluginContext(raw)
      assert.strictEqual(projectDirectory(parsed), "/repo")
      assert.strictEqual(parsed.focusedPaneId, "w1:p1")
      assert.strictEqual(parsed.focusedPaneAgent, "s-abcd1234")
      assert.notStrictEqual(projectDirectory(parsed), process.cwd())
    }),
  )

  it.effect("a missing focused pane cwd falls back to the workspace cwd; null is missing", () =>
    Effect.gen(function* () {
      const parsed = yield* parsePluginContext(JSON.stringify({ focused_pane_cwd: null, workspace_cwd: "/repo", focused_pane_id: "" }))
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
  it.effect("startup asks to republish and prints how many panes", () =>
    Effect.gen(function* () {
      let directory: string | undefined = "unset"
      const text = yield* shown("startup", project, fake({
        republish: (dir) => Effect.sync(() => {
          directory = dir
          return 2
        }),
      }))
      assert.strictEqual(text, "republished 2")
      assert.strictEqual(directory, "/repo")
    }),
  )

  it.effect("open-main focuses the main agent of the focused pane's directory", () =>
    Effect.gen(function* () {
      let directory = ""
      const text = yield* shown("open-main", project, fake({
        openMain: (dir) => Effect.sync(() => {
          directory = dir
          return { action: "focused" as const, place: "w1:p9" }
        }),
      }))
      assert.strictEqual(text, "focused w1:p9")
      assert.strictEqual(directory, "/repo")
    }),
  )

  it.effect("open-main uses the workspace directory when the focused pane has none", () =>
    Effect.gen(function* () {
      let directory = ""
      yield* shown("open-main", ctx({ workspaceCwd: "/repo", focusedPaneCwd: undefined }), fake({
        openMain: (dir) => Effect.sync(() => {
          directory = dir
          return { action: "opened" as const, place: "pane w1:p3 (herdr session vibest)" }
        }),
      }))
      assert.strictEqual(directory, "/repo")
    }),
  )

  it.effect("open-main without a directory does not ask to open one", () =>
    Effect.gen(function* () {
      let called = false
      const error = yield* Effect.flip(shown("open-main", ctx(), fake({
        openMain: () => Effect.sync(() => {
          called = true
          return { action: "opened" as const, place: "x" }
        }),
      })))
      assert.strictEqual(error._tag, "BadPluginContext")
      assert.isFalse(called)
    }),
  )

  it.effect("run reads the popup prompt and starts it in the context directory", () =>
    Effect.gen(function* () {
      let got: { readonly directory: string; readonly prompt: string } | undefined
      const text = yield* shown("run", project, fake({
        spawn: (directory, prompt) => Effect.sync(() => {
          got = { directory, prompt }
          return "abcd1234"
        }),
      }), ["fix the login bug"])
      assert.strictEqual(text, "Prompt:\nstarted abcd1234")
      assert.deepStrictEqual(got, { directory: "/repo", prompt: "fix the login bug" })
    }),
  )

  it.effect("run refuses an empty prompt and starts nothing", () =>
    Effect.gen(function* () {
      let called = false
      const error = yield* Effect.flip(shown("run", project, fake({
        spawn: () => Effect.sync(() => {
          called = true
          return "abcd1234"
        }),
      }), ["  "]))
      assert.strictEqual(error._tag, "EmptyInput")
      assert.isFalse(called)
    }),
  )

  it.effect("stop ignores the main agent in the focused pane", () =>
    Effect.gen(function* () {
      let called = false
      const error = yield* Effect.flip(shown("stop", ctx({ focusedPaneId: "w1:p1", focusedPaneAgent: "s-main0001" }), fake({
        list: () => Effect.succeed([
          session({ id: "main0001", agent: "main", paneId: "w1:p1" }),
          session({ id: "abcd1234", paneId: "w1:p9" }),
        ]),
        interrupt: () => Effect.sync(() => {
          called = true
        }),
      })))
      assert.strictEqual(error._tag, "NoFocusedSession")
      assert.isFalse(called)
    }),
  )

  it.effect("stop stops the session of the focused pane", () =>
    Effect.gen(function* () {
      let removed = ""
      let listed: string | undefined = "unset"
      const text = yield* shown("stop", ctx({ focusedPaneId: "w1:p2" }), fake({
        list: (directory) => Effect.sync(() => {
          listed = directory
          return [session({ id: "aaaa1111", paneId: "w1:p1" }), session()]
        }),
        interrupt: (id) => Effect.sync(() => {
          removed = id
        }),
      }))
      assert.strictEqual(text, "stopped abcd1234")
      assert.strictEqual(removed, "abcd1234")
      assert.isUndefined(listed)
    }),
  )

  it.effect("stop matches the herdr agent name when the pane id moved", () =>
    Effect.gen(function* () {
      let removed = ""
      const text = yield* shown("stop", ctx({ focusedPaneId: "w9:p9", focusedPaneAgent: "s-abcd1234" }), fake({
        list: () => Effect.succeed([session({ paneId: "w1:p2" })]),
        interrupt: (id) => Effect.sync(() => {
          removed = id
        }),
      }))
      assert.strictEqual(text, "stopped abcd1234")
      assert.strictEqual(removed, "abcd1234")
    }),
  )

  it.effect("stop with no session in the focused pane interrupts nothing", () =>
    Effect.gen(function* () {
      let removed = false
      const daemon = fake({
        list: () => Effect.succeed([session()]),
        interrupt: () => Effect.sync(() => {
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

  it.effect("runs prints live sessions for the context directory", () =>
    Effect.gen(function* () {
      let directory = ""
      const text = yield* shown("runs", project, fake({
        list: (dir) => Effect.sync(() => {
          directory = dir ?? ""
          return [session()]
        }),
      }))
      assert.strictEqual(text, "abcd1234  general  pi  working  w1:p2")
      assert.strictEqual(directory, "/repo")
      assert.notStrictEqual(directory, "/plugin-directory")
    }),
  )

  it.effect("runs with nothing live says so", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* shown("runs", project, fake()), "no live sessions")
    }),
  )

  it.effect("subscriptions prints usage when it is available, otherwise unknown", () =>
    Effect.gen(function* () {
      const known = yield* shown("subscriptions", ctx(), fake({
        usage: () => Effect.succeed([{ harness: "claude", window: "5h", percent: 40, status: "available" as const }]),
      }))
      assert.strictEqual(known, "claude  5h  40%  available")
      assert.strictEqual(yield* shown("subscriptions", ctx(), fake()), "unknown")
      assert.strictEqual(yield* shown("subscriptions", ctx(), fake({ usage: () => Effect.succeed([]) })), "unknown")
    }),
  )

  it.effect("palette prints a numbered menu and runs the chosen action in the context directory", () =>
    Effect.gen(function* () {
      let directory = ""
      const runs = yield* shown("palette", project, fake({
        list: (dir) => Effect.sync(() => {
          directory = dir ?? ""
          return [session()]
        }),
      }), ["4"])
      assert.strictEqual(runs, `${paletteMenu()}\nabcd1234  general  pi  working  w1:p2`)
      assert.strictEqual(directory, "/repo")
      let prompt = ""
      const started = yield* shown("palette", project, fake({
        spawn: (_dir, text) => Effect.sync(() => {
          prompt = text
          return "abcd1234"
        }),
      }), ["2", "fix the login bug"])
      assert.strictEqual(started, `${paletteMenu()}\nPrompt:\nstarted abcd1234`)
      assert.strictEqual(prompt, "fix the login bug")
      assert.strictEqual(yield* shown("palette", project, fake(), ["9"]), `${paletteMenu()}\npick a number from 1 to ${ACTIONS.length}`)
      assert.strictEqual(yield* shown("palette", project, fake(), ["startup"]), `${paletteMenu()}\npick a number from 1 to ${ACTIONS.length}`)
    }),
  )

  it("formatRuns prints the live sessions the daemon listed, the main agent included", () => {
    assert.strictEqual(
      formatRuns([session(), session({ id: "main0001", agent: "main" })]),
      "abcd1234  general  pi  working  w1:p2\nmain0001  main  pi  working  w1:p2",
    )
    assert.strictEqual(formatRuns([]), "no live sessions")
    assert.strictEqual(formatUsage(undefined), "unknown")
    assert.strictEqual(formatUsage([]), "unknown")
  })
})

describe("herdr plugin package", () => {
  it("the manifest only calls herdr verbs, or opens a pane that runs one", () => {
    const toml = fs.readFileSync(path.join(import.meta.dirname, "../herdr-plugin/herdr-plugin.toml"), "utf8")
    const commands = [...toml.matchAll(/command = \["sh", "bin\/vibest\.sh", "(herdr|pane)", "([^"]+)"\]/g)]
    assert.isAbove(commands.length, 0)
    for (const [, kind, name] of commands) {
      assert.include(VERBS, name)
      if (kind === "pane") assert.include(["run", "runs", "subscriptions", "palette"], name)
    }
    assert.notMatch(toml, /reschedule/)
    const files = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8")).files
    assert.include(files, "herdr-plugin")
  })

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

  it.effect("the vibest herdr group reads the context and does not start vibestd from the working directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* tempDirectory("herdr-plugin-")
      const cwd = `${home}/plugin`
      yield* fs.makeDirectory(cwd)
      const env = { HOME: home, VIBEST_HOME: `${home}/vibest` }
      // `subscriptions` starts a vibestd for this home: stopped however the test ends, or it outlives its temp home.
      yield* Effect.addFinalizer(() => TestClock.withLive(stopRecorded(`${home}/vibest/vibestd.pid`)))
      const missing = yield* runVibest(cwd, env, ["herdr", "startup"])
      assert.strictEqual(missing.code, 1, missing.stderr)
      assert.match(missing.stderr, /^BadPluginContext: /)
      assert.isFalse(yield* fs.exists(`${home}/vibest`))
      const context = JSON.stringify({ focused_pane_cwd: `${home}/project`, workspace_cwd: cwd, focused_pane_id: "w1:p1" })
      const usage = yield* runVibest(cwd, { ...env, HERDR_PLUGIN_CONTEXT_JSON: context }, ["herdr", "subscriptions"])
      assert.strictEqual(usage.code, 0, usage.stderr)
      assert.strictEqual(usage.stdout, "unknown\n")
      const picked = yield* runVibest(cwd, { ...env, HERDR_PLUGIN_CONTEXT_JSON: context }, ["herdr", "palette"], "5\n")
      assert.strictEqual(picked.code, 0, picked.stderr)
      assert.match(picked.stdout, /subscriptions  Subscription usage/)
      assert.strictEqual(picked.stdout.trim().split("\n").at(-1), "unknown")
      const empty = yield* runVibest(cwd, { ...env, HERDR_PLUGIN_CONTEXT_JSON: context }, ["herdr", "run"], "\n")
      assert.strictEqual(empty.code, 1, empty.stderr)
      assert.match(empty.stderr, /^EmptyInput: /)
      assert.match(empty.stdout, /^Prompt:/)
      const agent = yield* runVibest(cwd, { ...env, VIBEST_SESSION_ID: "abcd1234" }, ["herdr", "stop"])
      assert.strictEqual(agent.code, 1, agent.stderr)
      assert.match(agent.stderr, /^Forbidden: /)
      const help = yield* runVibest(cwd, env, ["herdr", "--help"])
      assert.strictEqual(help.code, 0, help.stderr)
      for (const name of VERBS) assert.match(help.stdout, new RegExp(`\\b${name}\\b`))
    }).pipe(Effect.provide(Platform.services)), 30_000)
})
