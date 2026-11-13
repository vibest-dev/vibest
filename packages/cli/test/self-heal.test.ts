import net from "node:net"
import path from "node:path"

import { assert, layer } from "@effect/vitest"
import { accepts, cliHeaders, connect, probe, protocolHeaders, readPing, startDaemon } from "@vibest/client/client"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { SessionLive } from "@vibest/core/session/live"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { PingResult } from "@vibest/protocol/rpc"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { PROTOCOL, VERSION } from "@vibest/schema/version"
import { readDaemonInfo } from "@vibest/server/daemon"
import { Cause, Duration, Effect, Exit, Fiber, FileSystem, Layer, Option, Schedule, Stdio, Stream } from "effect"
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { replaceDaemon, type Timing } from "../src/replace.ts"
import {
  PATH_WITHOUT_HARNESS_CLIS,
  noteRecorded,
  pingOf,
  projectOf,
  recordedInfo,
  runVibest,
  stopRecorded,
  tempDirectory,
} from "./fakes.ts"

const typed = (text: string, terminal = true) =>
  Stdio.layerTest({
    stdinIsTerminal: Effect.succeed(terminal),
    stdoutIsTerminal: Effect.succeed(terminal),
    stdin: Stream.make(new TextEncoder().encode(text)),
  })

const parentOf = (pid: number) =>
  Number(
    Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)])
      .stdout.toString()
      .trim(),
  )

const main = path.join(path.dirname(import.meta.dirname), "src", "main.ts")
const sourceArgv = [process.execPath, main]

const isolatedHome = (home: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const saved = {
        VIBEST_HOME: process.env.VIBEST_HOME,
        VIBEST_SESSION_ID: process.env.VIBEST_SESSION_ID,
        VIBEST_AGENT: process.env.VIBEST_AGENT,
        PATH: process.env.PATH,
        VIBEST_NO_UPDATE_CHECK: process.env.VIBEST_NO_UPDATE_CHECK,
      }
      process.env.VIBEST_HOME = home
      process.env.PATH = PATH_WITHOUT_HARNESS_CLIS
      process.env.VIBEST_NO_UPDATE_CHECK = "1"
      delete process.env.VIBEST_SESSION_ID
      delete process.env.VIBEST_AGENT
      return saved
    }),
    (saved) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
      }),
  )

const fakeVibestd = (
  socket: string,
  ping: object,
  onStop: (sock: net.Socket, server: net.Server, id: unknown, request: { readonly headers?: unknown }) => void,
  pauseAcceptedSocketUntil?: Promise<void>,
) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly server: net.Server
      readonly methods: Array<string>
      readonly sockets: Array<net.Socket>
      readonly pingReply: Promise<{ readonly code: string }> | undefined
    }>((resume) => {
      const methods: Array<string> = []
      const sockets: Array<net.Socket> = []
      let finishPing: (code: string) => void = () => {}
      const pingReply =
        pauseAcceptedSocketUntil === undefined
          ? undefined
          : new Promise<{ readonly code: string }>((resolve) => {
              finishPing = (code) => {
                finishPing = () => {}
                resolve({ code })
              }
            })
      const server = net.createServer((sock) => {
        sockets.push(sock)
        sock.on("error", (err) => {
          const code =
            typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined
          if (code === "EPIPE") finishPing("EPIPE")
          else if (code !== "ECONNRESET") throw err
        })
        let buf = ""
        const onChunk = (chunk: Buffer) => {
          buf += chunk.toString()
          for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            for (const req of [JSON.parse(line)].flat() as Array<{
              id?: unknown
              method?: string
              headers?: unknown
            }>) {
              if (req.method === undefined) continue
              methods.push(req.method)
              if (req.method === "Ping") sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: ping }) + "\n")
              if (req.method === "Daemon.Stop") onStop(sock, server, req.id, req)
            }
          }
        }
        if (pauseAcceptedSocketUntil === undefined) sock.on("data", onChunk)
        else {
          sock.pause()
          pauseAcceptedSocketUntil.then(() => {
            if (sock.destroyed) return
            sock.on("data", onChunk)
            sock.resume()
          })
        }
      })
      server.listen(socket, () => resume(Effect.succeed({ server, methods, sockets, pingReply })))
    }),
    ({ server, sockets }) =>
      Effect.sync(() => {
        for (const sock of sockets) sock.destroy()
        server.close()
      }),
  )

