// The herdr terminal runtime against a temporary headless session. Skipped when `herdr` is not on PATH.
import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, assert, describe, it } from "@effect/vitest"
import * as Platform from "#platform"
import { ConfigProvider, Effect, Exit, Layer, Option, Ref, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { FileSystem } from "effect"
import { HerdrPool } from "@vibest/runtime-herdr/pool"
import * as TerminalRuntime from "@vibest/runtime-herdr/terminal-runtime"
import { fromPool } from "@vibest/runtime-herdr/terminal-runtime"
import { callerLocation } from "@vibest/runtime-herdr/caller"
import { rewrite } from "../src/legacy-terminal-ids.ts"
import { runtimeContract } from "@vibest/plugin/testing"

const herdrOnPath = childProcess.spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0
const piOnPath = childProcess.spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0

/** This process may be inside a herdr pane. A child must not inherit that socket or session. */
const herdrChildEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("HERDR_") && !key.startsWith("VIBEST_")) env[key] = value
  }
  return env
}

const sessionName = /^vbt-[0-9a-f]{8}$/
const started = new Set<string>()
const children = new Map<string, ReturnType<typeof childProcess.spawn>>()

type ListedSession = { name?: string; running?: boolean; socket_path?: string }

const readSessions = (): ReadonlyArray<ListedSession> | undefined => {
  const listed = childProcess.spawnSync("herdr", ["session", "list", "--json"], { env: herdrChildEnv(), encoding: "utf8" })
  if (listed.status !== 0 || !listed.stdout) return undefined
  try {
    const json = JSON.parse(listed.stdout) as { sessions?: Array<ListedSession> }
    return json.sessions ?? []
  } catch {
    return undefined
  }
}

/** Pid of a detached server that has not exited. `> 1` so the group signal cannot be `-1`. */
const livePid = (child: ReturnType<typeof childProcess.spawn> | undefined) => {
  const pid = child?.pid
  return child?.exitCode === null && child?.signalCode === null && pid !== undefined && pid > 1 ? pid : undefined
}

/** Stop, kill this server's process group if it is still alive, delete, and retry until `session list` drops the name. */
const stopSession = async (name: string) => {
  if (!sessionName.test(name)) return
  const env = herdrChildEnv()
  const child = children.get(name)
  const deadline = Date.now() + 5_000
  for (;;) {
    childProcess.spawnSync("herdr", ["session", "stop", name], { env, stdio: "ignore", timeout: 2_000 })
    const pid = livePid(child)
    if (pid !== undefined) {
      try {
        // Detached: this pid is the process group. Negative signals only that group.
        process.kill(-pid, "SIGKILL")
      } catch {
        // already exited
      }
    }
    childProcess.spawnSync("herdr", ["session", "delete", name], { env, stdio: "ignore", timeout: 2_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const sessions = readSessions()
    if (sessions !== undefined && !sessions.some((session) => session.name === name) && livePid(child) === undefined) {
      started.delete(name)
      children.delete(name)
      return
    }
    if (Date.now() >= deadline) return
  }
}

const socketOf = (name: string) => {
  const found = readSessions()?.find((session) => session.name === name && session.running && session.socket_path)
  return found?.socket_path !== undefined && fs.existsSync(found.socket_path) ? found.socket_path : undefined
}

const layer = HerdrPool.layer.pipe(Layer.provideMerge(Platform.services))

const waitFor = <A, E, R>(read: Effect.Effect<A, E, R>, ready: (value: A) => boolean, label: string, attempts = 200) =>
  Effect.gen(function* () {
    let last = ""
    // A real herdr session under a loaded full-suite run needs more than 5 s to run a typed command.
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = yield* read
      if (ready(value)) return value
      last = JSON.stringify(value)
      yield* Effect.sleep("100 millis")
    }
    return yield* Effect.die(new Error(`${label}: ${last}`))
  })

/** `herdr --session <name> server`, headless. Stopped and deleted when the test scope closes. */
const withSession = <A, E, R>(use: (session: { readonly name: string; readonly socketPath: string }) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const name = `vbt-${crypto.randomBytes(4).toString("hex")}`
    started.add(name)
    const child = childProcess.spawn("herdr", ["--session", name, "server"], { env: herdrChildEnv(), detached: true, stdio: "ignore" })
    child.unref()
    children.set(name, child)
    yield* Effect.addFinalizer(() => Effect.promise(() => stopSession(name)))
    let socketPath: string | undefined
    for (let attempt = 0; attempt < 50 && socketPath === undefined; attempt++) {
      socketPath = socketOf(name)
      if (socketPath === undefined) yield* Effect.sleep("200 millis")
    }
    if (socketPath === undefined) return yield* Effect.die(new Error(`herdr session ${name} did not come up`))
    return yield* use({ name, socketPath })
  })

