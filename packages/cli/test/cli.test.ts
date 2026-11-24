import net from "node:net"

import { assert, describe, it } from "@effect/vitest"
import { runVibest as vibest, tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { EdgeChain, EdgeDirected, EdgeMutual } from "@vibest/protocol/rpc"
import { PROTOCOL } from "@vibest/schema/version"
import { Effect, FileSystem, Path, Schema } from "effect"

import * as Platform from "#platform"

import { VERSION } from "../src/version.ts"

const TIMEOUT = 30_000

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const unknownMethodLine = (id: string | undefined) =>
  `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"error":{"_tag":"Cause","code":0,"message":"Unknown request tag: Machine.Load","data":[{"_tag":"Die","defect":"Unknown request tag: Machine.Load"}]}}\n`

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

  const fakeDaemon = (
    capabilities: Record<string, boolean>,
    answer: (n: number) => Schema.JsonObject | undefined,
    load: "silent" | "unknown" = "silent",
  ) =>
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

            const reply = (body: Schema.JsonObject) =>
              sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }) + "\n")

            if (req.method === "Ping")
              reply({ result: { protocol: PROTOCOL, version: VERSION, runtimes: [], capabilities } })
            else if (req.method === "Send") {
              sends.push(req.params!)
              const out = answer(sends.length)

              if (out === undefined) sock.destroy()
              else reply(out)
            } else if (req.method === "Machine.Load" && load === "unknown") sock.write(unknownMethodLine(req.id))
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

      const status = vibest(home, { HOME: home, VIBEST_HOME: home }, ["status"])

      return { sends, send, status }
    })

  const id = "abcd1234-abcd-4abc-8abc-abcd1234abcd"

  it.effect(
    "status prints a running vibestd without its load when the load does not come in time or that vibestd cannot read it",
    () =>
      Effect.gen(function* () {
        for (const [capabilities, load] of [
          [{ load: true }, "silent"],
          [{}, "unknown"],
        ] as const) {
          const d = yield* fakeDaemon(capabilities, () => undefined, load)
          const r = yield* d.status.pipe(Effect.timeout("10 seconds"))
          assert.strictEqual(r.code, 0, `${load}: ${r.stderr}`)
          const status = decodeJson(r.stdout) as { daemon: { status: string; load?: unknown } }
          assert.strictEqual(status.daemon.status, "running", load)
          assert.isUndefined(status.daemon.load, load)
        }
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )
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

describe("vibest run links and vibest session link/unlink", () => {
  type SpawnCall = {
    harness?: string | null
    prompt?: string
    from?: ReadonlyArray<{ id: string; machine?: string }>
    to?: ReadonlyArray<{ id: string; machine?: string }>
    with?: ReadonlyArray<{ id: string; machine?: string }>
  }

  type LinkCall = { method: "Session.Link" | "Session.Unlink"; spec: unknown }

  const agentEnv = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" }
  const spawnedId = "11111111-1111-4111-8111-111111111111"

  const linkDaemon = () =>
    Effect.gen(function* () {
      const home = yield* tempDirectory("vibest-link-cli-")
      const spawns: Array<SpawnCall> = []
      const links: Array<LinkCall> = []

      const server = net.createServer((sock) => {
        let buf = ""
        sock.on("data", (chunk) => {
          buf += chunk.toString()

          for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
            const req = JSON.parse(buf.slice(0, nl)) as {
              id?: string
              method?: string
              params?: SpawnCall & { spec?: Schema.Json }
            }

            buf = buf.slice(nl + 1)

            const reply = (body: Schema.JsonObject) =>
              sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }) + "\n")

            if (req.method === "Ping")
              reply({
                result: { protocol: PROTOCOL, version: VERSION, runtimes: [], capabilities: { requests: true } },
              })
            else if (req.method === "Harnesses.List") reply({ result: [] })
            else if (req.method === "Spawn") {
              const params = req.params ?? {}
              spawns.push(params)
              reply({
                result: {
                  id: spawnedId,
                  harness: params.harness ?? "pi",
                  decidedBy: {},
                  trace: [],
                },
              })
            } else if (req.method === "Session.Link" || req.method === "Session.Unlink") {
              links.push({ method: req.method, spec: req.params?.spec ?? null })
              reply({ result: { edges: [{ from: { id: "a" }, to: { id: "b" } }] } })
            }
          }
        })
      })

      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => void server.listen(`${home}/vibest.sock`, () => resume(Effect.void))),
        () => Effect.sync(() => server.close()),
      )

      const run = (args: ReadonlyArray<string>, extra: Record<string, string> = agentEnv) =>
        vibest(home, { HOME: home, VIBEST_HOME: home, ...extra }, args)

      return { home, spawns, links, run }
    })

  it.effect(
    "passes repeatable --from, --to, and --with on vibest run",
    () =>
      Effect.gen(function* () {
        const d = yield* linkDaemon()

        const r = yield* d.run([
          "run",
          "--from",
          "aaaa1111",
          "--from",
          "bbbb2222",
          "--to",
          "cccc3333",
          "--with",
          "dddd4444",
          "pi",
          "--",
          "do work",
        ])

        assert.strictEqual(r.code, 0, r.stderr)
        assert.deepStrictEqual(JSON.parse(r.stdout), { id: spawnedId })
        assert.deepInclude(d.spawns[0], {
          harness: "pi",
          prompt: "do work",
          from: [{ id: "aaaa1111" }, { id: "bbbb2222" }],
          to: [{ id: "cccc3333" }],
          with: [{ id: "dddd4444" }],
        })
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )

  it.effect(
    "parses vibest session link and unlink for mutual, directed, and chain modes",
    () =>
      Effect.gen(function* () {
        const d = yield* linkDaemon()

        const mutual = yield* d.run(["session", "link", "a", "b", "c"])
        assert.strictEqual(mutual.code, 0, mutual.stderr)
        assert.deepStrictEqual(JSON.parse(mutual.stdout), { edges: [{ from: { id: "a" }, to: { id: "b" } }] })

        const directed = yield* d.run(["session", "link", "a", "b", "--to", "c", "--to", "d"])
        assert.strictEqual(directed.code, 0, directed.stderr)

        const chain = yield* d.run(["session", "link", "--chain", "a", "b", "c"])
        assert.strictEqual(chain.code, 0, chain.stderr)

        const unlinked = yield* d.run(["session", "unlink", "a", "--to", "b"])
        assert.strictEqual(unlinked.code, 0, unlinked.stderr)

        assert.deepStrictEqual(d.links, [
          { method: "Session.Link", spec: EdgeMutual.make({ ids: [{ id: "a" }, { id: "b" }, { id: "c" }] }) },
          {
            method: "Session.Link",
            spec: EdgeDirected.make({ from: [{ id: "a" }, { id: "b" }], to: [{ id: "c" }, { id: "d" }] }),
          },
          { method: "Session.Link", spec: EdgeChain.make({ ids: [{ id: "a" }, { id: "b" }, { id: "c" }] }) },
          { method: "Session.Unlink", spec: EdgeDirected.make({ from: [{ id: "a" }], to: [{ id: "b" }] }) },
        ])

        const bad = yield* d.run(["session", "link", "--chain", "a", "--to", "b"])
        assert.notStrictEqual(bad.code, 0, bad.stdout)
        assert.include(bad.stderr, "EmptyInput: give --chain or --to, not both")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )
})
