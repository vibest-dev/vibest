import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect, HttpConnector } from "@vibest/client/client"
import { Layout } from "@vibest/schema/layout"
import * as Server from "@vibest/server/server"
import { authed, makeRepository, testLayer } from "@vibest/testkit/fakes"
import * as Platform from "@vibest/testkit/platform"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/http"

import { VibestApiTools } from "../src/codemode/vibest-api-tools.ts"

const FAKE_ISSUES_MCP = `
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
        capabilities: { tools: {} },
        serverInfo: { name: "issues-mcp", version: "1.0.0" },
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
            name: "list_issues",
            description: "List issues",
            inputSchema: { type: "object", properties: { state: { type: "string" } }, required: ["state"] },
          },
        ],
      },
    })
    return
  }
  if (msg.method === "tools/call" && msg.params?.name === "list_issues") {
    const items = [
      { id: 1, title: "Fix QuickJS", priority: "high", state: "open" },
      { id: 2, title: "Update docs", priority: "low", state: "open" },
      { id: 3, title: "Old bug", priority: "high", state: "closed" },
    ].filter((i) => i.state === (msg.params.arguments?.state ?? "open"))
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: JSON.stringify(items) }] },
    })
  }
})
`

const FAKE_NOTIFY_MCP = `
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
        capabilities: { tools: {} },
        serverInfo: { name: "notify-mcp", version: "1.0.0" },
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
            name: "summarize",
            description: "Summarize a title",
            inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
          },
        ],
      },
    })
    return
  }
  if (msg.method === "tools/call" && msg.params?.name === "summarize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: JSON.stringify({ tag: "ALERT:" + String(msg.params.arguments?.title) }) }] },
    })
  }
})
`

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.httpServer(layout.socket)))),
  Layer.provideMerge(testLayer()),
)

