import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Agents } from "@vibest/core/agent/registry"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { Layout } from "@vibest/schema/layout"
import * as Server from "@vibest/server/server"
import { authed, makeRepository, testLayer } from "@vibest/testkit/fakes"
import * as Platform from "@vibest/testkit/platform"
import { failureTag } from "@vibest/testkit/rpc-helpers"
import { Effect, Layer } from "effect"

const makeFakeMcp = (serverTitle: string, sentinelPath?: string) => `
import fs from "node:fs"
import readline from "node:readline"
${sentinelPath !== undefined ? `fs.writeFileSync(${JSON.stringify(sentinelPath)}, "spawned", "utf8")` : ""}
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
        capabilities: {
          tools: {},
          resources: {},
          extensions: {
            "io.modelcontextprotocol/events": {},
            "io.modelcontextprotocol/skills": { directoryRead: false },
          },
        },
        serverInfo: { name: ${JSON.stringify(serverTitle)}, version: "1.0.0" },
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
            name: "ping",
            description: "Ping ${serverTitle}",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    })
    return
  }
  if (msg.method === "tools/call" && msg.params?.name === "ping") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: JSON.stringify({ from: ${JSON.stringify(serverTitle)} }) }] },
    })
    return
  }
  if (msg.method === "events/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { events: [{ name: "tick", description: "Tick" }] },
    })
    return
  }
  if (msg.method === "skills/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { resultType: "complete", skills: [] },
    })
    return
  }
  if (msg.method === "resources/read") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { contents: [{ uri: msg.params?.uri, mimeType: "text/plain", text: "ok" }] },
    })
  }
})
`

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.httpServer(layout.socket)))),
  Layer.provideMerge(testLayer()),
)

