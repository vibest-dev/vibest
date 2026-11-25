import http from "node:http"

import { assert, describe, it } from "@effect/vitest"
import { HttpConnector } from "@vibest/client/client"
import { SocketConnector as VibestSocketConnector } from "@vibest/client/socket-connector"
import { Db } from "@vibest/core/database/db"
import { check } from "@vibest/core/guard"
import { Plugins } from "@vibest/core/plugin"
import { Project } from "@vibest/core/project"
import { SocketConnector } from "@vibest/herdr-sdk"
import { Plugin as PromisePlugin, ToolRefused as PromiseToolRefused } from "@vibest/plugin"
import { Plugin, ToolRefused } from "@vibest/plugin/effect"
import { Forbidden } from "@vibest/protocol/errors"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import type { Host } from "@vibest/server/daemon"
import * as Server from "@vibest/server/server"
import { FakeGit, HARNESSES, makeRepository, testLayer } from "@vibest/testkit/fakes"
import { spawnWorking } from "@vibest/testkit/sessions-helpers"
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Path, Queue, Stdio, Terminal } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

import { shellRefusal, splitCommand } from "../../plugin-builtins/src/guard.ts"
import { Commands, entryFlags } from "../src/commands/commands.ts"
import { Runtime as CliRuntime } from "../src/framework/runtime.ts"
import { Spec } from "../src/framework/spec.ts"
import { Host as CliHost } from "../src/host.ts"

