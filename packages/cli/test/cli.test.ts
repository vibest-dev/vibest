import net from "node:net"

import { assert, describe, it } from "@effect/vitest"
import { runVibest as vibest, tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { PROTOCOL } from "@vibest/schema/version"
import { Effect, FileSystem, Path, Schema } from "effect"

import * as Platform from "#platform"

import { bareTeam } from "../src/commands/commands.ts"
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

describe("vibest run --team", () => {
  type SpawnCall = { harness?: string | null; prompt?: string; team?: string; newTeam?: boolean }

  type TeamListCall = { team?: string }

  const agentEnv = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" }
  const spawnedId = "11111111-1111-4111-8111-111111111111"

  const teamDaemon = (capabilities: Record<string, boolean>) =>
    Effect.gen(function* () {
      const home = yield* tempDirectory("vibest-team-cli-")
      const spawns: Array<SpawnCall> = []
      const teamLists: Array<TeamListCall> = []

      const server = net.createServer((sock) => {
        let buf = ""
        sock.on("data", (chunk) => {
          buf += chunk.toString()

          for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
            const req = JSON.parse(buf.slice(0, nl)) as { id?: string; method?: string; params?: SpawnCall }
            buf = buf.slice(nl + 1)

            const reply = (body: Schema.JsonObject) =>
              sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }) + "\n")

            if (req.method === "Ping")
              reply({ result: { protocol: PROTOCOL, version: VERSION, runtimes: [], capabilities } })
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
                  ...(params.newTeam === true && { team: "t-1234" }),
                  ...(params.team !== undefined && { team: params.team }),
                },
              })
            } else if (req.method === "Team.List") {
              if (capabilities.teams !== true) {
                sock.write(
                  `{"jsonrpc":"2.0","id":${JSON.stringify(req.id)},"error":{"_tag":"Cause","code":0,"message":"Unknown request tag: Team.List","data":[{"_tag":"Die","defect":"Unknown request tag: Team.List"}]}}\n`,
                )
              } else {
                const params: TeamListCall = req.params ?? {}
                teamLists.push(params)
                reply({ result: { team: params.team ?? "t-1234", members: [] } })
              }
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

      return { home, spawns, teamLists, run }
    })

  it("takes the next word as the team id only when it has the id's form", () => {
    assert.deepStrictEqual(bareTeam(["run", "--team", "pi", "--", "task"]), ["run", "--team=", "pi", "--", "task"])
    assert.deepStrictEqual(bareTeam(["run", "pi", "--team", "--", "task"]), ["run", "pi", "--team=", "--", "task"])
    assert.deepStrictEqual(bareTeam(["run", "--team", "--env", "A=1", "pi"]), ["run", "--team=", "--env", "A=1", "pi"])
    assert.deepStrictEqual(bareTeam(["run", "--team", "t-3f2a", "pi"]), ["run", "--team", "t-3f2a", "pi"])
    assert.deepStrictEqual(bareTeam(["run", "pi", "--", "--team"]), ["run", "pi", "--", "--team"])
    assert.deepStrictEqual(bareTeam(["ls", "--team", "t-3f2a"]), ["ls", "--team", "t-3f2a"])
  })

  it.effect(
    "refuses repeated --team flags on vibest run instead of dropping one",
    () =>
      Effect.gen(function* () {
        const d = yield* teamDaemon({ requests: true, teams: true })

        for (const args of [
          ["run", "--team", "--team", "t-1234", "pi", "--", "do work"],
          ["run", "--team", "t-1234", "--team", "pi", "--", "do work"],
          ["run", "--team", "t-1234", "--team", "t-5678", "pi", "--", "do work"],
        ]) {
          const r = yield* d.run(args)
          assert.notStrictEqual(r.code, 0, `${args.join(" ")}: ${r.stdout}`)
          assert.include(r.stderr, "EmptyInput: give --team only once")
        }

        assert.lengthOf(d.spawns, 0)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )

  it.effect(
    "refuses vibest ls --team with LaunchFailed when vibestd lacks capabilities.teams",
    () =>
      Effect.gen(function* () {
        const d = yield* teamDaemon({ requests: true })
        const r = yield* d.run(["ls", "--team"])
        assert.strictEqual(r.code, 1, r.stdout)
        assert.strictEqual(
          r.stderr.trim(),
          "LaunchFailed: this vibestd does not take --team on vibest ls; run vibest update",
        )
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )

  it.effect(
    "rewrites bare --team when a value-taking global flag precedes run",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(bareTeam(["--log-level", "debug", "run", "--team", "pi", "--", "do work"]), [
          "--log-level",
          "debug",
          "run",
          "--team=",
          "pi",
          "--",
          "do work",
        ])
        assert.deepStrictEqual(bareTeam(["--log-level", "info", "run", "--team", "--", "do work"]), [
          "--log-level",
          "info",
          "run",
          "--team=",
          "--",
          "do work",
        ])
        const d = yield* teamDaemon({ requests: true, teams: true })
        const r1 = yield* d.run(["--log-level", "debug", "run", "--team", "pi", "--", "do work"])
        assert.strictEqual(r1.code, 0, r1.stderr)
        assert.deepInclude(d.spawns[0], { harness: "pi", newTeam: true, prompt: "do work" })
        assert.isUndefined(d.spawns[0]?.team)
        const r2 = yield* d.run(["--log-level", "info", "run", "--team", "--", "do work"])
        assert.strictEqual(r2.code, 0, r2.stderr)
        assert.deepInclude(d.spawns[1], { harness: null, newTeam: true, prompt: "do work" })
        assert.isUndefined(d.spawns[1]?.team)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )

  it.effect(
    "refuses vibest ls --team outside an agent session without claiming vibest run was called",
    () =>
      Effect.gen(function* () {
        const d = yield* teamDaemon({ requests: true, teams: true })
        const r = yield* d.run(["ls", "--team"], {})
        assert.strictEqual(r.code, 1, r.stdout)
        assert.strictEqual(r.stderr.trim(), "Forbidden: vibest ls --team is run by an agent in a session")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )

  it.effect(
    "vibest ls rejects positional arguments without team-name wording and accepts --team=<id>",
    () =>
      Effect.gen(function* () {
        const d = yield* teamDaemon({ requests: true, teams: true })
        const bad = yield* d.run(["ls", "foo"])
        assert.notStrictEqual(bad.code, 0, bad.stdout)
        assert.notInclude(bad.stderr, "takes a name")

        const eq = yield* d.run(["ls", "--team=t-1234"])
        assert.strictEqual(eq.code, 0, eq.stderr)
        const sp = yield* d.run(["ls", "--team", "t-1234"])
        assert.strictEqual(sp.code, 0, sp.stderr)
        const bare = yield* d.run(["ls", "--team"])
        assert.strictEqual(bare.code, 0, bare.stderr)
        assert.deepStrictEqual(d.teamLists, [{ team: "t-1234" }, { team: "t-1234" }, {}])

        const twice = yield* d.run(["ls", "--team", "--team", "t-1234"])
        assert.notStrictEqual(twice.code, 0, twice.stdout)
        assert.include(twice.stderr, "EmptyInput: give --team only once")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    TIMEOUT,
  )
})
