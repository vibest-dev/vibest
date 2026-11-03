import net from "node:net"
import path from "node:path"

// What `vibest` fixes for the user on an interactive terminal: a vibestd to replace (`vibest daemon restart`, `vibest update`). A temporary HOME and VIBEST_HOME throughout, never the user's.
import { assert, layer } from "@effect/vitest"
import { cliHeaders, connect, probe, protocolHeaders, readPing, startDaemon } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { layer as builtinHarnesses } from "@vibest/core/harnesses"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { PROTOCOL, sessionHeaders } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { readDaemonInfo } from "@vibest/server/daemon"
import { Cause, Duration, Effect, Exit, Fiber, FileSystem, Layer, Option, Stdio, Stream } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { replaceDaemon, type Timing } from "../src/replace.ts"
import { pingOf, runVibest, stopRecorded, tempDirectory } from "./fakes.ts"

const typed = (text: string, terminal = true) =>
  Stdio.layerTest({
    stdinIsTerminal: Effect.succeed(terminal),
    stdoutIsTerminal: Effect.succeed(terminal),
    stdin: Stream.make(new TextEncoder().encode(text)),
  })

const main = path.join(path.dirname(import.meta.dirname), "src", "main.ts")
/** The vibest this test runs from source, as vibestd reports its own argv. */
const self = [process.execPath, main]

/**
 * The environment vibestd and `vibest --version` get from this test: the temp VIBEST_HOME, and none of the agent roles this test
 * run may have inherited. Restored afterwards.
 */
const ownHome = (home: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const saved = {
        VIBEST_HOME: process.env.VIBEST_HOME,
        VIBEST_SESSION_ID: process.env.VIBEST_SESSION_ID,
        VIBEST_AGENT: process.env.VIBEST_AGENT,
      }
      process.env.VIBEST_HOME = home
      delete process.env.VIBEST_SESSION_ID
      delete process.env.VIBEST_AGENT
      return saved
    }),
    (saved) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
      }),
  )

