import { assert, describe, it } from "@effect/vitest"
import { type Cli, link, locate, type Profile } from "@vibest/runtime-herdr/machines"
import { HerdrPool } from "@vibest/runtime-herdr/pool"
import { agentName, fromPool, parseTerminal } from "@vibest/runtime-herdr/terminal-runtime"
import { Effect, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

const SESSION = "11111111-2222-4333-8444-555555555555"

const fake = (
  options: {
    readonly version?: string
    readonly addFails?: string
    readonly removeFails?: boolean
    readonly listFails?: boolean
    readonly agents?: ReadonlyArray<{ readonly name: string | null; readonly pane_id: string }>
    readonly sessions?: ReadonlyArray<{ readonly name: string; readonly socket_path: string }>
  } = {},
  catalog: Array<Profile> = [],
) => {
  const calls: Array<ReadonlyArray<string>> = []
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" })
  const cli: Cli = (args) =>
    Effect.sync(() => {
      calls.push(args)
      const [a, b, c] = args
      if (a === "--version") return ok(`herdr ${options.version ?? "0.9.5"}\n`)
      if (a === "session") return ok(JSON.stringify({ sessions: options.sessions ?? [] }))
      if (a === "--machine")
        return ok(JSON.stringify({ id: "cli:agent:list", result: { agents: options.agents ?? [] } }))
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

describe("runtime-herdr machines: link", () => {
  it.effect("names the default session with B's herdr version; an ambient socket names its session or nothing", () =>
    Effect.gen(function* () {
      const herdr = fake({ version: "0.9.6", sessions: [{ name: "work", socket_path: "/s/work.sock" }] })
      assert.deepStrictEqual(yield* link(herdr.cli, undefined), { session: "vibest", version: "0.9.6" })
      assert.deepStrictEqual(yield* link(herdr.cli, "/s/work.sock"), { session: "work", version: "0.9.6" })
      assert.isUndefined(yield* link(herdr.cli, "/s/other.sock"))
    }),
  )
})

describe("runtime-herdr machines: locate", () => {
  const machine = { id: "racknerd", target: "b-host", link: { session: "vibest" } }

  it.effect("missing with no profile; with one, its label and nothing over ssh when no session is asked", () =>
    Effect.gen(function* () {
      assert.isTrue((yield* locate(fake().cli, machine, [SESSION])).missing)
      const herdr = fake({}, [profile({ label: "racknerd/vibest" })])
      const found = yield* locate(herdr.cli, machine, [])
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

  it.effect("each session's agent becomes <B session>/<pane>/<agent>@<label>; a missing one gets a note", () =>
    Effect.gen(function* () {
      const herdr = fake(
        {
          agents: [
            { name: agentName(SESSION), pane_id: "w1:p3" },
            { name: null, pane_id: "w1:p1" },
          ],
        },
        [profile({ id: "p7", label: "racknerd/vibest" })],
      )
      const other = "99999999-2222-4333-8444-555555555555"
      const found = yield* locate(herdr.cli, machine, [SESSION, other])
      assert.deepStrictEqual(found.terminals.get(SESSION), {
        machine: "local",
        id: `vibest/w1:p3/${agentName(SESSION)}@racknerd/vibest`,
      })
      assert.isFalse(found.terminals.has(other))
      assert.include(found.note!, "herdr has no agent of that session on racknerd/vibest")
      assert.deepStrictEqual(herdr.calls.at(-1), ["--machine", "p7", "agent", "list"])
    }),
  )

  it.effect("a disabled profile and a failing herdr give a note, not missing", () =>
    Effect.gen(function* () {
      const disabled = yield* locate(fake({}, [profile({ enabled: false })]).cli, machine, [SESSION])
      assert.isFalse(disabled.missing)
      assert.include(disabled.note!, "herdr machine enable p0")
      const failing = yield* locate(fake({ listFails: true }).cli, machine, [SESSION])
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
