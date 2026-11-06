import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import { PROTOCOL, sessionHeaders } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { render, RPC_JSON } from "@vibest/protocol/scripts/contract"
import * as Server from "@vibest/server/server"
import { Effect, Layer, type Scope } from "effect"

import * as Platform from "#platform"

import {
  authed,
  FakeRuntime,
  type Line,
  makeRepository,
  projectOf,
  settled,
  tempDirectory,
  testLayer,
  type TestServices,
  until,
  wire,
} from "./fakes.ts"

const FIXTURES = path.join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "contract", "fixtures")
const RECORD = process.env["VIBEST_RECORD_FIXTURES"] === "1"
const TIME_KEYS = new Set(["createdAt", "lastActive", "startedAt", "exitedAt", "endedAt", "at"])
const FIXED_TIME = 1767225600000
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer()),
)

const headers = (record: Record<string, string>) => Object.entries(record)

const request = (id: number, method: string, params: unknown, sent: Record<string, string>) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
  headers: headers(sent),
})

const normalizer = (paths: Record<string, string>) => {
  const ids = new Map<string, string>()
  const known = Object.entries(paths).sort(([a], [b]) => b.length - a.length)
  const text = (value: string) => {
    let out = value
    for (const [from, to] of known) out = out.split(from).join(to)
    out = out.replace(UUID, (id) => {
      const mapped = ids.get(id) ?? `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`
      ids.set(id, mapped)
      return mapped
    })
    return out
      .split(VERSION)
      .join("0.0.0-fixture")
      .replace(/"fiberId":\d+/g, '"fiberId":0')
  }
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return text(value)
    if (typeof value === "number" && key !== undefined && TIME_KEYS.has(key)) return FIXED_TIME
    if (typeof value === "number" && key === "fiberId") return 0
    if (Array.isArray(value)) return value.map((item) => walk(item))
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]))
    return value
  }
  return walk
}

const check = (name: string, lines: ReadonlyArray<Line>, paths: Record<string, string>) =>
  Effect.sync(() => {
    const walk = normalizer(paths)
    const body = lines.map((line) => JSON.stringify(walk(line))).join("\n") + "\n"
    const file = path.join(FIXTURES, `${name}.ndjson`)
    if (RECORD) {
      fs.mkdirSync(FIXTURES, { recursive: true })
      fs.writeFileSync(file, body)
      return
    }
    const committed = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    assert.strictEqual(
      body,
      committed,
      `${file} is stale: run VIBEST_RECORD_FIXTURES=1 pnpm test contract-fixtures and review the diff`,
    )
  })

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(served)))

describe("contract", () => {
  it("rpc.json matches the RPC group; regenerate with pnpm --filter @vibest/protocol contract", () => {
    assert.strictEqual(fs.readFileSync(RPC_JSON, "utf8"), render())
  })

  test(
    "Ping answers the protocol, version, runtimes and capabilities",
    Effect.gen(function* () {
      const w = yield* wire
      yield* w.send(request(1, "Ping", null, {}))
      const answer = yield* w.recv
      assert.strictEqual((answer["result"] as { protocol: number }).protocol, PROTOCOL)
      yield* check("ping", w.lines, {})
    }),
  )

  test(
    "a request without the protocol header is refused with ProtocolRejected",
    Effect.gen(function* () {
      const w = yield* wire
      const repo = yield* makeRepository
      yield* w.send(request(1, "List", { all: true }, { "vibest-caller": "cli", "vibest-repository": repo }))
      yield* w.recv
      yield* check("protocol-rejected", w.lines, { [repo]: "/fixture/repo" })
    }),
  )

  test(
    "Project.Open finds or creates the project of a checkout and refuses a folder outside one",
    Effect.gen(function* () {
      const w = yield* wire
      const repo = yield* makeRepository
      const plain = yield* tempDirectory("vibest-plain-")
      yield* w.send(request(1, "Project.Open", {}, cliHeaders(repo)))
      yield* w.recv
      yield* w.send(request(2, "Project.Open", {}, cliHeaders(repo)))
      yield* w.recv
      yield* w.send(request(3, "Project.Open", {}, cliHeaders(plain)))
      yield* w.recv
      yield* check("project-open", w.lines, { [repo]: "/fixture/repo", [plain]: "/fixture/plain" })
    }),
  )

  test(
    "Launch opens a terminal in the project and runs the command there",
    Effect.gen(function* () {
      const w = yield* wire
      const layout = yield* Layout
      const repo = yield* makeRepository
      yield* w.send(request(1, "Launch", { argv: ["vibest"], focus: false }, cliHeaders(repo)))
      yield* w.recv
      yield* check("launch", w.lines, { [repo]: "/fixture/repo", [layout.home]: "/fixture/home" })
    }),
  )

  test(
    "Remove archives a session and answers NoSuchSession for an unknown id",
    Effect.gen(function* () {
      const layout = yield* Layout
      const repo = yield* makeRepository
      const c = authed(yield* connect(layout.socket), cliHeaders(repo))
      const { id } = yield* c.Spawn({ harness: "pi", prompt: "do it" })
      yield* until((yield* Db).getSession(id), (row) => row?.turnState === "open")
      const worktree = (yield* (yield* Db).sessionDirectory(id))!
      const w = yield* wire
      yield* w.send(request(1, "Remove", { id }, cliHeaders("/")))
      yield* w.recv
      yield* w.send(request(2, "Remove", { id: "0000000000" }, cliHeaders("/")))
      yield* w.recv
      yield* check("remove", w.lines, {
        [worktree]: "/fixture/home/worktrees/repo/w1",
        [repo]: "/fixture/repo",
        [layout.home]: "/fixture/home",
      })
    }),
  )

  test(
    "Watch answers a Snapshot, then a Project and a Session as they change, each after the client's Ack",
    Effect.gen(function* () {
      const db = yield* Db
      const layout = yield* Layout
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const other = yield* makeRepository
      const project = yield* projectOf(repo)
      yield* herdr.addPane("w1:p8", "ws", repo)
      yield* herdr.seedAgent("w1:p8")
      const main = yield* db.coordinatorLaunch(
        project,
        "pi",
        false,
        { runtime: "herdr", address: { machine: "local", id: "w1:p8" } },
        { projectDirectory: repo },
      )
      const coordinator = authed(
        yield* connect(layout.socket),
        sessionHeaders({ sessionId: main.sessionId, projectId: project }),
      )
      const { id } = yield* coordinator.Spawn({ harness: "pi", prompt: "do it" })
      yield* until(db.getSession(id), (row) => row?.turnState === "open")
      yield* settled
      const worktree = (yield* db.sessionDirectory(id))!
      const w = yield* wire
      const ack = { jsonrpc: "2.0", method: "@effect/rpc/Ack", params: { requestId: 1 } }
      yield* w.send(request(1, "Watch", null, cliHeaders(repo)))
      yield* w.recv
      yield* w.send(ack)
      yield* authed(yield* connect(layout.socket), cliHeaders(other))["Project.Open"]({})
      yield* w.recv
      yield* w.send(ack)
      yield* db.updateSession(id, { name: "renamed" })
      yield* w.recv
      yield* w.send(ack)
      yield* w.send({ jsonrpc: "2.0", method: "@effect/rpc/Interrupt", params: { requestId: 1 } })
      yield* w.recv
      yield* check("watch", w.lines, {
        [worktree]: "/fixture/home/worktrees/repo/w1",
        [repo]: "/fixture/repo",
        [other]: "/fixture/other",
        [layout.home]: "/fixture/home",
      })
    }),
  )
})