describe("vibest.guard shell rules", () => {
  it("allows normal commands and previously restricted commands by default", () => {
    for (const command of [
      "touch x",
      "echo hi > y",
      "jq . package.json",
      "sort a | uniq -c",
      "X=push git status",
      "FOO=1 bun test",
      "env -i PATH=/bin ls",
      "git commit -m x",
      "git push",
      "hc --version",
      "hc pane list",
      "herdr pane list",
      "herdr --help",
      "rex status",
      "ls ~/.vibest/worktrees/vibest/1234/src/*.ts",
      "cat ~/.vibest/projects/other/notes.md",
      "gh auth token",
      "claude -p x",
      "vibest connect",
      "vibest machine ls",
      "rg vibest.sock src",
      "grep vibest.sock src/server.ts",
      'git commit -m "vibest.sock"',
      "ls ~/.vibest/vibest.sock",
      "cat ~/.vibest/vibestd.log",
      "echo ~/.vibest/vibest.sock",
      "curl https://example.com",
      "vibest run pi 'curl --unix-socket ~/.vibest/vibest.sock http://vibest/api/hook/ready'",
      "vibest run pi - <<'EOF'\ncurl --unix-socket ~/.vibest/vibest.sock http://vibest/api/hook/ready\nEOF",
      "ls # curl --unix-socket ~/.vibest/vibest.sock",
      "vibest archive abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "vibest send abcd1234-abcd-4abc-8abc-abcd1234abcd x",
      "vibest ls",
      "echo $VIBEST_SESSION_ID",
      "env -u VIBEST_AGENT vibest ls",
    ])
      assert.isUndefined(shellRefusal(command), command)
  })

  it("refuses vibest with VIBEST_SESSION_ID changed or cleared, however it is wrapped or spelled", () => {
    for (const command of [
      "env -u VIBEST_SESSION_ID vibest archive abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "env -u VIBEST_SESSION_ID vibest ls",
      "env -uVIBEST_SESSION_ID vibest ls",
      "env --unset=VIBEST_SESSION_ID vibest ls",
      "env -i PATH=/bin vibest interrupt abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "env - vibest ls",
      "VIBEST_SESSION_ID= vibest archive abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "VIBEST_SESSION_ID=other vibest ls",
      'VIBEST_SESSION_ID=other "$VIBEST_CLI" ls',
      "VIBEST_SESSION_ID=other $VIBEST_CLI ls",
      'VIBEST_SESSION_ID=other "${VIBEST_CLI}" ls',
      'VIBEST_SESSION_ID=other "${VIBEST_CLI:-vibest}" ls',
      'env -u VIBEST_SESSION_ID "$VIBEST_CLI" archive abcd',
      'env -S "VIBEST_SESSION_ID=other vibest ls"',
      "env VIBEST_SESSION_ID= /usr/local/bin/vibest ls",
      "unset VIBEST_SESSION_ID; vibest archive abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "export VIBEST_SESSION_ID=other && vibest ls",
      "VIBEST_SESSION_ID=; vibest ls",
      "sh -c 'env -u VIBEST_SESSION_ID vibest archive abcd1234-abcd-4abc-8abc-abcd1234abcd'",
      "echo $(VIBEST_SESSION_ID= vibest archive abcd1234-abcd-4abc-8abc-abcd1234abcd)",
      "nohup env -i vibest daemon restart",
      "echo a | VIBEST_SESSION_ID= xargs vibest archive",
    ])
      assert.strictEqual(
        shellRefusal(command),
        "vibest runs with the agent's own VIBEST_SESSION_ID; a command that changes or clears it is refused.",
        command,
      )
  })

  it("refuses socket and HTTP tools targeting vibest.sock, however they are wrapped", () => {
    for (const command of [
      'curl --unix-socket "$VIBEST_HOME/vibest.sock" http://vibest/api/hook/ready',
      "curl --unix-socket=vibest.sock http://vibest/api/hook/cursor/guard",
      "curl --unix-socket=/tmp/vibest.sock http://vibest/api/hook/ready",
      "nc -U ~/.vibest/vibest.sock",
      "ncat -U vibest.sock",
      "netcat -U ~/.vibest/vibest.sock",
      "socat - UNIX-CONNECT:/tmp/vibest.sock",
      "socat - UNIX-CONNECT:vibest.sock",
      "socat - UNIX-CONNECT:/tmp/vibest.sock,crnl",
      "wget --unix-socket=/tmp/vibest.sock http://vibest/api/hook/ready",
      "nohup timeout 5 curl --unix-socket ~/.vibest/vibest.sock http://vibest/api/hook/ready",
      "bash -c 'curl --unix-socket ~/.vibest/vibest.sock http://vibest/api/hook/ready'",
      "x=$(curl --unix-socket ~/.vibest/vibest.sock http://vibest/api/hook/ready)",
    ])
      assert.strictEqual(
        shellRefusal(command),
        "vibest.sock is the vibestd daemon socket, not for agent commands.",
        command,
      )
  })

  it("splits at unquoted separators, leaves out redirections and here-documents, and adds substitutions", () => {
    assert.deepStrictEqual(splitCommand(`rg 'a|b' "c;d" && git log`), [
      ["rg", "a|b", "c;d"],
      ["git", "log"],
    ])
    assert.deepStrictEqual(splitCommand("echo '$x'"), [["echo", "$x"]])
    assert.deepStrictEqual(splitCommand("echo 'open"), [["echo", "open"]])
    assert.deepStrictEqual(splitCommand("git diff 2>&1 > /tmp/x | head -5"), [
      ["git", "diff"],
      ["head", "-5"],
    ])
    assert.deepStrictEqual(splitCommand('echo "a $(git rev-parse HEAD) b" `ls`'), [
      ["echo", "a $(git rev-parse HEAD) b", "`ls`"],
      ["git", "rev-parse", "HEAD"],
      ["ls"],
    ])
    assert.deepStrictEqual(splitCommand("cat <<-'EOF' | wc -l\n\tbody; rm x\n\tEOF\nls"), [
      ["cat"],
      ["wc", "-l"],
      ["ls"],
    ])
  })
})

