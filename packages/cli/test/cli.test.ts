import net from "node:net"

import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { PluginLoader } from "@vibest/core/plugin-sources"
import { Project } from "@vibest/core/project"
import { unwrapped } from "@vibest/core/replies"
import { Sessions } from "@vibest/core/sessions"
import { PROTOCOL } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { HANDOFF_ENV } from "@vibest/server/daemon"
import * as Server from "@vibest/server/server"
import { ConfigProvider, Effect, Exit, FileSystem, Fiber, Layer, Option, Path, type Scope, Schema } from "effect"
import { Command } from "effect/cli"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import * as Cli from "../src/cli.ts"
import {
  FakeRuntime,
  makeRepository,
  runVibest as vibest,
  tempDirectory,
  testLayer,
  type TestServices,
  until,
  writeEnd,
  systemPromptFile,
  projectOf,
  callerPlugin,
} from "./fakes.ts"

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer()),
)

const TIMEOUT = 30_000

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(served)), TIMEOUT)

const coordinatorUpdate = (agent: string, args: ReadonlyArray<string>) =>
  agent === "coordinator" && args[0] === "update"

const asEntryEnv = (
  env: Record<string, string>,
  entry: { readonly sessionId: string; readonly projectId: string },
) => ({
  ...env,
  VIBEST_AGENT: "coordinator",
  VIBEST_SESSION_ID: entry.sessionId,
  VIBEST_PROJECT_ID: String(entry.projectId),
})

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
describe("vibest CLI", () => {
  test(
    "vibest run without a harness starts on the entry session's harness; auto is an unknown harness; a harness name alone is a missing prompt",
    Effect.gen(function* () {
      const db = yield* Db
      const layout = yield* Layout
      const repo = yield* makeRepository
      const entry = yield* db.startEntry(
        yield* projectOf(repo),
        "claude",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p1" },
        },
        { agent: "coordinator" },
      )
      const run = (args: ReadonlyArray<string>) =>
        vibest(repo, asEntryEnv({ HOME: layout.home, VIBEST_HOME: layout.home }, entry), args)
      const inherited = yield* run(["run", "--runtime", "herdr", "--", "do it"])
      assert.strictEqual(inherited.code, 0, inherited.stderr)
      const { id } = decodeJson(inherited.stdout) as { id: string }
      assert.strictEqual((yield* db.getSession(id))?.harnessId, "claude")
      const auto = yield* run(["run", "--runtime", "herdr", "auto", "--", "do it"])
      assert.notStrictEqual(auto.code, 0)
      assert.include(auto.stderr, "no plugin provides harness auto")
      const before = (yield* db.listSessions()).length
      const forgotten = yield* run(["run", "--runtime", "herdr", "claude"])
      assert.notStrictEqual(forgotten.code, 0)
      assert.include(forgotten.stderr, "the prompt is missing: claude is a harness")
      assert.strictEqual((yield* db.listSessions()).length, before)
    }),
  )

  test(
    "plain CLI: run, status, send and ls print JSON; input is literal; empty input and unknown commands fail",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const layout = yield* Layout
      const repo = yield* makeRepository
      const entry = yield* db.startEntry(
        yield* projectOf(repo),
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p1" },
        },
        { agent: "coordinator" },
      )
      const user = { HOME: layout.home, VIBEST_HOME: layout.home }
      const run = (args: ReadonlyArray<string>, stdin?: string) => vibest(repo, user, args, stdin)
      const runAsEntry = (args: ReadonlyArray<string>, stdin?: string) =>
        vibest(repo, asEntryEnv(user, entry), args, stdin)

      const task = `it's "$HOME" and \`x\`\nsecond line`
      const spawned = yield* runAsEntry(["run", "--runtime", "herdr", "pi", "-"], task)
      assert.strictEqual(spawned.code, 0, spawned.stderr)
      const { id } = decodeJson(spawned.stdout) as { id: string }
      yield* until(db.getSession(id), (w) => w?.executionState === "open")
      yield* until(herdr.callsTo("send"), (calls) => calls.length > 0)
      assert.strictEqual(unwrapped((yield* herdr.callsTo("send"))[0]!.text!), task)

      const live = ["idle", "working", "blocked", "done", "unknown"]
      const { sessions: listed, machines } = decodeJson((yield* run(["ls"])).stdout) as {
        sessions: Array<{
          id: string
          status: string
          executionState: string
          task: string
          latest: { status: string; summary: string; endedAt: number | null }
        }>
        machines: Array<unknown>
      }
      assert.deepStrictEqual(machines, [])
      assert.deepInclude(
        listed.find((w) => w.id === id),
        {
          id,
          executionState: "open",
          task,
          latest: { status: "working", summary: "", endedAt: null },
        },
      )
      assert.include(live, listed.find((w) => w.id === id)!.status)
      assert.deepInclude(decodeJson((yield* run(["result", id])).stdout), {
        id,
        executionState: "open",
        task,
        reply: null,
      })
      yield* writeEnd(id, "pi", { text: "kept finding\nstatus: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      const done = decodeJson((yield* run(["result", id])).stdout) as {
        reply: { status: string; text: string }
        task: string
        latest: { status: string; summary: string; endedAt: number | null }
      }
      assert.deepInclude(done.reply, { status: "completed" })
      assert.include(done.reply.text, "kept finding")
      assert.strictEqual(done.task, task)
      assert.strictEqual(done.latest.status, "completed")
      assert.strictEqual(done.latest.summary, "kept finding")
      assert.isNumber(done.latest.endedAt)

      assert.deepStrictEqual(decodeJson((yield* run(["send", id, "--", "--help me: $1 'q'"])).stdout), {
        id,
        queued: true,
      })
      yield* until(herdr.callsTo("send"), (calls) => calls.at(-1)!.text === "--help me: $1 'q'")

      const empty = yield* run(["send", id, "-"], "")
      assert.deepStrictEqual([empty.code, empty.stdout], [1, ""])
      assert.match(empty.stderr, /^EmptyInput: /)
      const missing = yield* run(["result", "0e0e0000-0e0e-40e0-80e0-0e0e00000e0e"])
      assert.deepStrictEqual([missing.code, missing.stdout], [1, ""])
      assert.match(missing.stderr, /^NoSuchSession: /)
      assert.strictEqual((yield* run(["frobnicate"])).code, 2)
      assert.strictEqual((yield* run(["status", id])).code, 2)

      const { id: other } = decodeJson(
        (yield* runAsEntry(["run", "--runtime", "herdr", "pi", "-"], "other")).stdout,
      ) as {
        id: string
      }
      yield* until(db.getSession(other), (w) => w?.executionState === "open")
      yield* db.updateSession(id, { status: "unknown", exitedAt: 1 })
      const ids = (args: ReadonlyArray<string>) =>
        run(args).pipe(
          Effect.map((r) =>
            (decodeJson(r.stdout) as { sessions: Array<{ id: string }> }).sessions
              .map((w) => w.id)
              .filter((w) => w !== entry.sessionId)
              .sort(),
          ),
        )
      assert.deepStrictEqual(yield* ids(["ls"]), [other])
      assert.deepStrictEqual(yield* ids(["ls", "--all"]), [id, other].sort())
      assert.deepStrictEqual(yield* ids(["ls", "-a"]), [id, other].sort())

      const system = decodeJson((yield* run(["status"])).stdout) as {
        client: { version: string }
        daemon: object
        runtimes: ReadonlyArray<{ kind: string; status: string }>
      }
      assert.strictEqual(system.client.version, VERSION)
      assert.deepInclude(system.daemon, { status: "running", version: VERSION, socket: layout.socket })
      assert.deepStrictEqual(system.runtimes, [{ kind: "herdr", status: "online" }])
    }),
  )

  test(
    "a session's vibest runs only what a session may; anything else is Forbidden, an unknown session is refused at Hello, and report is gone",
    Effect.gen(function* () {
      const db = yield* Db
      const layout = yield* Layout
      const repo = yield* makeRepository
      const cli = { HOME: layout.home, VIBEST_HOME: layout.home }
      const entry = yield* db.startEntry(
        yield* projectOf(repo),
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p1" },
        },
        { agent: "coordinator" },
      )
      const printed = decodeJson(
        (yield* vibest(repo, asEntryEnv(cli, entry), ["run", "--runtime", "herdr", "pi", "do it"])).stdout,
      ) as {
        id: string
      }
      assert.deepStrictEqual(Object.keys(printed), ["id"])
      const { id } = printed
      yield* until(db.getSession(id), (w) => w?.executionState === "open")
      const asSession = (sessionId: string, args: ReadonlyArray<string>) =>
        Effect.flatMap(db.sessionIdentity(sessionId), (row) =>
          vibest(
            repo,
            {
              ...cli,
              VIBEST_AGENT: "general",
              VIBEST_SESSION_ID: sessionId,
              VIBEST_PROJECT_ID: String(row?.projectId ?? ""),
            },
            args,
          ),
        )

      for (const args of [
        ["machine", "ls"],
        ["machine", "rm", "x"],
      ]) {
        const r = yield* asSession(id, args)
        assert.deepStrictEqual([r.code, r.stdout], [1, ""], args.join(" "))
        assert.match(r.stderr, /^Forbidden: /, args.join(" "))
      }
      const started = yield* asSession(id, ["run", "--runtime", "herdr", "pi", "x"])
      assert.strictEqual(started.code, 0, started.stderr)
      assert.deepStrictEqual(yield* db.creatorOf((decodeJson(started.stdout) as { id: string }).id), { local: id })
      assert.match(
        (yield* asSession("0e0e0000-0e0e-40e0-80e0-0e0e00000e0e", ["send", id, "x"])).stderr,
        /^NoSuchSession: /,
      )
      assert.notStrictEqual((yield* vibest(repo, cli, ["report", "x"])).code, 0)
    }),
  )

  test(
    "archive: the entry session archives its own session through vibestd and git; rm does the same; a session, or another entry session, is refused",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const layout = yield* Layout
      const repo = yield* makeRepository
      const cli = { HOME: layout.home, VIBEST_HOME: layout.home }
      const entry = yield* db.startEntry(
        yield* projectOf(repo),
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p1" },
        },
        { agent: "coordinator" },
      )
      const asCoord = (args: ReadonlyArray<string>) =>
        vibest(
          repo,
          {
            ...cli,
            VIBEST_AGENT: "coordinator",
            VIBEST_SESSION_ID: entry.sessionId,
            VIBEST_PROJECT_ID: String(entry.projectId),
          },
          args,
        )
      const otherRepo = yield* makeRepository
      const other = yield* db.startEntry(
        yield* projectOf(otherRepo),
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "w9:p9" },
        },
        { agent: "coordinator" },
      )

      for (const command of ["archive", "rm"] as const) {
        const spawned = yield* asCoord(["run", "pi", "--", "do it"])
        const { id } = decodeJson(spawned.stdout) as { id: string }
        yield* until(db.getSession(id), (w) => w?.executionState === "open")
        yield* writeEnd(id, "pi", { text: "status: completed" })
        yield* herdr.endExecution(id)
        yield* sessions.check(id)
        const worktree = yield* db.sessionDirectory(id)
        if (worktree === undefined) return yield* Effect.die(`spawned ${id} has no worktree path`)

        for (const r of [
          yield* vibest(
            repo,
            { ...cli, VIBEST_AGENT: "general", VIBEST_SESSION_ID: id, VIBEST_PROJECT_ID: String(entry.projectId) },
            [command, id],
          ),
          yield* vibest(
            otherRepo,
            {
              ...cli,
              VIBEST_AGENT: "coordinator",
              VIBEST_SESSION_ID: other.sessionId,
              VIBEST_PROJECT_ID: String(other.projectId),
            },
            [command, id],
          ),
        ]) {
          assert.strictEqual(r.code, 1, command)
          assert.match(r.stderr, /^Forbidden: /, command)
        }
        assert.isTrue(yield* fs.exists(worktree))
        assert.strictEqual((yield* db.getSession(id))!.status, "idle")

        const archived = yield* asCoord([command, id])
        assert.strictEqual(archived.code, 0, archived.stderr)
        assert.deepStrictEqual(decodeJson(archived.stdout), {
          id,
          processes: "exited",
          pane: "closed",
          workspace: "none",
          worktree: "removed",
          path: worktree,
          branch: null,
          reasons: [],
        })
        assert.isFalse(yield* fs.exists(worktree))
        const row = (yield* db.getSession(id))!
        assert.strictEqual(row.metadata.archived, true)
        assert.strictEqual(row.metadata.removed, true)
        const again = command === "archive" ? "rm" : "archive"
        assert.deepInclude(decodeJson((yield* asCoord([again, id])).stdout) as object, {
          worktree: "gone",
          reasons: [`${worktree} was already gone`],
        })

        const busy = decodeJson((yield* asCoord(["run", "pi", "--", "more"])).stdout) as { id: string }
        yield* until(db.getSession(busy.id), (w) => w?.executionState === "open")
        const stopped = yield* asCoord([command, busy.id])
        assert.strictEqual(stopped.code, 0, stopped.stderr)
        assert.deepInclude(decodeJson(stopped.stdout) as object, {
          processes: "exited",
          pane: "closed",
          worktree: "removed",
        })
        const stoppedRow = (yield* db.getSession(busy.id))!
        assert.strictEqual(stoppedRow.metadata.archived, true)
        assert.strictEqual(stoppedRow.metadata.removed, true)
      }
    }),
  )

  test(
    "archive keeps the stored answer after the rules file is removed",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const layout = yield* Layout
      const repo = yield* makeRepository
      const cli = { HOME: layout.home, VIBEST_HOME: layout.home }
      const run = (args: ReadonlyArray<string>) => vibest(repo, cli, args)
      const entry = yield* db.startEntry(
        yield* projectOf(repo),
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p1" },
        },
        { agent: "coordinator" },
      )
      const { id } = decodeJson(
        (yield* vibest(repo, asEntryEnv(cli, entry), ["run", "--runtime", "herdr", "pi", "do it"])).stdout,
      ) as { id: string }
      yield* until(db.getSession(id), (w) => w?.executionState === "open")
      const finding = "status: completed\nsummary: kept finding"
      yield* writeEnd(id, "pi", { text: finding })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      const before = decodeJson((yield* run(["result", id])).stdout) as { reply: { text: string } }
      assert.include(before.reply.text, "kept finding")
      assert.isTrue(yield* fs.exists(yield* systemPromptFile(id)))

      const archived = yield* run(["archive", id])
      assert.strictEqual(archived.code, 0, archived.stderr)
      assert.isFalse(yield* fs.exists(yield* systemPromptFile(id)))

      const after = decodeJson((yield* run(["result", id])).stdout) as { id: string; reply: object }
      assert.strictEqual(after.id, id)
      assert.deepStrictEqual(after.reply, before.reply)
    }),
  )
})