/** The terminal runtime on the pool, in this test's scope. */
const withRuntime = <A, E, R>(use: (runtime: TerminalRuntime.Runtime) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const runtime = yield* fromPool({
      pool: yield* HerdrPool,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      fs: yield* FileSystem.FileSystem,
      scope: yield* Effect.scope,
    })
    return yield* use(runtime)
  })

describe("terminal ids", () => {
  it("a terminal is `<session>/<pane>[/<name>]`, the parts non-empty; the caller's location is the machine target", () => {
    const terminal = TerminalRuntime.terminalOf("s1", "w1:p1")
    assert.deepStrictEqual(terminal, { machine: "local", id: "s1/w1:p1" })
    assert.deepStrictEqual(TerminalRuntime.parseTerminal(terminal), { session: "s1", paneId: "w1:p1", name: undefined })
    // The agent name `open` gave the pane rides in the id, so a pane id herdr reused is not the earlier terminal.
    assert.deepStrictEqual(TerminalRuntime.parseTerminal(TerminalRuntime.terminalOf("s1", "w1:p1", "vbt-w1:p1-ab12cd34")), { session: "s1", paneId: "w1:p1", name: "vbt-w1:p1-ab12cd34" })
    assert.isUndefined(TerminalRuntime.parseTerminal({ machine: "local", id: "/p" }))
    assert.isUndefined(TerminalRuntime.parseTerminal({ machine: "local", id: "s/" }))
    assert.isUndefined(TerminalRuntime.parseTerminal({ machine: "local", id: "pane" }))
    assert.isUndefined(TerminalRuntime.parseTerminal({ machine: "local", id: "s/p/" }))
    assert.deepStrictEqual(TerminalRuntime.decodeTarget(TerminalRuntime.encodeTarget({ session: "other" })), { session: "other" })
    assert.deepStrictEqual(TerminalRuntime.decodeTarget(TerminalRuntime.encodeTarget({ socketPath: "/h/s.sock" })), { socketPath: "/h/s.sock" })
    assert.isUndefined(TerminalRuntime.decodeTarget("{}"))
    assert.isUndefined(TerminalRuntime.decodeTarget(undefined))
  })

  it("the pre-port migration keeps the agent name those builds gave the row: `s-<id>` rides in the id", () => {
    assert.strictEqual(rewrite('{"type":"herdr","session":"work","pane":"w1:p2"}', "ab12"), '{"kind":"herdr","machine":"local","id":"work/w1:p2/s-ab12"}')
    // A row without a pane is core's "no terminal"; anything else is left alone.
    assert.strictEqual(rewrite('{"type":"herdr","session":"work"}', "ab12"), '{"kind":"herdr","machine":"local","id":""}')
    assert.isUndefined(rewrite('{"kind":"herdr","machine":"local","id":"work/w1:p2/s-ab12"}', "ab12"))
    assert.isUndefined(rewrite("not json", "ab12"))
  })
})

describe("callerLocation", () => {
  const env = (values: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromUnknown(values))

  it.effect("an explicit session name wins over the ambient herdr socket; without one the socket, else vibest", () =>
    Effect.gen(function* () {
      const ambient = env({ HERDR_SOCKET_PATH: "/h/ambient.sock" })
      const bare = env({})
      // Inside herdr with --session: the named session, not the ambient socket (Finding 1).
      assert.deepStrictEqual(yield* callerLocation("other").pipe(Effect.provide(ambient)), { session: "other" })
      // Inside herdr without --session: the ambient socket, as before.
      assert.deepStrictEqual(yield* callerLocation().pipe(Effect.provide(ambient)), { socketPath: "/h/ambient.sock" })
      // Outside herdr: the default session, or the named one.
      assert.deepStrictEqual(yield* callerLocation().pipe(Effect.provide(bare)), { session: "vibest" })
      assert.deepStrictEqual(yield* callerLocation("mine").pipe(Effect.provide(bare)), { session: "mine" })
    }))
})

