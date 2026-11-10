import { assert, describe, it } from "@effect/vitest"
import { type MachineEvent, Plugin } from "@vibest/plugin"
import { machineHooks } from "@vibest/plugin/testing"
import { Effect, Queue, Stream } from "effect"
import { type api, HcError, type HcShape, HcTransportError } from "effect-herdr-core-sdk"

import { connect, locate, mirror, remove } from "../src/machines.ts"

type Row = api.MachineView

const row = (name: string, id: string, extra: Partial<Row> = {}): Row => ({
  host: "b-host",
  id,
  name,
  session: "main",
  state: "connected",
  target: "b-host",
  version: "0.1.19",
  ...extra,
})

const fake = (rows: Array<Row>, options: { offline?: boolean; addFails?: string; rmFails?: string } = {}) => {
  const calls: Array<[string, unknown]> = []
  const hc: Pick<HcShape, "call"> = {
    call: ((method: string, params: Record<string, unknown>) =>
      Effect.suspend((): Effect.Effect<unknown, HcError | HcTransportError> => {
        calls.push([method, params])
        if (options.offline) return Effect.fail(new HcTransportError({ method, message: "connect ENOENT" }))
        switch (method) {
          case "machine.list":
            return Effect.succeed({ machines: [...rows] })
          case "machine.add": {
            if (options.addFails)
              return Effect.fail(new HcError({ method, kind: options.addFails, message: options.addFails }))
            if (rows.some((r) => r.name === params.name))
              return Effect.fail(new HcError({ method, kind: "name_taken", message: "name taken" }))
            const added = row(params.name as string, "core-new", { session: params.session as string })
            rows.push(added)
            return Effect.succeed(added)
          }
          case "machine.rm": {
            if (options.rmFails)
              return Effect.fail(new HcError({ method, kind: options.rmFails, message: options.rmFails }))
            const at = rows.findIndex((r) => r.name === params.machine)
            if (at < 0) return Effect.fail(new HcError({ method, kind: "machine_unknown", message: "unknown" }))
            rows.splice(at, 1)
            return Effect.succeed({ removed: [params.machine] })
          }
          case "terminal.list":
            return Effect.succeed({
              machines: [],
              hidden_finished: 0,
              terminals: [
                { address: "mb/t7", labels: { "vibest.session": "s1" } },
                { address: "mb/t8", labels: { "vibest.session": "s2" } },
                { address: "other/t1", labels: { "vibest.session": "s1" } },
                { address: "t3", labels: { "vibest.session": "s1" } },
              ],
            })
        }
        return Effect.die(new Error(`unexpected ${method}`))
      })) as HcShape["call"],
  }
  return { hc, calls, rows, added: () => calls.filter(([m]) => m === "machine.add").length }
}

const event = (link?: Record<string, string>, extra: Partial<MachineEvent> = {}): MachineEvent => ({
  name: "mb",
  target: "b-host",
  vibestd: "b-id",
  runtimes: [{ kind: "hc", status: "online", ...(link === undefined ? {} : { link }) }],
  notes: [],
  ...extra,
})

const linked = { core: "core-new", session: "main" }