describe("vibest CLI without vibestd", () => {
  it.effect(
    "an agent's vibest does not start vibestd (it would run in the agent's sandbox); it says to ask the user; the entry session may still run update from its own shell",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* tempDirectory("vibest-cli-")
        const vibestHome = path.join(home, "vibest")
        const commands = [
          ["ls"],
          ["send", "abcd1234-abcd-4abc-8abc-abcd1234abcd", "--", "x"],
          ["run", "pi", "--", "x"],
          ["project", "info"],
          ["plugins"],
          ["daemon"],
          ["daemon", "--foreground"],
          ["daemon", "restart"],
          ["--harness", "pi"],
          ["update"],
        ]
        const runs = [
          { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" },
          { VIBEST_AGENT: "coordinator", VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" },
        ]
          .flatMap((env) => commands.map((args) => ({ env, args })))
          .filter(({ env, args }) => !coordinatorUpdate(env.VIBEST_AGENT, args))
        yield* Effect.forEach(
          runs,
          ({ env, args }) =>
            vibest(home, { HOME: home, VIBEST_HOME: vibestHome, ...env }, args).pipe(
              Effect.map((r) => {
                const what = `${Object.keys(env)[0]} ${args.join(" ")}`
                assert.deepStrictEqual([r.code, r.stdout], [1, ""], what)
                const userOnly = args[1] === "restart" ? `${args[0]} ${args[1]}` : args[0]
                if (args[0]!.startsWith("--"))
                  assert.match(r.stderr, /^Forbidden: an agent may not run vibest; ask the user to/, what)
                else if (["daemon", "update"].includes(args[0]!))
                  assert.match(
                    r.stderr,
                    new RegExp(`^Forbidden: an agent may not run vibest ${userOnly}; ask the user to`),
                    what,
                  )
                else
                  assert.match(
                    r.stderr,
                    /^DaemonUnavailable: vibestd is unreachable on .*; ask the user to check it, or to run: vibest daemon/,
                    what,
                  )
              }),
            ),
          { concurrency: 4, discard: true },
        )
        const status = yield* vibest(
          home,
          {
            HOME: home,
            VIBEST_HOME: vibestHome,
            VIBEST_AGENT: "coordinator",
            VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
          },
          ["status"],
        )
        assert.strictEqual(status.code, 0, status.stderr)
        assert.deepInclude(decodeJson(status.stdout), {
          daemon: { status: "not running", socket: path.join(vibestHome, "vibest.sock") },
          runtimes: null,
        })
        assert.isFalse(yield* fs.exists(vibestHome))
        for (const dir of [".claude", ".cursor", ".pi"]) assert.isFalse(yield* fs.exists(path.join(home, dir)), dir)
      }).pipe(Effect.provide(Platform.services)),
    TIMEOUT,
  )

  it.effect(
    "help and version only print: vibestd is not contacted or started and no file changes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* tempDirectory("vibest-help-")
        const vibestHome = `${home}/vibest`
        yield* fs.makeDirectory(vibestHome)
        let contacts = 0
        const server = net.createServer((socket) => {
          contacts++
          socket.destroy()
        })
        yield* Effect.acquireRelease(
          Effect.callback<void>((resume) => void server.listen(`${vibestHome}/vibest.sock`, () => resume(Effect.void))),
          () => Effect.sync(() => server.close()),
        )
        const files = Effect.gen(function* () {
          const names = (yield* fs.readDirectory(home, { recursive: true })).sort()
          return yield* Effect.forEach(names, (name) =>
            Effect.map(
              fs.stat(`${home}/${name}`),
              (s) => `${name} ${s.size} ${Option.getOrUndefined(s.mtime)?.getTime()}`,
            ),
          )
        })
        const before = yield* files
        const env = { HOME: home, VIBEST_HOME: vibestHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }
        const coordinator = { VIBEST_AGENT: "coordinator", VIBEST_SESSION_ID: "c0ffee00-c0ff-4c0f-8c0f-c0ffee00c0ff" }
        const general = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" }
        const runs = [
          [{}, ["daemon", "--foreground", "--help"]],
          [{}, ["update", "--help"]],
          [{}, ["integration", "install", "--help"]],
          [{}, ["nope", "--help"]],
          [{}, ["--version"]],
          [coordinator, ["daemon", "-h"]],
          [general, ["update", "--help"]],
          [general, ["-v"]],
          [{}, ["daemon", "restart", "--help"]],
          [coordinator, ["daemon", "restart", "--help"]],
          [general, ["daemon", "restart", "-h"]],
        ] as const
        const results = yield* Effect.forEach(runs, ([extra, args]) => vibest(home, { ...env, ...extra }, args))
        for (const [i, r] of results.entries()) {
          const args = runs[i]![1]
          assert.strictEqual(r.code, 0, `${args.join(" ")}: ${r.stderr}`)
          assert.match(r.stdout, ["--version", "-v"].includes(args.join(" ")) ? /^vibest v\d/ : /USAGE/, args.join(" "))
        }
        assert.strictEqual(contacts, 0)
        assert.deepStrictEqual(yield* files, before)
        const removed = yield* vibest(home, env, ["daemon", "--restart"])
        assert.strictEqual(removed.code, 2, removed.stderr)
        assert.match(removed.stderr, /--restart/)
        assert.notMatch(removed.stdout + removed.stderr, /vibestd is running|Stop the running vibestd/)
        assert.strictEqual(contacts, 0)
        assert.deepStrictEqual(yield* files, before)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
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
  const refused = {
    error: {
      _tag: "Cause",
      code: 0,
      message: "no session",
      data: [{ _tag: "Fail", error: { _tag: "NoSuchSession", id, message: `no session ${id}` } }],
    },
  }

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
    "send that vibestd refused is not sent again",
    () =>
      Effect.gen(function* () {
        const d = yield* fakeDaemon({ requests: true }, () => refused)
        const r = yield* d.send
        assert.strictEqual(r.code, 1, r.stdout)
        assert.match(r.stderr, /^NoSuchSession/)
        assert.lengthOf(d.sends, 1)
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

  const spawnProbe = (capabilities: Record<string, boolean>, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const home = yield* tempDirectory("vibest-spawn-runtime-")
      const calls: Array<{ method: string | undefined; params: { runtime?: string } | undefined }> = []
      const server = net.createServer((sock) => {
        let buf = ""
        sock.on("data", (chunk) => {
          buf += chunk.toString()
          for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
            const req = JSON.parse(buf.slice(0, nl)) as {
              id?: string
              method?: string
              params?: { runtime?: string }
            }
            buf = buf.slice(nl + 1)
            calls.push({ method: req.method, params: req.params })
            const reply = (body: object) => sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }) + "\n")
            if (req.method === "Ping")
              reply({ result: { protocol: PROTOCOL, version: VERSION, runtimes: [], capabilities } })
            else if (req.method === "Spawn")
              reply({
                result: {
                  id: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
                  harness: "pi",
                  decidedBy: {},
                  trace: [],
                },
              })
          }
        })
      })
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => void server.listen(`${home}/vibest.sock`, () => resume(Effect.void))),
        () => Effect.sync(() => server.close()),
      )
      return {
        calls,
        run: vibest(
          home,
          {
            HOME: home,
            VIBEST_HOME: home,
            VIBEST_AGENT: "general",
            VIBEST_SESSION_ID: "dcba4321-dcba-4abc-8abc-dcba4321dcba",
          },
          args,
        ),
      }
    })

  it.effect(
    "vibest run --runtime is refused when vibestd has no spawnRuntime capability, and is sent when it does",
    () =>
      Effect.gen(function* () {
        const missing = yield* spawnProbe({ http: true, handoff: true, requests: true, watch: true }, [
          "run",
          "--runtime",
          "herdr",
          "pi",
          "do it",
        ])
        const refused = yield* missing.run
        assert.notStrictEqual(refused.code, 0, refused.stdout)
        assert.match(refused.stderr, /does not take --runtime/)
        assert.notInclude(
          missing.calls.map((call) => call.method),
          "Spawn",
        )
        const plain = yield* spawnProbe({ http: true, handoff: true, requests: true, watch: true }, [
          "run",
          "pi",
          "do it",
        ])
        const spawned = yield* plain.run
        assert.strictEqual(spawned.code, 0, spawned.stderr)
        assert.strictEqual(plain.calls.find((call) => call.method === "Spawn")?.params?.runtime ?? null, null)
        const capable = yield* spawnProbe({ spawnRuntime: true }, ["run", "--runtime", "herdr", "pi", "do it"])
        const accepted = yield* capable.run
        assert.strictEqual(accepted.code, 0, accepted.stderr)
        assert.strictEqual(capable.calls.find((call) => call.method === "Spawn")?.params?.runtime, "herdr")
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

it.effect("vibest execs the daemon command over the process environment and never loads plugins", () =>
  Effect.gen(function* () {
    const repo = yield* makeRepository
    const back = process.cwd()
    process.chdir(repo)
    const prev = {
      HERDR_PANE_ID: process.env.HERDR_PANE_ID,
      HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
      VIBEST_SESSION_ID: process.env.VIBEST_SESSION_ID,
      VIBEST_AGENT: process.env.VIBEST_AGENT,
    }
    process.env.HERDR_PANE_ID = "w1:p1"
    process.env.HERDR_SOCKET_PATH = "/h.sock"
    delete process.env.VIBEST_SESSION_ID
    delete process.env.VIBEST_AGENT
    const seen: Array<{ file: string; args: ReadonlyArray<string>; env: Record<string, string> }> = []
    const exit = yield* Command.runWith(
      Cli.command(Platform.daemon, Platform.replacements, (file, args, env) => {
        seen.push({
          file,
          args,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
            ),
            ...env,
          },
        })
      }),
      { version: "0.0.0-test" },
    )(["--harness", "pi"]).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            HERDR_PANE_ID: "w1:p1",
            HERDR_SOCKET_PATH: "/h.sock",
            HOME: process.env.HOME,
            PATH: process.env.PATH,
          }),
        ),
      ),
      Effect.provideService(PluginLoader, {
        prepare: Effect.die("PluginLoader"),
        parseJsonc: () => {
          throw new Error("PluginLoader")
        },
        graph: () => {
          throw new Error("PluginLoader")
        },
        load: () => Promise.reject(new Error("PluginLoader")),
        watch: () => () => undefined,
      }),
      Effect.exit,
      Effect.ensuring(
        Effect.sync(() => {
          process.chdir(back)
          if (prev.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID
          else process.env.HERDR_PANE_ID = prev.HERDR_PANE_ID
          if (prev.HERDR_SOCKET_PATH === undefined) delete process.env.HERDR_SOCKET_PATH
          else process.env.HERDR_SOCKET_PATH = prev.HERDR_SOCKET_PATH
          if (prev.VIBEST_SESSION_ID === undefined) delete process.env.VIBEST_SESSION_ID
          else process.env.VIBEST_SESSION_ID = prev.VIBEST_SESSION_ID
          if (prev.VIBEST_AGENT === undefined) delete process.env.VIBEST_AGENT
          else process.env.VIBEST_AGENT = prev.VIBEST_AGENT
        }),
      ),
    )
    assert.strictEqual(Exit.isSuccess(exit), true, Exit.isFailure(exit) ? String(exit.cause) : "")
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0]!.file, "pi")
    assert.ok(seen[0]!.env.VIBEST_SESSION_ID)
    assert.strictEqual(seen[0]!.env.PATH, process.env.PATH)
  }).pipe(
    Effect.provide(
      Server.layer.pipe(
        Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
        Layer.provideMerge(Project.layer),
        Layer.provideMerge(
          testLayer({
            plugins: [
              callerPlugin("herdr", {
                env: ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"],
                terminal: (env) => Effect.succeed(env.HERDR_PANE_ID),
              }),
            ],
          }),
        ),
      ),
    ),
  ),
)

test(
  "daemon --foreground --import drops VIBEST_HANDOFF_ENV before it runs",
  Effect.gen(function* () {
    const agent = process.env.VIBEST_SESSION_ID
    const who = process.env.VIBEST_AGENT
    delete process.env.VIBEST_SESSION_ID
    delete process.env.VIBEST_AGENT
    process.env[HANDOFF_ENV] = "from-the-old-daemon"
    const fiber = yield* Effect.forkChild(
      Command.runWith(
        Cli.command(Platform.daemon, Platform.replacements, () => {}),
        { version: "0.0.0-test" },
      )(["daemon", "--foreground", "--import"]).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: process.env.HOME, PATH: process.env.PATH })),
        ),
      ),
    )
    for (let i = 0; i < 10 && process.env[HANDOFF_ENV] !== undefined; i++) yield* TestClock.adjust("20 millis")
    assert.strictEqual(process.env[HANDOFF_ENV], undefined)
    yield* Fiber.interrupt(fiber)
    if (agent === undefined) delete process.env.VIBEST_SESSION_ID
    else process.env.VIBEST_SESSION_ID = agent
    if (who === undefined) delete process.env.VIBEST_AGENT
    else process.env.VIBEST_AGENT = who
  }),
)
