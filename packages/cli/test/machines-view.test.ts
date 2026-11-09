import { assert, describe, it } from "@effect/vitest"
import { cliHeaders } from "@vibest/client/client"
import { REPAIR_PAUSE } from "@vibest/core/machines"
import { MACHINE_TIMEOUT } from "@vibest/core/plugins"
import type { SpawnInput } from "@vibest/core/sessions"
import { type MachineEvent, Plugin } from "@vibest/plugin"
import { Duration, Effect, Fiber, PubSub, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { FakeRuntime, PluginHost, until, untilVirtual, yieldToIo } from "./fakes.ts"
import { fakeSpawns, Net, onB, repoStack } from "./machines-fakes.ts"

type Side = {
  readonly id: string
  readonly link: Record<string, string>
  readonly mirror: Map<string, string>
  readonly connects: Array<MachineEvent>
  readonly removes: Array<MachineEvent>
  refuse: boolean
  hang: boolean
}

const side = (id: string): Side => ({
  id,
  link: { core: `core-${id}` },
  mirror: new Map(),
  connects: [],
  removes: [],
  refuse: false,
  hang: false,
})

const unused = () => Effect.die(new Error("not used in this test"))

const coreOf = (event: MachineEvent) => event.runtimes.find((r) => r.kind === "view")?.link?.core

const viewPlugin = (s: Side) =>
  Plugin.define({
    id: `view-${s.id}`,
    effect: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.runtime.transform((editor) =>
          editor.add({
            id: "view",
            status: () => Effect.succeed({ status: "online" as const }),
            open: unused,
            send: unused,
            read: () => Effect.succeed("screen of B"),
            process: unused,
            close: unused,
            events: Stream.never,
            link: () => Effect.succeed(s.link),
            locate: (machine, sessions) =>
              Effect.sync(() => {
                const name = s.mirror.get(machine.link?.core ?? "")
                return name === undefined
                  ? { missing: true, terminals: new Map() }
                  : {
                      missing: false,
                      as: name,
                      terminals: new Map(sessions.map((id) => [id, { machine: "local", id: `${name}/${id}` }])),
                    }
              }),
          }),
        )
        yield* ctx.machine.hook(
          "connect",
          (event) =>
            Effect.suspend(() => {
              s.connects.push(event)
              if (s.hang) return Effect.never
              const core = coreOf(event)
              if (s.refuse) event.notes.push({ message: "cannot add", fix: "add by hand" })
              else if (core !== undefined && !s.mirror.has(core)) {
                s.mirror.set(core, event.name)
                event.notes.push({ message: `added ${event.name}` })
              }
              return Effect.void
            }),
          { runtime: "view" },
        )
        yield* ctx.machine.hook(
          "remove",
          (event) =>
            Effect.sync(() => {
              s.removes.push(event)
              s.mirror.delete(coreOf(event) ?? "")
            }),
          { runtime: "view" },
        )
      }),
  })

const crasher = Plugin.define({
  id: "crasher",
  effect: (ctx) => ctx.machine.hook("remove", () => Effect.die(new Error("boom"))),
})

const counting = (seen: Array<string>) =>
  Plugin.define({
    id: "counting",
    effect: (ctx) =>
      ctx.machine.hook("connect", (event) => Effect.sync(() => seen.push(event.name)), { runtime: "other" }),
  })

const pair = (extra: ReadonlyArray<Plugin.Plugin> = [], options: { readonly late?: boolean } = {}) =>
  Effect.gen(function* () {
    const net = new Net()
    const A = side("a")
    const B = side("b")
    const spawned: Array<SpawnInput> = []
    const a = yield* repoStack(net, { plugins: [...(options.late ? [] : [viewPlugin(A)]), ...extra] })
    const b = yield* repoStack(net, {
      plugins: [viewPlugin(B)],
      sessions: fakeSpawns(spawned, (input, id) => (input.runtime === undefined ? "" : `t-${id}`)),
    })
    net.route("b-host", b.layout.socket)
    const added = yield* a.cli(a.raw["Machine.Add"]({ name: "mb", target: "b-host" }))
    yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "connected")
    const here = <A, E>(effect: Effect.Effect<A, E>) => RpcClient.withHeaders(effect, cliHeaders(a.directory))
    const spawn = (runtime = "view") => here(a.raw.Spawn({ machine: "mb", prompt: "x", callerEnv: {}, runtime }))
    const listed = (id: string) => Effect.map(here(a.raw.List({})), (r) => r.sessions.find((row) => row.id === id)!)
    return { net, A, B, a, b, added, here, spawn, listed, spawned }
  })

