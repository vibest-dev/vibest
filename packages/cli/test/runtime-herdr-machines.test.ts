import { assert, describe, it } from "@effect/vitest"
import { type Cli, link, locate, type Profile } from "@vibest/runtime-herdr/machines"
import { HerdrPool } from "@vibest/runtime-herdr/pool"
import { agentName, fromPool, parseTerminal } from "@vibest/runtime-herdr/terminal-runtime"
import { RuntimeUnreachable } from "@vibest/schema/session"
import { Effect, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

const SESSION = "11111111-2222-4333-8444-555555555555"

const fake = (
  options: {
    readonly addFails?: string
    readonly removeFails?: boolean
    readonly listFails?: boolean
  } = {},
  catalog: Array<Profile> = [],
) => {
  const calls: Array<ReadonlyArray<string>> = []
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" })
  const cli: Cli = (args) =>
    Effect.sync(() => {
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
    })
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

const pinging = (version: string, sockets: Record<string, string>) => {
  const asked: Array<string> = []
  const pool = HerdrPool.of({
    resolve: (location) =>
      "socketPath" in location && sockets[location.socketPath] !== undefined
        ? Effect.succeed(sockets[location.socketPath]!)
        : Effect.fail(new RuntimeUnreachable({ session: "?", message: "no session" })),
    client: (session) =>
      Effect.sync(() => {
        asked.push(session)
        return { call: () => Effect.succeed({ type: "pong", version, protocol: 1 }) } as unknown as Effect.Success<
          ReturnType<HerdrPool["Service"]["client"]>
        >
      }),
    events: Stream.empty,
    restarts: Stream.empty,
    sessions: Effect.succeed([]),
  })
  return { pool, asked }
}

describe("runtime-herdr machines: link", () => {
  it.effect(
    "the default session with its server's version over the socket; an ambient socket names its session or nothing",
    () =>
      Effect.gen(function* () {
        const herdr = pinging("0.9.6", { "/s/work.sock": "work" })
        assert.deepStrictEqual(yield* link(herdr.pool, undefined), { session: "vibest", version: "0.9.6" })
        assert.deepStrictEqual(yield* link(herdr.pool, "/s/work.sock"), { session: "work", version: "0.9.6" })
        assert.isUndefined(yield* link(herdr.pool, "/s/other.sock"))
        assert.deepStrictEqual(herdr.asked, ["vibest", "work"])
        const down = HerdrPool.of({
          ...herdr.pool,
          client: (session) => Effect.fail(new RuntimeUnreachable({ session, message: "not running" })),
        })
        assert.deepStrictEqual(yield* link(down, undefined), { session: "vibest" })
      }),
  )
})

describe("runtime-herdr machines: locate", () => {
  const machine = { id: "racknerd", target: "b-host", link: { session: "vibest" } }
  const there = `vibest/w1:p3/${agentName(SESSION)}`

  it.effect("missing with no profile; with one, its label, from herdr machine list alone", () =>
    Effect.gen(function* () {
      assert.isTrue((yield* locate(fake().cli, machine, new Map([[SESSION, there]]))).missing)
      const herdr = fake({}, [profile({ label: "racknerd/vibest" })])
      const found = yield* locate(herdr.cli, machine, new Map())
      assert.deepStrictEqual(
        { ...found, terminals: [...found.terminals] },
        {
          missing: false,
          terminals: [],
          as: "racknerd/vibest",
        },
      )
      assert.deepStrictEqual(herdr.calls, [["machine", "list", "--json"]])
    }),
  )

  it.effect(
    "each B terminal becomes <B terminal>@<label of its herdr session>; one in an unsaved session gets a note",
    () =>
      Effect.gen(function* () {
        const herdr = fake({}, [profile({ id: "p7", label: "racknerd/vibest" })])
        const other = "99999999-2222-4333-8444-555555555555"
        const found = yield* locate(
          herdr.cli,
          machine,
          new Map([
            [SESSION, there],
            [other, `work/w2:p1/${agentName(other)}`],
          ]),
        )
        assert.deepStrictEqual(found.terminals.get(SESSION), { machine: "local", id: `${there}@racknerd/vibest` })
        assert.isFalse(found.terminals.has(other))
        assert.include(found.note!, "no enabled saved machine for that agent's herdr session on racknerd")
        assert.deepStrictEqual(herdr.calls, [["machine", "list", "--json"]])
      }),
  )

  it.effect("a disabled profile and a failing herdr give a note, not missing", () =>
    Effect.gen(function* () {
      const asked = new Map([[SESSION, there]])
      const disabled = yield* locate(fake({}, [profile({ enabled: false })]).cli, machine, asked)
      assert.isFalse(disabled.missing)
      assert.include(disabled.note!, "herdr machine enable p0")
      const failing = yield* locate(fake({ listFails: true }).cli, machine, asked)
      assert.isFalse(failing.missing)
      assert.include(failing.note!, "herdr machine list here: boom")
    }),
  )
})

describe("runtime-herdr machines: remote terminal ids", () => {
  it("an id with @ names a pane on another machine and never parses as a local one", () => {
    assert.isUndefined(parseTerminal({ machine: "local", id: `vibest/w1:p3/${agentName(SESSION)}@racknerd/vibest` }))
    assert.deepStrictEqual(parseTerminal({ machine: "local", id: "vibest/w1:p3" }), {
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
