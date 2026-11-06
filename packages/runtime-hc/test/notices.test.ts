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
import { Hc, SocketConnector } from "effect-hc-sdk"
import * as HcBun from "effect-hc-sdk/bun"
import * as Socket from "effect/socket/Socket"

import { make, terminalId } from "../src/terminal-runtime.ts"

const shell = { argv: ["/bin/zsh"], cwd: "/tmp", name: "zsh", pid: 100 }
const sleeping = { argv: ["sleep", "5"], cwd: "/tmp", name: "sleep", pid: 101 }
type Foreground = typeof shell

const recordedTerminal = (foreground: Foreground) =>
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
    labels: { "vibest.runtime": "hc" },
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
      const request = yield* Request(Option.getOrElse(line, () => ""))
      yield* Ref.update(calls, (all) => [...all, request.method])
      const reply = (result: string) => writer.write(`{"id":${request.id},"jsonrpc":"2.0","result":${result}}\n`)
      if (request.method === "events.subscribe") {
        yield* reply(`{"channel":null,"seq":0,"terminals":[${recordedTerminal(yield* Ref.get(foreground))}]}`)
        const closed = yield* Deferred.make<void>()
        yield* Queue.offer(subscribers, {
          push: (text) => writer.write(`${text}\n`).pipe(Effect.orDie),
          close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
        })
        yield* Deferred.await(closed)
      } else if (request.method === "terminal.get") yield* reply(recordedTerminal(yield* Ref.get(foreground)))
      else if (request.method === "terminal.send") yield* reply('{"started":null,"status":null,"turn":0}')
      yield* writer.write(new Socket.CloseEvent())
    }).pipe(Effect.scoped, Effect.ignore)

  const server = yield* BunSocketServer.make({ path: socketPath })
  yield* Effect.forkScoped(server.run(serve))
  const connector = yield* SocketConnector
  const connect = (at: string) => Effect.runSync(Hc.make(at).pipe(Effect.provideService(SocketConnector, connector)))
  const runtime = yield* make({ connect, socket: socketPath, scope: yield* Effect.scope })
  const seen = yield* Queue.unbounded<VibestPlugin.Runtime.RuntimeEvent>()
  yield* runtime.events.pipe(
    Stream.runForEach((e) => Queue.offer(seen, e)),
    Effect.forkScoped,
  )
  yield* Effect.sleep("50 millis")
  return {
    runtime,
    foreground,
    calls,
    subscriber: Queue.take(subscribers),
    next: Queue.take(seen),
    terminal: { machine: "local", id: terminalId(socketPath, "t1") },
  }
})

const sentCount = (calls: Ref.Ref<ReadonlyArray<string>>) =>
  Ref.get(calls).pipe(Effect.map((all) => all.filter((m) => m === "terminal.send").length))

const live = <A, E>(
  name: string,
  body: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem | Path.Path | SocketConnector>,
) =>
  it.live(name, () => body.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, HcBun.layer))), 20_000)

describe("runtime-hc against a fake core", () => {
  live(
    "a foreground change back to the shell after a program ran is the terminal's exit",
    Effect.gen(function* () {
      const core = yield* fakeCore
      yield* core.runtime.process(core.terminal)
      const sub = yield* core.subscriber
      yield* sub.push(foregroundEvent(1, sleeping))
      yield* sub.push(foregroundEvent(2, shell))
      assert.deepStrictEqual(yield* core.next, { type: "exited", terminal: core.terminal })
    }),
  )

  live(
    "missed events drop the subscription; the next snapshot publishes reset",
    Effect.gen(function* () {
      const core = yield* fakeCore
      yield* core.runtime.process(core.terminal)
      const first = yield* core.subscriber
      yield* first.push(MISSED)
      yield* core.subscriber
      assert.deepStrictEqual(yield* core.next, { type: "reset", machine: "local" })
    }),
  )

  live(
    "a subscription the core closes is made again, and its snapshot publishes reset",
    Effect.gen(function* () {
      const core = yield* fakeCore
      yield* core.runtime.process(core.terminal)
      const first = yield* core.subscriber
      yield* first.close
      yield* core.subscriber
      assert.deepStrictEqual(yield* core.next, { type: "reset", machine: "local" })
    }),
  )

  live(
    "run types into a busy terminal only after the foreground event back to its shell",
    Effect.gen(function* () {
      const core = yield* fakeCore
      yield* Ref.set(core.foreground, sleeping)
      yield* core.runtime.process(core.terminal)
      const sub = yield* core.subscriber
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