/** `git` in `cwd`, failing the test when it does not run. */
const git = (cwd: string | undefined, ...args: string[]) => {
  const run = childProcess.spawnSync("git", args, { cwd, encoding: "utf8", env: herdrChildEnv() })
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${(run.stderr ?? run.stdout ?? "").trim()}`)
  return (run.stdout ?? "").trim()
}

describe.skipIf(!herdrOnPath)("runtime-herdr", () => {
  afterAll(async () => {
    for (const name of started) await stopSession(name)
  })

  it.live("the terminal runtime passes the shared contract suite (runtime-port.md §3)", () =>
    withSession(({ socketPath }) =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          const cwd = fs.realpathSync(os.tmpdir())
          yield* runtimeContract(runtime, { cwd, timeout: "20 seconds" }).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_SOCKET_PATH: socketPath }))),
          )
        }),
      ),
    ).pipe(Effect.provide(layer)), 120_000)

  it.live("open types argv into the pane's shell, and read, send, process, present and close land on herdr", () =>
    withSession(({ name, socketPath }) =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          const cwd = fs.realpathSync(os.tmpdir())
          const env = { HERDR_SOCKET_PATH: socketPath }
          // An interactive shell: `open` types `exec <argv>`, so a program that ends closes its pane; a shell stays.
          const opened = yield* runtime.open({ id: "local" }, {
            project: cwd,
            cwd,
            argv: ["/bin/sh"],
            env: {},
            label: "vibest test",
          }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
          const seen = TerminalRuntime.parseTerminal(opened)
          assert.isDefined(seen)
          assert.strictEqual(seen!.session, name)
          // The typed shell runs: what `send` types into it shows in `read`.
          yield* runtime.send(opened, { text: "printf 'VBT_%s\\n' OPENED", keys: ["enter"] })
          const text = yield* waitFor(runtime.read(opened, 40), (value) => value.includes("VBT_OPENED"), "pane text")
          assert.include(text, "VBT_OPENED")
          // No agent of this terminal runs in the pane (open started none): state names no agent there - not_found.
          if (runtime.state !== undefined) {
            const failed = yield* runtime.state(opened).pipe(Effect.flip, Effect.option)
            assert.isTrue(Option.isSome(failed) && Option.getOrThrow(failed).code === "not_found")
          }
          // Something is in the foreground only while it runs.
          yield* runtime.send(opened, { text: "sleep 2", keys: ["enter"] })
          yield* waitFor(runtime.process(opened), (p) => p.running, "foreground program")
          yield* runtime.send(opened, { keys: ["enter"] })
          yield* waitFor(runtime.process(opened), (p) => !p.running, "shell again")
          // Pane tokens: the vibest labels herdr shows on the pane.
          if (runtime.present !== undefined) yield* runtime.present(opened, { agent: "general", harness: "pi", title: "task", definition: "general", session: "abcd1234", project: "repo", live: "2" })
          const herdr = yield* (yield* HerdrPool).client(name)
          const pane = (yield* herdr.call("pane.get", { pane_id: seen!.paneId })).pane
          // `agent · harness`, each part and the join cut to herdr's 80-char token limit.
          assert.strictEqual(pane.display_agent, "general \u00b7 pi")
          assert.strictEqual(pane.title, "task")
          assert.strictEqual(pane.tokens?.definition, "general")
          assert.strictEqual(pane.tokens?.session, "abcd1234")
          assert.strictEqual(pane.state_labels?.blocked, "waiting for you")
          const workspace = (yield* herdr.call("workspace.list", {})).workspaces.find((item) => item.workspace_id === pane.workspace_id)
          assert.strictEqual(workspace?.tokens?.project, "repo")
          assert.strictEqual(workspace?.tokens?.agents, "2")
          // Each label is cut to herdr's 80-char token limit, the joined display_agent with them.
          if (runtime.present !== undefined) {
            yield* runtime.present(opened, { agent: "g".repeat(90), harness: "pi", title: "n".repeat(90), definition: "g".repeat(90) })
            const limited = (yield* herdr.call("pane.get", { pane_id: seen!.paneId })).pane
            assert.strictEqual(limited.display_agent?.length, 80)
            assert.strictEqual(limited.title?.length, 80)
            assert.strictEqual(limited.tokens?.definition?.length, 80)
            // Two presents back to back both land: herdr drops a report whose seq is not newer, so the seq must increase.
            yield* runtime.present(opened, { agent: "reviewer", harness: "pi", title: "later" })
            const again = (yield* herdr.call("pane.get", { pane_id: seen!.paneId })).pane
            assert.strictEqual(again.display_agent, "reviewer \u00b7 pi")
            assert.strictEqual(again.title, "later")
          }
          // `near` places the terminal in that pane's workspace: same workspace, no new one, a labelled unfocused tab.
          const before = (yield* herdr.call("workspace.list", {})).workspaces.map((item) => item.workspace_id)
          const beside = yield* runtime.open({ id: "local" }, {
            project: cwd,
            cwd,
            argv: ["/bin/sh"],
            env: { VBT_NEAR: "1" },
            label: "beside",
            near: opened,
          }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
          const besidePane = (yield* herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(beside)!.paneId })).pane
          assert.strictEqual(besidePane.workspace_id, pane.workspace_id)
          assert.deepStrictEqual((yield* herdr.call("workspace.list", {})).workspaces.map((item) => item.workspace_id), before)
          const tab = (yield* herdr.call("tab.list", { workspace_id: besidePane.workspace_id })).tabs.find((item) => item.tab_id === besidePane.tab_id)
          assert.strictEqual(tab?.label, "beside")
          assert.strictEqual(tab?.focused, false)
          yield* runtime.close(beside).pipe(Effect.ignore)
          // The same project without `near` still reuses the group's workspace (a pane at the directory names it).
          const grouped = yield* runtime.open({ id: "local" }, {
            project: cwd,
            cwd,
            argv: ["/bin/sh"],
            env: {},
            label: "grouped",
          }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
          const groupedPane = (yield* herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(grouped)!.paneId })).pane
          assert.strictEqual(groupedPane.workspace_id, pane.workspace_id)
          yield* runtime.close(grouped).pipe(Effect.ignore)
        }),
      ),
    ).pipe(Effect.provide(layer)), 90_000)

  it.live("a program that ends is an exited event with no close; a closed pane is one too; a pane without an agent takes pane.send_text as send", () =>
    withSession(({ socketPath }) =>
      withRuntime((runtime) => {
        const env = { HERDR_SOCKET_PATH: socketPath }
        return Effect.gen(function* () {
          const log = yield* Ref.make<ReadonlyArray<TerminalRuntime.RuntimeEvent>>([])
          yield* (runtime.events ?? Stream.empty).pipe(Stream.runForEach((event) => Ref.update(log, (events) => [...events, event])), Effect.forkScoped)
          // `open` types `exec printf x`: the program ends on its own, herdr closes the pane, no close was called.
          const ended = yield* runtime.open({ id: "local" }, {
            project: os.tmpdir(),
            cwd: os.tmpdir(),
            argv: ["printf", "x"],
            env: {},
            label: "events",
          }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
          yield* waitFor(Ref.get(log), (events) => events.some((event) => event.type === "exited" && event.terminal.id === ended.id), "exited event")
          // The pane went with its program: `process` names no such terminal any more.
          yield* waitFor(runtime.process(ended).pipe(Effect.flip, Effect.option), (found) => Option.isSome(found) && found.value.code === "not_found", "pane gone")
          // A shell pane, driven by `send` (no agent in it, so the runtime types into the pane), closed by `close`.
          const opened = yield* runtime.open({ id: "local" }, {
            project: os.tmpdir(),
            cwd: os.tmpdir(),
            argv: ["/bin/sh"],
            env: {},
            label: "shell",
          }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
          yield* runtime.send(opened, { text: "printf 'VBT_SEND\\n'", keys: ["enter"] })
          yield* waitFor(runtime.read(opened, 20), (value) => value.includes("VBT_SEND"), "typed text ran")
          yield* runtime.close(opened)
          yield* waitFor(Ref.get(log), (events) => events.some((event) => event.type === "exited" && event.terminal.id === opened.id), "closed event")
        })
      }),
    ).pipe(Effect.provide(layer)), 60_000)

  // How the main agent runs in place: a harness a shell ran, herdr detected it, and no `open` named it.
  it.live.skipIf(!piOnPath)("an agent herdr detected in a pane is still ours: state reads it, and send submits (Enter included)", () =>
    withSession(({ name }) =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          const herdr = yield* (yield* HerdrPool).client(name)
          const cwd = fs.realpathSync(os.tmpdir())
          // A pane of its own, its shell running pi by hand; not focused, as when the user is on another tab.
          const made = yield* herdr.call("workspace.create", { cwd, label: "detected", focus: false })
          const paneId = made.root_pane.pane_id
          yield* Effect.gen(function* () {
            yield* herdr.call("pane.wait_for_output", { pane_id: paneId, source: "visible", match: { type: "regex", value: "\\S" }, timeout_ms: 60_000 })
            // A bare pi (none of the user's extensions, MCP servers or skills): light enough for the parallel suite.
            yield* herdr.call("pane.send_text", { pane_id: paneId, text: "pi --no-extensions --no-mcp --no-skills --no-session" })
            yield* herdr.call("pane.send_keys", { pane_id: paneId, keys: ["enter"] })
            yield* waitFor(herdr.call("agent.get", { target: paneId }).pipe(Effect.exit), Exit.isSuccess, "herdr detected the agent", 1400)
            // What the CLI reports for its own pane: `<session>/<pane>`, no name.
            const terminal = TerminalRuntime.terminalOf(name, paneId)
            // state reads the detected agent; core delivers only once it is idle, so the test waits for that too (a cold
            // pi can sit a minute at its own startup, an MCP timeout).
            if (runtime.state !== undefined) yield* waitFor(runtime.state(terminal), (state) => state === "idle", "the detected agent idle", 1400)
            // `send` reaches the detected agent as a submitted prompt (`agent.prompt`, Enter included): pi runs the
            // `!` shell line and prints a word the typed text itself does not contain — typed without submitting, it
            // never runs.
            yield* runtime.send(terminal, { text: "! printf 'VBT_%s\\n' SUBMITS" })
            yield* waitFor(runtime.read(terminal, 80), (text) => text.includes("VBT_SUBMITS"), "the submitted prompt ran", 1400)
            // A subagent's old terminal whose pane id now holds this stranger agent: not its agent, never closed.
            const stale = TerminalRuntime.terminalOf(name, paneId, "vbt-gone-00000000")
            if (runtime.state !== undefined) assert.strictEqual((yield* Effect.flip(runtime.state(stale))).code, "not_found")
            assert.strictEqual((yield* Effect.flip(runtime.close(stale))).code, "failed")
            assert.isTrue(Exit.isSuccess(yield* Effect.exit(herdr.call("pane.get", { pane_id: paneId }))))
          }).pipe(Effect.ensuring(herdr.call("workspace.close", { workspace_id: made.workspace.workspace_id }).pipe(Effect.ignore)))
        }),
      ),
    ).pipe(Effect.provide(layer)), 400_000)

  // How every subagent runs: `open` with the harness argv starts a named agent, and `send` prompts it. Ten opens so
  // pane ids pass `p9` (herdr's later ids carry uppercase, which an agent name must not).
  it.live.skipIf(!piOnPath)("open starts a harness as a named agent that state reads and send prompts, whatever its pane id", () =>
    withSession(({ socketPath }) =>
      withRuntime((runtime) => {
        const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_SOCKET_PATH: socketPath }))
        const cwd = fs.realpathSync(os.tmpdir())
        const open = (argv: ReadonlyArray<string>, vars: Record<string, string> = {}) => runtime.open({ id: "local" }, { project: cwd, cwd, argv, env: vars, label: "harness" }).pipe(Effect.provide(env))
        return Effect.gen(function* () {
          for (let i = 0; i < 10; i++) yield* open(["/bin/sh"])
          const terminal = yield* open(["pi", "--no-extensions", "--no-mcp", "--no-skills", "--no-session"], { VIBEST_SESSION_ID: "ab12cd34" })
          // Named after the vibest session, as before the port: `herdr agent list` shows which session runs where.
          assert.strictEqual(TerminalRuntime.parseTerminal(terminal)?.name, "s-ab12cd34")
          if (runtime.state !== undefined) yield* waitFor(runtime.state(terminal), (state) => state === "idle", "the started agent idle", 1400)
          yield* runtime.send(terminal, { text: "! printf 'VBT_%s\\n' STARTED" })
          yield* waitFor(runtime.read(terminal, 80), (text) => text.includes("VBT_STARTED"), "the prompt ran", 1400)
        })
      }),
    ).pipe(Effect.provide(layer)), 400_000)

  it.live("close moves the last pane of a main checkout's workspace out before closing it: the linked worktree's pane survives; a worktree-less workspace closes directly, at most itself", () =>
    withSession(({ name, socketPath }) =>
      withRuntime((runtime) => {
        const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_SOCKET_PATH: socketPath }))
        const open = (cwd: string) =>
          runtime.open({ id: "local" }, { project: cwd, cwd, argv: ["/bin/sh"], env: {}, label: "close test" }).pipe(Effect.provide(env))
        return Effect.gen(function* () {
          const log = yield* Ref.make<ReadonlyArray<TerminalRuntime.RuntimeEvent>>([])
          yield* (runtime.events ?? Stream.empty).pipe(Stream.runForEach((event) => Ref.update(log, (events) => [...events, event])), Effect.forkScoped, Effect.ignore)
          const herdr = yield* (yield* HerdrPool).client(name)
          const workspaces = () => herdr.call("workspace.list", {}).pipe(Effect.map((r) => r.workspaces))

          // A repository (a main checkout) with one linked worktree: herdr keeps each in a workspace of its own, and
          // closing the main checkout's workspace (its last pane) takes the linked one with it — so vibest moves first.
          const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vibest-close-")))
          const repo = path.join(dir, "repo")
          fs.mkdirSync(repo)
          git(dir, "init", "-q", repo)
          git(repo, "-c", "user.email=v@v", "-c", "user.name=v", "commit", "-q", "--allow-empty", "-m", "x")
          git(repo, "worktree", "add", "-q", "--detach", path.join(dir, "linked"))
          const main = yield* open(repo)
          const mainPane = TerminalRuntime.parseTerminal(main)!.paneId
          const linked = yield* herdr.call("worktree.open", { cwd: repo, path: path.join(dir, "linked"), trust_repository: true })
          const linkedPane = linked.root_pane.pane_id
          yield* runtime.close(main)
          // The main pane is closed; the linked worktree's pane and workspace survived what would have taken them too.
          assert.isTrue(Exit.isFailure(yield* Effect.exit(herdr.call("pane.get", { pane_id: mainPane }))))
          assert.strictEqual((yield* herdr.call("pane.get", { pane_id: linkedPane })).pane.pane_id, linkedPane)
          assert.isTrue((yield* workspaces()).some((w) => w.workspace_id === linked.workspace.workspace_id))

          // A workspace without a worktree closes at most itself: one of two panes closed with its sibling left, the
          // last in place (its pane id unchanged to the end, so no move happened).
          const plain = path.join(dir, "plain")
          fs.mkdirSync(plain)
          const first = yield* open(plain)
          const second = yield* open(plain)
          const ws = (yield* herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(first)!.paneId })).pane.workspace_id
          yield* runtime.close(first)
          assert.strictEqual((yield* herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(second)!.paneId })).pane.workspace_id, ws)
          yield* runtime.close(second)
          // Closed in place: the pane is gone under its own id (a move would have renamed it first), the workspace
          // with no worktree took at most itself — its sibling's close above already left everything else alone.
          assert.isTrue(Exit.isFailure(yield* Effect.exit(herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(second)!.paneId }))))
          yield* waitFor(Ref.get(log), (events) => events.some((event) => event.type === "exited" && event.terminal.id === second.id), "closed in place")
        })
      }),
    ).pipe(Effect.provide(layer)), 90_000)
})