describe("Guard.check and tool.execute.before hooks", () => {
  const session = {
    id: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
    agent: "general",
    project: "proj-1",
    projectDir: "/tmp/projects/proj-1",
    directory: "/work",
  }

  it.effect("decodes hook input, runs vibest.guard, and fails on malformed input", () =>
    Effect.gen(function* () {
      const allowed = yield* check(
        session,
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "hc --version" }, cwd: "/tmp" }),
      )

      assert.isUndefined(allowed)

      const refused = yield* check(
        session,
        JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "VIBEST_SESSION_ID=other vibest ls" },
          workspace_roots: ["/tmp"],
        }),
      )

      assert.strictEqual(
        refused,
        "vibest runs with the agent's own VIBEST_SESSION_ID; a command that changes or clears it is refused.",
      )

      const noCwd = yield* check(session, JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })).pipe(
        Effect.exit,
      )

      assert.strictEqual(Exit.isFailure(noCwd), true)

      const badCwd = yield* check(
        session,
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls", cwd: 123 }, cwd: "/tmp" }),
      ).pipe(Effect.exit)

      assert.strictEqual(Exit.isFailure(badCwd), true)
    }).pipe(
      Effect.provide(testLayer()),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/tmp" }))),
    ),
  )

  it.effect(
    "Effect and Promise tool.execute.before plugins receive session/tool/input/cwd, refuse calls, and count stats",
    () => {
      const seenEffect: Array<unknown> = []
      const seenPromise: Array<unknown> = []

      const effectGuard = Plugin.define({
        id: "effect-guard",
        effect: (ctx) =>
          ctx.session.hook("tool.execute.before", (event) =>
            Effect.gen(function* () {
              seenEffect.push(event)

              if (event.tool === "Write" && event.input.file_path === "/etc/passwd")
                return yield* new ToolRefused({ reason: "effect plugin refused write" })
            }),
          ),
      })

      const promiseGuard = PromisePlugin.define({
        id: "promise-guard",
        setup: async (ctx) => {
          await ctx.session.hook("tool.execute.before", async (event) => {
            seenPromise.push(event)

            if (event.tool === "Bash" && event.input.command === "rm -rf /")
              throw new PromiseToolRefused({ reason: "promise plugin refused bash" })
          })
        },
      })

      return Effect.gen(function* () {
        const plugins = yield* Plugins.Service

        const r1 = yield* check(
          session,
          JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/etc/passwd" }, cwd: "/work" }),
        )

        assert.strictEqual(r1, "effect plugin refused write")
        assert.deepStrictEqual(seenEffect, [
          { session, tool: "Write", input: { file_path: "/etc/passwd" }, cwd: "/work" },
        ])
        assert.deepStrictEqual(seenPromise, [])

        const r2 = yield* check(
          session,
          JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "/work" }),
        )

        assert.strictEqual(r2, "promise plugin refused bash")
        assert.deepStrictEqual(seenPromise, [{ session, tool: "Bash", input: { command: "rm -rf /" }, cwd: "/work" }])

        const listed = yield* plugins.list
        assert.deepInclude(
          listed.find((p) => p.id === "effect-guard"),
          { calls: 2, refused: 1 },
        )
        assert.deepInclude(
          listed.find((p) => p.id === "promise-guard"),
          { calls: 1, refused: 1 },
        )
      }).pipe(
        Effect.provide(testLayer({ plugins: [effectGuard, promiseGuard as never] })),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/tmp" }))),
      )
    },
  )
})

const EntryCommands = Spec.make("vibest", {
  params: entryFlags,
  commands: [Spec.make("daemon", { commands: [Commands.commands.daemon.commands.restart] })],
})

const untouchableHost = (onTouch: () => void): Host => {
  const touch = () => {
    onTouch()

    return Effect.die("host")
  }

  return { lock: touch, checkDatabase: touch, trimLog: touch, onSignals: touch, exit: touch }
}

const entryHandlers = CliRuntime.handlers(EntryCommands, {
  $: () => import("../src/commands/handlers/default.ts"),
  daemon: { restart: () => import("../src/commands/handlers/daemon/restart.ts") },
})

