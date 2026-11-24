import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { checkLedger, open } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { tempDirectory } from "@vibest/platform-bun/test/lib/fakes"
import { database } from "@vibest/platform-bun/test/lib/unit-helpers"
import { Runtime } from "@vibest/plugin/effect"
import { SessionReply } from "@vibest/protocol/rpc"
import { ArchiveOutcome } from "@vibest/schema/archive"
import { canonicalTarget, Terminal } from "@vibest/schema/terminal"
import { Effect, Layer, Option, Path, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { parseSessionRef } from "../src/session-ref.ts"

const P = "11111111-1111-4111-8111-111111111111"
const S_HC = "22222222-2222-4222-8222-222222222221"
const S_HC_SOCK = "22222222-2222-4222-8222-222222222222"
const S_HERDR = "22222222-2222-4222-8222-222222222223"
const S_HERDR_HASH = "22222222-2222-4222-8222-222222222224"
const S_REX = "22222222-2222-4222-8222-222222222225"
const S_CUSTOM = "22222222-2222-4222-8222-222222222226"
const S_UNPLACED = "22222222-2222-4222-8222-222222222227"
const MIGRATION = "20261124040000_structured_terminal_targets"

const runner = (file: string) => Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(file)))

describe("ledger migration 20261124040000_structured_terminal_targets", () => {
  it.effect("rewrites legacy terminal strings across runtimes and passes ledger replay", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const file = path.join(yield* tempDirectory("vibest-structured-terminals-"), "vibest.db")
      yield* Effect.void.pipe(Effect.provide(database(file)))

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM migration WHERE id = ${MIGRATION}`
        yield* sql`UPDATE meta SET value = '14' WHERE key = 'catalog'`

        const sessionEvent = (id: string, name: string) =>
          [id, 1, 10, "session.created", { project: P, agent: "general", name, directory: `/p/${name}` }] as const

        const legacyFacts = [
          [P, 1, 5, "project.created", { directory: "/p", repositories: [] }],
          sessionEvent(S_HC, "hc-bare"),
          [S_HC, 2, 11, "process.started", { harness: "pi", runtime: "hc", terminal: "t1" }],
          sessionEvent(S_HC_SOCK, "hc-sock"),
          [S_HC_SOCK, 2, 12, "process.started", { harness: "pi", runtime: "hc" }],
          [S_HC_SOCK, 3, 13, "process.placed", { process: 2, terminal: "t2@/other.sock" }],
          sessionEvent(S_HERDR, "herdr-slash"),
          [S_HERDR, 2, 14, "process.started", { harness: "pi", runtime: "herdr", terminal: "s1/w1:p2/vbt-a" }],
          sessionEvent(S_HERDR_HASH, "herdr-hash"),
          [S_HERDR_HASH, 2, 15, "process.started", { harness: "pi", runtime: "herdr", terminal: "s1/w1:p3#vbt-b" }],
          sessionEvent(S_REX, "rex-one"),
          [S_REX, 2, 16, "process.started", { harness: "pi", runtime: "rex", terminal: "session:s/block:b" }],
          sessionEvent(S_CUSTOM, "custom-one"),
          [S_CUSTOM, 2, 17, "process.started", { harness: "pi", runtime: "custom", terminal: "custom-1" }],
          sessionEvent(S_UNPLACED, "unplaced"),
          [S_UNPLACED, 2, 18, "process.started", { harness: "pi", runtime: "hc", terminal: "" }],
        ] as const

        for (const [aggregate, seq, at, type, data] of legacyFacts)
          yield* sql`INSERT INTO event (aggregate, seq, at, type, data)
            VALUES (${aggregate}, ${seq}, ${at}, ${type}, ${JSON.stringify(data)})`
      }).pipe(Effect.provide(Platform.sqlite(file)))

      yield* open().pipe(Effect.provide(runner(file)))

      yield* Effect.gen(function* () {
        const stored = yield* Layer.build(Platform.sqlite(file)).pipe(
          Effect.flatMap((context) => SqlClient.SqlClient.pipe(Effect.provide(context))),
        )

        yield* checkLedger(stored).pipe(
          Effect.provide(Projectors.replay.pipe(Layer.provideMerge(Platform.sqlite(":memory:")))),
        )
      }).pipe(Effect.scoped)

      const rawTerminals = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        return yield* sql<{ sessionId: string; terminal: string | null }>`SELECT session_id, terminal FROM process`
      }).pipe(Effect.provide(Platform.sqlite(file)))

      const byId = new Map(rawTerminals.map((r) => [r.sessionId, r.terminal]))
      assert.strictEqual(byId.get(S_HC), canonicalTarget({ address: "t1" }))
      assert.strictEqual(byId.get(S_HC_SOCK), canonicalTarget({ address: "t2", socket: "/other.sock" }))
      assert.strictEqual(byId.get(S_HERDR), canonicalTarget({ session: "s1", pane: "w1:p2", name: "vbt-a" }))
      assert.strictEqual(byId.get(S_HERDR_HASH), canonicalTarget({ session: "s1", pane: "w1:p3", name: "vbt-b" }))
      assert.strictEqual(byId.get(S_REX), canonicalTarget({ session: "session:s", block: "block:b" }))
      assert.strictEqual(byId.get(S_CUSTOM), canonicalTarget({ id: "custom-1" }))
      assert.isNull(byId.get(S_UNPLACED))

      const decoded = yield* Effect.gen(function* () {
        const db = yield* Db.Service

        return {
          hc: (yield* db.session.getSession(S_HC))?.process?.terminal,
          hcSock: (yield* db.session.getSession(S_HC_SOCK))?.process?.terminal,
          herdr: (yield* db.session.getSession(S_HERDR))?.process?.terminal,
          rex: (yield* db.session.getSession(S_REX))?.process?.terminal,
          unplaced: (yield* db.session.getSession(S_UNPLACED))?.process?.terminal,
        }
      }).pipe(Effect.provide(database(file)))

      assert.deepStrictEqual(decoded.hc, { address: "t1" })
      assert.deepStrictEqual(decoded.hcSock, { address: "t2", socket: "/other.sock" })
      assert.deepStrictEqual(decoded.herdr, { session: "s1", pane: "w1:p2", name: "vbt-a" })
      assert.deepStrictEqual(decoded.rex, { session: "session:s", block: "block:b" })
      assert.isNull(decoded.unplaced)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})

describe("structured terminal and session schemas", () => {
  it("canonicalTarget sorts keys deterministically", () => {
    assert.strictEqual(
      canonicalTarget({ socket: "/a.sock", address: "t1" }),
      canonicalTarget({ address: "t1", socket: "/a.sock" }),
    )
    assert.strictEqual(canonicalTarget({ z: "1", a: "2" }), '{"a":"2","z":"1"}')
  })

  it("parseSessionRef handles local and remote refs", () => {
    assert.deepStrictEqual(parseSessionRef("abcd1234"), { id: "abcd1234" })
    assert.deepStrictEqual(parseSessionRef("mac-mini/abcd1234"), { id: "abcd1234", machine: "mac-mini" })
  })

  it("Terminal, SessionReply, and ArchiveOutcome schemas enforce structured contracts", () => {
    const terminal = Schema.decodeUnknownSync(Terminal)({
      runtime: "hc",
      machine: "mb",
      target: { address: "t1" },
    })

    assert.deepStrictEqual(terminal, { runtime: "hc", machine: "mb", target: { address: "t1" } })

    assert.isTrue(
      Option.isSome(
        Schema.decodeUnknownOption(SessionReply)({
          execution: 1,
          status: "completed",
          text: "done",
          failure: null,
          endedAt: 1,
        }),
      ),
    )
    assert.isTrue(
      Option.isNone(
        Schema.decodeUnknownOption(SessionReply)({
          execution: 1,
          status: "bogus",
          text: null,
          failure: "bad",
          endedAt: 1,
        }),
      ),
    )

    const archive = Schema.decodeUnknownSync(ArchiveOutcome)({
      id: S_HC,
      machine: "mb",
      processes: "exited",
      pane: "closed",
      workspace: "none",
      worktree: "removed",
      path: "/p/w",
      branches: [{ repository: "app", branch: "feat/x" }],
      reasons: [],
    })

    assert.deepStrictEqual(archive.branches, [{ repository: "app", branch: "feat/x" }])
  })

  it.effect("Runtime.define validates terminal shapes at the host boundary", () =>
    Effect.gen(function* () {
      const CustomTerminal = Schema.Struct({
        slot: Schema.String,
        pane: Schema.String,
      })

      const rt = Runtime.define({
        id: "custom",
        terminal: CustomTerminal,
        format: (t) => `${t.slot}:${t.pane}`,
        status: () => Effect.succeed({ status: "online" }),
        open: () => Effect.succeed({ slot: "s1", pane: "p1" }),
        send: () => Effect.void,
        read: (t) => Effect.succeed(`${t.slot}:${t.pane}`),
        process: () => Effect.succeed({ running: false }),
        close: () => Effect.void,
        events: Stream.empty,
      })

      assert.strictEqual(yield* rt.read({ slot: "s1", pane: "p1" }, 10), "s1:p1")

      const rejected = yield* Effect.flip(rt.read({ id: "wrong-shape" }, 10))
      assert.strictEqual(rejected.code, "not_found")
    }),
  )
})
