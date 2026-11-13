import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { runtimeContract } from "@vibest/plugin/testing"
import { Effect, Ref, type Scope, Stream } from "effect"
import { Hc, SocketConnector } from "effect-herdr-core-sdk"
import * as HcBun from "effect-herdr-core-sdk/bun"

import { commandOf, note } from "../../../tools/reap.ts"
import {
  KIND,
  LABEL,
  make,
  parseTerminalId,
  PRESENT_ENTRY_SESSION,
  PRESENT_PROJECT_ID,
} from "../src/terminal-runtime.ts"

const hcOnPath = childProcess.spawnSync("hc", ["--version"], { stdio: "ignore" }).status === 0

const SOCKET_PATH_LIMIT_SAFE_ROOT = "/tmp/vbhc-"
const root = hcOnPath ? fs.mkdtempSync(SOCKET_PATH_LIMIT_SAFE_ROOT) : ""
const coreEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("HC_") && !key.startsWith("VIBEST_")) env[key] = value
  return {
    ...env,
    HC_SESSION: "t",
    XDG_RUNTIME_DIR: path.join(root, "r"),
    XDG_STATE_HOME: path.join(root, "s"),
    XDG_CONFIG_HOME: path.join(root, "c"),
    ZDOTDIR: path.join(root, "z"),
  }
}
const socketPath = path.join(root, "r", "herdr-core", "t.sock")
const hcCli = (...args: Array<string>) =>
  childProcess.spawnSync("hc", args, { env: coreEnv(), encoding: "utf8", timeout: 20_000 })

const until = <A, E>(read: Effect.Effect<A, E>, ok: (a: A) => boolean, what: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 30_000
    for (;;) {
      const value = yield* read
      if (ok(value)) return value
      if (Date.now() > deadline)
        return yield* Effect.fail(new Error(`${what} within 30 s; last ${JSON.stringify(value)}`))
      yield* Effect.sleep("200 millis")
    }
  })

const withRuntime = <A, E>(
  body: (runtime: Effect.Success<ReturnType<typeof make>>, hc: Hc["Service"]) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const connector = yield* SocketConnector
    const connect = (at: string) => Hc.make(at).pipe(Effect.provideService(SocketConnector, connector))
    const hc = yield* connect(socketPath)
    const runtime = yield* make({
      connect,
      socket: socketPath,
      scope: yield* Effect.scope,
      typedLaunch: "2 seconds",
    })
    return yield* body(runtime, hc)
  }).pipe(Effect.scoped, Effect.provide(HcBun.layer))