describe("vibestd /api/codemode endpoints", () => {
  it.effect(
    "chains tools across two fake MCP servers with Promise.all, respects codemode:false, and serves declarations",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-cm-srv-"))
        const issuesScript = path.join(workDir, "issues.mjs")
        const notifyScript = path.join(workDir, "notify.mjs")
        fs.writeFileSync(issuesScript, FAKE_ISSUES_MCP, "utf8")
        fs.writeFileSync(notifyScript, FAKE_NOTIFY_MCP, "utf8")

        try {
          const rawClient = yield* connect(layout.socket)
          const client = authed(rawClient, cliHeaders(workDir))

          const ping = yield* rawClient["server.daemon"]["daemon.ping"]()
          assert.strictEqual(ping.capabilities?.codemode, true)

          yield* client["server.mcp"]["mcp.add"]({
            params: { server: "issues" },
            payload: {
              type: "local",
              command: [process.execPath, issuesScript],
              cwd: workDir,
              protocol: "legacy",
            },
          })

          yield* client["server.mcp"]["mcp.add"]({
            params: { server: "notify" },
            payload: {
              type: "local",
              command: [process.execPath, notifyScript],
              cwd: workDir,
              protocol: "legacy",
            },
          })

          yield* client["server.mcp"]["mcp.add"]({
            params: { server: "hidden" },
            payload: {
              type: "local",
              command: [process.execPath, notifyScript],
              cwd: workDir,
              protocol: "legacy",
              codemode: false,
            },
          })

          const decls = yield* client["server.codemode"]["codemode.declarations"]({
            query: { directory: workDir },
          })

          assert.sameMembers([...decls.servers], ["vibest", "issues", "notify"])
          assert.isAtLeast(decls.toolCount, 12)
          assert.include(decls.declarations, "list_issues")
          assert.include(decls.declarations, "summarize")
          assert.include(decls.declarations, "session_list")
          assert.include(decls.declarations, "session_get")
          assert.include(decls.declarations, "project_search")
          assert.include(decls.declarations, "mcp_skills")
          assert.include(decls.declarations, "mcp_read")
          assert.notInclude(decls.declarations, "hidden")

          const execResult = yield* client["server.codemode"]["codemode.execute"]({
            payload: {
              directory: workDir,
              code: `
                const open = await tools.issues.list_issues({ state: "open" });
                const high = open.filter((item) => item.priority === "high");
                const alerts = await Promise.all(high.map((item) => tools.notify.summarize({ title: item.title })));
                return { count: alerts.length, tags: alerts.map((a) => a.tag) };
              `,
            },
          })

          assert.strictEqual(execResult.ok, true)

          if (execResult.ok) {
            assert.deepStrictEqual(execResult.value, { count: 1, tags: ["ALERT:Fix QuickJS"] })
            assert.strictEqual(execResult.calls.length, 2)
            assert.strictEqual(execResult.calls[0]?.path, "issues.list_issues")
            assert.strictEqual(execResult.calls[1]?.path, "notify.summarize")
          }

          const hiddenResult = yield* client["server.codemode"]["codemode.execute"]({
            payload: {
              directory: workDir,
              code: 'return await tools.hidden.summarize({ title: "secret" });',
            },
          })

          assert.strictEqual(hiddenResult.ok, false)

          if (!hiddenResult.ok) {
            assert.include(hiddenResult.error.message, "not enabled for CodeMode")
          }
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(served)),
    30_000,
  )

  it.effect(
    "does not eagerly spawn uncalled MCP servers during codemode.execute",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-cm-lazy-"))
        const issuesScript = path.join(workDir, "issues.mjs")
        const sentinelMarker = path.join(workDir, "unused-spawned.txt")
        const unusedScript = path.join(workDir, "unused.mjs")
        fs.writeFileSync(issuesScript, FAKE_ISSUES_MCP, "utf8")
        fs.writeFileSync(
          unusedScript,
          `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sentinelMarker)}, "spawned");`,
          "utf8",
        )

        try {
          const rawClient = yield* connect(layout.socket)
          const client = authed(rawClient, cliHeaders(workDir))

          yield* client["server.mcp"]["mcp.add"]({
            params: { server: "issues" },
            payload: {
              type: "local",
              command: [process.execPath, issuesScript],
              cwd: workDir,
              protocol: "legacy",
            },
          })

          yield* client["server.mcp"]["mcp.add"]({
            params: { server: "unused" },
            payload: {
              type: "local",
              command: [process.execPath, unusedScript],
              cwd: workDir,
              protocol: "legacy",
            },
          })

          const execResult = yield* client["server.codemode"]["codemode.execute"]({
            payload: {
              directory: workDir,
              code: 'const open = await tools.issues.list_issues({ state: "open" }); return open.length;',
            },
          })

          assert.strictEqual(execResult.ok, true)

          if (execResult.ok) {
            assert.strictEqual(execResult.value, 2)
          }

          assert.isFalse(fs.existsSync(sentinelMarker))
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(served)),
    30_000,
  )

  it.effect(
    "derives tools.vibest.* directly from OpenApi.fromApi(VibestApi) and dispatches through unified HTTP API",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const repo = yield* makeRepository
        const skillBody = "# Release Skill\nCheck CI before tagging."
        const skillDigest = `sha256:${crypto.createHash("sha256").update(skillBody, "utf8").digest("hex")}`

        const skillMcpScript = path.join(repo, "skill-mcp.mjs")

        fs.writeFileSync(
          skillMcpScript,
          `
import readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n")
const body = ${JSON.stringify(skillBody)}
const digest = ${JSON.stringify(skillDigest)}
rl.on("line", (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } },
        serverInfo: { name: "skill-mcp", version: "1.0.0" },
      },
    })
    return
  }
  if (msg.method === "skills/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        resultType: "complete",
        skills: [
          {
            uri: "skill://release/SKILL.md",
            frontmatter: { name: "release", description: "Release checklist" },
            resources: [{ uri: "skill://release/SKILL.md", digest, size: body.length }],
          },
        ],
      },
    })
    return
  }
  if (msg.method === "resources/read") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { contents: [{ uri: msg.params?.uri, mimeType: "text/markdown", text: body }] },
    })
  }
})
`,
          "utf8",
        )

        const rawClient = yield* connect(layout.socket)
        const cli = authed(rawClient, cliHeaders(repo))

        const claimed = yield* cli["server.session"]["session.claim"]({
          payload: {
            agent: "coordinator",
            harness: "pi",
            fresh: false,
            terminal: { id: "test/vibest-api-tools" },
          },
        })

        const memoriesDir = path.join(layout.project(claimed.projectId), "memories")
        fs.mkdirSync(memoriesDir, { recursive: true })
        fs.writeFileSync(path.join(memoriesDir, "note.md"), "Remember: single source of truth via VibestApi\n", "utf8")

        yield* cli["server.mcp"]["mcp.add"]({
          params: { server: "docs-mcp" },
          payload: {
            type: "local",
            command: [process.execPath, skillMcpScript],
            cwd: repo,
            protocol: "legacy",
          },
        })

        const vibestDecls = yield* cli["server.codemode"]["codemode.declarations"]({
          query: { directory: repo, server: "vibest" },
        })

        assert.deepStrictEqual([...vibestDecls.servers], ["vibest"])
        assert.include(vibestDecls.declarations, "session_list")
        assert.include(vibestDecls.declarations, "session_get")
        assert.include(vibestDecls.declarations, "project_search")
        assert.include(vibestDecls.declarations, "mcp_read")

        const execResult = yield* cli["server.codemode"]["codemode.execute"]({
          payload: {
            directory: repo,
            bindings: { targetId: claimed.sessionId, repoDir: repo },
            code: `
              const [listed, detail, hits, skills, skillDoc] = await Promise.all([
                tools.vibest.session_list({}),
                tools.vibest.session_get({ id: targetId }),
                tools.vibest.project_search({ query: "single source of truth" }),
                tools.vibest.mcp_skills({ server: "docs-mcp", directory: repoDir }),
                tools.vibest.mcp_read({ server: "docs-mcp", uri: "skill://release/SKILL.md", directory: repoDir }),
              ]);
              return {
                sessionCount: listed.sessions.length,
                gotId: detail.id,
                hit: hits[0] ?? null,
                skillName: skills[0]?.frontmatter?.name ?? null,
                skillText: skillDoc.contents[0]?.text ?? null,
              };
            `,
          },
        })

        assert.strictEqual(execResult.ok, true)

        if (execResult.ok) {
          assert.deepStrictEqual(execResult.value, {
            sessionCount: 1,
            gotId: claimed.sessionId,
            hit: "memories/note.md:1: Remember: single source of truth via VibestApi",
            skillName: "release",
            skillText: skillBody,
          })
        }
      }).pipe(Effect.provide(served)),
    30_000,
  )

  it.effect(
    "receives full untruncated >64 KiB JSON inside CodeMode while outer HTTP mcp.call truncates via ToolOutput",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-cm-big-"))
        const bigScript = path.join(workDir, "big-mcp.mjs")

        fs.writeFileSync(
          bigScript,
          `
import readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n")
const items = Array.from({ length: 1500 }, (_, i) => ({
  id: i + 1,
  tag: i === 42 || i === 1337 ? "critical" : "normal",
  payload: "x".repeat(48),
}))
rl.on("line", (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "big-mcp", version: "1.0.0" },
      },
    })
    return
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [{ name: "dump_items", description: "Return 1500 items", inputSchema: { type: "object", properties: {} } }],
      },
    })
    return
  }
  if (msg.method === "tools/call" && msg.params?.name === "dump_items") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: JSON.stringify(items) }] },
    })
  }
})
`,
          "utf8",
        )

        try {
          const rawClient = yield* connect(layout.socket)
          const client = authed(rawClient, cliHeaders(workDir))

          yield* client["server.mcp"]["mcp.add"]({
            params: { server: "big" },
            payload: {
              type: "local",
              command: [process.execPath, bigScript],
              cwd: workDir,
              protocol: "legacy",
            },
          })

          const cmRes = yield* client["server.codemode"]["codemode.execute"]({
            payload: {
              directory: workDir,
              code: `
                const all = await tools.big.dump_items({});
                const critical = all.filter((item) => item.tag === "critical").map((item) => item.id);
                return { total: all.length, critical };
              `,
            },
          })

          assert.strictEqual(cmRes.ok, true)

          if (cmRes.ok) {
            assert.deepStrictEqual(cmRes.value, { total: 1500, critical: [43, 1338] })
          }

          const httpRes = yield* client["server.mcp"]["mcp.call"]({
            params: { server: "big", tool: "dump_items" },
            payload: { directory: workDir, arguments: {} },
          })

          assert.strictEqual(httpRes.truncated, true)
          assert.isDefined(httpRes.outputFile)
          const saved = fs.readFileSync(httpRes.outputFile!, "utf8")
          const parsedSaved = JSON.parse(saved) as Array<{ readonly id: number }>
          assert.strictEqual(parsedSaved.length, 1500)

          const unfilteredCm = yield* client["server.codemode"]["codemode.execute"]({
            payload: {
              directory: workDir,
              code: "return await tools.big.dump_items({});",
            },
          })

          assert.strictEqual(unfilteredCm.ok, true)

          if (unfilteredCm.ok) {
            assert.strictEqual(unfilteredCm.truncated, true)
            assert.isDefined(unfilteredCm.outputFile)
            const savedCm = fs.readFileSync(unfilteredCm.outputFile!, "utf8")
            const parsedCm = JSON.parse(savedCm) as Array<{ readonly id: number }>
            assert.strictEqual(parsedCm.length, 1500)
          }
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(served)),
    30_000,
  )

  it.effect(
    "filters mutating operations out of vibest.json codemode.vibest allowlist and supports hyphenated MCP server filtering",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-cm-r2-"))
        const docsScript = path.join(workDir, "docs-mcp.mjs")
        fs.writeFileSync(docsScript, FAKE_ISSUES_MCP, "utf8")

        try {
          fs.writeFileSync(
            path.join(layout.home, "vibest.json"),
            JSON.stringify({
              codemode: {
                vibest: ["session.list", "session.spawn", "session.send", "daemon.stop", "automation.remove"],
              },
            }),
            "utf8",
          )

          const provider = yield* VibestApiTools.make().pipe(
            Effect.provideService(HttpConnector.Service, () => HttpClient.make(() => Effect.die("unused"))),
          )

          assert.deepStrictEqual(
            provider.list().map((t) => t.name),
            ["session_list"],
          )

          const rawClient = yield* connect(layout.socket)
          const client = authed(rawClient, cliHeaders(workDir))

          yield* client["server.mcp"]["mcp.add"]({
            params: { server: "docs-mcp" },
            payload: {
              type: "local",
              command: [process.execPath, docsScript],
              cwd: workDir,
              protocol: "legacy",
            },
          })

          const hyphenRes = yield* client["server.codemode"]["codemode.execute"]({
            payload: {
              directory: workDir,
              servers: ["docs-mcp"],
              code: 'const open = await tools.docs_mcp.list_issues({ state: "open" }); return open.length;',
            },
          })

          assert.strictEqual(hyphenRes.ok, true)

          if (hyphenRes.ok) {
            assert.strictEqual(hyphenRes.value, 2)
          }

          const deniedExternal = yield* client["server.codemode"]["codemode.execute"]({
            payload: {
              directory: workDir,
              servers: ["vibest"],
              code: 'return await tools.docs_mcp.list_issues({ state: "open" });',
            },
          })

          assert.strictEqual(deniedExternal.ok, false)

          if (!deniedExternal.ok) {
            assert.include(deniedExternal.error.message, "not included in the allowed servers list")
          }

          const allowedBuiltin = yield* client["server.codemode"]["codemode.execute"]({
            payload: {
              directory: workDir,
              servers: ["vibest"],
              code: "const servers = await tools.vibest.mcp_list({}); return servers.map((s) => s.name);",
            },
          })

          assert.strictEqual(allowedBuiltin.ok, true)

          if (allowedBuiltin.ok) {
            assert.deepStrictEqual(allowedBuiltin.value, ["docs-mcp"])
          }
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(served)),
    30_000,
  )
})
