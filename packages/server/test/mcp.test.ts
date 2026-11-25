import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Layout } from "@vibest/schema/layout"
import * as Server from "@vibest/server/server"
import { authed, testLayer } from "@vibest/testkit/fakes"
import * as Platform from "@vibest/testkit/platform"
import { Effect, Layer } from "effect"

const FAKE_STDIO_MCP = `
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
        serverInfo: { name: "test-mcp", version: "1.0.0", title: "Test MCP" },
        instructions: "Test MCP server instructions.",
      },
    })
    return
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "greet",
            description: "Greet a user by name",
            inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          },
          {
            name: "big_blob",
            description: "Return a large text payload",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    })
    return
  }
  if (msg.method === "tools/call") {
    if (msg.params?.name === "greet") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "Hello, " + String(msg.params.arguments?.name ?? "world") }] },
      })
      return
    }
    if (msg.params?.name === "big_blob") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "X".repeat(4096) }] },
      })
      return
    }
  }
  if (msg.method === "events/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { events: [{ name: "ping.event", description: "Ping event" }] },
    })
  }
})
`

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.httpServer(layout.socket)))),
  Layer.provideMerge(testLayer()),
)

describe("vibestd /api/mcp endpoints", () => {
  it.effect(
    "exposes mcp capability on daemon.ping and serves full MCP lifecycle, search, call truncation, events, and skill sync",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-mcp-srv-"))
        const script = path.join(workDir, "mcp-server.mjs")
        fs.writeFileSync(script, FAKE_STDIO_MCP, "utf8")

        try {
          const rawClient = yield* connect(layout.socket)
          const client = authed(rawClient, cliHeaders(workDir))

          const ping = yield* rawClient["server.daemon"]["daemon.ping"]()
          assert.strictEqual(ping.capabilities?.mcp, true)

          const added = yield* client["server.mcp"]["mcp.add"]({
            params: { server: "demo" },
            payload: {
              type: "local",
              command: [process.execPath, script],
              cwd: workDir,
              protocol: "legacy",
              exposure: "skill",
            },
          })

          assert.strictEqual(added.name, "demo")
          assert.strictEqual(added.exposure, "skill")

          const connected = yield* client["server.mcp"]["mcp.connect"]({
            params: { server: "demo" },
            payload: { directory: workDir },
          })

          assert.strictEqual(connected.status.status, "connected")
          assert.strictEqual(connected.toolCount, 2)

          const found = yield* client["server.mcp"]["mcp.search"]({ query: { q: "greet", directory: workDir } })
          assert.strictEqual(found.length, 1)
          assert.strictEqual(found[0]?.name, "greet")
          assert.strictEqual(found[0]?.signature, "{ name: string; }")

          const described = yield* client["server.mcp"]["mcp.describe"]({
            params: { server: "demo", tool: "greet" },
            query: { directory: workDir },
          })

          assert.strictEqual(described.description, "Greet a user by name")

          const callResult = yield* client["server.mcp"]["mcp.call"]({
            params: { server: "demo", tool: "greet" },
            payload: { arguments: { name: "Vibest" }, directory: workDir },
          })

          assert.strictEqual(callResult.isError, false)
          assert.deepStrictEqual(callResult.content, [{ type: "text", text: "Hello, Vibest" }])

          const truncated = yield* client["server.mcp"]["mcp.call"]({
            params: { server: "demo", tool: "big_blob" },
            payload: {
              arguments: {},
              directory: workDir,
              maxBytes: 1024,
              scratchpadDir: path.join(workDir, "scratchpad"),
            },
          })

          assert.strictEqual(truncated.truncated, true)
          assert.isString(truncated.outputFile)
          assert.strictEqual(fs.readFileSync(truncated.outputFile!, "utf8").length, 4096)

          const events = yield* client["server.mcp"]["mcp.events"]({
            params: { server: "demo" },
            query: { directory: workDir },
          })

          assert.strictEqual(events.length, 1)
          assert.strictEqual(events[0]?.name, "ping.event")

          const syncResult = yield* client["server.mcp"]["mcp.syncSkills"]({ payload: {} })
          assert.strictEqual(syncResult.synced.length, 1)
          const skillContent = fs.readFileSync(syncResult.synced[0]!.skillPath, "utf8")
          assert.include(skillContent, "name: mcp-demo")
          assert.include(skillContent, "greet({ name: string; })")

          yield* client["server.mcp"]["mcp.disconnect"]({ params: { server: "demo" } })
          yield* client["server.mcp"]["mcp.remove"]({ params: { server: "demo" } })

          const remaining = yield* client["server.mcp"]["mcp.list"]({ query: { directory: workDir } })
          assert.strictEqual(remaining.length, 0)
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(served)),
    30_000,
  )
})
