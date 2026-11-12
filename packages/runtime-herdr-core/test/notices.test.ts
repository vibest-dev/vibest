import { BunServices, BunSocketServer } from "@effect/platform-bun"
import { assert, describe, it } from "@effect/vitest"
import type * as VibestPlugin from "@vibest/plugin"
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { Hc, SocketConnector } from "effect-herdr-core-sdk"
import * as HcBun from "effect-herdr-core-sdk/bun"
import * as Socket from "effect/socket/Socket"

import { LABEL, TYPED_LAUNCH_MS, make, terminalId } from "../src/terminal-runtime.ts"

const shell = { argv: ["/bin/zsh"], cwd: "/tmp", name: "zsh", pid: 100 }
const sleeping = { argv: ["sleep", "5"], cwd: "/tmp", name: "sleep", pid: 101 }
type Foreground = typeof shell

const recordedTerminal = (foreground: Foreground, labels: Readonly<Record<string, string>>) =>
  JSON.stringify({
    address: "t1",
    argv: ["/bin/zsh"],
    cols: 200,
    created_ms: 1793929163810,
    cwd: "/tmp",
    die_with_parent: false,
    exit_code: null,
    finished_ms: null,
    foreground,
    identity: "ghostty",
    keep: true,
    labels,
    name: "probe1",
    notify: false,
    parent: null,
    pid: 100,
    reason: null,
    reported: false,
    rm: false,
    rows: 120,
    screen: "exact",
    signal: null,
    state: "live",
    status: null,
    status_ms: null,
    template: null,
    title: "",
    turn: 0,
  })

const foregroundEvent = (seq: number, foreground: Foreground) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { data: foreground, seq, terminal: "t1", type: "foreground" },
  })

const MISSED = JSON.stringify({ jsonrpc: "2.0", method: "missed", params: {} })

const Request = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number, method: Schema.String })),
)

type Subscriber = { readonly push: (line: string) => Effect.Effect<void>; readonly close: Effect.Effect<void> }

const fakeCore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-hc-rt-" })
  const socketPath = path.join(dir, "hc.sock")
  const foreground = yield* Ref.make<Foreground>(shell)
  const labels = yield* Ref.make<Record<string, string>>({ "vibest.runtime": "hc" })
  const calls = yield* Ref.make<ReadonlyArray<string>>([])
  const subscribers = yield* Queue.unbounded<Subscriber>()

  const serve = (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const pull = yield* Socket.readerString(socket)
      const writer = yield* socket.writer
      const line = yield* Stream.fromPull(
        Effect.succeed(
          pull.pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "SocketCloseError",
              () => Cause.done(),
            ),
          ),
        ),
      ).pipe(Stream.splitLines, Stream.runHead)
      const text = Option.getOrElse(line, () => "")
      const request = yield* Request(text)
      yield* Ref.update(calls, (all) => [...all, request.method])
      const reply = (result: string) => writer.write(`{"id":${request.id},"jsonrpc":"2.0","result":${result}}\n`)
      const terminalJson = Effect.gen(function* () {
        return recordedTerminal(yield* Ref.get(foreground), yield* Ref.get(labels))
      })
      if (request.method === "events.subscribe") {
        yield* reply(`{"channel":null,"seq":0,"terminals":[${yield* terminalJson}]}`)
        const closed = yield* Deferred.make<void>()
        yield* Queue.offer(subscribers, {
          push: (pushed) => writer.write(`${pushed}\n`).pipe(Effect.orDie),
          close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
        })
        yield* Deferred.await(closed)
      } else if (request.method === "terminal.get") yield* reply(yield* terminalJson)
      else if (request.method === "terminal.send") yield* reply('{"started":null,"status":null,"turn":0}')
      else if (request.method === "terminal.label") {
        const params = (JSON.parse(text) as { params?: { labels?: Record<string, string> } }).params
        if (params?.labels !== undefined) yield* Ref.update(labels, (cur) => ({ ...cur, ...params.labels }))
        yield* reply(yield* terminalJson)
      }
      yield* writer.write(new Socket.CloseEvent())
    }).pipe(Effect.scoped, Effect.ignore)

  const server = yield* BunSocketServer.make({ path: socketPath })
  yield* Effect.forkScoped(server.run(serve))
  const connector = yield* SocketConnector
  const connect = (at: string) => Hc.make(at).pipe(Effect.provideService(SocketConnector, connector))
  const runtime = yield* make({ connect, socket: socketPath, scope: yield* Effect.scope })
  const terminal = { id: terminalId(socketPath, "t1") }
  const seen = yield* Queue.unbounded<VibestPlugin.Runtime.RuntimeEvent>()
  yield* runtime.events.pipe(
    Stream.runForEach((e) => Queue.offer(seen, e)),
    Effect.forkScoped,
  )
  yield* Effect.sleep("50 millis")
  const follow = Effect.gen(function* () {
    yield* runtime.process(terminal)
    const sub = yield* Queue.take(subscribers)
    assert.deepStrictEqual(yield* Queue.take(seen), { type: "reset" })
    return sub
  })
  return {
    follow,
    runtime,
    foreground,
    labels,
    calls,
    connect,
    socketPath,
    subscriber: Queue.take(subscribers),
    next: Queue.take(seen),
    terminal,
  }
})