/** A server on `socket` that answers Ping with `ping` and records each method asked; `onStop` runs on a Daemon.Stop. */
const fakeVibestd = (
  socket: string,
  ping: object,
  onStop: (sock: net.Socket, server: net.Server, id: unknown, request: { readonly headers?: unknown }) => void,
  /** Pauses the accepted socket until this resolves, then handles the bytes already received. */
  releasePing?: Promise<void>,
) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly server: net.Server
      readonly methods: Array<string>
      readonly sockets: Array<net.Socket>
      /** Set when `releasePing` is passed. Resolved by the fixture's error handler when it ignores EPIPE. */
      readonly pingReply: Promise<{ readonly code: string }> | undefined
    }>((resume) => {
      const methods: Array<string> = []
      const sockets: Array<net.Socket> = []
      let finishPing: (code: string) => void = () => {}
      const pingReply =
        releasePing === undefined
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
          if (code !== "EPIPE") throw err
          finishPing("EPIPE")
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
        if (releasePing === undefined) sock.on("data", onChunk)
        else {
          sock.pause()
          releasePing.then(() => {
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

/** Deadlines for the fixtures that never answer: the product's are 55 s and 15 s. The wait is the behavior, not a pad past it. */
const short: Timing = { reply: Duration.millis(400), observe: Duration.millis(400) }

layer(Layer.mergeAll(Platform.services, builtinHarnesses))("self-healing", (it) => {
  it.effect(
    "replacing vibestd: no terminal, a no, EOF or an vibest of another version stop nothing; a yes replaces it with the vibest asked for; another vibest answering after the stop is reported",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        yield* ownHome(layout.home)
        const ping = Effect.map(readPing(layout.socket), Option.getOrThrow)
        const replace = (stdio: Layer.Layer<Stdio.Stdio>, target = { version: VERSION, command: self }) =>
          replaceDaemon(target).pipe(
            Effect.provide(stdio),
            Effect.flip,
            Effect.map((e) => e.message),
          )
        yield* Effect.gen(function* () {
          yield* startDaemon.pipe(Effect.provideService(VibestCommand, self))
          const old = yield* ping
          // Ping says who answered, the same vibestd vibestd.pid records: its own argv, as it runs (bun and main.ts from source).
          const info = Option.getOrThrow(yield* readDaemonInfo(layout.daemonInfo))
          assert.deepStrictEqual(
            [old.pid, old.instance, old.command, old.startedAt],
            [info.pid, info.instance, info.command, info.startedAt],
          )
          assert.match(old.instance!, /^[0-9a-f-]{36}$/)
          assert.deepStrictEqual(old.command, self)

          assert.match(yield* replace(typed("y\n", false)), /needs a yes on a terminal; nothing was stopped/)
          assert.match(yield* replace(typed("n\n")), /not confirmed; nothing was stopped/)
          assert.match(yield* replace(typed("")), /not confirmed; nothing was stopped/)
          assert.match(
            yield* replace(typed("y\n"), { version: "9.9.9", command: self }),
            new RegExp(`reports ${VERSION.replaceAll(".", "\\.")}, not 9\\.9\\.9; vibestd was not stopped`),
          )
          assert.strictEqual((yield* ping).instance, old.instance)
          yield* replaceDaemon({ version: VERSION, command: self }).pipe(Effect.provide(typed("y\n")))
          const next = yield* ping
          assert.notStrictEqual(next.instance, old.instance)
          assert.deepInclude(next, { version: VERSION, command: self })
          yield* Effect.sleep("50 millis").pipe(
            Effect.repeat({ until: () => Platform.liveness(old.pid!) === "exited", times: 100 }),
          )
          assert.strictEqual(Platform.liveness(old.pid!), "exited")

          // The vibest asked for is a wrapper; the vibestd it starts reports the vibest it runs: not the one asked for, and said so.
          const wrapper = `${layout.home}/vibest-wrapper`
          yield* fs.writeFileString(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${main}" "$@"\n`)
          yield* fs.chmod(wrapper, 0o755)
          assert.match(
            yield* replace(typed("y\n"), { version: VERSION, command: [wrapper] }),
            /^the old vibestd stopped answering, and vibest started .*vibest-wrapper.*; vibestd .*, instance [0-9a-f-]{36}, answers, not vibest .* as asked\. vibest does nothing more$/,
          )
          assert.notStrictEqual((yield* ping).instance, next.instance)
        }).pipe(
          Effect.ensuring(Effect.ignore(stopRecorded(layout.daemonInfo))),
          TestClock.withLive,
          Effect.provideService(Layout, layout),
        )
      }),
    // Two daemon replacements inside one test: generous for a loaded run, and a real hang still times out (no
    // retry — a retry would hide exactly the hang this test exists to catch).
    { timeout: 120_000 },
  )

  it.effect("an vibestd from before Daemon.Stop is never asked to stop: the user gets the manual steps", () =>
    Effect.gen(function* () {
      const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
      const legacy = yield* fakeVibestd(layout.socket, { version: "0.0.0", runtimeSessions: [], runtimes: [] }, () =>
        assert.fail("asked to stop"),
      )
      const message = yield* replaceDaemon({ version: VERSION, command: self }).pipe(
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
    "the reply to Stop is lost as vibestd goes: vibest watches Ping, starts the new vibestd and checks it",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        yield* ownHome(layout.home)
        // It accepts, closes the connection without a reply, and stops listening.
        const old = yield* fakeVibestd(
          layout.socket,
          { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
          (sock, server) => {
            sock.destroy()
            server.close()
          },
        )
        yield* Effect.gen(function* () {
          yield* replaceDaemon({ version: VERSION, command: self }).pipe(Effect.provide(typed("y\n")))
          assert.include(old.methods, "Daemon.Stop")
          const next = yield* pingOf(layout.socket)
          assert.notStrictEqual(next.instance, "old-instance")
          assert.deepInclude(next, { version: VERSION, command: self })
        }).pipe(
          Effect.ensuring(Effect.ignore(stopRecorded(layout.daemonInfo))),
          TestClock.withLive,
          Effect.provideService(Layout, layout),
        )
      }),
    60_000,
  )

  it.effect(
    "a planned Stop is accepted with a stopped session and a message queued for it: vibestd exits and the message stays on disk for the next one",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        // A session herdr cannot be asked about (no herdr on vibestd's PATH) and a message queued for it, written before vibestd starts.
        const pending = yield* Effect.gen(function* () {
          const db = yield* Db
          yield* db.insertSession(
            {
              id: "b0050001",
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
              turnState: "completed",
              turnPromptedAt: 0,
              metadata: {},
              createdAt: 1,
              lastActive: 1,
            },
            "seeded-project",
          )
          return yield* db.insertInbox({ sessionId: "b0050001", kind: "send", message: "queued", details: {} })
        }).pipe(Effect.provide(Db.layer.pipe(Layer.provide(Platform.sqlite(layout.database)))))
        const env = { HOME: layout.home, VIBEST_HOME: layout.home, PATH: "/usr/bin:/bin" }
        const daemon = yield* Effect.forkScoped(runVibest(layout.home, env, ["daemon", "--foreground"]))
        yield* Effect.gen(function* () {
          const old = yield* pingOf(layout.socket)

          // The command line with no terminal: refused before any Stop, non-zero.
          const cli = yield* runVibest(layout.home, env, ["daemon", "restart"])
          assert.notStrictEqual(cli.code, 0)
          assert.include(cli.stderr, "needs a yes on a terminal; nothing was stopped")

          // Every Stop is checked like any other request.
          const raw = yield* connect(layout.socket)
          const tag = <A, E extends { readonly _tag: string }>(e: Effect.Effect<A, E>) =>
            Effect.map(Effect.flip(e), (x) => x._tag)
          const stop = (instance: string, headers: Record<string, string>) =>
            raw["Daemon.Stop"]({ instance }, { headers })
          assert.strictEqual(yield* tag(stop(old.instance!, {})), "ProtocolRejected")
          assert.strictEqual(yield* tag(stop(old.instance!, protocolHeaders())), "InvalidCaller")
          assert.strictEqual(
            yield* tag(stop(old.instance!, sessionHeaders({ sessionId: "nosuch00" }))),
            "NoSuchSession",
          )
          assert.strictEqual(yield* tag(stop("another", cliHeaders(layout.home))), "WrongInstance")
          assert.strictEqual((yield* pingOf(layout.socket)).instance, old.instance)

          // Agents and queued messages do not block: accepted, and vibestd exits.
          assert.deepStrictEqual(yield* stop(old.instance!, cliHeaders(layout.home)), { instance: old.instance! })
          assert.strictEqual((yield* Fiber.join(daemon).pipe(Effect.timeout("10 seconds"))).code, 0)
          assert.isFalse(yield* probe(layout.socket))
          const rows = yield* Effect.flatMap(Db, (db) => db.pendingInbox("b0050001")).pipe(
            Effect.provide(Db.layer.pipe(Layer.provide(Platform.sqlite(layout.database)))),
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
          // It refuses, then stops listening: a client that took the refusal for a lost reply would start a new vibestd.
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
          const failed = yield* replaceDaemon({ version: VERSION, command: self }).pipe(
            Effect.provide(typed("y\n")),
            Effect.provideService(Layout, layout),
            Effect.provideService(VibestCommand, self),
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
        const failed = yield* replaceDaemon({ version: VERSION, command: self }).pipe(
          Effect.provide(typed("y\n")),
          Effect.provideService(Layout, layout),
          Effect.provideService(VibestCommand, self),
          Effect.flip,
          TestClock.withLive,
        )
        assert.strictEqual(failed.outcome, "busy")
        assert.deepInclude(headers[0] as Array<[string, string]>, ["vibest-protocol", String(PROTOCOL - 1)])
      }).pipe(Effect.scoped),
    60_000,
  )

  /** Replies to Stop this vibest cannot decode: an error it does not know, and an acceptance of the wrong shape. */
  const unreadable = [
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
        for (const [what, reply] of unreadable) {
          const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
          yield* ownHome(layout.home)
          const old = yield* fakeVibestd(
            layout.socket,
            { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
            (sock, _server, id) => {
              sock.write(JSON.stringify({ jsonrpc: "2.0", id, ...reply }) + "\n")
            },
          )
          const exit = yield* replaceDaemon({ version: VERSION, command: self }, short).pipe(
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
          assert.match(failed.message, /^vibestd instance old-instance still answers .* Stop was not sent again/, what)
          assert.strictEqual(old.methods.filter((m) => m === "Daemon.Stop").length, 1, what)
          assert.isTrue(Option.isNone(yield* readDaemonInfo(layout.daemonInfo)), what)
        }
      }).pipe(Effect.scoped),
    60_000,
  )

  it.effect(
    "a reply to Stop vibest cannot read, and vibestd goes: vibest sees it gone, starts the new vibestd and checks it",
    () =>
      Effect.gen(function* () {
        for (const [what, reply] of unreadable) {
          const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
          yield* ownHome(layout.home)
          const old = yield* fakeVibestd(
            layout.socket,
            { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
            (sock, server, id) => {
              sock.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }) + "\n")
              server.close()
            },
          )
          yield* Effect.gen(function* () {
            yield* replaceDaemon({ version: VERSION, command: self }, short).pipe(
              Effect.provide(typed("y\n")),
              Effect.timeout("30 seconds"),
            )
            assert.strictEqual(old.methods.filter((m) => m === "Daemon.Stop").length, 1, what)
            const next = yield* pingOf(layout.socket)
            assert.notStrictEqual(next.instance, "old-instance", what)
            assert.deepInclude(next, { version: VERSION, command: self })
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
        yield* ownHome(layout.home)
        const old = yield* fakeVibestd(
          layout.socket,
          { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
          () => {},
        )
        const failed = yield* replaceDaemon({ version: VERSION, command: self }, short).pipe(
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
    "vibest interrupted while it waits for Stop's reply: it stops there, watching and starting nothing",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
        yield* ownHome(layout.home)
        const old = yield* fakeVibestd(
          layout.socket,
          { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
          (_sock, server) => {
            server.close()
          },
        )
        const replacing = yield* replaceDaemon({ version: VERSION, command: self }, short).pipe(
          Effect.provide(typed("y\n")),
          Effect.provideService(Layout, layout),
          Effect.forkChild,
        )
        yield* Effect.sleep("50 millis").pipe(
          Effect.repeat({ until: () => old.methods.includes("Daemon.Stop"), times: 100 }),
        )
        yield* Fiber.interrupt(replacing)
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(replacing)))
        // Past the reply deadline: nothing was started in the old one's place.
        yield* Effect.sleep("600 millis")
        // The client cancels its Stop; no Ping follows it.
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
        yield* ownHome(layout.home)
        // It stops listening and keeps the Stop's connection open without a reply.
        const old = yield* fakeVibestd(
          layout.socket,
          { version: VERSION, protocol: PROTOCOL, instance: "old-instance", runtimeSessions: [], runtimes: [] },
          (_sock, server) => {
            server.close()
          },
        )
        yield* Effect.gen(function* () {
          yield* replaceDaemon({ version: VERSION, command: self }, short).pipe(
            Effect.provide(typed("y\n")),
            Effect.timeout("30 seconds"),
          )
          assert.strictEqual(old.methods.filter((m) => m === "Daemon.Stop").length, 1)
          const next = yield* pingOf(layout.socket)
          assert.notStrictEqual(next.instance, "old-instance")
          assert.deepInclude(next, { version: VERSION, command: self })
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
        const releasePing = new Promise<void>((resolve) => {
          release = resolve
        })
        const dir = yield* tempDirectory("vibest-sock-")
        const socket = path.join(dir, "vibest.sock")
        const daemon = yield* fakeVibestd(
          socket,
          { version: VERSION, protocol: PROTOCOL, runtimeSessions: [], runtimes: [] },
          () => {},
          releasePing,
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

  it.effect("a fixture socket error other than EPIPE still fails", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory("vibest-sock-")
      const socket = path.join(dir, "vibest.sock")
      const daemon = yield* fakeVibestd(
        socket,
        { version: VERSION, protocol: PROTOCOL, runtimeSessions: [], runtimes: [] },
        () => {},
      )
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<net.Socket>((resolve, reject) => {
              const socketClient = net.connect(socket)
              socketClient.once("error", (err) => {
                socketClient.destroy()
                reject(err)
              })
              socketClient.once("connect", () => {
                socketClient.removeAllListeners("error")
                resolve(socketClient)
              })
            }),
        ),
        (socketClient) => Effect.sync(() => socketClient.destroy()),
      )
      const sock = daemon.sockets[0]
      assert.isDefined(sock)
      sock.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
      let threw = false
      try {
        sock.emit("error", Object.assign(new Error("boom"), { code: "EIO" }))
      } catch (err) {
        threw = (err as { code?: string }).code === "EIO"
      }
      assert.isTrue(threw)
    }).pipe(Effect.scoped),
  )
})
