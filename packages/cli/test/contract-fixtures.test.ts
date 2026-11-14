import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders } from "@vibest/client/client"
import { Project } from "@vibest/core/project"
import { Layout } from "@vibest/schema/layout"
import * as Server from "@vibest/server/server"
import {
  type Line,
  makeRepository,
  tempDirectory,
  testLayer,
  type TestServices,
  wire,
} from "@vibest/server/test/lib/fakes"
import { Effect, Layer, type Scope } from "effect"

import * as Platform from "#platform"

import { VERSION } from "../src/version.ts"

const FIXTURES = path.join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "contract", "fixtures")
const RECORD = process.env["VIBEST_RECORD_FIXTURES"] === "1"
const TIME_KEYS = new Set(["createdAt", "lastActive", "startedAt", "exitedAt", "endedAt", "at"])
const FIXED_TIME = 1767225600000
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
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

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project.Service | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(served)))

describe("contract", () => {
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
})