const REPLACE_TIMEOUT_MS = 120_000

const fixtureTiming: Timing = { reply: Duration.millis(400), observe: Duration.millis(400) }

layer(Platform.services)(
  "self-healing: vibest replaces a vibestd for the user on an interactive terminal, in a temp VIBEST_HOME",
  (it) => {
    it.effect(
      "replacing vibestd: no terminal, a no, EOF or an vibest of another version stop nothing; a yes replaces it with the vibest asked for; another vibest answering after the stop is reported",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
          yield* isolatedHome(layout.home)
          const ping = Effect.map(readPing(layout.socket), Option.getOrThrow)
          const replace = (stdio: Layer.Layer<Stdio.Stdio>, target = { version: VERSION, command: sourceArgv }) =>
            replaceDaemon(target).pipe(
              Effect.provide(stdio),
              Effect.flip,
              Effect.map((e) => e.message),
            )
          yield* Effect.gen(function* () {
            yield* startDaemon.pipe(Effect.provideService(VibestCommand, sourceArgv))
            yield* noteRecorded(layout.daemonInfo)
            const old = yield* ping
            const info = yield* recordedInfo(layout.daemonInfo, old.instance)
            assert.deepStrictEqual(
              [old.pid, old.instance, old.command, old.startedAt],
              [info.pid, info.instance, info.command, info.startedAt],
            )
            assert.match(old.instance!, /^[0-9a-f-]{36}$/)
            assert.deepStrictEqual(old.command, sourceArgv)
            assert.notStrictEqual(parentOf(old.pid!), process.pid, "the started vibestd is no child of this process")

            assert.match(yield* replace(typed("y\n", false)), /needs a yes on a terminal; nothing was stopped/)
            assert.match(yield* replace(typed("n\n")), /not confirmed; nothing was stopped/)
            assert.match(yield* replace(typed("")), /not confirmed; nothing was stopped/)
            assert.match(
              yield* replace(typed("y\n"), { version: "9.9.9", command: sourceArgv }),
              new RegExp(`reports ${VERSION.replaceAll(".", "\\.")}, not 9\\.9\\.9; vibestd was not stopped`),
            )
            assert.strictEqual((yield* ping).instance, old.instance)
            yield* replaceDaemon({ version: VERSION, command: sourceArgv }).pipe(Effect.provide(typed("y\n")))
            const next = yield* ping
            assert.notStrictEqual(next.instance, old.instance)
            assert.deepInclude(next, { version: VERSION, command: sourceArgv })
            assert.notStrictEqual(parentOf(next.pid!), process.pid, "the restarted vibestd is no child of this process")
            yield* Effect.sleep("50 millis").pipe(
              Effect.repeat({ until: () => Platform.liveness(old.pid!) === "exited", times: 100 }),
            )
            assert.strictEqual(Platform.liveness(old.pid!), "exited")

            const wrapper = `${layout.home}/vibest-wrapper`
            yield* fs.writeFileString(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${main}" "$@"\n`)
            yield* fs.chmod(wrapper, 0o755)
            assert.match(
              yield* replace(typed("y\n"), { version: VERSION, command: [wrapper] }),
              /^the old vibestd stopped answering, and vibest started .*vibest-wrapper.*; vibestd .*, instance [0-9a-f-]{36}, answers, not vibest .* as asked\. vibest does nothing more$/,
            )
            assert.notStrictEqual((yield* ping).instance, next.instance)
            yield* noteRecorded(layout.daemonInfo)
          }).pipe(
            Effect.ensuring(Effect.ignore(stopRecorded(layout.daemonInfo))),
            TestClock.withLive,
            Effect.provideService(Layout, layout),
          )
        }),
      { timeout: REPLACE_TIMEOUT_MS },
    )

    it.effect("an vibestd from before Daemon.Stop is never asked to stop: the user gets the manual steps", () =>
      Effect.gen(function* () {
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        const legacy = yield* fakeVibestd(layout.socket, { version: "0.0.0", runtimeSessions: [], runtimes: [] }, () =>
          assert.fail("asked to stop"),
        )
        const message = yield* replaceDaemon({
          version: VERSION,
          command: sourceArgv,
        }).pipe(
          Effect.provide(typed("y\n")),
          Effect.provideService(Layout, layout),
          Effect.flip,
          Effect.map((e) => e.message),
          TestClock.withLive,
        )
        assert.match(message, /cannot be asked to stop by this vibest .* stop it yourself with `kill -TERM <pid>`/)
        assert.deepStrictEqual([...new Set(legacy.methods)], ["Ping"])
      }),
    )

    it.effect(
      "a planned Stop is accepted with a session herdr cannot be asked about and a message queued for it: the CLI with no terminal is refused, every Stop is checked, then vibestd exits and the message stays on disk for the next one",
      () =>
        Effect.gen(function* () {
          const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
          const pending = yield* Effect.gen(function* () {
            const db = yield* Db
            yield* db.insertSession(
              {
                id: "b0050001-b005-4b00-8b00-b0050001b005",
                agent: "general",
                harnessId: "pi",
                harnessSessionId: null,
                runtime: RUNTIME,
                address: { machine: "local", id: "nowhere/p1" },
                name: "seeded",
                provider: null,
                model: null,
                status: "unknown",
                startedAt: 1,
                exitedAt: 1,
                executionState: "completed",
                executionPromptedAt: 0,
                createdAt: 1,
                lastActive: 1,
              },
              yield* projectOf("seeded-project"),
            )
            return (yield* db.insertSend("b0050001-b005-4b00-8b00-b0050001b005", "queued"))!
          }).pipe(
            Effect.provide(
              Db.layer.pipe(
                Layer.provide(Platform.sqlite(layout.database)),
                Layer.provide(Bus.layer),
                Layer.provide(SessionLive.layer),
              ),
            ),
          )
          const env = { HOME: layout.home, VIBEST_HOME: layout.home }
          const daemon = yield* Effect.forkScoped(runVibest(layout.home, env, ["daemon", "--foreground"]))
          yield* Effect.gen(function* () {
            const old = yield* pingOf(layout.socket)

            const cli = yield* runVibest(layout.home, env, ["daemon", "restart"])
            assert.notStrictEqual(cli.code, 0)
            assert.include(cli.stderr, "needs a yes on a terminal; nothing was stopped")

            const raw = yield* connect(layout.socket)
            const tag = <A, E extends { readonly _tag: string }>(e: Effect.Effect<A, E>) =>
              Effect.map(Effect.flip(e), (x) => x._tag)
            const stop = (instance: string, headers: Record<string, string>) =>
              raw["Daemon.Stop"]({ instance }, { headers })
            assert.strictEqual(yield* tag(stop(old.instance!, {})), "ProtocolRejected")
            assert.strictEqual(yield* tag(stop(old.instance!, protocolHeaders())), "InvalidCaller")
            assert.strictEqual(
              yield* tag(stop(old.instance!, sessionHeaders({ sessionId: "05c00000-05c0-405c-805c-05c0000005c0" }))),
              "NoSuchSession",
            )
            assert.strictEqual(yield* tag(stop("another", cliHeaders(layout.home))), "WrongInstance")
            assert.strictEqual((yield* pingOf(layout.socket)).instance, old.instance)

            assert.deepStrictEqual(yield* stop(old.instance!, cliHeaders(layout.home)), { instance: old.instance! })
            assert.strictEqual((yield* Fiber.join(daemon).pipe(Effect.timeout("10 seconds"))).code, 0)
            assert.isFalse(yield* probe(layout.socket))
            const rows = yield* Effect.flatMap(Db, (db) =>
              db.pendingInbox("b0050001-b005-4b00-8b00-b0050001b005"),
            ).pipe(
              Effect.provide(
                Db.layer.pipe(
                  Layer.provide(Platform.sqlite(layout.database)),
                  Layer.provide(Bus.layer),
                  Layer.provide(SessionLive.layer),
                ),
              ),
            )
            assert.deepStrictEqual(rows, [pending])
          }).pipe(Effect.ensuring(Effect.ignore(stopRecorded(layout.daemonInfo))), TestClock.withLive, Effect.scoped)
        }).pipe(Effect.scoped),
      60_000,
    )

    it.effect(
      "a refusal vibestd sends for Stop, decoded, is a refusal: nothing is watched or started, whatever vibestd does next",
      () =>
        Effect.gen(function* () {
          for (const [error, outcome] of [
            [{ _tag: "DaemonBusy", blockers: [{ id: "s1", reason: "session working" }] }, "busy"],
            [{ _tag: "WrongInstance", expected: "old-instance", actual: "other" }, "unchanged"],
          ] as const) {
            const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
            yield* fakeVibestd(
              layout.socket,
              { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
              (sock, server, id) => {
                sock.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    error: { _tag: "Cause", code: 0, message: "refused", data: [{ _tag: "Fail", error }] },
                  }) + "\n",
                )
                server.close()
              },
            )
            const failed = yield* replaceDaemon({
              version: VERSION,
              command: sourceArgv,
            }).pipe(
              Effect.provide(typed("y\n")),
              Effect.provideService(Layout, layout),
              Effect.provideService(VibestCommand, sourceArgv),
              Effect.flip,
              TestClock.withLive,
            )
            assert.strictEqual(failed.outcome, outcome, error._tag)
            assert.isFalse(yield* probe(layout.socket), error._tag)
            assert.isTrue(Option.isNone(yield* readDaemonInfo(layout.daemonInfo)), error._tag)
          }
        }).pipe(Effect.scoped),
      60_000,
    )

    it.effect(
      "an vibestd of an older protocol is asked to stop in its own protocol, so an upgrade replaces it with no manual steps",
      () =>
        Effect.gen(function* () {
          const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
          const headers: Array<unknown> = []
          yield* fakeVibestd(
            layout.socket,
            { version: "0.0.1", protocol: PROTOCOL - 1, instance: "old-instance", runtimeSessions: [] },
            (sock, server, id, request) => {
              headers.push(request.headers)
              sock.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: {
                    _tag: "Cause",
                    code: 0,
                    message: "refused",
                    data: [
                      {
                        _tag: "Fail",
                        error: { _tag: "DaemonBusy", blockers: [{ id: "s1", reason: "session working" }] },
                      },
                    ],
                  },
                }) + "\n",
              )
              server.close()
            },
          )
          const failed = yield* replaceDaemon({
            version: VERSION,
            command: sourceArgv,
          }).pipe(
            Effect.provide(typed("y\n")),
            Effect.provideService(Layout, layout),
            Effect.provideService(VibestCommand, sourceArgv),
            Effect.flip,
            TestClock.withLive,
          )
          assert.strictEqual(failed.outcome, "busy")
          assert.deepInclude(headers[0] as Array<[string, string]>, ["vibest-protocol", String(PROTOCOL - 1)])
        }).pipe(Effect.scoped),
      60_000,
    )

    const undecodableStopReplies = [
      [
        "an unknown refusal",
        {
          error: {
            _tag: "Cause",
            code: 0,
            message: "refused",
            data: [{ _tag: "Fail", error: { _tag: "DaemonFrozen", message: "from a later vibestd" } }],
          },
        },
      ],
      ["a malformed acceptance", { result: { bogus: 1 } }],
      [
        "an interruption vibestd reports",
        { error: { _tag: "Cause", code: 0, message: "interrupted", data: [{ _tag: "Interrupt", fiberId: 1 }] } },
      ],
    ] as const

    it.effect(
      "a reply to Stop vibest cannot read is no refusal: vibest watches Ping, and an vibestd still answering is left and reported, with one Stop and nothing started",
      () =>
        Effect.gen(function* () {
          for (const [what, reply] of undecodableStopReplies) {
            const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
            yield* isolatedHome(layout.home)
            const old = yield* fakeVibestd(
              layout.socket,
              { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
              (sock, _server, id) => {
                sock.write(JSON.stringify({ jsonrpc: "2.0", id, ...reply }) + "\n")
              },
            )
            const exit = yield* replaceDaemon({ version: VERSION, command: sourceArgv }, fixtureTiming).pipe(
              Effect.provide(typed("y\n")),
              Effect.provideService(Layout, layout),
              Effect.exit,
              Effect.timeout("30 seconds"),
              TestClock.withLive,
            )
            assert.isTrue(Exit.isFailure(exit), what)
            if (Exit.isSuccess(exit)) continue
            assert.isFalse(Cause.hasDies(exit.cause), `${what}: ${Cause.pretty(exit.cause)}`)
            const failed = Option.getOrThrow(Cause.findErrorOption(exit.cause))
            assert.strictEqual(failed.outcome, "unknown", what)
            assert.match(
              failed.message,
              /^vibestd instance old-instance still answers .* Stop was not sent again/,
              what,
            )
            assert.strictEqual(old.methods.filter((m) => m === "Daemon.Stop").length, 1, what)
            assert.isTrue(Option.isNone(yield* readDaemonInfo(layout.daemonInfo)), what)
          }
        }).pipe(Effect.scoped),
      60_000,
    )

    it.effect(
      "a reply to Stop vibest cannot read or never gets, and vibestd goes: vibest sees it gone, starts the new vibestd and checks it",
      () =>
        Effect.gen(function* () {
          for (const [what, reply] of [
            ...undecodableStopReplies,
            ["the connection closed without a reply", undefined],
          ] as const) {
            const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
            yield* isolatedHome(layout.home)
            const old = yield* fakeVibestd(
              layout.socket,
              { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
              (sock, server, id) => {
                if (reply === undefined) sock.destroy()
                else sock.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }) + "\n")
                server.close()
              },
            )
            yield* Effect.gen(function* () {
              yield* replaceDaemon({ version: VERSION, command: sourceArgv }, fixtureTiming).pipe(
                Effect.provide(typed("y\n")),
                Effect.timeout("30 seconds"),
              )
              assert.strictEqual(old.methods.filter((m) => m === "Daemon.Stop").length, 1, what)
              const next = yield* pingOf(layout.socket)
              assert.notStrictEqual(next.instance, "old-instance", what)
              assert.deepInclude(next, { version: VERSION, command: sourceArgv })
            }).pipe(
              Effect.ensuring(Effect.ignore(stopRecorded(layout.daemonInfo))),
              TestClock.withLive,
              Effect.provideService(Layout, layout),
            )
          }
        }).pipe(Effect.scoped),
      60_000,
    )

    it.effect(
      "Stop is never answered: vibest stops waiting at its deadline, sends no second Stop, and watches Ping; still answering, the same vibestd is left and the replacement fails",
      () =>
        Effect.gen(function* () {
          const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
          yield* isolatedHome(layout.home)
          const old = yield* fakeVibestd(
            layout.socket,
            { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
            () => {},
          )
          const failed = yield* replaceDaemon({ version: VERSION, command: sourceArgv }, fixtureTiming).pipe(
            Effect.provide(typed("y\n")),
            Effect.provideService(Layout, layout),
            Effect.flip,
            Effect.timeout("30 seconds"),
            TestClock.withLive,
          )
          assert.strictEqual(failed.outcome, "unknown")
          assert.match(
            failed.message,
            /^vibestd instance old-instance still answers .* after its Stop was sent; .* Stop was not sent again/,
          )
          assert.strictEqual(old.methods.filter((m) => m === "Daemon.Stop").length, 1)
          assert.strictEqual((yield* pingOf(layout.socket)).instance, "old-instance")
          assert.isTrue(Option.isNone(yield* readDaemonInfo(layout.daemonInfo)))
        }).pipe(Effect.scoped),
      60_000,
    )

    it.effect(
      "vibest interrupted while it waits for Stop's reply: it cancels the Stop and stops there, pinging and starting nothing past the deadline",
      () =>
        Effect.gen(function* () {
          const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
          yield* isolatedHome(layout.home)
          const old = yield* fakeVibestd(
            layout.socket,
            { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
            (_sock, server) => {
              server.close()
            },
          )
          const replacing = yield* replaceDaemon({ version: VERSION, command: sourceArgv }, fixtureTiming).pipe(
            Effect.provide(typed("y\n")),
            Effect.provideService(Layout, layout),
            Effect.forkChild,
          )
          yield* Effect.sleep("50 millis").pipe(
            Effect.repeat({ until: () => old.methods.includes("Daemon.Stop"), times: 100 }),
          )
          yield* Fiber.interrupt(replacing)
          assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(replacing)))
          yield* Effect.sleep("600 millis")
          assert.deepStrictEqual(old.methods, ["Ping", "Daemon.Stop", "@effect/rpc/Interrupt"])
          assert.isFalse(yield* probe(layout.socket))
          assert.isTrue(Option.isNone(yield* readDaemonInfo(layout.daemonInfo)))
        }).pipe(Effect.scoped, TestClock.withLive),
      60_000,
    )

    it.effect(
      "Stop is never answered but vibestd goes: after the deadline vibest sees it gone, starts the new vibestd and checks it",
      () =>
        Effect.gen(function* () {
          const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
          yield* isolatedHome(layout.home)
          const old = yield* fakeVibestd(
            layout.socket,
            { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
            (_sock, server) => {
              server.close()
            },
          )
          yield* Effect.gen(function* () {
            yield* replaceDaemon({ version: VERSION, command: sourceArgv }, fixtureTiming).pipe(
              Effect.provide(typed("y\n")),
              Effect.timeout("30 seconds"),
            )
            assert.strictEqual(old.methods.filter((m) => m === "Daemon.Stop").length, 1)
            const next = yield* pingOf(layout.socket)
            assert.notStrictEqual(next.instance, "old-instance")
            assert.deepInclude(next, { version: VERSION, command: sourceArgv })
          }).pipe(
            Effect.ensuring(Effect.ignore(stopRecorded(layout.daemonInfo))),
            TestClock.withLive,
            Effect.provideService(Layout, layout),
          )
        }).pipe(Effect.scoped),
      60_000,
    )

    it.effect(
      "a Ping left unread until readPing times out is the client closing, and the late reply is not an uncaught EPIPE",
      () =>
        Effect.gen(function* () {
          let release = () => {}
          const pauseAcceptedSocketUntil = new Promise<void>((resolve) => {
            release = resolve
          })
          const dir = yield* tempDirectory("vibest-sock-")
          const socket = path.join(dir, "vibest.sock")
          const daemon = yield* fakeVibestd(
            socket,
            { version: VERSION, protocol: PROTOCOL, runtimeSessions: [], runtimes: [] },
            () => {},
            pauseAcceptedSocketUntil,
          )
          assert.isTrue(Option.isNone(yield* readPing(socket)))
          assert.isDefined(daemon.pingReply)
          release()
          const reply = yield* Effect.promise(() => daemon.pingReply!)
          assert.strictEqual(reply.code, "EPIPE")
          assert.ok(daemon.methods.includes("Ping"))
        }).pipe(Effect.scoped, Effect.timeout("10 seconds"), TestClock.withLive),
      15_000,
    )

    it.effect(
      "a Ping that a stopping vibestd interrupts is no answer, not an interrupt of the caller (vibest daemon restart polls Ping while the old vibestd stops)",
      () =>
        Effect.gen(function* () {
          const socket = path.join(yield* tempDirectory("vibest-sock-"), "vibest.sock")
          const PingOnly = RpcGroup.make(Rpc.make("Ping", { success: PingResult }))
          let pings = 0
          yield* Layer.launch(
            RpcServer.layer(PingOnly).pipe(
              Layer.provide(
                PingOnly.toLayer({ Ping: () => Effect.sync(() => pings++).pipe(Effect.andThen(Effect.interrupt)) }),
              ),
              Layer.provide(RpcServer.layerProtocolSocketServer),
              Layer.provide(RpcSerialization.layerNdJsonRpc()),
              Layer.provide(Platform.socketServer(socket)),
            ),
          ).pipe(Effect.forkScoped)
          yield* accepts(socket).pipe(Effect.repeat({ until: (up) => up, schedule: Schedule.spaced("20 millis") }))
          const exit = yield* Effect.exit(readPing(socket))
          assert.deepStrictEqual(exit, Exit.succeed(Option.none()))
          assert.strictEqual(pings, 1)
        }).pipe(Effect.scoped, Effect.timeout("10 seconds"), TestClock.withLive),
      15_000,
    )
  },
)
