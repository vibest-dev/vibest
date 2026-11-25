import { assert, describe, it } from "@effect/vitest"
import {
  ACTIONS,
  formatUsage,
  type HerdrDaemon,
  type LiveSession,
  type PluginContext,
  type UsageWindow,
  paletteMenu,
  parsePluginContext,
  perform,
  projectDirectory,
  type Verb,
} from "@vibest/runtime-herdr/commands"
import { Effect } from "effect"

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
