import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BunServices } from "@effect/platform-bun"
import { Bus } from "@vibest/core/bus"
import { Layout } from "@vibest/schema/layout"
import type { Mcp as McpSchema } from "@vibest/schema/mcp"
import { Deferred, Effect, Exit, FiberSet, Layer, Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"

import { McpClient } from "../src/client.ts"
import { Mcp } from "../src/index.ts"
import { McpMetadataCache } from "../src/metadata-cache.ts"
import { McpPool } from "../src/pool.ts"
import { McpVault } from "../src/vault.ts"

const noopBusLayer = Layer.succeed(
  Bus.Service,
  Bus.Service.of({
    subscribe: () => Effect.die("unused"),
    publish: () => Effect.succeed(undefined as never),
    transaction: (effect) => effect,
    afterCommit: () => Effect.undefined,
    log: () => Stream.empty,
    project: () => Effect.undefined,
    rebuild: Effect.void,
  }),
)

const testMcpEnv = (vibestHome: string) => {
  const layoutLayer = Layer.effect(Layout, Layout.make(vibestHome)).pipe(Layer.provide(BunServices.layer))
  const base = Layer.mergeAll(BunServices.layer, layoutLayer, noopBusLayer)

  return Layer.mergeAll(McpPool.layer(), McpVault.layer({ vibestHome }), McpMetadataCache.layer(vibestHome)).pipe(
    Layer.provideMerge(base),
  )
}

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
      const config: McpSchema.LocalServerConfig = {
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
      const config: McpSchema.LocalServerConfig = {
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
            const key = McpPool.key({ config, cwd: dir, mcpEvents: true })
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

  it("respects pool:false with distinct private PIDs and evicts McpRuntime ephemeral calls after idleTimeoutMs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-mcp-b3-"))
    const script = path.join(dir, "server.mjs")
    fs.writeFileSync(script, FAKE_STDIO_SERVER, "utf8")

    try {
      const unpooledConfig: McpSchema.LocalServerConfig = {
        type: "local",
        command: [process.execPath, script],
        cwd: dir,
        protocol: "2026-07-28",
        pool: false,
      }

      const unpooled = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Effect.scope
            const run = yield* FiberSet.makeRuntime<never, void, never>()
            const pool = yield* McpPool.make()
            const key = McpPool.key({ config: unpooledConfig, cwd: dir, mcpEvents: true })
            const readyA = yield* Deferred.make<void, Error>()
            const readyB = yield* Deferred.make<void, Error>()

            const makeConn = (ready: Deferred.Deferred<void, Error>) =>
              pool.connection({
                name: "unpooled-demo",
                config: unpooledConfig,
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

            const a = makeConn(readyA)
            const b = makeConn(readyB)
            yield* a.start
            yield* b.start
            yield* Deferred.await(readyA)
            yield* Deferred.await(readyB)

            const pidARes = yield* a.client!.callTool({ name: "pid" })
            const pidBRes = yield* b.client!.callTool({ name: "pid" })
            const slots = yield* pool.activeSlotCount
            yield* a.stop
            yield* b.stop

            return {
              pidA: pidARes.content[0]?.type === "text" ? Number(pidARes.content[0].text) : 0,
              pidB: pidBRes.content[0]?.type === "text" ? Number(pidBRes.content[0].text) : 0,
              slots,
            }
          }),
        ).pipe(Effect.provide(BunServices.layer)),
      )

      expect(unpooled.pidA).toBeGreaterThan(0)
      expect(unpooled.pidB).toBeGreaterThan(0)
      expect(unpooled.pidA).not.toBe(unpooled.pidB)
      expect(unpooled.slots).toBe(0)

      const vibestHome = path.join(dir, "vibest-home")

      const ephemeral = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const rt = yield* Mcp.make()

            yield* rt.add("idle-srv", {
              type: "local",
              command: [process.execPath, script],
              cwd: dir,
              protocol: "2026-07-28",
              pool: true,
              idleTimeoutMs: 100,
            })

            const res = yield* rt.call({ server: "idle-srv", tool: "pid", directory: dir })
            const pid = res.content[0]?.type === "text" ? Number(res.content[0].text) : 0
            yield* Effect.sleep("350 millis")

            return { pid, aliveAfterIdle: isPidAlive(pid) }
          }),
        ).pipe(Effect.provide(testMcpEnv(vibestHome))),
      )

      expect(ephemeral.pid).toBeGreaterThan(0)
      expect(ephemeral.aliveAfterIdle).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("never persists private/ttlMs:0 tools/list to disk and refreshes tools on HEADER_MISMATCH (-32020) without retrying -32602", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-mcp-b2b4-"))
    const script = path.join(dir, "priv-server.mjs")

    fs.writeFileSync(
      script,
      `
import readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n")
let listCount = 0
let callCount = 0
let invalidParamCalls = 0
rl.on("line", (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === "server/discover") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        serverInfo: { name: "priv", version: "1.0.0" },
      },
    })
    return
  }
  if (msg.method === "tools/list") {
    listCount++
    const name = listCount === 1 ? "secret_tool" : "refreshed_tool"
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        resultType: "complete",
        cacheScope: "private",
        ttlMs: 0,
        tools: [{ name, description: "tool", inputSchema: { type: "object", properties: {} } }],
      },
    })
    return
  }
  if (msg.method === "tools/call") {
    if (msg.params?.name === "bad_params_tool") {
      invalidParamCalls++
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params -32602" } })
      return
    }
    if (msg.params?.name === "bad_params_count") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { resultType: "complete", content: [{ type: "text", text: String(invalidParamCalls) }] },
      })
      return
    }
    callCount++
    if (callCount === 1) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32020, message: "Header mismatch" } })
      return
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { resultType: "complete", content: [{ type: "text", text: "ok-after-refresh" }] },
    })
  }
})
`,
      "utf8",
    )

    try {
      const vibestHome = path.join(dir, "vibest-home")

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const rt = yield* Mcp.make()

            yield* rt.add("priv-srv", {
              type: "local",
              command: [process.execPath, script],
              cwd: dir,
              protocol: "2026-07-28",
            })

            yield* rt.connect("priv-srv", dir)
            const cachePath = path.join(vibestHome, "cache", "mcp-metadata-cache.json")
            const diskContent = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, "utf8") : ""
            const callRes = yield* rt.call({ server: "priv-srv", tool: "refreshed_tool", directory: dir })

            const badExit = yield* rt
              .call({ server: "priv-srv", tool: "bad_params_tool", directory: dir })
              .pipe(Effect.exit)

            const countRes = yield* rt.call({ server: "priv-srv", tool: "bad_params_count", directory: dir })

            return {
              hasSecretOnDisk: diskContent.includes("secret_tool"),
              callText: callRes.content[0]?.type === "text" ? callRes.content[0].text : "",
              badFailed: Exit.isFailure(badExit),
              invalidParamCalls: countRes.content[0]?.type === "text" ? countRes.content[0].text : "",
            }
          }),
        ).pipe(Effect.provide(testMcpEnv(vibestHome))),
      )

      expect(result.hasSecretOnDisk).toBe(false)
      expect(result.callText).toBe("ok-after-refresh")
      expect(result.badFailed).toBe(true)
      expect(result.invalidParamCalls).toBe("1")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("Mcp.Service.eventStream keeps an unpooled ephemeral server open across events and pins a pooled server past idleTimeoutMs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-mcp-evstream-"))
    const script = path.join(dir, "event-stream-server.mjs")

    fs.writeFileSync(
      script,
      `
import readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n")
rl.on("line", (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/events": {} } },
        serverInfo: { name: "ev-srv", version: "1.0.0" },
      },
    })
    return
  }
  if (msg.method === "server/discover") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/events": {} } },
        serverInfo: { name: "ev-srv", version: "1.0.0" },
      },
    })
    return
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", ttlMs: 60000, cacheScope: "public", tools: [] } })
    return
  }
  if (msg.method === "events/stream") {
    const subId = msg.id
    send({
      jsonrpc: "2.0",
      method: "notifications/events/active",
      params: { cursor: "c0", _meta: { "io.modelcontextprotocol/subscriptionId": subId } },
    })
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "notifications/events/event",
        params: {
          eventId: "ev-1",
          name: "tick",
          timestamp: new Date().toISOString(),
          data: { n: 1 },
          cursor: "c1",
          _meta: { "io.modelcontextprotocol/subscriptionId": subId },
        },
      })
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "notifications/events/event",
          params: {
            eventId: "ev-2",
            name: "tick",
            timestamp: new Date().toISOString(),
            data: { n: 2 },
            cursor: "c2",
            _meta: { "io.modelcontextprotocol/subscriptionId": subId },
          },
        })
        send({ jsonrpc: "2.0", id: subId, result: { resultType: "complete" } })
      }, 220)
    }, 80)
  }
})
`,
      "utf8",
    )

    try {
      const vibestHome = path.join(dir, "vibest-home")

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const rt = yield* Mcp.make()

            yield* rt.add("ephemeral-ev", {
              type: "local",
              command: [process.execPath, script],
              cwd: dir,
              pool: false,
              protocol: "legacy",
            })

            const ephemeralEvents = yield* rt
              .eventStream({ server: "ephemeral-ev", name: "tick", directory: dir })
              .pipe(Stream.runCollect)

            yield* rt.add("pooled-ev", {
              type: "local",
              command: [process.execPath, script],
              cwd: dir,
              pool: true,
              idleTimeoutMs: 120,
              protocol: "2026-07-28",
            })

            const pooledEvents = yield* rt
              .eventStream({ server: "pooled-ev", name: "tick", directory: dir })
              .pipe(Stream.runCollect)

            return {
              ephemeralTypes: Array.from(ephemeralEvents).map((m) => m.type),
              pooledTypes: Array.from(pooledEvents).map((m) => m.type),
            }
          }),
        ).pipe(Effect.provide(testMcpEnv(vibestHome))),
      )

      expect(result.ephemeralTypes).toEqual(["active", "event", "event"])
      expect(result.pooledTypes).toEqual(["active", "event", "event"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