describe("per-agent mcpServers scoping and non-blocking warnings", () => {
  it.effect(
    "enforces agent mcpServers allowlist across MCP, CodeMode, Automation, and surfaces non-blocking warnings in agent.list",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const agents = yield* Agents.Service
        const repo = yield* makeRepository
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-agent-mcp-scope-"))
        const alphaScript = path.join(workDir, "alpha.mjs")
        const betaScript = path.join(workDir, "beta.mjs")
        const betaSentinel = path.join(workDir, "beta-spawned.txt")

        fs.writeFileSync(alphaScript, makeFakeMcp("alpha"), "utf8")
        fs.writeFileSync(betaScript, makeFakeMcp("beta", betaSentinel), "utf8")

        try {
          yield* agents.transformFor("test-scope")((editor) => {
            editor.add({
              id: "scoped-alpha",
              description: "only alpha",
              system: "Scoped to alpha.",
              mcpServers: ["alpha", "missing-srv", "off-srv"],
              warnings: ['inline mcpServers config for "alpha" is ignored; configure it centrally with vibest mcp add'],
            })
            editor.add({
              id: "no-mcp",
              description: "no external MCP servers",
              system: "No MCP.",
              mcpServers: [],
            })
          })

          const rawClient = yield* connect(layout.socket)
          const cli = authed(rawClient, cliHeaders(repo))

          yield* cli["server.mcp"]["mcp.add"]({
            params: { server: "alpha" },
            payload: { type: "local", command: [process.execPath, alphaScript], cwd: repo, protocol: "legacy" },
          })

          yield* cli["server.mcp"]["mcp.add"]({
            params: { server: "beta" },
            payload: { type: "local", command: [process.execPath, betaScript], cwd: repo, protocol: "legacy" },
          })

          yield* cli["server.mcp"]["mcp.add"]({
            params: { server: "off-srv" },
            payload: {
              type: "local",
              command: [process.execPath, alphaScript],
              cwd: repo,
              protocol: "legacy",
              disabled: true,
            },
          })

          const listedAgents = yield* cli["server.agent"]["agent.list"]({ query: {} })
          const scopedInfo = listedAgents.agents.find((a) => a.id === "scoped-alpha")
          assert.isDefined(scopedInfo)
          assert.deepStrictEqual(scopedInfo!.mcpServers, ["alpha", "missing-srv", "off-srv"])
          assert.strictEqual(scopedInfo!.warnings?.length, 3)
          assert.include(scopedInfo!.warnings![0], 'inline mcpServers config for "alpha" is ignored')
          assert.include(scopedInfo!.warnings![1], 'mcpServers entry "missing-srv" is not configured in vibest mcp')
          assert.include(scopedInfo!.warnings![2], 'mcpServers entry "off-srv" is disabled in vibest mcp')

          const noMcpInfo = listedAgents.agents.find((a) => a.id === "no-mcp")
          assert.deepStrictEqual(noMcpInfo?.mcpServers, [])
          assert.isUndefined(noMcpInfo?.warnings)

          const cliMcpList = yield* cli["server.mcp"]["mcp.list"]({ query: { directory: repo } })
          assert.sameMembers(
            cliMcpList.map((s) => s.name),
            ["alpha", "beta", "off-srv"],
          )

          const scopedClaim = yield* cli["server.session"]["session.claim"]({
            payload: {
              agent: "scoped-alpha",
              harness: "pi",
              fresh: true,
              terminal: { id: "test/scoped-alpha" },
            },
          })

          const scopedSession = authed(
            rawClient,
            sessionHeaders({
              sessionId: scopedClaim.sessionId,
              projectId: scopedClaim.projectId,
              repositoryRoot: repo,
            }),
          )

          const sessionMcpList = yield* scopedSession["server.mcp"]["mcp.list"]({ query: { directory: repo } })
          assert.sameMembers(
            sessionMcpList.map((s) => s.name),
            ["alpha", "off-srv"],
          )

          const alphaCall = yield* scopedSession["server.mcp"]["mcp.call"]({
            params: { server: "alpha", tool: "ping" },
            payload: { arguments: {}, directory: repo },
          })

          assert.strictEqual(alphaCall.isError, false)

          const allTools = yield* scopedSession["server.mcp"]["mcp.tools"]({ query: { directory: repo } })
          assert.deepStrictEqual(
            allTools.map((t) => `${t.server}.${t.name}`),
            ["alpha.ping"],
          )

          const searched = yield* scopedSession["server.mcp"]["mcp.search"]({ query: { q: "ping", directory: repo } })
          assert.deepStrictEqual(
            searched.map((t) => t.server),
            ["alpha"],
          )

          const forbiddenOps: ReadonlyArray<readonly [string, Effect.Effect<unknown, { readonly _tag: string }>]> = [
            ["mcp.connect", scopedSession["server.mcp"]["mcp.connect"]({ params: { server: "beta" }, payload: {} })],
            ["mcp.disconnect", scopedSession["server.mcp"]["mcp.disconnect"]({ params: { server: "beta" } })],
            ["mcp.tools", scopedSession["server.mcp"]["mcp.tools"]({ query: { server: "beta", directory: repo } })],
            [
              "mcp.describe",
              scopedSession["server.mcp"]["mcp.describe"]({
                params: { server: "beta", tool: "ping" },
                query: { directory: repo },
              }),
            ],
            [
              "mcp.call",
              scopedSession["server.mcp"]["mcp.call"]({
                params: { server: "beta", tool: "ping" },
                payload: { arguments: {}, directory: repo },
              }),
            ],
            [
              "mcp.events",
              scopedSession["server.mcp"]["mcp.events"]({ params: { server: "beta" }, query: { directory: repo } }),
            ],
            [
              "mcp.skills",
              scopedSession["server.mcp"]["mcp.skills"]({ params: { server: "beta" }, query: { directory: repo } }),
            ],
            [
              "mcp.read",
              scopedSession["server.mcp"]["mcp.read"]({
                params: { server: "beta" },
                payload: { uri: "skill://a", directory: repo },
              }),
            ],
            [
              "codemode.declarations",
              scopedSession["server.codemode"]["codemode.declarations"]({
                query: { server: "beta", directory: repo },
              }),
            ],
            [
              "codemode.execute",
              scopedSession["server.codemode"]["codemode.execute"]({
                payload: { code: "return 1;", servers: ["beta"], directory: repo },
              }),
            ],
            [
              "automation.create",
              scopedSession["server.automation"]["automation.create"]({
                payload: {
                  name: "forbidden-event",
                  directory: repo,
                  trigger: { type: "event", server: "beta", event: "tick" },
                  action: { type: "prompt", prompt: "hi" },
                },
              }),
            ],
          ]

          for (const [label, op] of forbiddenOps) {
            assert.strictEqual(failureTag(yield* Effect.exit(op)), "Forbidden", label)
          }

          const scopedDecls = yield* scopedSession["server.codemode"]["codemode.declarations"]({
            query: { directory: repo },
          })

          assert.sameMembers([...scopedDecls.servers], ["vibest", "alpha"])

          const cmOk = yield* scopedSession["server.codemode"]["codemode.execute"]({
            payload: {
              directory: repo,
              code: `
                const ping = await tools.alpha.ping({});
                const visible = await tools.vibest.mcp_list({ directory: ${JSON.stringify(repo)} });
                return { ping, visible: visible.map((s) => s.name) };
              `,
            },
          })

          assert.strictEqual(cmOk.ok, true)

          if (cmOk.ok) {
            assert.deepStrictEqual(cmOk.value, { ping: { from: "alpha" }, visible: ["alpha", "off-srv"] })
          }

          const cmDeniedBeta = yield* scopedSession["server.codemode"]["codemode.execute"]({
            payload: {
              directory: repo,
              code: "return await tools.beta.ping({});",
            },
          })

          assert.strictEqual(cmDeniedBeta.ok, false)

          if (!cmDeniedBeta.ok) {
            assert.include(cmDeniedBeta.error.message, "not included in the allowed servers list")
          }

          const autoBeta = yield* scopedSession["server.automation"]["automation.create"]({
            payload: {
              name: "try-beta-in-bg",
              directory: repo,
              trigger: { type: "every", every: "5 minutes" },
              action: { type: "code", code: "return await tools.beta.ping({});" },
            },
          })

          const autoBetaRun = yield* cli["server.automation"]["automation.runNow"]({ params: { id: autoBeta.id } })
          assert.strictEqual(autoBetaRun.lastOutcome, "failed")
          assert.include(autoBetaRun.lastOutput ?? "", "not included in the allowed servers list")

          const autoAlpha = yield* scopedSession["server.automation"]["automation.create"]({
            payload: {
              name: "use-alpha-in-bg",
              directory: repo,
              trigger: { type: "every", every: "5 minutes" },
              action: { type: "code", code: "const r = await tools.alpha.ping({}); return { state: r };" },
            },
          })

          const autoAlphaRun = yield* cli["server.automation"]["automation.runNow"]({ params: { id: autoAlpha.id } })
          assert.strictEqual(autoAlphaRun.lastOutcome, "fired")
          assert.deepStrictEqual(autoAlphaRun.state, { from: "alpha" })

          assert.isFalse(fs.existsSync(betaSentinel), "disallowed server beta must never be spawned")

          const noMcpClaim = yield* cli["server.session"]["session.claim"]({
            payload: {
              agent: "no-mcp",
              harness: "pi",
              fresh: true,
              terminal: { id: "test/no-mcp" },
            },
          })

          const noMcpSession = authed(
            rawClient,
            sessionHeaders({
              sessionId: noMcpClaim.sessionId,
              projectId: noMcpClaim.projectId,
              repositoryRoot: repo,
            }),
          )

          assert.deepStrictEqual(yield* noMcpSession["server.mcp"]["mcp.list"]({ query: { directory: repo } }), [])

          const noMcpDecls = yield* noMcpSession["server.codemode"]["codemode.declarations"]({
            query: { directory: repo },
          })

          assert.deepStrictEqual([...noMcpDecls.servers], ["vibest"])

          const noMcpCm = yield* noMcpSession["server.codemode"]["codemode.execute"]({
            payload: {
              directory: repo,
              code: `const s = await tools.vibest.mcp_list({ directory: ${JSON.stringify(repo)} }); return s.length;`,
            },
          })

          assert.strictEqual(noMcpCm.ok, true)

          if (noMcpCm.ok) assert.strictEqual(noMcpCm.value, 0)

          const noMcpCmDenied = yield* noMcpSession["server.codemode"]["codemode.execute"]({
            payload: {
              directory: repo,
              code: "return await tools.alpha.ping({});",
            },
          })

          assert.strictEqual(noMcpCmDenied.ok, false)
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(served)),
    30_000,
  )
})