describe("wizard entry", () => {
  it.effect(
    "a confirmed --wizard (Enter picks daemon, the first subcommand, then restart, its only child) reaches the handler, and a session stops at userOnly before spawn, exec or the daemon host",
    () =>
      Effect.gen(function* () {
        const touched = { spawn: false, exec: false, host: false, socket: false }

        const enter: Terminal.UserInput = {
          input: Option.none(),
          key: { name: "enter", ctrl: false, meta: false, shift: false },
        }

        const keys = yield* Queue.unbounded<Terminal.UserInput>()
        const [pickDaemon, pickRestart, acceptRunDefaultYes] = [enter, enter, enter]
        yield* Queue.offerAll(keys, [pickDaemon, pickRestart, acceptRunDefaultYes])

        const terminal = Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(24),
          size: Queue.unbounded(),
          readInput: Effect.succeed(keys),
          readLine: Effect.die("readline"),
          display: () => Effect.void,
        })

        const host = untouchableHost(() => {
          touched.host = true
        })

        const exit = yield* CliRuntime.run(EntryCommands, entryHandlers, {
          version: "0.0.0-test",
          extra: { after: "daemon", commands: [] },
        }).pipe(
          Effect.provideService(CliHost, {
            daemon: host,
            replacements: [],
            exec: () => {
              touched.exec = true
            },
            parseJsonc: JSON.parse,
          }),
          Effect.provideService(Terminal.Terminal, terminal),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => {
              touched.spawn = true

              return Effect.die("spawned")
            }),
          ),
          Effect.provideService(SocketConnector, () => {
            touched.socket = true

            return Effect.die("socket")
          }),
          Effect.provideService(VibestSocketConnector.Service, () => {
            touched.socket = true

            return Effect.die("socket")
          }),
          Effect.provideService(HttpConnector.Service, () => {
            touched.socket = true

            return Effect.die("http") as never
          }),
          Effect.provide(Digest.layerWebCrypto),
          Effect.provide(SecureRandom.layerWebCrypto),
          Effect.provide(FileSystem.layerNoop({})),
          Effect.provide(Stdio.layerTest({ args: Effect.succeed(["--wizard"]) })),
          Effect.provideServiceEffect(Layout, Layout.make("/nonexistent/.vibest")),
          Effect.provide(Path.layer),
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
                HOME: "/nonexistent",
              }),
            ),
          ),
          Effect.exit,
        )

        const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
        assert.strictEqual(
          error instanceof Forbidden,
          true,
          Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "wizard returned success",
        )
        assert.match(error instanceof Forbidden ? error.message : "", /an agent may not run vibest daemon restart/)
        assert.include(
          error instanceof Forbidden ? error.message : "",
          "This shell carries agent session abcd1234-abcd-4abc-8abc-abcd1234abcd. If you are the user, run it as env -u VIBEST_SESSION_ID vibest daemon restart",
        )
        assert.deepStrictEqual(touched, { spawn: false, exec: false, host: false, socket: false })
      }),
    15_000,
  )
})

