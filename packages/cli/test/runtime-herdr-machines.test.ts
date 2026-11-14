import { assert, describe, it } from "@effect/vitest"
import type { MachineEvent, MachineNote } from "@vibest/plugin/effect"
import { type Cli, link, locate, type Profile } from "@vibest/runtime-herdr/machines"
import * as Mirror from "@vibest/runtime-herdr/mirror"
import { HerdrPool } from "@vibest/runtime-herdr/pool"
import { agentName, fromPool, parseTerminal } from "@vibest/runtime-herdr/terminal-runtime"
import { RuntimeUnreachable } from "@vibest/schema/session"
import { Effect, Fiber, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

const SESSION = "11111111-2222-4333-8444-555555555555"

const fake = (
  options: {
    readonly addFails?: string
    readonly addHangs?: boolean
    readonly removeFails?: boolean
    readonly listFails?: boolean
  } = {},
  catalog: Array<Profile> = [],
) => {
  const calls: Array<ReadonlyArray<string>> = []
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" })
  const cli: Cli = (args) =>
    (options.addHangs && args[1] === "add" ? Effect.never : Effect.void).pipe(
      Effect.map(() => {
        calls.push(args)
        const [a, b, c] = args
        if (a === "machine" && b === "list")
          return options.listFails ? { code: 1, stdout: "", stderr: "boom\n" } : ok(JSON.stringify(catalog))
        if (a === "machine" && b === "add") {
          if (options.addFails !== undefined) return { code: 1, stdout: "", stderr: options.addFails }
          catalog.push({ id: `p${catalog.length + 1}`, label: args[4]!, target: c!, session: args[6]!, enabled: true })
          return ok("Saved SSH machine. Remote server is ready.\n")
        }
        if (a === "machine" && b === "remove") {
          if (options.removeFails) return { code: 1, stdout: "", stderr: "cannot\n" }
          catalog.splice(
            catalog.findIndex((p) => p.id === c),
            1,
          )
          return ok("")
        }
        return { code: 2, stdout: "", stderr: `unexpected ${args.join(" ")}` }
      }),
    )
  return { cli, calls, catalog }
}

const profile = (extra: Partial<Profile> = {}): Profile => ({
  id: "p0",
  label: "mine",
  target: "b-host",
  session: "vibest",
  enabled: true,
  ...extra,
})

type Noted = MachineEvent & { readonly notes: Array<MachineNote> }

const noting = (hook: typeof Mirror.connect) => (cli: Cli, event: Noted) =>
  hook(cli, event).pipe(Effect.map((notes) => void event.notes.push(...notes)))
const connect = noting(Mirror.connect)
const remove = noting(Mirror.remove)

const event = (link?: Record<string, string>, extra: Partial<Noted> = {}): Noted => ({
  name: "racknerd",
  target: "b-host",
  vibestd: "v",
  runtimes: [{ kind: "herdr", status: "online", ...(link === undefined ? {} : { link }) }],
  notes: [],
  ...extra,
})

const adds = (calls: ReadonlyArray<ReadonlyArray<string>>) => calls.filter((c) => c[0] === "machine" && c[1] === "add")

const pinging = (version: string, detached?: boolean) => {
  const asked: Array<string> = []
  const pool = HerdrPool.of({
    resolve: () => Effect.die("resolve reached"),
    client: (session) =>
      Effect.sync(() => {
        asked.push(session)
        return {
          call: () =>
            Effect.succeed({
              type: "pong",
              version,
              protocol: 1,
              ...(detached === undefined
                ? {}
                : { capabilities: { live_handoff: true, detached_server_daemon: detached } }),
            }),
        } as unknown as Effect.Success<ReturnType<HerdrPool["Service"]["client"]>>
      }),
    events: Stream.empty,
    restarts: Stream.empty,
    sessions: Effect.succeed([]),
  })
  return { pool, asked }
}

describe("runtime-herdr machines: link", () => {
  it.effect(
    "herdr's default session, where agents of other machines open, with its server's version over the socket",
    () =>
      Effect.gen(function* () {
        const herdr = pinging("0.9.6")
        assert.deepStrictEqual(yield* link(herdr.pool), { session: "default", version: "0.9.6" })
        assert.deepStrictEqual(herdr.asked, ["default"])
        const down = HerdrPool.of({
          ...herdr.pool,
          client: (session) => Effect.fail(new RuntimeUnreachable({ session, message: "not running" })),
        })
        assert.deepStrictEqual(yield* link(down), { session: "default" })
        assert.deepStrictEqual(yield* link(pinging("0.9.5", true).pool), { session: "default", version: "0.9.5" })
        assert.deepStrictEqual(yield* link(pinging("0.9.5", false).pool), {
          session: "default",
          version: "0.9.5",
          detached: "no",
        })
      }),
  )
})

describe("runtime-herdr machines: connect", () => {
  it.effect("a profile for the same target and session counts under any label, ssh:// or not", () =>
    Effect.gen(function* () {
      const herdr = fake({}, [profile({ target: "ssh://b-host" })])
      const e = event({ session: "vibest" })
      yield* connect(herdr.cli, e)
      assert.strictEqual(adds(herdr.calls).length, 0)
      assert.deepStrictEqual(e.notes, [])
    }),
  )

  it.effect("a disabled profile gets the enable note and is never enabled by vibest", () =>
    Effect.gen(function* () {
      const herdr = fake({}, [profile({ enabled: false })])
      const e = event({ session: "vibest" })
      yield* connect(herdr.cli, e)
      assert.strictEqual(adds(herdr.calls).length, 0)
      assert.deepStrictEqual(e.notes, [{ message: "herdr here has mine disabled", fix: "herdr machine enable p0" }])
    }),
  )

  it.effect("a label held by another machine gets the rename note", () =>
    Effect.gen(function* () {
      const herdr = fake({}, [profile({ id: "p9", label: "racknerd/vibest", target: "elsewhere" })])
      const e = event({ session: "vibest" })
      yield* connect(herdr.cli, e)
      assert.strictEqual(adds(herdr.calls).length, 0)
      assert.include(e.notes[0]!.message, "a machine racknerd/vibest that is another one")
      assert.strictEqual(e.notes[0]!.fix, "herdr machine rename p9 --label <another label>, then vibest machine ls")
    }),
  )

  it.effect("herdr's refusal becomes the note, never with a command that could stop B's server", () =>
    Effect.gen(function* () {
      const herdr = fake({
        addFails: "remote herdr server is still running v0.9.5\nerror: remote server is not ready for saved machines\n",
      })
      const e = event({ session: "vibest" })
      yield* connect(herdr.cli, e)
      assert.include(e.notes[0]!.message, "error: remote server is not ready for saved machines")
      assert.isUndefined(e.notes[0]!.fix)
    }),
  )

  it.effect("a herdr machine add slower than the hook's budget becomes a note", () =>
    Effect.gen(function* () {
      const e = event({ session: "vibest" })
      const fiber = yield* Effect.forkChild(connect(fake({ addHangs: true }).cli, e))
      yield* TestClock.adjust("26 seconds")
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(e.notes, [
        { message: "herdr here took over 25s to add racknerd; herdr machine list shows whether it did" },
      ])
    }),
  )

  it.effect("no herdr link, an old herdr on B, or no herdr on B: a note or nothing, never an add", () =>
    Effect.gen(function* () {
      const herdr = fake()
      const offline = event(undefined, { runtimes: [{ kind: "herdr", status: "offline", reason: "no server" }] })
      yield* connect(herdr.cli, offline)
      assert.deepStrictEqual(offline.notes, [{ message: "racknerd's herdr is offline: no server" }])
      const nameless = event(undefined)
      yield* connect(herdr.cli, nameless)
      assert.include(nameless.notes[0]!.message, "racknerd's herdr is online but its vibestd named no herdr session")
      const theirs = event({ session: "vibest", version: "0.9.4" })
      yield* connect(herdr.cli, theirs)
      assert.include(theirs.notes[0]!.message, "racknerd's herdr 0.9.4 cannot be viewed from here")
      const none = event(undefined, { runtimes: [{ kind: "hc", status: "online" }] })
      yield* connect(herdr.cli, none)
      assert.deepStrictEqual(none.notes, [])
      assert.strictEqual(adds(herdr.calls).length, 0)
    }),
  )
})

describe("runtime-herdr machines: remove", () => {
  it.effect("removes the profile of the link's session under any label, and only that one", () =>
    Effect.gen(function* () {
      const herdr = fake({}, [
        profile({ id: "p1", session: "work" }),
        profile({ id: "p2", label: "x", session: "vibest" }),
      ])
      yield* remove(herdr.cli, event({ session: "work" }))
      assert.deepStrictEqual(
        herdr.catalog.map((p) => p.id),
        ["p2"],
      )
    }),
  )

  it.effect("with no link the session default; several matches leave all with a note; nothing found is done", () =>
    Effect.gen(function* () {
      const herdr = fake({}, [profile({ id: "p1", session: "default" }), profile({ id: "p2" })])
      yield* remove(herdr.cli, event(undefined, { runtimes: [] }))
      assert.deepStrictEqual(
        herdr.catalog.map((p) => p.id),
        ["p2"],
      )
      const twice = fake({}, [profile({ id: "p1" }), profile({ id: "p2", target: "ssh://b-host" })])
      const e = event({ session: "vibest" })
      yield* remove(twice.cli, e)
      assert.strictEqual(twice.catalog.length, 2)
      assert.include(e.notes[0]!.message, "2 machines for b-host")
      const gone = event({ session: "vibest" })
      yield* remove(fake().cli, gone)
      assert.deepStrictEqual(gone.notes, [])
      const hcOnly = fake({}, [profile()])
      yield* remove(hcOnly.cli, event(undefined, { runtimes: [{ kind: "hc", status: "online" }] }))
      assert.strictEqual(hcOnly.catalog.length, 1)
    }),
  )

  it.effect("a failed remove is a note with the command", () =>
    Effect.gen(function* () {
      const e = event({ session: "vibest" })
      yield* remove(fake({ removeFails: true }, [profile()]).cli, e)
      assert.deepStrictEqual(e.notes, [
        { message: "herdr here could not remove mine: cannot", fix: "herdr machine remove p0" },
      ])
    }),
  )
})

describe("runtime-herdr machines: locate", () => {
  const peer = { id: "racknerd", target: "b-host", link: { session: "vibest" } }
  const there = `vibest/w1:p3/${agentName(SESSION)}`

  it.effect(
    "each B terminal becomes <B terminal>@<label of its herdr session>; one in an unsaved session gets a note",
    () =>
      Effect.gen(function* () {
        const herdr = fake({}, [profile({ id: "p7", label: "racknerd/vibest" })])
        const other = "99999999-2222-4333-8444-555555555555"
        const found = yield* locate(
          herdr.cli,
          peer,
          new Map([
            [SESSION, there],
            [other, `work/w2:p1/${agentName(other)}`],
          ]),
        )
        assert.deepStrictEqual(found.terminals.get(SESSION), { id: `${there}@racknerd/vibest` })
        assert.isFalse(found.terminals.has(other))
        assert.include(found.note!, "no enabled saved machine for that agent's herdr session on racknerd")
        assert.deepStrictEqual(herdr.calls, [["machine", "list", "--json"]])
      }),
  )

  it.effect("a disabled profile and a failing herdr give a note, not missing", () =>
    Effect.gen(function* () {
      const asked = new Map([[SESSION, there]])
      const disabled = yield* locate(fake({}, [profile({ enabled: false })]).cli, peer, asked)
      assert.isFalse(disabled.missing)
      assert.include(disabled.note!, "herdr machine enable p0")
      const failing = yield* locate(fake({ listFails: true }).cli, peer, asked)
      assert.isFalse(failing.missing)
      assert.include(failing.note!, "herdr machine list here: boom")
    }),
  )
})

describe("runtime-herdr machines: remote terminal ids", () => {
  it("an id with @ names a pane on another machine and never parses as a local one", () => {
    assert.isUndefined(parseTerminal({ id: `vibest/w1:p3/${agentName(SESSION)}@racknerd/vibest` }))
    assert.deepStrictEqual(parseTerminal({ id: "vibest/w1:p3" }), {
      session: "vibest",
      paneId: "w1:p3",
      name: undefined,
    })
  })

  it.effect("every runtime member called with such an id fails not_found and never reaches herdr", () =>
    Effect.gen(function* () {
      const pool = HerdrPool.of({
        resolve: () => Effect.die("resolve reached"),
        client: () => Effect.die("client reached"),
        events: Stream.empty,
        restarts: Stream.empty,
        sessions: Effect.succeed([]),
      })
      const runtime = yield* fromPool({
        pool,
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        fs: undefined,
        scope: yield* Effect.scope,
      })
      const terminal = { machine: "local", id: `vibest/w1:p3/${agentName(SESSION)}@racknerd/vibest` }
      const members = [
        runtime.send(terminal, { text: "x" }),
        runtime.read(terminal, 10),
        runtime.process(terminal),
        runtime.close(terminal),
        runtime.focus!(terminal),
        runtime.run!(terminal, ["pi"]),
        runtime.state!(terminal),
        runtime.session!(terminal),
        runtime.present!(terminal, { agent: "a" }),
      ]
      for (const member of members) {
        const error = yield* Effect.flip(member)
        assert.strictEqual(error.code, "not_found")
        assert.include(error.message, "is a pane on racknerd/vibest; vibest peek and send reach it through vibest")
      }
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
