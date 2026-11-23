import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import type * as VibestPlugin from "@vibest/plugin/effect"
import { runtimeContract } from "@vibest/plugin/testing"
import { Effect, Ref, Stream } from "effect"

import { alive, commandOf, note } from "../../../tools/reap.ts"
import { connect } from "../src/client.ts"
import { make, MIN_API_REVISION, parseTerminalId } from "../src/terminal-runtime.ts"

const REX_CANDIDATES = [
  process.env.REX_BIN,
  "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
  "/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
]

const revisionOf = (bin: string) => {
  const out = childProcess.spawnSync(bin, ["version"], { encoding: "utf8", timeout: 10_000 }).stdout ?? ""

  return Number(/api: revision (\d+)/.exec(out)?.[1] ?? 0)
}

const rexBin = REX_CANDIDATES.find(
  (bin) => bin !== undefined && bin !== "" && fs.existsSync(bin) && revisionOf(bin) >= MIN_API_REVISION,
)

const root = rexBin === undefined ? "" : fs.mkdtempSync("/tmp/vbrex-")
const socket = path.join(root, "server.sock")
const zdotdir = path.join(root, "z")
const serverPid: Array<number> = []

const serverEnv = () => {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("REX_") && !key.startsWith("VIBEST_")) env[key] = value

  return { ...env, ZDOTDIR: zdotdir }
}

const rexCli = (...args: Array<string>) =>
  childProcess.spawnSync(rexBin ?? "rex", ["--autostart=false", "-S", `unix://${socket}`, ...args], {
    env: serverEnv(),
    encoding: "utf8",
    timeout: 20_000,
  })

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
  body: (runtime: VibestPlugin.Runtime.RuntimeDefinition) => Effect.Effect<A, E, never>,
  at = socket,
) =>
  Effect.gen(function* () {
    const runtime = yield* make({
      connect: connect((endpoint) => NodeSocket.makeNet({ path: endpoint }), at),
      socket: at,
      scope: yield* Effect.scope,
      shell: "/bin/zsh",
      typedLaunch: "2 seconds",
    })

    return yield* body(runtime)
  }).pipe(Effect.scoped)

const LISTENER = `import fs from "node:fs"
process.stdin.setRawMode(true)
process.stdout.write("\\x1b[?2004h")
process.stdout.write("vbt-" + "ready\\n")
let got = ""
process.stdin.on("data", (d) => {
  got += d.toString("latin1")
  if (got.includes("\\x1b[201~") && got.endsWith("\\r")) {
    fs.writeFileSync(process.argv[2], got)
    process.stdout.write("\\x1b[?2004l")
    process.exit(0)
  }
})
`

const agentMessage = [
  "<vibest-agent-message>",
  "<agent-id>d4ff81ab-b98c-45ee-bfe7-c8b89df131f3</agent-id>",
  "<message>",
  ...Array.from({ length: 16 }, (_, i) => `line ${i + 1}: 'single' "double" \`tick\` $HOME $(uname) \\back`),
  "</message>",
  "</vibest-agent-message>",
].join("\n")