const runs = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(Platform.services))

describe("another machine's terminals here", () => {
  it.effect("Machine.Add fires machine.connect once with B's runtimes and links; notes come back", () =>
    runs(
      Effect.gen(function* () {
        const { A, b, a, added } = yield* pair()
        assert.lengthOf(A.connects, 1)
        const event = A.connects[0]!
        assert.deepStrictEqual([event.name, event.target, event.vibestd], ["mb", "b-host", b.id])
        assert.deepStrictEqual(
          event.runtimes.map((r) => [r.kind, r.status, r.link]),
          [
            ["herdr", "online", undefined],
            ["view", "online", { core: "core-b" }],
          ],
        )
        assert.deepStrictEqual(added.notes, [
          { message: "mb's herdr terminals cannot be shown here; vibest peek mb/<id> reads them" },
          { plugin: "view-a", message: "added mb" },
        ])
        const [row] = yield* a.cli(a.raw["Machine.List"]())
        assert.deepStrictEqual(
          row!.runtimes?.map((r) => [r.kind, r.here]),
          [
            [
              "herdr",
              { visible: false, note: "mb's herdr terminals cannot be shown here; vibest peek mb/<id> reads them" },
            ],
            ["view", { visible: true, as: "mb" }],
          ],
        )
        assert.isNumber(row!.runtimesAt)
        assert.deepStrictEqual(
          row!.notes?.map((n) => [n.plugin, n.message]),
          [["view-a", "added mb"]],
        )
      }),
    ),
  )

  it.effect("the runtime forgot B: List, Get and run --machine call connect on the owner first", () =>
    runs(
      Effect.gen(function* () {
        const { A, a, here, spawn, listed } = yield* pair()
        const spawned = yield* spawn()
        const row = yield* listed(spawned.id)
        assert.deepStrictEqual(row.address, { machine: "local", id: `mb/${onB(spawned.id)}` })
        assert.lengthOf(A.connects, 1)
        const events = (yield* a.run(FakeRuntime)).events
        const foreign = { machine: "local", id: `${row.address.id}@/a.sock` }
        yield* PubSub.publish(events, { type: "state", terminal: foreign, state: "working" })
        yield* PubSub.publish(events, { type: "exited", terminal: foreign })
        yield* yieldToIo
        assert.deepStrictEqual(
          (yield* listed(spawned.id)).status,
          row.status,
          "events for unknown terminals are ignored",
        )
        A.mirror.clear()
        assert.deepStrictEqual((yield* listed(spawned.id)).address, row.address)
        assert.lengthOf(A.connects, 2)
        A.mirror.clear()
        const got = yield* here(a.raw.Get({ id: spawned.id }))
        assert.deepStrictEqual(got.address, row.address)
        assert.lengthOf(A.connects, 3)
        A.mirror.clear()
        const again = yield* spawn()
        assert.isUndefined(again.notes)
        assert.lengthOf(A.connects, 4)
        assert.strictEqual(A.mirror.get("core-b"), "mb")
        const other = yield* spawn("herdr")
        const plain = yield* listed(other.id)
        assert.deepStrictEqual(plain.address, { machine: "mb", id: "" })
        assert.include(plain.view ?? "", "cannot be shown here")
        const peeked = yield* here(a.raw.Peek({ id: spawned.id }))
        assert.strictEqual(peeked.terminal, row.address.id)
        A.refuse = true
        A.mirror.clear()
        const unseen = yield* here(a.raw.Peek({ id: spawned.id }))
        assert.strictEqual(unseen.view, "cannot add; fix: add by hand")
      }),
    ),
  )

  it.effect(
    "a hook that hangs: the pause starts when it gives up, so an ls 1 s later and one queued meanwhile wait",
    () =>
      runs(
        Effect.gen(function* () {
          const { A, spawn, listed } = yield* pair()
          const spawned = yield* spawn()
          A.hang = true
          A.mirror.clear()
          const first = yield* Effect.forkChild(listed(spawned.id))
          yield* until(
            Effect.sync(() => A.connects.length),
            (n) => n === 2,
          )
          const queued = yield* Effect.forkChild(listed(spawned.id))
          yield* yieldToIo
          yield* TestClock.adjust(MACHINE_TIMEOUT)
          const row = yield* Fiber.join(first)
          assert.include(row.view ?? "", "timed out after 30")
          yield* Fiber.join(queued)
          yield* TestClock.adjust(Duration.seconds(1))
          yield* listed(spawned.id)
          assert.lengthOf(A.connects, 2, "no repair within the pause")
        }),
      ),
  )

  it.effect(
    "a runtime plugin loaded after machine add: connect reaches only hooks for its runtime, with no reconnect; ls then shows the address",
    () =>
      runs(
        Effect.gen(function* () {
          const seen: Array<string> = []
          const { A, a, net, spawn, listed } = yield* pair([counting(seen)], { late: true })
          assert.deepStrictEqual(seen, ["mb"])
          const spawned = yield* spawn()
          assert.include((yield* listed(spawned.id)).view ?? "", "cannot be shown here")
          const dials = net.argv.length
          yield* (yield* a.run(PluginHost)).load([counting(seen), viewPlugin(A)])
          yield* until(
            Effect.sync(() => A.connects.length),
            (n) => n === 1,
          )
          assert.deepStrictEqual(seen, ["mb"], "a hook for another runtime is not called again")
          assert.strictEqual(net.argv.length, dials, "no reconnect")
          assert.deepStrictEqual((yield* listed(spawned.id)).address, {
            machine: "local",
            id: `mb/${onB(spawned.id)}`,
          })
        }),
      ),
  )

  it.effect("a repair that fails: the note and no address; paused 30 s for ls; run --machine tries and starts", () =>
    runs(
      Effect.gen(function* () {
        const { A, spawned: onBSide, spawn, listed } = yield* pair()
        const spawned = yield* spawn()
        A.refuse = true
        A.mirror.clear()
        const row = yield* listed(spawned.id)
        assert.deepStrictEqual(row.address, { machine: "mb", id: "" })
        assert.strictEqual(row.view, "cannot add; fix: add by hand")
        assert.lengthOf(A.connects, 2)
        yield* listed(spawned.id)
        assert.lengthOf(A.connects, 2, "within the pause")
        yield* TestClock.adjust(REPAIR_PAUSE)
        yield* listed(spawned.id)
        assert.lengthOf(A.connects, 3, "after the pause")
        const started = yield* spawn()
        assert.lengthOf(A.connects, 4, "run --machine does not wait for the pause")
        assert.deepStrictEqual(started.notes, [{ message: "cannot add; fix: add by hand" }])
        assert.lengthOf(onBSide, 2)
      }),
    ),
  )

  it.effect("a reconnect fires connect again and adds nothing; machine rm fires remove; a crash is a note", () =>
    runs(
      Effect.gen(function* () {
        const { net, A, a } = yield* pair([crasher])
        yield* net.cutAll("b-host")
        yield* untilVirtual(
          Effect.sync(() => A.connects.length),
          (n) => n === 2,
        )
        assert.strictEqual(A.mirror.size, 1)
        const [row] = yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "connected")
        assert.deepStrictEqual(row!.notes, [], "the last connect left no note")
        const removed = yield* a.cli(a.raw["Machine.Remove"]({ name: "mb" }))
        assert.lengthOf(A.removes, 1)
        assert.deepStrictEqual(A.removes[0]!.runtimes.find((r) => r.kind === "view")?.link, { core: "core-b" })
        assert.strictEqual(A.mirror.size, 0)
        assert.lengthOf(removed.notes, 1)
        assert.strictEqual(removed.notes[0]!.plugin, "crasher")
        assert.include(removed.notes[0]!.message, "plugin crasher crashed: boom")
        assert.deepStrictEqual(yield* a.cli(a.raw["Machine.List"]()), [])
      }),
    ),
  )
})
