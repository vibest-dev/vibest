import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { addressOf } from "../src/scenarios/hc.ts"
import { entrySessionId, foreignTerminalsIn, herdrPane, SESSIONS } from "../src/world/db.ts"

const tempWorld = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vbe-db-test-"))
  const home = path.join(root, "vibest")
  const repo = path.join(root, "shop")
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(repo, { recursive: true })

  return { root, home, repo, file: path.join(home, "vibest.db") }
}

describe("world db helpers", () => {
  test("entrySessionId resolves latest live local root session on current and legacy schemas", async () => {
    const current = await tempWorld()

    try {
      const db = new Database(current.file)
      db.run("CREATE TABLE project (id TEXT PRIMARY KEY, directory TEXT NOT NULL)")
      db.run(
        `CREATE TABLE session (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          parent_session_id TEXT,
          origin_remote TEXT,
          created_at INTEGER NOT NULL,
          active_at INTEGER,
          ended_at INTEGER
        )`,
      )
      const directory = await fs.realpath(current.repo)
      db.run("INSERT INTO project VALUES ('p1', ?)", [directory])
      db.run("INSERT INTO session VALUES ('s-old', 'p1', NULL, NULL, 100, 100, NULL)")
      db.run("INSERT INTO session VALUES ('s-child', 'p1', 's-old', NULL, 300, 300, NULL)")
      db.run("INSERT INTO session VALUES ('s-remote', 'p1', NULL, 'm-remote', 400, 400, NULL)")
      db.run("INSERT INTO session VALUES ('s-ended', 'p1', NULL, NULL, 500, 500, 501)")
      db.run("INSERT INTO session VALUES ('s-active', 'p1', NULL, NULL, 200, 250, NULL)")
      db.close()

      expect(await entrySessionId(current.repo, current.home)).toBe("s-active")
    } finally {
      await fs.rm(current.root, { recursive: true, force: true })
    }

    const legacy = await tempWorld()

    try {
      const db = new Database(legacy.file)
      db.run("CREATE TABLE project (id TEXT PRIMARY KEY, directory TEXT NOT NULL, entry_session_id TEXT)")
      db.run(
        `CREATE TABLE session (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          parent_session_id TEXT,
          origin_peer TEXT,
          created_at INTEGER NOT NULL,
          active_at INTEGER,
          ended_at INTEGER
        )`,
      )
      const directory = await fs.realpath(legacy.repo)
      db.run("INSERT INTO project VALUES ('p1', ?, 's-legacy')", [directory])
      db.run("INSERT INTO session VALUES ('s-legacy', 'p1', NULL, NULL, 100, 100, NULL)")
      db.run("INSERT INTO session VALUES ('s-peer', 'p1', NULL, 'peer-1', 200, 200, NULL)")
      db.close()

      expect(await entrySessionId(legacy.repo, legacy.home)).toBe("s-legacy")
    } finally {
      await fs.rm(legacy.root, { recursive: true, force: true })
    }
  })

  test("SESSIONS formats structured JSON and legacy process.terminal values", async () => {
    const db = new Database(":memory:")

    try {
      db.run(
        `CREATE TABLE session (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          parent_session_id TEXT,
          agent TEXT NOT NULL,
          directory TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          ended_at INTEGER
        )`,
      )
      db.run(
        `CREATE TABLE process (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          harness TEXT NOT NULL,
          provider TEXT,
          runtime TEXT,
          terminal TEXT,
          harness_session_id TEXT,
          pid INTEGER,
          integration_version TEXT,
          ended_at INTEGER
        )`,
      )

      const cases: ReadonlyArray<readonly [string, string, string | null, string]> = [
        ["s-herdr", "herdr", JSON.stringify({ name: "main", pane: "w1:p2", session: "vbe-1" }), "vbe-1/w1:p2/main"],
        ["s-hc-default", "hc", JSON.stringify({ address: "t1" }), "t1"],
        ["s-hc-sock", "hc", JSON.stringify({ address: "t2", socket: "/tmp/hc.sock" }), "t2@/tmp/hc.sock"],
        ["s-rex", "rex", JSON.stringify({ block: "b9", session: "vbe-1" }), "vbe-1/b9"],
        ["s-custom", "status-fixture", JSON.stringify({ id: "vbe-1/t3" }), "vbe-1/t3"],
        ["s-legacy", "herdr", "vbe-1/w2:p4", "vbe-1/w2:p4"],
      ]

      for (const [id, runtime, terminal] of cases) {
        db.run("INSERT INTO session VALUES (?, 'p1', NULL, 'general', '/repo', 1, NULL)", [id])
        db.run("INSERT INTO process (session_id, harness, runtime, terminal) VALUES (?, 'pi', ?, ?)", [
          id,
          runtime,
          terminal,
        ])
      }

      for (const [id, runtime, raw, expected] of cases) {
        const found = db.query(`SELECT runtime FROM ${SESSIONS} s WHERE id = ?`).get(id) as { runtime: string }
        expect(JSON.parse(found.runtime)).toEqual({ kind: runtime, id: expected })

        if (runtime === "herdr") expect(herdrPane(raw)).toBe(expected.split("/")[1])

        if (runtime === "hc") {
          expect(addressOf(expected)).toBe(expected.split("@")[0] ?? "")
          expect(addressOf(raw!)).toBe(expected.split("@")[0] ?? "")
        }
      }
    } finally {
      db.close()
    }
  })

  test("foreignTerminalsIn accepts world terminals and reports leaked ones", async () => {
    const w = await tempWorld()

    try {
      const db = new Database(w.file)
      db.run("CREATE TABLE session (id TEXT PRIMARY KEY)")
      db.run(
        "CREATE TABLE process (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, runtime TEXT, terminal TEXT)",
      )

      const entries: ReadonlyArray<readonly [string, string, string]> = [
        ["own-herdr", "herdr", JSON.stringify({ pane: "w1:p1", session: "vbe-123" })],
        ["sub-herdr", "herdr", JSON.stringify({ pane: "w1:p2", session: "vbe-123-move" })],
        ["own-hc-default", "hc", JSON.stringify({ address: "t1" })],
        ["own-hc-sock", "hc", JSON.stringify({ address: "t2", socket: path.join(w.root, "sub/hc.sock") })],
        ["own-custom", "status-fixture", JSON.stringify({ id: "vbe-123/t1" })],
        ["leak-herdr", "herdr", JSON.stringify({ pane: "w1:p9", session: "default" })],
        ["leak-hc", "hc", JSON.stringify({ address: "t9", socket: "/Users/someone/.hc.sock" })],
      ]

      for (const [id, runtime, terminal] of entries) {
        db.run("INSERT INTO session VALUES (?)", [id])
        db.run("INSERT INTO process (session_id, runtime, terminal) VALUES (?, ?, ?)", [id, runtime, terminal])
      }

      db.close()

      const found = foreignTerminalsIn(w.home, w.root, "vbe-123", new Set())
      expect(found.map((item) => item.split(" ")[0])).toEqual(["leak-herdr", "leak-hc"])
    } finally {
      await fs.rm(w.root, { recursive: true, force: true })
    }
  })
})