describe.skipIf(!hcOnPath)("runtime-herdr-core against an isolated herdr-core", () => {
  beforeAll(() => {
    for (const dir of ["r", "s", "c", "z"]) fs.mkdirSync(path.join(root, dir), { recursive: true })
    const started = hcCli("server", "start")
    if (started.status !== 0) throw new Error(`hc server start: ${started.stderr}${started.stdout}`)
    const core = (JSON.parse(started.stdout) as { pid?: number }).pid
    if (core !== undefined) note(core, commandOf(core).trim(), "", root)
  })
  afterAll(() => {
    hcCli("server", "stop")
    fs.rmSync(root, { recursive: true, force: true })
  })

  it.live(
    "passes the shared runtime contract",
    () => withRuntime((runtime) => runtimeContract(runtime, { cwd: fs.realpathSync(root), timeout: "30 seconds" })),
    120_000,
  )

  it.live(
    "readable names survive collisions without changing terminal identity",
    () =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          const cwd = fs.realpathSync(root)
          const input = { project: "/work/My Project", cwd, argv: [], env: {}, label: "main" }
          const opened = []
          for (const request of [
            input,
            input,
            ...Array.from({ length: 2 }, () => ({
              ...input,
              label: "a09e0000 修复登录",
              env: { VIBEST_SESSION_ID: "a09e0000-0000-4000-8000-000000000000", VIBEST_HARNESS: "pi" },
            })),
          ])
            opened.push(yield* runtime.open(request))
          const names = ["my-project-main", "my-project-main-2", "pi-a09e", "pi-a09e-2"]
          const listed = hcCli("ls", "--json")
          assert.strictEqual(listed.status, 0, listed.stderr)
          const records = JSON.parse(listed.stdout).terminals as Array<{ address: string; name: string }>
          for (const [i, terminal] of opened.entries()) {
            const { address, socket } = parseTerminalId(terminal.id, socketPath)
            assert.strictEqual(socket, socketPath)
            assert.strictEqual(records.find((t) => t.address === address)?.name, names[i])
            const got = hcCli("get", address, "--json")
            assert.strictEqual(got.status, 0, got.stderr)
            assert.strictEqual(JSON.parse(got.stdout).name, names[i])
            yield* runtime.close(terminal)
          }
        }),
      ),
    90_000,
  )

  it.live(
    "a text sent from vibestd reaches a subagent's program byte-identical, with no <hc> tag",
    () =>
      withRuntime((runtime, hc) =>
        Effect.gen(function* () {
          const cwd = fs.realpathSync(root)
          const main = yield* runtime.open({ project: cwd, cwd, argv: [], env: {}, label: "main" })
          const child = yield* runtime.open({
            project: cwd,
            cwd,
            argv: ["cat"],
            env: {},
            label: "child",
            near: main,
          })
          yield* until(runtime.process(child), (p) => p.running, "cat did not start")
          const text = `vbt <b>"quoted" $HOME 'single' \\back`
          yield* runtime.send(child, { text })
          const screen = yield* until(
            runtime.read(child, 20),
            (s) => s.split(text).length >= 3,
            "cat did not echo the text",
          )
          assert.notInclude(screen, "<hc")
          const record = yield* hc.call("terminal.get", { terminal: parseTerminalId(child.id, socketPath).address })
          assert.isNotNull(record.parent ?? null)
          assert.isFalse(record.notify ?? false)
          assert.isFalse(record.die_with_parent ?? false)
          yield* runtime.close(child)
          yield* runtime.close(main)
        }),
      ),
    90_000,
  )

  it.live(
    "a kept terminal whose shell dies by a signal gets a shell that still has the env it was opened with",
    () =>
      withRuntime((runtime, hc) =>
        Effect.gen(function* () {
          const cwd = fs.realpathSync(root)
          const marker = `keep${Math.random().toString(16).slice(2, 8)}`
          const terminal = yield* runtime.open({
            project: cwd,
            cwd,
            argv: [],
            env: { VBT_KEEP: marker },
            label: "keep",
          })
          const pid = (yield* hc.call("terminal.get", { terminal: parseTerminalId(terminal.id, socketPath).address }))
            .pid
          yield* runtime.send(terminal, { text: "kill -9 $$" })
          yield* until(
            hc.call("terminal.get", { terminal: parseTerminalId(terminal.id, socketPath).address }),
            (t) => t.state === "live" && typeof t.pid === "number" && t.pid !== pid,
            "the core did not replace the killed shell",
          )
          yield* runtime.run!(terminal, ["sh", "-c", 'printf "kept-%s\\n" "$VBT_KEEP"'])
          yield* until(
            runtime.read(terminal, 40),
            (s) => s.includes(`kept-${marker}`),
            "the replacement shell lost VBT_KEEP",
          )
          yield* runtime.close(terminal)
        }),
      ),
    90_000,
  )

  it.live(
    "labels an entry session's terminal for herdr-app and reports the typed program's exit",
    () =>
      withRuntime((runtime, hc) =>
        Effect.gen(function* () {
          const cwd = fs.realpathSync(root)
          const seen = yield* Ref.make<ReadonlyArray<string>>([])
          yield* runtime.events.pipe(
            Stream.runForEach((e) =>
              Ref.update(seen, (all) => [...all, e.type === "reset" ? "reset" : `${e.type}:${e.terminal.id}`]),
            ),
            Effect.forkScoped,
          )
          yield* Effect.sleep("300 millis")
          const main = yield* runtime.open({ project: cwd, cwd, argv: [], env: {}, label: "main" })
          yield* runtime.present!(main, { [PRESENT_ENTRY_SESSION]: "session-1", [PRESENT_PROJECT_ID]: "project-1" })
          const labels = (yield* hc.call("terminal.get", { terminal: parseTerminalId(main.id, socketPath).address }))
            .labels
          assert.deepInclude(labels, {
            [LABEL.runtime]: KIND,
            [LABEL.project]: "project-1",
            [LABEL.session]: "session-1",
            [LABEL.space]: "project-1",
            [LABEL.tab]: "session-1",
          })
          yield* runtime.run!(main, ["sleep", "1"])
          yield* until(Ref.get(seen), (all) => all.includes(`exited:${main.id}`), "no exited event after sleep ended")
          assert.isFalse((yield* runtime.process(main)).running)
          yield* runtime.close(main)
        }),
      ),
    90_000,
  )
})
