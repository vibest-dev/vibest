import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, assert, describe, it } from "@effect/vitest"
import { runtimeContract } from "@vibest/plugin/testing"
import { HerdrPool } from "@vibest/runtime-herdr/pool"
import * as TerminalRuntime from "@vibest/runtime-herdr/terminal-runtime"
import { fromPool } from "@vibest/runtime-herdr/terminal-runtime"
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Stream } from "effect"
import { FileSystem } from "effect"
import { HerdrError, type HerdrShape, type PushFrame } from "effect-herdr-sdk"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

const herdrOnPath = childProcess.spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0
const piOnPath = childProcess.spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0
const barePiArgv = ["pi", "--no-extensions", "--no-mcp", "--no-skills", "--no-session"]
const coldPiStartupAttempts = 1400

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
  const listed = childProcess.spawnSync("herdr", ["session", "list", "--json"], {
    env: herdrChildEnv(),
    encoding: "utf8",
  })
  if (listed.status !== 0 || !listed.stdout) return undefined
  try {
    const json = JSON.parse(listed.stdout) as { sessions?: Array<ListedSession> }
    return json.sessions ?? []
  } catch {
    return undefined
  }
}

const signalablePid = (pid: number) => pid > 1

const livePid = (child: ReturnType<typeof childProcess.spawn> | undefined) => {
  const pid = child?.pid
  return child?.exitCode === null && child?.signalCode === null && pid !== undefined && signalablePid(pid)
    ? pid
    : undefined
}

const killDetachedProcessGroup = (leader: number) => {
  try {
    process.kill(-leader, "SIGKILL")
    return true
  } catch {
    return false
  }
}

const stopSession = async (name: string) => {
  if (!sessionName.test(name)) return
  const env = herdrChildEnv()
  const child = children.get(name)
  const deadline = Date.now() + 5_000
  for (;;) {
    childProcess.spawnSync("herdr", ["session", "stop", name], { env, stdio: "ignore", timeout: 2_000 })
    const pid = livePid(child)
    if (pid !== undefined) killDetachedProcessGroup(pid)
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

const loadedSuiteAttempts = 200

const waitFor = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
  label: string,
  attempts = loadedSuiteAttempts,
) =>
  Effect.gen(function* () {
    let last = ""
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = yield* read
      if (ready(value)) return value
      last = JSON.stringify(value)
      yield* Effect.sleep("100 millis")
    }
    return yield* Effect.die(new Error(`${label}: ${last}`))
  })

