import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BunServices } from "@effect/platform-bun"
import type { Mcp } from "@vibest/schema/mcp"
import { Deferred, Effect, Exit, FiberSet, Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"

import { McpClient } from "../src/client.ts"
import { McpPool } from "../src/pool.ts"

const FAKE_STDIO_SERVER = `
import readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n")
let isModern = false
rl.on("line", (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: {
          tools: {},
          extensions: { "io.modelcontextprotocol/events": {} },
        },
        serverInfo: { name: "fake-stdio", version: "1.0.0", title: "Fake Stdio" },
        instructions: "Fake stdio server for testing.",
      },
    })
    return
  }
  if (msg.method === "server/discover") {
    isModern = true
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        supportedVersions: ["2026-07-28"],
        capabilities: {
          tools: {},
          extensions: { "io.modelcontextprotocol/events": {} },
        },
        serverInfo: { name: "fake-stdio", version: "1.0.0", title: "Fake Stdio" },
        instructions: "Fake stdio server for testing.",
      },
    })
    return
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        ...(isModern ? { resultType: "complete", ttlMs: 60000, cacheScope: "public" } : {}),
        tools: [
          {
            name: "pid",
            description: "Return server process PID",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "echo",
            description: "Echo input text",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      },
    })
    return
  }
  if (msg.method === "tools/call") {
    if (msg.params?.name === "pid") {
      send({ jsonrpc: "2.0", id: msg.id, result: { ...(isModern ? { resultType: "complete" } : {}), content: [{ type: "text", text: String(process.pid) }] } })
      return
    }
    if (msg.params?.name === "echo") {
      send({ jsonrpc: "2.0", id: msg.id, result: { ...(isModern ? { resultType: "complete" } : {}), content: [{ type: "text", text: String(msg.params.arguments?.text ?? "") }] } })
      return
    }
  }
  if (msg.method === "events/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        events: [{ name: "issue.created", description: "Fires when an issue is created", delivery: ["push"] }],
      },
    })
    return
  }
  if (msg.method === "events/stream") {
    const subId = msg.id
    send({
      jsonrpc: "2.0",
      method: "notifications/events/active",
      params: { cursor: "cur-1", truncated: true, _meta: { "io.modelcontextprotocol/subscriptionId": subId } },
    })
    send({
      jsonrpc: "2.0",
      method: "notifications/events/event",
      params: {
        eventId: "e-1",
        name: "issue.created",
        timestamp: "2026-11-25T00:00:00Z",
        data: { id: 42 },
        cursor: "cur-2",
        _meta: { "io.modelcontextprotocol/subscriptionId": subId },
      },
    })
    send({
      jsonrpc: "2.0",
      method: "notifications/events/heartbeat",
      params: { cursor: "cur-2", _meta: { "io.modelcontextprotocol/subscriptionId": subId } },
    })
    setTimeout(() => {
      send({ jsonrpc: "2.0", id: msg.id, result: {} })
    }, 30)
  }
})
`

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

describe("McpStdio, McpPool scale-to-zero, and SEP-3415 events", () => {
  it("streams SEP-3415 events/list and events/stream with truncated cursor detection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-mcp-events-"))
    const script = path.join(dir, "server.mjs")
    fs.writeFileSync(script, FAKE_STDIO_SERVER, "utf8")

    try {
      const config: Mcp.LocalServerConfig = {
        type: "local",
        command: [process.execPath, script],
        cwd: dir,
        protocol: "legacy",
      }

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* McpClient.connect({
              server: "fake-events",
              config,
              directory: dir,
              events: true,
            })

            const listed = yield* client.events!.list()
            const messages = yield* Stream.runCollect(client.events!.stream({ name: "issue.created", cursor: "cur-0" }))

            return { listed, messages }
          }),
        ).pipe(Effect.provide(BunServices.layer)),
      )

      expect(result.listed).toHaveLength(1)
      expect(result.listed[0]?.name).toBe("issue.created")
      expect(result.messages[0]).toEqual({ type: "active", cursor: "cur-1", truncated: true })
      expect(result.messages[1]).toMatchObject({
        type: "event",
        eventId: "e-1",
        name: "issue.created",
        data: { id: 42 },
        cursor: "cur-2",
      })
      expect(result.messages[2]).toEqual({ type: "heartbeat", cursor: "cur-2" })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("evicts idle pooled slots after idleTimeoutMs, pins active streams, and kills child process group", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-mcp-pool-"))
    const script = path.join(dir, "server.mjs")
    fs.writeFileSync(script, FAKE_STDIO_SERVER, "utf8")

    try {
      const config: Mcp.LocalServerConfig = {
        type: "local",
        command: [process.execPath, script],
        cwd: dir,
        protocol: "2026-07-28",
        pool: true,
        idleTimeoutMs: 120,
      }

      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Effect.scope
            const run = yield* FiberSet.makeRuntime<never, void, never>()
            const pool = yield* McpPool.make()
            const key = McpPool.poolKey({ config, cwd: dir, mcpEvents: true })
            const readyA = yield* Deferred.make<void, Error>()
            const readyB = yield* Deferred.make<void, Error>()

            const makeHolder = (ready: Deferred.Deferred<void, Error>) =>
              pool.connection({
                name: "pooled-demo",
                config,
                directory: dir,
                mcpEvents: true,
                authProvider: Effect.succeed(undefined),
                select: Effect.succeed({ key, authProvider: Effect.succeed(undefined) }),
                scope,
                lock: (e) => e,
                callbacks: (e) => {
                  run(e)
                },
                fork: (e) => {
                  run(e)
                },
                events: {
                  connecting: Effect.void,
                  connected: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
                  failed: (failure) => Deferred.fail(ready, new Error(failure.error)).pipe(Effect.asVoid),
                  settled: Effect.void,
                  closed: () => Effect.void,
                  changed: () => Effect.void,
                },
              })

            const connA = makeHolder(readyA)
            const connB = makeHolder(readyB)
            yield* connA.start
            yield* connB.start
            yield* Deferred.await(readyA)
            yield* Deferred.await(readyB)

            const pidARes = yield* connA.client!.callTool({ name: "pid" })
            const pidBRes = yield* connB.client!.callTool({ name: "pid" })
            const pidA = pidARes.content[0]?.type === "text" ? Number(pidARes.content[0].text) : 0
            const pidB = pidBRes.content[0]?.type === "text" ? Number(pidBRes.content[0].text) : 0
            const slotsWhileShared = yield* pool.activeSlotCount

            const streamScope = yield* Scope.make()
            yield* connA.pinStream().pipe(Scope.provide(streamScope))
            yield* connA.stop
            yield* connB.stop

            yield* Effect.sleep("200 millis")
            const slotsWhilePinned = yield* pool.activeSlotCount
            const aliveWhilePinned = isPidAlive(pidA)

            yield* Scope.close(streamScope, Exit.void)
            yield* Effect.sleep("250 millis")
            const slotsAfterEviction = yield* pool.activeSlotCount
            const aliveAfterEviction = isPidAlive(pidA)

            return {
              pidA,
              pidB,
              slotsWhileShared,
              slotsWhilePinned,
              aliveWhilePinned,
              slotsAfterEviction,
              aliveAfterEviction,
            }
          }),
        ).pipe(Effect.provide(BunServices.layer)),
      )

      expect(outcome.pidA).toBeGreaterThan(0)
      expect(outcome.pidA).toBe(outcome.pidB)
      expect(outcome.slotsWhileShared).toBe(1)
      expect(outcome.slotsWhilePinned).toBe(1)
      expect(outcome.aliveWhilePinned).toBe(true)
      expect(outcome.slotsAfterEviction).toBe(0)
      expect(outcome.aliveAfterEviction).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
