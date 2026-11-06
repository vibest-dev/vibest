import fs from "node:fs"
import net from "node:net"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import { PROTOCOL } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { render, RPC_JSON } from "@vibest/protocol/scripts/contract"
import * as Server from "@vibest/server/server"
import { Effect, Layer, type Scope } from "effect"

import * as Platform from "#platform"

import { authed, makeRepository, tempDirectory, testLayer, type TestServices, until } from "./fakes.ts"

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

type Line = Record<string, unknown>

interface Wire {
  readonly send: (message: Line) => Effect.Effect<void>
  readonly recv: Effect.Effect<Line>
  readonly lines: Array<Line>
}

const wire = Effect.gen(function* () {
  const layout = yield* Layout
  const lines: Array<Line> = []
  const received: Array<Line> = []
  const waiting: Array<(line: Line) => void> = []
  const conn = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<net.Socket>((resolve, reject) => {
          const socket = net.createConnection(layout.socket)
          let buffer = ""
          socket.setEncoding("utf8")
          socket.on("data", (chunk: string) => {
            buffer += chunk
            for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
              const text = buffer.slice(0, end)
              buffer = buffer.slice(end + 1)
              if (text === "") continue
              const line = JSON.parse(text) as Line
              const waiter = waiting.shift()
              if (waiter) waiter(line)
              else received.push(line)
            }
          })
          socket.once("connect", () => resolve(socket))
          socket.once("error", reject)
        }),
    ),
    (socket) => Effect.sync(() => socket.destroy()),
  )
  return {
    lines,
    send: (message) =>
      Effect.sync(() => {
        lines.push(message)
        conn.write(`${JSON.stringify(message)}\n`)
      }),
    recv: Effect.promise(
      () => new Promise<Line>((resolve) => (received.length > 0 ? resolve(received.shift()!) : waiting.push(resolve))),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.orDie,
      Effect.tap((line) => Effect.sync(() => lines.push(line))),
    ),
  } satisfies Wire
})

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
    return out.split(VERSION).join("0.0.0-fixture")
  }
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return text(value)
    if (typeof value === "number" && key !== undefined && TIME_KEYS.has(key)) return FIXED_TIME
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
})
