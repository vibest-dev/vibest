import net from "node:net"

import { assert, describe, it } from "@effect/vitest"
import { PROTOCOL } from "@vibest/schema/version"
import { Effect, FileSystem, Path, Schema } from "effect"

import * as Platform from "#platform"

import { VERSION } from "../src/version.ts"
import { runVibest as vibest, tempDirectory } from "./fakes.ts"

const TIMEOUT = 30_000

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

describe("vibest CLI without vibestd", () => {
  it.effect(
    "an agent's vibest does not start vibestd: it fails DaemonUnavailable and creates no home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* tempDirectory("vibest-cli-")
        const vibestHome = path.join(home, "vibest")
        const agent = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" }
        const r = yield* vibest(home, { HOME: home, VIBEST_HOME: vibestHome, ...agent }, ["ls"])
        assert.deepStrictEqual([r.code, r.stdout], [1, ""])
        assert.match(r.stderr, /^DaemonUnavailable: vibestd is unreachable on .*; ask the user to check it/)
        assert.isFalse(yield* fs.exists(vibestHome))
        for (const dir of [".claude", ".cursor", ".pi"]) assert.isFalse(yield* fs.exists(path.join(home, dir)), dir)
      }).pipe(Effect.provide(Platform.services)),
    TIMEOUT,
  )

  const fakeDaemon = (capabilities: Record<string, boolean>, answer: (n: number) => object | undefined) =>
    Effect.gen(function* () {
      const home = yield* tempDirectory("vibest-requests-")
      const sends: Array<{ id: string; request?: string }> = []
      const server = net.createServer((sock) => {
        let buf = ""
        sock.on("data", (chunk) => {
          buf += chunk.toString()
          for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
            const req = JSON.parse(buf.slice(0, nl)) as { id?: string; method?: string; params?: never }
            buf = buf.slice(nl + 1)
            const reply = (body: object) => sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }) + "\n")
            if (req.method === "Ping")
              reply({ result: { protocol: PROTOCOL, version: VERSION, runtimes: [], capabilities } })
            else if (req.method === "Send") {
              sends.push(req.params!)
              const out = answer(sends.length)
              if (out === undefined) sock.destroy()
              else reply(out)
            }
          }
        })
      })
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => void server.listen(`${home}/vibest.sock`, () => resume(Effect.void))),
        () => Effect.sync(() => server.close()),
      )
      const send = vibest(home, { HOME: home, VIBEST_HOME: home }, [
        "send",
        "abcd1234-abcd-4abc-8abc-abcd1234abcd",
        "--",
        "hi",
      ])
      return { sends, send }
    })
  const id = "abcd1234-abcd-4abc-8abc-abcd1234abcd"
  it.effect(
    "send whose connection drops after the request: sent once more with the same request id, the output unchanged",
    () =>
      Effect.gen(function* () {
        const d = yield* fakeDaemon({ requests: true }, (n) => (n === 1 ? undefined : { result: { id } }))
        const r = yield* d.send
        assert.strictEqual(r.code, 0, r.stderr)
        assert.deepStrictEqual(decodeJson(r.stdout), { id, queued: true })
        assert.lengthOf(d.sends, 2)
        assert.match(d.sends[0]!.request!, /^[0-9a-f-]{36}$/)
        assert.strictEqual(d.sends[1]!.request, d.sends[0]!.request)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )

  it.effect(
    "send to a vibestd without request ids carries none and is not sent again when its connection drops",
    () =>
      Effect.gen(function* () {
        const d = yield* fakeDaemon({ http: true, handoff: true }, (n) => (n === 1 ? undefined : { result: { id } }))
        const r = yield* d.send
        assert.strictEqual(r.code, 1, r.stdout)
        assert.lengthOf(d.sends, 1)
        assert.isUndefined(d.sends[0]!.request)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )

  it.effect(
    "integration guard fails with no answer when no vibest agent runs it, or when vibestd cannot check the call; the plugin refuses the call then",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-guard-cli-" })
        const guard = (env: Record<string, string>, stdin: string) =>
          vibest(cwd, { HOME: cwd, VIBEST_HOME: cwd, ...env }, ["integration", "guard", "--harness", "cursor"], stdin)
        const noAgent = yield* guard({}, JSON.stringify({ tool_name: "Shell", tool_input: { command: "git status" } }))
        assert.notStrictEqual(noAgent.code, 0, noAgent.stderr)
        assert.strictEqual(noAgent.stdout, "")
        assert.match(noAgent.stderr, /VIBEST_SESSION_ID/)
        const unchecked = yield* guard({ VIBEST_AGENT: "general", VIBEST_SESSION_ID: "s1" }, "not json")
        assert.notStrictEqual(unchecked.code, 0, unchecked.stderr)
        assert.strictEqual(unchecked.stdout, "")
        assert.match(unchecked.stderr, /vibestd/)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )
})
