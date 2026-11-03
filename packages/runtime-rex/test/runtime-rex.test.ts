// The Rex runtime against an isolated Rex server of its own (its own socket, state directory and empty config), never
// the user's: every call names that socket with `-S`. Skipped when no `rex` is installed.
import childProcess from "node:child_process"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { runtimeContract } from "@vibest/plugin/testing"
import { callerTerminal, failure, findRex, make, parseTerminal } from "@vibest/runtime-rex/runtime"
import { Effect } from "effect"

describe("rex runtime: pure parts", () => {
  it("reads Rex's error codes", () => {
    assert.strictEqual(failure("Error: block not found: block:x (status=404 code=not_found)").code, "not_found")
    assert.strictEqual(failure("Error: x (status=404 code=session_not_found)").code, "not_found")
    assert.strictEqual(failure("Error: x (status=409 code=conflict)").code, "busy")
    assert.strictEqual(
      failure("Error: rex server is not running\nrex server autostart is disabled").code,
      "unreachable",
    )
    assert.strictEqual(failure("Error: x (status=400 code=bad_request)").code, "failed")
  })

  it("names a terminal by session and block", () => {
    assert.deepStrictEqual(parseTerminal({ machine: "local", id: "session:a/block:b" }), {
      session: "session:a",
      block: "block:b",
    })
    assert.strictEqual(parseTerminal({ machine: "local", id: "block:b" }), undefined)
    assert.strictEqual(callerTerminal({ REX_SESSION: "session:a", REX_BLOCK: "block:b" }), "session:a/block:b")
    assert.strictEqual(callerTerminal({ REX_SESSION: "session:a" }), undefined)
  })
})

const rex = findRex()

describe.skipIf(rex === undefined)("rex runtime on an isolated Rex server", () => {
  // A short path: a Unix socket path is limited to about 100 bytes.
  const dir = fs.mkdtempSync("/tmp/vbt-rex-")
  const server = `unix://${dir}/rex.sock`
  let child: childProcess.ChildProcess | undefined

  beforeAll(async () => {
    fs.mkdirSync(path.join(dir, "state"))
    fs.writeFileSync(path.join(dir, "init.lua"), "")
    child = childProcess.spawn(
      rex!,
      [
        "server",
        "run",
        "--listen",
        server,
        "--state-dir",
        path.join(dir, "state"),
        "--config",
        path.join(dir, "init.lua"),
      ],
      // REX_SERVER in the server's own environment: a `rex` run in one of its terminals reaches it, not the user's.
      // REX_RUNTIME_DIR: its runtime record goes here, not into the user's Rex directory (--state-dir does not move it).
      {
        cwd: dir,
        env: { ...process.env, REX_SERVER: server, REX_AUTOSTART: "0", REX_RUNTIME_DIR: path.join(dir, "run") },
        stdio: "ignore",
      },
    )
    const deadline = Date.now() + 10_000
    while (
      childProcess.spawnSync(rex!, ["-S", server, "--autostart=false", "api", "call", "server.status"]).status !== 0
    ) {
      if (Date.now() > deadline) throw new Error("the isolated Rex server did not start")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })

  afterAll(async () => {
    child?.kill()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await fsPromises.rm(dir, { recursive: true, force: true })
  })

  it.live(
    "passes the runtime contract",
    () =>
      Effect.gen(function* () {
        const runtime = yield* make({ server, settle: "5 seconds" })
        yield* runtimeContract(runtime, { cwd: fs.realpathSync(os.tmpdir()), timeout: "20 seconds" })
      }).pipe(Effect.scoped),
    120_000,
  )

  it.live(
    "opens beside near, splits for --peer, labels, and runs exec",
    () =>
      Effect.gen(function* () {
        const runtime = yield* make({ server, settle: "5 seconds" })
        const local = { id: "local" }
        const cwd = fs.realpathSync(os.tmpdir())
        const input = { project: "/tmp/vbt-project", cwd, argv: ["/bin/sh"], env: {}, label: "main" }
        const main = yield* runtime.open(local, input)
        const peer = yield* runtime.open(local, { ...input, label: "peer", near: main, split: true })
        const tab = yield* runtime.open(local, { ...input, label: "tab", near: main })
        // All three in one session: the project's.
        const sessions = [main, peer, tab].map((t) => parseTerminal(t)!.session)
        assert.deepStrictEqual(new Set(sessions).size, 1)
        yield* runtime.present!(peer, { agent: "worker", harness: "pi", title: "fix it" })
        const ran = yield* runtime.exec!(local, ["sh", "-c", "printf exec-ok; exit 4"], cwd)
        assert.strictEqual(ran.code, 4)
        assert.include(ran.output, "exec-ok")
        for (const t of [main, peer, tab]) yield* runtime.close(t)
      }).pipe(Effect.scoped),
    60_000,
  )
})