describe("hc mirrors vibest's machines", () => {
  it.effect("connect adds B once with name, target and session, never install; found by core id under any name", () =>
    Effect.gen(function* () {
      const f = fake([])
      const first = event(linked)
      yield* connect(f.hc, first)
      assert.deepStrictEqual(f.calls[1], ["machine.add", { target: "b-host", name: "mb", session: "main" }])
      assert.match(first.notes[0]!.message, /^hc: added mb to herdr-core here/)
      yield* connect(f.hc, event(linked))
      assert.strictEqual(f.added(), 1)
      f.rows[0] = { ...f.rows[0]!, name: "vps" }
      const renamed = event(linked)
      yield* connect(f.hc, renamed)
      assert.strictEqual(f.added(), 1)
      assert.deepStrictEqual(renamed.notes, [])
    }),
  )

  it.effect("already_added is done; no hc link adds nothing; an offline hc there is a note", () =>
    Effect.gen(function* () {
      const busy = fake([], { addFails: "already_added" })
      const e = event(linked)
      yield* connect(busy.hc, e)
      assert.deepStrictEqual(e.notes, [])
      const none = fake([])
      yield* connect(none.hc, event(undefined, { runtimes: [{ kind: "herdr", status: "online" }] }))
      const off = event(undefined, { runtimes: [{ kind: "hc", status: "offline", reason: "no core" }] })
      yield* connect(none.hc, off)
      assert.strictEqual(none.calls.length, 0)
      assert.deepStrictEqual(off.notes, [{ message: "mb's hc is offline: no core" }])
    }),
  )

  it.effect("name_taken: the same target and session is a stale mirror and is replaced; another row is left", () =>
    Effect.gen(function* () {
      const stale = fake([row("mb", "core-old", { state: "unreachable" })])
      const e = event(linked)
      yield* connect(stale.hc, e)
      assert.deepStrictEqual(
        stale.rows.map((r) => [r.name, r.id]),
        [["mb", "core-new"]],
      )
      assert.strictEqual(e.notes[0]!.message, "hc: mb's core changed (core-old → core-new); replaced")
      const mine = fake([row("mb", "core-user", { target: "elsewhere" })])
      const kept = event(linked)
      yield* connect(mine.hc, kept)
      assert.deepStrictEqual(
        mine.rows.map((r) => r.id),
        ["core-user"],
      )
      assert.strictEqual(kept.notes[0]!.message, "hc here has a machine mb that is another one")
      assert.include(kept.notes[0]!.fix ?? "", "hc machine rm mb")
    }),
  )

  it.effect("hc_missing and an offline core here give notes with fixes; a row not connected says its state", () =>
    Effect.gen(function* () {
      const missing = event(linked)
      yield* connect(fake([], { addFails: "hc_missing" }).hc, missing)
      assert.deepStrictEqual(missing.notes, [
        { message: "hc here: hc_missing", fix: "hc machine add --name mb --session main b-host" },
      ])
      const offline = event(linked)
      yield* connect(fake([], { offline: true }).hc, offline)
      assert.strictEqual(offline.notes[0]!.fix, "hc server start")
      assert.match(offline.notes[0]!.message, /^hc here is offline/)
      const login = event(linked)
      yield* connect(fake([row("mb", "core-new", { state: "needs_login" })]).hc, login)
      assert.deepStrictEqual(login.notes, [
        { message: "hc here reaches mb as mb: needs_login", fix: "hc machine login mb" },
      ])
      const noSession = event({ core: "core-new", session: "" })
      yield* connect(fake([]).hc, noSession)
      assert.include(noSession.notes[0]!.message, "add it by hand")
    }),
  )

  it.effect("remove: by core id under another name; by target without a link; several targets left; gone is done", () =>
    Effect.gen(function* () {
      const byId = fake([row("vps", "core-new"), row("keep", "core-x")])
      yield* remove(byId.hc, event(linked))
      assert.deepStrictEqual(
        byId.rows.map((r) => r.name),
        ["keep"],
      )
      const byTarget = fake([row("mb", "core-1"), row("x", "core-2", { target: "other" })])
      yield* remove(byTarget.hc, event(undefined, { runtimes: [] }))
      assert.deepStrictEqual(
        byTarget.rows.map((r) => r.name),
        ["x"],
      )
      const two = fake([row("a", "core-1"), row("b", "core-2")])
      const several = event(undefined, { runtimes: [] })
      yield* remove(two.hc, several)
      assert.lengthOf(two.rows, 2)
      assert.include(several.notes[0]!.message, "hc here has 2 machines for b-host")
      const gone = event(linked)
      yield* remove(fake([row("mb", "core-new")], { rmFails: "machine_unknown" }).hc, gone)
      assert.deepStrictEqual(gone.notes, [])
      const offline = event(linked)
      yield* remove(fake([], { offline: true }).hc, offline)
      assert.strictEqual(offline.notes[0]!.fix, "hc machine rm mb")
    }),
  )

  const asked = (ids: ReadonlyArray<string>) => new Map(ids.map((id) => [id, `b/${id}`]))

  it.effect("locate: missing, found by core id under a renamed name, and unreachable with its why", () =>
    Effect.gen(function* () {
      const machine = { id: "mb", target: "b-host", link: linked }
      const none = yield* locate(fake([]).hc, "/a.sock", machine, asked(["s1"]))
      assert.isTrue(none.missing)
      const found = yield* locate(fake([row("mb", "core-new")]).hc, "/a.sock", machine, asked(["s1", "s2", "s9"]))
      assert.isFalse(found.missing)
      assert.include(found.note ?? "", "no terminal of that session under mb/")
      assert.strictEqual(found.as, "mb")
      assert.deepStrictEqual(
        [...found.terminals.entries()],
        [
          ["s1", { machine: "local", id: "mb/t7@/a.sock" }],
          ["s2", { machine: "local", id: "mb/t8@/a.sock" }],
        ],
      )
      const down = yield* locate(
        fake([row("mb", "core-new", { state: "unreachable", why: "ssh refused" })]).hc,
        "/a.sock",
        machine,
        asked(["s1"]),
      )
      assert.isFalse(down.missing)
      assert.strictEqual(down.note, "hc here reaches mb as mb: unreachable (ssh refused)")
      const offline = yield* locate(fake([], { offline: true }).hc, "/a.sock", machine, asked(["s1"]))
      assert.isFalse(offline.missing)
      assert.include(offline.note ?? "", "fix: hc server start")
    }),
  )

  it.effect("remove leaves a same-target row alone when B reported runtimes but no hc", () =>
    Effect.gen(function* () {
      const f = fake([row("mine", "core-user")])
      const e = event(undefined, { runtimes: [{ kind: "herdr", status: "online" }] })
      yield* remove(f.hc, e)
      assert.deepStrictEqual(
        f.rows.map((r) => r.name),
        ["mine"],
      )
      assert.deepStrictEqual(e.notes, [])
      const linkless = fake([row("mb", "core-1")])
      yield* remove(linkless.hc, event(undefined, { runtimes: [{ kind: "hc", status: "offline" }] }))
      assert.lengthOf(linkless.rows, 0, "an hc entry without a link still falls back to the target")
    }),
  )

  it.effect("a same-target, same-session row that is connected is not replaced", () =>
    Effect.gen(function* () {
      const f = fake([row("mb", "core-other")])
      const e = event(linked)
      yield* connect(f.hc, e)
      assert.deepStrictEqual(
        f.rows.map((r) => r.id),
        ["core-other"],
      )
      assert.strictEqual(e.notes[0]!.message, "hc here has a machine mb that is another one")
    }),
  )

  it.live("mirror: a core reset re-checks the held machines; remove drops one from what is held", () =>
    Effect.gen(function* () {
      const f = fake([])
      const resets = yield* Queue.unbounded<void>()
      const hooks = yield* machineHooks(
        Plugin.define({ id: "hc-test", effect: (ctx) => mirror(ctx.machine, f.hc, Stream.fromQueue(resets)) }),
      )
      const { notes: _, ...b } = event(linked)
      const { notes: __, ...c } = event({ core: "core-c", session: "main" }, { name: "mc", target: "c-host" })
      yield* hooks.fire("connect", b)
      yield* hooks.fire("connect", c)
      assert.strictEqual(f.added(), 2)
      f.rows.length = 0
      yield* hooks.fire("remove", c)
      yield* Queue.offer(resets, undefined)
      yield* Effect.yieldNow
      yield* Effect.sleep("10 millis").pipe(Effect.repeat({ until: () => f.added() >= 3, times: 100 }))
      yield* Effect.sleep("50 millis")
      assert.strictEqual(f.added(), 3, "only mb is added back")
      assert.deepStrictEqual(
        f.rows.map((r) => r.name),
        ["mb"],
      )
    }).pipe(Effect.scoped),
  )
})