const withSession = <A, E, R>(
  use: (session: { readonly name: string; readonly socketPath: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const name = `vbt-${crypto.randomBytes(4).toString("hex")}`
    started.add(name)
    const child = childProcess.spawn("herdr", ["--session", name, "server"], {
      env: herdrChildEnv(),
      detached: true,
      stdio: "ignore",
    })
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

type Scripted = (method: string, params: Record<string, unknown>) => Effect.Effect<unknown, HerdrError>

const scriptedRuntime = (answer: Scripted, pushed: Stream.Stream<PushFrame> = Stream.empty) =>
  Effect.gen(function* () {
    const calls: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = []
    const resendingCall = ((method: string, params: Record<string, unknown>) =>
      Effect.suspend(() => {
        calls.push({ method, params })
        return answer(method, params)
      })) as HerdrShape["call"]
    const client: HerdrShape = {
      socketPath: "/nowhere",
      subscribe: () => pushed,
      call: resendingCall,
    }
    const pool = HerdrPool.of({
      resolve: () => Effect.succeed("s"),
      client: () => Effect.succeed(client),
      events: Stream.empty,
      restarts: Stream.empty,
      sessions: Effect.succeed(["s"]),
    })
    const runtime = yield* fromPool({
      pool,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      fs: undefined,
      scope: yield* Effect.scope,
    })
    return { runtime, calls }
  })

const herdrError = (method: string, code: string) => Effect.fail(new HerdrError({ method, code, message: code }))

const scriptedSend = (agentNotReadyRefusals: number) =>
  Effect.gen(function* () {
    let refused = 0
    const { runtime, calls } = yield* scriptedRuntime((method) => {
      if (method === "agent.get")
        return Effect.succeed({
          agent: { name: "s-abcd1234abcd4abc8abcabcd1234ab", pane_id: "w1:p2", agent: "claude" },
        })
      if (method === "agent.prompt" && refused < agentNotReadyRefusals) {
        refused++
        return herdrError(method, "agent_not_ready")
      }
      return Effect.succeed({})
    })
    const sending = yield* Effect.forkChild(
      runtime.send(TerminalRuntime.terminalOf("s", "w1:p2", "s-abcd1234abcd4abc8abcabcd1234ab"), {
        text: "line one\nline two",
      }),
    )
    yield* TestClock.adjust("40 seconds")
    yield* Fiber.join(sending)
    return calls.map((c) => c.method).filter((m) => m !== "agent.get")
  }).pipe(Effect.provide(Platform.services))

describe("send to an agent herdr started", () => {
  it.effect("waits until herdr marks it ready, then prompts it: no text typed into a launch still pending", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* scriptedSend(3), ["agent.prompt", "agent.prompt", "agent.prompt", "agent.prompt"])
    }),
  )

  it.effect("herdr marks it ready only when it is read (agent.get), so each try reads it before agent.prompt", () =>
    Effect.gen(function* () {
      let ready = false
      let gets = 0
      const { runtime, calls } = yield* scriptedRuntime((method) => {
        if (method === "agent.get") {
          if (++gets > 2) ready = true
          return Effect.succeed({ agent: { name: "s-abcd1234abcd4abc8abcabcd1234ab", pane_id: "w1:p2", agent: "pi" } })
        }
        if (method === "agent.prompt" && !ready) return herdrError(method, "agent_not_ready")
        return Effect.succeed({})
      })
      const sending = yield* Effect.forkChild(
        runtime.send(TerminalRuntime.terminalOf("s", "w1:p2", "s-abcd1234abcd4abc8abcabcd1234ab"), { text: "task" }),
      )
      yield* TestClock.adjust("40 seconds")
      yield* Fiber.join(sending)
      const methods = calls.map((c) => c.method)
      assert.strictEqual(methods.filter((m) => m === "agent.prompt").length, 2)
      assert.notInclude(methods, "pane.send_input")
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("an agent herdr never marks ready gets the text as one paste with Enter (pane.send_input)", () =>
    Effect.gen(function* () {
      const calls = yield* scriptedSend(Number.POSITIVE_INFINITY)
      assert.isAbove(calls.filter((m) => m === "agent.prompt").length, 1, "agent.prompt is retried before the paste")
      assert.strictEqual(calls.at(-1), "pane.send_input")
      assert.notInclude(calls, "pane.send_text")
    }),
  )
})

describe("pane events", () => {
  it.effect("a pane.agent_status_changed subscription frame (its data has no type) is a state event", () =>
    Effect.gen(function* () {
      const go = yield* Deferred.make<void>()
      const frame = {
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p2", workspace_id: "w1", agent: "pi", agent_status: "done" },
      } as PushFrame
      const { runtime } = yield* scriptedRuntime(
        () => Effect.succeed({}),
        Stream.fromEffect(Deferred.await(go)).pipe(Stream.as(frame)),
      )
      const first = yield* runtime.events!.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      const installPaneSubscription = runtime.state!(TerminalRuntime.terminalOf("s", "w1:p2")).pipe(Effect.ignore)
      yield* installPaneSubscription
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow
      yield* Deferred.succeed(go, undefined)
      assert.deepStrictEqual(yield* Fiber.join(first), [
        { type: "state", terminal: TerminalRuntime.terminalOf("s", "w1:p2"), state: "idle" },
      ])
    }).pipe(Effect.provide(Platform.services)),
  )
})

describe("terminal ids", () => {
  it("a terminal is `<session>/<pane>[/<name>]`, the parts non-empty, the agent name telling a pane id herdr reused apart; the caller's location is the machine target", () => {
    const terminal = TerminalRuntime.terminalOf("s1", "w1:p1")
    assert.deepStrictEqual(terminal, { machine: "local", id: "s1/w1:p1" })
    assert.deepStrictEqual(TerminalRuntime.parseTerminal(terminal), { session: "s1", paneId: "w1:p1", name: undefined })
    assert.deepStrictEqual(
      TerminalRuntime.parseTerminal(TerminalRuntime.terminalOf("s1", "w1:p1", "vbt-w1:p1-ab12cd34")),
      { session: "s1", paneId: "w1:p1", name: "vbt-w1:p1-ab12cd34" },
    )
    assert.isUndefined(TerminalRuntime.parseTerminal({ machine: "local", id: "/p" }))
    assert.isUndefined(TerminalRuntime.parseTerminal({ machine: "local", id: "s/" }))
    assert.isUndefined(TerminalRuntime.parseTerminal({ machine: "local", id: "pane" }))
    assert.isUndefined(TerminalRuntime.parseTerminal({ machine: "local", id: "s/p/" }))
    assert.deepStrictEqual(TerminalRuntime.decodeTarget(TerminalRuntime.encodeTarget({ session: "other" })), {
      session: "other",
    })
    assert.deepStrictEqual(TerminalRuntime.decodeTarget(TerminalRuntime.encodeTarget({ socketPath: "/h/s.sock" })), {
      socketPath: "/h/s.sock",
    })
    assert.isUndefined(TerminalRuntime.decodeTarget("{}"))
    assert.isUndefined(TerminalRuntime.decodeTarget(undefined))
  })
})

const git = (cwd: string | undefined, ...args: string[]) => {
  const run = childProcess.spawnSync("git", args, { cwd, encoding: "utf8", env: herdrChildEnv() })
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${(run.stderr ?? run.stdout ?? "").trim()}`)
  return (run.stdout ?? "").trim()
}

describe.skipIf(!herdrOnPath)("runtime-herdr", () => {
  afterAll(async () => {
    for (const name of started) await stopSession(name)
  })

  it.live(
    "the terminal runtime passes the shared contract suite (runtime-port.md §3)",
    () =>
      withSession(({ socketPath }) =>
        withRuntime((runtime) =>
          Effect.gen(function* () {
            const cwd = fs.realpathSync(os.tmpdir())
            yield* runtimeContract(runtime, { cwd, timeout: "20 seconds" }).pipe(
              Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_SOCKET_PATH: socketPath }))),
            )
          }),
        ),
      ).pipe(Effect.provide(layer)),
    120_000,
  )

  it.live(
    "open types argv into the pane's shell, and read, send, process, present and close land on herdr",
    () =>
      withSession(({ name, socketPath }) =>
        withRuntime((runtime) =>
          Effect.gen(function* () {
            const cwd = fs.realpathSync(os.tmpdir())
            const env = { HERDR_SOCKET_PATH: socketPath }
            const opened = yield* runtime
              .open(
                { id: "local" },
                {
                  project: cwd,
                  cwd,
                  argv: ["printf", "VBT_%s\\n", "TYPED"],
                  env: {},
                  label: "vibest test",
                },
              )
              .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
            const seen = TerminalRuntime.parseTerminal(opened)
            assert.isDefined(seen)
            assert.strictEqual(seen!.session, name)
            yield* waitFor(runtime.read(opened, 40), (value) => value.includes("VBT_TYPED"), "the typed argv ran")
            yield* runtime.send(opened, { text: "printf 'VBT_%s\\n' OPENED", keys: ["enter"] })
            const text = yield* waitFor(runtime.read(opened, 40), (value) => value.includes("VBT_OPENED"), "pane text")
            assert.include(text, "VBT_OPENED")
            if (runtime.state !== undefined) {
              const failed = yield* runtime.state(opened).pipe(Effect.flip, Effect.option)
              assert.isTrue(
                Option.isSome(failed) && Option.getOrThrow(failed).code === "not_found",
                "open started no agent, so state finds none of this terminal's",
              )
            }
            yield* runtime.send(opened, { text: "sleep 2", keys: ["enter"] })
            yield* waitFor(runtime.process(opened), (p) => p.running, "foreground program")
            yield* runtime.send(opened, { keys: ["enter"] })
            yield* waitFor(runtime.process(opened), (p) => !p.running, "shell again")
            if (runtime.present !== undefined)
              yield* runtime.present(opened, {
                agent: "general",
                harness: "pi",
                title: "task",
                definition: "general",
                session: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
                project: "repo",
                live: "2",
              })
            const herdr = yield* (yield* HerdrPool).client(name)
            const pane = (yield* herdr.call("pane.get", { pane_id: seen!.paneId })).pane
            assert.strictEqual(pane.display_agent, "general \u00b7 pi")
            assert.strictEqual(pane.title, "task")
            assert.strictEqual(pane.tokens?.definition, "general")
            assert.strictEqual(pane.tokens?.session, "abcd1234-abcd-4abc-8abc-abcd1234abcd")
            assert.strictEqual(pane.state_labels?.blocked, "waiting for you")
            const workspace = (yield* herdr.call("workspace.list", {})).workspaces.find(
              (item) => item.workspace_id === pane.workspace_id,
            )
            assert.strictEqual(workspace?.tokens?.project, "repo")
            assert.strictEqual(workspace?.tokens?.agents, "2")
            if (runtime.present !== undefined) {
              yield* runtime.present(opened, {
                agent: "g".repeat(90),
                harness: "pi",
                title: "n".repeat(90),
                definition: "g".repeat(90),
              })
              const limited = (yield* herdr.call("pane.get", { pane_id: seen!.paneId })).pane
              assert.strictEqual(limited.display_agent?.length, 80)
              assert.strictEqual(limited.title?.length, 80)
              assert.strictEqual(limited.tokens?.definition?.length, 80)
              yield* runtime.present(opened, { agent: "reviewer", harness: "pi", title: "later" })
              const again = (yield* herdr.call("pane.get", { pane_id: seen!.paneId })).pane
              assert.strictEqual(again.display_agent, "reviewer \u00b7 pi")
              assert.strictEqual(
                again.title,
                "later",
                "a present right after another lands: each report's seq is newer",
              )
            }
            const before = (yield* herdr.call("workspace.list", {})).workspaces.map((item) => item.workspace_id)
            const beside = yield* runtime
              .open(
                { id: "local" },
                {
                  project: cwd,
                  cwd,
                  argv: ["/bin/sh"],
                  env: { VBT_NEAR: "1" },
                  label: "beside",
                  near: opened,
                },
              )
              .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
            const besidePane = (yield* herdr.call("pane.get", {
              pane_id: TerminalRuntime.parseTerminal(beside)!.paneId,
            })).pane
            assert.strictEqual(besidePane.workspace_id, pane.workspace_id)
            assert.deepStrictEqual(
              (yield* herdr.call("workspace.list", {})).workspaces.map((item) => item.workspace_id),
              before,
            )
            const tab = (yield* herdr.call("tab.list", { workspace_id: besidePane.workspace_id })).tabs.find(
              (item) => item.tab_id === besidePane.tab_id,
            )
            assert.strictEqual(tab?.label, "beside")
            assert.strictEqual(tab?.focused, false, "near opens an unfocused tab in that pane's workspace")
            yield* runtime.close(beside).pipe(Effect.ignore)
            const grouped = yield* runtime
              .open(
                { id: "local" },
                {
                  project: cwd,
                  cwd,
                  argv: ["/bin/sh"],
                  env: {},
                  label: "grouped",
                },
              )
              .pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))
            const groupedPane = (yield* herdr.call("pane.get", {
              pane_id: TerminalRuntime.parseTerminal(grouped)!.paneId,
            })).pane
            assert.strictEqual(
              groupedPane.workspace_id,
              pane.workspace_id,
              "the same project without near reuses the workspace a pane at its directory names",
            )
            yield* runtime.close(grouped).pipe(Effect.ignore)
          }),
        ),
      ).pipe(Effect.provide(layer)),
    90_000,
  )

  it.live.skipIf(!piOnPath)(
    "the main agent in place, a harness a shell ran that herdr detected and no open named, is still ours: state reads it, and send submits (Enter included)",
    () =>
      withSession(({ name }) =>
        withRuntime((runtime) =>
          Effect.gen(function* () {
            const herdr = yield* (yield* HerdrPool).client(name)
            const cwd = fs.realpathSync(os.tmpdir())
            const made = yield* herdr.call("workspace.create", { cwd, label: "detected", focus: false })
            const paneId = made.root_pane.pane_id
            yield* Effect.gen(function* () {
              yield* herdr.call("pane.wait_for_output", {
                pane_id: paneId,
                source: "visible",
                match: { type: "regex", value: "\\S" },
                timeout_ms: 60_000,
              })
              yield* herdr.call("pane.send_text", { pane_id: paneId, text: barePiArgv.join(" ") })
              yield* herdr.call("pane.send_keys", { pane_id: paneId, keys: ["enter"] })
              yield* waitFor(
                herdr.call("agent.get", { target: paneId }).pipe(Effect.exit),
                Exit.isSuccess,
                "herdr detected the agent",
                coldPiStartupAttempts,
              )
              const terminal = TerminalRuntime.terminalOf(name, paneId)
              if (runtime.state !== undefined)
                yield* waitFor(
                  runtime.state(terminal),
                  (state) => state === "idle",
                  "the detected agent idle",
                  coldPiStartupAttempts,
                )
              yield* runtime.send(terminal, { text: "! printf 'VBT_%s\\n' SUBMITS" })
              yield* waitFor(
                runtime.read(terminal, 80),
                (text) => text.includes("VBT_SUBMITS"),
                "the submitted prompt ran, printing VBT_SUBMITS that the typed text does not contain",
                coldPiStartupAttempts,
              )
              const oldTerminal = TerminalRuntime.terminalOf(name, paneId, "vbt-gone-00000000")
              if (runtime.state !== undefined)
                assert.strictEqual((yield* Effect.flip(runtime.state(oldTerminal))).code, "not_found")
              assert.strictEqual((yield* Effect.flip(runtime.close(oldTerminal))).code, "failed")
              assert.isTrue(Exit.isSuccess(yield* Effect.exit(herdr.call("pane.get", { pane_id: paneId }))))
            }).pipe(
              Effect.ensuring(
                herdr.call("workspace.close", { workspace_id: made.workspace.workspace_id }).pipe(Effect.ignore),
              ),
            )
          }),
        ),
      ).pipe(Effect.provide(layer)),
    400_000,
  )

  it.live.skipIf(!piOnPath)(
    "every subagent's way: open starts a harness as a named agent that state reads and send prompts, whatever its pane id (past p9 herdr's ids carry uppercase)",
    () =>
      withSession(({ socketPath }) =>
        withRuntime((runtime) => {
          const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_SOCKET_PATH: socketPath }))
          const cwd = fs.realpathSync(os.tmpdir())
          const open = (argv: ReadonlyArray<string>, vars: Record<string, string> = {}) =>
            runtime
              .open({ id: "local" }, { project: cwd, cwd, argv, env: vars, label: "harness" })
              .pipe(Effect.provide(env))
          return Effect.gen(function* () {
            const shellsPastP9 = 10
            for (let i = 0; i < shellsPastP9; i++) yield* open(["/bin/sh"])
            const terminal = yield* open(barePiArgv, {
              VIBEST_SESSION_ID: "ab12cd34-5678-4abc-8def-0123456789ab",
            })
            assert.strictEqual(
              TerminalRuntime.parseTerminal(terminal)?.name,
              "s-ab12cd3456784abc8def0123456789",
              "named after the vibest session, so herdr agent list shows which session runs where",
            )
            if (runtime.state !== undefined)
              yield* waitFor(
                runtime.state(terminal),
                (state) => state === "idle",
                "the started agent idle",
                coldPiStartupAttempts,
              )
            yield* runtime.send(terminal, { text: "! printf 'VBT_%s\\n' STARTED" })
            yield* waitFor(
              runtime.read(terminal, 80),
              (text) => text.includes("VBT_STARTED"),
              "the prompt ran",
              coldPiStartupAttempts,
            )
          })
        }),
      ).pipe(Effect.provide(layer)),
    400_000,
  )

  it.live(
    "close moves the last pane of a main checkout's workspace out before closing it: the linked worktree's pane survives; a worktree-less workspace closes directly, at most itself",
    () =>
      withSession(({ name, socketPath }) =>
        withRuntime((runtime) => {
          const env = ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_SOCKET_PATH: socketPath }))
          const open = (cwd: string) =>
            runtime
              .open({ id: "local" }, { project: cwd, cwd, argv: ["/bin/sh"], env: {}, label: "close test" })
              .pipe(Effect.provide(env))
          return Effect.gen(function* () {
            const log = yield* Ref.make<ReadonlyArray<TerminalRuntime.RuntimeEvent>>([])
            yield* (runtime.events ?? Stream.empty).pipe(
              Stream.runForEach((event) => Ref.update(log, (events) => [...events, event])),
              Effect.forkScoped,
              Effect.ignore,
            )
            const herdr = yield* (yield* HerdrPool).client(name)
            const workspaces = () => herdr.call("workspace.list", {}).pipe(Effect.map((r) => r.workspaces))

            const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vibest-close-")))
            const repo = path.join(dir, "repo")
            fs.mkdirSync(repo)
            git(dir, "init", "-q", repo)
            git(repo, "-c", "user.email=v@v", "-c", "user.name=v", "commit", "-q", "--allow-empty", "-m", "x")
            git(repo, "worktree", "add", "-q", "--detach", path.join(dir, "linked"))
            const main = yield* open(repo)
            const mainPane = TerminalRuntime.parseTerminal(main)!.paneId
            const linked = yield* herdr.call("worktree.open", {
              cwd: repo,
              path: path.join(dir, "linked"),
              trust_repository: true,
            })
            const linkedPane = linked.root_pane.pane_id
            yield* runtime.close(main)
            assert.isTrue(Exit.isFailure(yield* Effect.exit(herdr.call("pane.get", { pane_id: mainPane }))))
            assert.strictEqual((yield* herdr.call("pane.get", { pane_id: linkedPane })).pane.pane_id, linkedPane)
            assert.isTrue((yield* workspaces()).some((w) => w.workspace_id === linked.workspace.workspace_id))

            const plain = path.join(dir, "plain")
            fs.mkdirSync(plain)
            const first = yield* open(plain)
            const second = yield* open(plain)
            const ws = (yield* herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(first)!.paneId })).pane
              .workspace_id
            yield* runtime.close(first)
            assert.strictEqual(
              (yield* herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(second)!.paneId })).pane
                .workspace_id,
              ws,
            )
            yield* runtime.close(second)
            assert.isTrue(
              Exit.isFailure(
                yield* Effect.exit(herdr.call("pane.get", { pane_id: TerminalRuntime.parseTerminal(second)!.paneId })),
              ),
            )
            yield* waitFor(
              Ref.get(log),
              (events) => events.some((event) => event.type === "exited" && event.terminal.id === second.id),
              "closed in place: gone under its own id, which a move would have changed",
            )
          })
        }),
      ).pipe(Effect.provide(layer)),
    90_000,
  )
})