describe("vibest --session inside herdr", () => {
  it.effect(
    "the parent-workspace pane refuses --session before any exec or herdr call",
    () =>
      Effect.gen(function* () {
        const touched = { exec: false, host: false, socket: false }
        const repo = yield* makeRepository.pipe(Effect.provide(FakeGit.layer), Effect.provide(Platform.services))
        const back = process.cwd()
        process.chdir(repo)

        const host = untouchableHost(() => {
          touched.host = true
        })

        const exit = yield* CliRuntime.run(EntryCommands, entryHandlers, {
          version: "0.0.0-test",
          extra: { after: "daemon", commands: [] },
        }).pipe(
          Effect.provide(Stdio.layerTest({ args: Effect.succeed(["--session", "other", "--in-parent", repo]) })),
          Effect.provideService(CliHost, {
            daemon: host,
            replacements: [],
            exec: () => {
              touched.exec = true
            },
            parseJsonc: JSON.parse,
          }),
          Effect.provideService(SocketConnector, () => {
            touched.socket = true

            return Effect.die("herdr socket")
          }),
          Effect.provideService(VibestSocketConnector.Service, () => {
            touched.socket = true

            return Effect.die("socket")
          }),
          Effect.provideService(HttpConnector.Service, () => {
            touched.socket = true

            return Effect.die("http") as never
          }),
          Effect.provide(Platform.services),
          Effect.provideServiceEffect(Layout, Layout.make("/nonexistent/.vibest")),
          Effect.provide(Path.layer),
          Effect.provideService(VibestCommand, ["/bin/vibest"]),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                HERDR_PANE_ID: "w1:p1",
                HERDR_SOCKET_PATH: "/h/ambient.sock",
                HOME: "/nonexistent",
              }),
            ),
          ),
          Effect.exit,
          Effect.ensuring(Effect.sync(() => process.chdir(back))),
        )

        assert.strictEqual(Exit.isFailure(exit), true, "vibest started the entry session")
        assert.strictEqual(touched.exec, false)
        assert.strictEqual(touched.host, false)
      }),
    15_000,
  )

  it.effect("below the root continues in this process and types no --env", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository.pipe(Effect.provide(FakeGit.layer))
      const sub = repo + "/sub"
      yield* fs.makeDirectory(sub)
      const back = process.cwd()
      process.chdir(sub)
      const secret = "probe-value-9f3c"
      const herdr: Array<string> = []

      const host = untouchableHost(() => undefined)

      const exit = yield* CliRuntime.run(EntryCommands, entryHandlers, {
        version: "0.0.0-test",
        extra: { after: "daemon", commands: [] },
      }).pipe(
        Effect.provide(Stdio.layerTest({ args: Effect.succeed(["--harness", "pi", "--env", "MAIN_PROBE=" + secret]) })),
        Effect.provideService(CliHost, { daemon: host, replacements: [], exec: () => {}, parseJsonc: JSON.parse }),
        Effect.provideService(SocketConnector, () => {
          herdr.push("connect")

          return Effect.die("herdr")
        }),
        Effect.provideService(VibestSocketConnector.Service, () => Effect.die("socket")),
        Effect.provide(Platform.services),
        Effect.provideServiceEffect(Layout, Layout.make("/nonexistent/.vibest")),
        Effect.provide(Path.layer),
        Effect.provideService(VibestCommand, ["/bin/vibest"]),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/nonexistent" }))),
        Effect.exit,
        Effect.ensuring(Effect.sync(() => process.chdir(back))),
      )

      assert.deepStrictEqual(herdr, [])
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "started"
      assert.notInclude(message, secret)
      assert.strictEqual(Exit.isFailure(exit), true)
    }).pipe(Effect.provide(Platform.services)),
  )
})

describe("HTTP guard through vibestd", () => {
  const cursorAnswer = (reason: string | undefined) =>
    reason ? { permission: "deny", user_message: reason, agent_message: reason } : { permission: "allow" }

  const served = Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.httpServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(
      testLayer({
        harnesses: HARNESSES.map((definition) =>
          definition.id === "cursor" ? { ...definition, guardAnswer: cursorAnswer } : definition,
        ),
      }),
    ),
  )

  it.live(
    "/api/hook/cursor/guard returns Cursor's deny shape for a refused call and its allow shape otherwise",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const repo = yield* makeRepository
        const { id } = yield* spawnWorking(repo, "cursor")
        const identity = (yield* (yield* Db.Service).session.sessionIdentity(id))!

        const guard = (command: string) =>
          Effect.promise(
            () =>
              new Promise<{ readonly status: number; readonly body: unknown }>((resolve, reject) => {
                const req = http.request(
                  {
                    socketPath: layout.socket,
                    method: "POST",
                    path: "/api/hook/cursor/guard",
                    headers: {
                      "content-type": "text/plain",
                      ...sessionHeaders({
                        sessionId: id,
                        projectId: String(identity.projectId),
                        harness: "cursor",
                      }),
                    },
                  },
                  (res) => {
                    let out = ""
                    res.setEncoding("utf8")
                    res.on("data", (chunk: string) => {
                      out += chunk
                    })
                    res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(out) }))
                  },
                )

                req.on("error", reject)
                req.write(JSON.stringify({ tool_name: "Shell", tool_input: { command }, cwd: repo }))
                req.end()
              }),
          )

        const refused = yield* guard('curl --unix-socket "$VIBEST_HOME/vibest.sock" http://vibest/api/hook/ready')
        assert.strictEqual(refused.status, 200)

        const reason = "vibest.sock is the vibestd daemon socket, not for agent commands."

        assert.deepStrictEqual(refused.body, {
          permission: "deny",
          user_message: reason,
          agent_message: reason,
        })
        const allowed = yield* guard("herdr pane list")
        assert.strictEqual(allowed.status, 200)
        assert.deepStrictEqual(allowed.body, { permission: "allow" })
      }).pipe(Effect.scoped, Effect.provide(served)),
    30_000,
  )
})