describe.skipIf(rexBin === undefined)("runtime-rex against an isolated Rex server", () => {
  beforeAll(async () => {
    fs.mkdirSync(path.join(root, "state"), { recursive: true })
    fs.mkdirSync(zdotdir, { recursive: true })
    fs.writeFileSync(path.join(root, "init.lua"), "")

    const server = childProcess.spawn(
      rexBin ?? "rex",
      [
        "server",
        "run",
        "--listen",
        `unix://${socket}`,
        "--state-dir",
        path.join(root, "state"),
        "--restore=false",
        "--config",
        path.join(root, "init.lua"),
      ],
      { env: serverEnv(), stdio: "ignore", detached: true },
    )

    server.unref()

    if (server.pid !== undefined) serverPid.push(server.pid)

    if (server.pid !== undefined) note(server.pid, commandOf(server.pid).trim(), "", root)
    const deadline = Date.now() + 20_000

    while (!fs.existsSync(socket)) {
      if (Date.now() > deadline) throw new Error(`rex server run did not listen at ${socket}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })
  afterAll(async () => {
    rexCli("server", "stop")

    for (const pid of serverPid) {
      const deadline = Date.now() + 10_000

      while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))

      if (alive(pid)) process.kill(pid, "SIGKILL")
    }

    fs.rmSync(root, { recursive: true, force: true })
  })

  it.live(
    "passes the shared runtime contract",
    () =>
      withRuntime((runtime) =>
        runtimeContract(runtime, { cwd: fs.realpathSync(root), timeout: "30 seconds" }).pipe(
          Effect.provide(NodeFileSystem.layer),
          Effect.provide(NodePath.layer),
          Effect.scoped,
        ),
      ),
    120_000,
  )

  it.live(
    "a multiline agent message sent with text arrives as one bracketed paste followed by one Enter",
    () =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          const cwd = fs.realpathSync(root)
          const script = path.join(cwd, "listen.mjs")
          const out = path.join(cwd, "pasted.txt")
          fs.writeFileSync(script, LISTENER)
          fs.rmSync(out, { force: true })

          const terminal = yield* runtime.open({
            project: cwd,
            cwd,
            launch: { argv: [process.execPath, script, out], env: {} },
            label: "paste",
          })

          yield* until(runtime.read(terminal, 40), (text) => text.includes("vbt-ready"), "the listener did not start")
          yield* runtime.send(terminal, { text: agentMessage })
          yield* until(
            Effect.sync(() => fs.existsSync(out)),
            (found) => found,
            "the listener received no Enter",
          )
          assert.strictEqual(
            fs.readFileSync(out, "latin1"),
            `\x1b[200~${Buffer.from(agentMessage).toString("latin1")}\x1b[201~\r`,
          )
          yield* runtime.close(terminal)
        }),
      ),
    90_000,
  )

  it.live(
    "OSC 7501 reports become the terminal's state and state events",
    () =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          const cwd = fs.realpathSync(root)
          const seen = yield* Ref.make<ReadonlyArray<VibestPlugin.Runtime.RuntimeEvent>>([])
          yield* runtime.events.pipe(
            Stream.runForEach((event) => Ref.update(seen, (events) => [...events, event])),
            Effect.forkScoped,
          )

          const terminal = yield* runtime.open({ project: cwd, cwd, launch: { argv: [], env: {} }, label: "state" })
          assert.strictEqual(yield* runtime.state!(terminal), "unknown")
          yield* runtime.send(terminal, { text: "printf '\\033]7501;state=blocked\\007'" })
          yield* until(runtime.state!(terminal), (state) => state === "blocked", "the state did not become blocked")
          yield* until(
            Ref.get(seen),
            (events) =>
              events.some((e) => e.type === "state" && e.terminal.id === terminal.id && e.state === "blocked"),
            "no blocked state event",
          )
          yield* runtime.send(terminal, { text: "printf '\\033]7501;state=done\\007'" })
          yield* until(runtime.state!(terminal), (state) => state === "idle", "done did not read as idle")
          yield* runtime.close(terminal)
        }).pipe(Effect.scoped),
      ),
    90_000,
  )

  it.live(
    "split opens the new terminal beside the near one in the same window",
    () =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          const cwd = fs.realpathSync(root)
          const near = yield* runtime.open({ project: cwd, cwd, launch: { argv: [], env: {} }, label: "near" })

          const beside = yield* runtime.open({
            project: cwd,
            cwd,
            launch: { argv: [], env: {} },
            label: "beside",
            near,
            split: true,
          })

          const a = parseTerminalId(near.id)
          const b = parseTerminalId(beside.id)
          assert.strictEqual(b?.sessionId, a?.sessionId)
          const view = rexCli("api", "call", "session.view", JSON.stringify({ session_id: a?.sessionId }))
          assert.strictEqual(view.status, 0, view.stderr)

          const windows = (
            JSON.parse(view.stdout) as { windows: Array<{ layers: Array<{ blocks: Array<{ block_id: string }> }> }> }
          ).windows

          const holding = windows.filter((w) =>
            w.layers.some((l) => l.blocks.some((block) => block.block_id === b?.blockId)),
          )

          assert.strictEqual(holding.length, 1)
          assert.isTrue(holding[0]?.layers.some((l) => l.blocks.some((block) => block.block_id === a?.blockId)))
          yield* runtime.close(beside)
          yield* runtime.close(near)
        }),
      ),
    60_000,
  )
})