const sentCount = (calls: Ref.Ref<ReadonlyArray<string>>) =>
  Ref.get(calls).pipe(Effect.map((all) => all.filter((m) => m === "terminal.send").length))

const live = <A, E>(
  name: string,
  body: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem | Path.Path | SocketConnector>,
) =>
  it.live(name, () => body.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, HcBun.layer))), 20_000)

describe("runtime-herdr-core against a fake core", () => {
  live(
    "missed events drop the subscription; the next snapshot publishes reset",
    Effect.gen(function* () {
      const core = yield* fakeCore
      const first = yield* core.follow
      yield* first.push(MISSED)
      yield* core.subscriber
      assert.deepStrictEqual(yield* core.next, { type: "reset" })
    }),
  )

  live(
    "a lost subscription publishes reset at once, then is made again, and its snapshot publishes reset",
    Effect.gen(function* () {
      const core = yield* fakeCore
      const first = yield* core.follow
      yield* first.close
      assert.deepStrictEqual(yield* core.next, { type: "reset" })
      yield* core.subscriber
      assert.deepStrictEqual(yield* core.next, { type: "reset" })
    }),
  )

  live(
    "a typed label keeps the shell running for every reader until it expires, including a runtime started later",
    Effect.gen(function* () {
      const core = yield* fakeCore
      yield* core.follow
      assert.isFalse((yield* core.runtime.process(core.terminal)).running)
      yield* core.runtime.run!(core.terminal, ["echo", "hi"])
      assert.isTrue((yield* core.runtime.process(core.terminal)).running)
      assert.isTrue((yield* core.runtime.process(core.terminal)).running)
      const restarted = yield* make({
        connect: core.connect,
        socket: core.socketPath,
        scope: yield* Effect.scope,
      })
      assert.isTrue((yield* restarted.process(core.terminal)).running)
      yield* Ref.update(core.labels, (cur) => ({ ...cur, [LABEL.typed]: String(Date.now() - TYPED_LAUNCH_MS - 1) }))
      assert.isFalse((yield* core.runtime.process(core.terminal)).running)
      assert.isFalse((yield* restarted.process(core.terminal)).running)
      yield* Ref.set(core.foreground, sleeping)
      assert.isTrue((yield* core.runtime.process(core.terminal)).running)
    }),
  )

  live(
    "run types into a busy terminal only after the foreground event back to its shell",
    Effect.gen(function* () {
      const core = yield* fakeCore
      yield* Ref.set(core.foreground, sleeping)
      const sub = yield* core.follow
      const running = yield* Effect.forkChild(core.runtime.run!(core.terminal, ["echo", "next"]))
      yield* Effect.sleep("300 millis")
      assert.strictEqual(yield* sentCount(core.calls), 0)
      yield* Ref.set(core.foreground, shell)
      yield* sub.push(foregroundEvent(1, shell))
      yield* Fiber.join(running)
      assert.strictEqual(yield* sentCount(core.calls), 1)
      assert.deepStrictEqual(yield* core.next, { type: "exited", terminal: core.terminal })
    }),
  )
})
