import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect, withHeaders } from "@vibest/client/client"
import { Database } from "@vibest/core/database/database"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { Layout } from "@vibest/schema/layout"
import * as Server from "@vibest/server/server"
import { authed, makeRepository, testLayer } from "@vibest/testkit/fakes"
import * as Platform from "@vibest/testkit/platform"
import { Effect, Exit, Layer } from "effect"

const makeFakeCounterMcp = (countFile: string) => `
import fs from "node:fs"
import readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n")
const countFile = ${JSON.stringify(countFile)}
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
        serverInfo: { name: "counter-mcp", version: "1.0.0" },
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
            name: "check_status",
            description: "Return incremental check count",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    })
    return
  }
  if (msg.method === "tools/call" && msg.params?.name === "check_status") {
    const prev = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0
    const calls = prev + 1
    fs.writeFileSync(countFile, String(calls), "utf8")
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: JSON.stringify({ count: calls, ready: calls >= 3 }) }] },
    })
  }
})
`

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.httpServer(layout.socket)))),
  Layer.provideMerge(testLayer()),
)

describe("vibestd /api/automation endpoints", () => {
  it.effect(
    "supports automation CRUD, 0-token CodeMode gate over fake MCP, and HMAC webhook with idempotency dedup",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-auto-srv-"))
        const counterScript = path.join(workDir, "counter.mjs")
        const countFile = path.join(workDir, "count.txt")
        fs.writeFileSync(counterScript, makeFakeCounterMcp(countFile), "utf8")

        try {
          const rawClient = yield* connect(layout.socket)
          const client = authed(rawClient, cliHeaders(workDir))

          const ping = yield* rawClient["server.daemon"]["daemon.ping"]()
          assert.strictEqual(ping.capabilities?.automation, true)

          yield* client["server.mcp"]["mcp.add"]({
            params: { server: "counter" },
            payload: {
              type: "local",
              command: [process.execPath, counterScript],
              cwd: workDir,
              protocol: "legacy",
            },
          })

          const created = yield* client["server.automation"]["automation.create"]({
            payload: {
              name: "counter-gate",
              directory: workDir,
              trigger: { type: "every", every: "5 minutes" },
              action: {
                type: "code",
                code: `
                  const res = await tools.counter.check_status({});
                  const seen = (input.state?.seen ?? 0) + 1;
                  if (!res.ready) return { state: { seen } };
                  return { state: { seen }, done: true };
                `,
              },
            },
          })

          assert.strictEqual(created.status, "active")
          assert.isTrue(created.id.startsWith("aut_"))

          const listed = yield* client["server.automation"]["automation.list"]({ query: {} })
          assert.strictEqual(listed.length, 1)

          const run1 = yield* client["server.automation"]["automation.runNow"]({ params: { id: created.id } })
          assert.strictEqual(run1.runCount, 1)
          assert.strictEqual(run1.status, "active")
          assert.deepStrictEqual(run1.state, { seen: 1 })

          const run2 = yield* client["server.automation"]["automation.runNow"]({ params: { id: created.id } })
          assert.strictEqual(run2.runCount, 2)
          assert.strictEqual(run2.status, "active")
          assert.deepStrictEqual(run2.state, { seen: 2 })

          const run3 = yield* client["server.automation"]["automation.runNow"]({ params: { id: created.id } })
          assert.strictEqual(run3.runCount, 3)
          assert.strictEqual(run3.status, "done")
          assert.deepStrictEqual(run3.state, { seen: 3 })

          const secret = "webhook-hmac-secret"

          const hookAuto = yield* client["server.automation"]["automation.create"]({
            payload: {
              name: "ci-webhook",
              directory: workDir,
              trigger: { type: "webhook" },
              webhookSecret: secret,
              action: {
                type: "code",
                code: `
                  const prev = input.state?.events ?? [];
                  return { state: { events: [...prev, input.webhook.payload.id] } };
                `,
              },
            },
          })

          const bodyObj = { id: "build-42" }
          const rawBody = JSON.stringify(bodyObj)

          const unauthorized = yield* withHeaders(
            rawClient["server.automation"]["automation.webhook"]({
              params: { id: hookAuto.id },
              payload: bodyObj,
            }),
            { "x-vibest-signature-256": "sha256=invalid" },
          ).pipe(Effect.exit)

          assert.isTrue(Exit.isFailure(unauthorized))

          const sig = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")

          const hook1 = yield* withHeaders(
            rawClient["server.automation"]["automation.webhook"]({
              params: { id: hookAuto.id },
              payload: bodyObj,
            }),
            {
              "x-vibest-signature-256": `sha256=${sig}`,
              "x-idempotency-key": "key-42",
            },
          )

          assert.strictEqual(hook1.accepted, true)
          assert.strictEqual(hook1.deduplicated, false)
          assert.strictEqual(hook1.info.runCount, 1)
          assert.deepStrictEqual(hook1.info.state, { events: ["build-42"] })

          const hook2 = yield* withHeaders(
            rawClient["server.automation"]["automation.webhook"]({
              params: { id: hookAuto.id },
              payload: bodyObj,
            }),
            {
              "x-vibest-signature-256": `sha256=${sig}`,
              "x-idempotency-key": "key-42",
            },
          )

          assert.strictEqual(hook2.accepted, true)
          assert.strictEqual(hook2.deduplicated, true)
          assert.strictEqual(hook2.info.runCount, 1)

          const paused = yield* client["server.automation"]["automation.pause"]({ params: { id: hookAuto.id } })
          assert.strictEqual(paused.status, "paused")

          const resumed = yield* client["server.automation"]["automation.resume"]({ params: { id: hookAuto.id } })
          assert.strictEqual(resumed.status, "active")

          yield* client["server.automation"]["automation.remove"]({ params: { id: hookAuto.id } })
          const afterRemove = yield* client["server.automation"]["automation.list"]({ query: {} })
          assert.strictEqual(afterRemove.length, 1)
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true })
        }
      }).pipe(Effect.provide(served)),
    30_000,
  )

  it.effect(
    "auto-binds creating sessionId from session claim headers, wakes that session by default, and pauses on runtime forbidden tool calls",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const { sql } = yield* Database.Service
        const repo = yield* makeRepository
        const rawClient = yield* connect(layout.socket)
        const cli = authed(rawClient, cliHeaders(repo))

        const claimed = yield* cli["server.session"]["session.claim"]({
          payload: {
            agent: "coordinator",
            harness: "pi",
            fresh: false,
            terminal: { id: "test/auto-creator" },
          },
        })

        const sessionClient = authed(
          rawClient,
          sessionHeaders({
            sessionId: claimed.sessionId,
            projectId: claimed.projectId,
            repositoryRoot: repo,
          }),
        )

        const codeAuto = yield* sessionClient["server.automation"]["automation.create"]({
          payload: {
            name: "wake-creator-code",
            directory: repo,
            trigger: { type: "every", every: "5 minutes" },
            action: {
              type: "code",
              code: 'return { send: { prompt: "Wake up!" } };',
            },
          },
        })

        assert.strictEqual(codeAuto.sessionId, claimed.sessionId)
        assert.strictEqual(codeAuto.projectId, claimed.projectId)

        const afterCode = yield* sessionClient["server.automation"]["automation.runNow"]({
          params: { id: codeAuto.id },
        })

        assert.strictEqual(afterCode.runCount, 1)
        assert.include(afterCode.lastOutput ?? "", claimed.sessionId)

        const inboxAfterCode = yield* sql<{ content: string }>`
          SELECT content FROM inbox
          WHERE recipient_session_id = ${claimed.sessionId} AND sender_type = 'vibest'
          ORDER BY id
        `

        assert.isTrue(inboxAfterCode.some((row) => row.content.includes("Wake up!")))

        const promptAuto = yield* sessionClient["server.automation"]["automation.create"]({
          payload: {
            name: "wake-creator-prompt",
            directory: repo,
            trigger: { type: "every", every: "5 minutes" },
            action: {
              type: "prompt",
              prompt: "Direct prompt wakeup!",
            },
          },
        })

        assert.strictEqual(promptAuto.sessionId, claimed.sessionId)

        yield* sessionClient["server.automation"]["automation.runNow"]({
          params: { id: promptAuto.id },
        })

        const inboxAfterPrompt = yield* sql<{ content: string }>`
          SELECT content FROM inbox
          WHERE recipient_session_id = ${claimed.sessionId} AND sender_type = 'vibest'
          ORDER BY id
        `

        assert.isTrue(inboxAfterPrompt.some((row) => row.content.includes("Direct prompt wakeup!")))

        const invalidSyntaxExit = yield* sessionClient["server.automation"]
          ["automation.create"]({
            payload: {
              name: "bad-syntax",
              directory: repo,
              trigger: { type: "every", every: "5 minutes" },
              action: { type: "code", code: "const x = ;" },
            },
          })
          .pipe(Effect.exit)

        assert.isTrue(Exit.isFailure(invalidSyntaxExit))

        const forbiddenAuto = yield* sessionClient["server.automation"]["automation.create"]({
          payload: {
            name: "forbidden-runtime-tool",
            directory: repo,
            trigger: { type: "every", every: "5 minutes" },
            action: {
              type: "code",
              code: 'try { await tools.automation.create({ name: "loop" }); } catch {} return null;',
            },
          },
        })

        const afterForbidden = yield* sessionClient["server.automation"]["automation.runNow"]({
          params: { id: forbiddenAuto.id },
        })

        assert.strictEqual(afterForbidden.status, "paused")
        assert.include(afterForbidden.lastOutput ?? "", "cannot be used inside an automation")

        const queryAuto = yield* sessionClient["server.automation"]["automation.create"]({
          payload: {
            name: "vibest-api-gate",
            directory: repo,
            trigger: { type: "every", every: "5 minutes" },
            action: {
              type: "code",
              code: `
                const [listed, autos] = await Promise.all([
                  tools.vibest.session_list({ stopped: true }),
                  tools.vibest.automation_list({}),
                ]);
                const detail = await tools.vibest.session_get({ id: listed.sessions[0].id });
                console.log(JSON.stringify({ id: detail.id, autos: autos.length }));
                return { state: { id: detail.id, autos: autos.length } };
              `,
            },
          },
        })

        const afterQuery = yield* sessionClient["server.automation"]["automation.runNow"]({
          params: { id: queryAuto.id },
        })

        assert.strictEqual(afterQuery.runCount, 1, afterQuery.lastOutput ?? "no output")
        assert.strictEqual(afterQuery.lastOutcome, "fired")
        assert.include(afterQuery.lastOutput ?? "", claimed.sessionId)
      }).pipe(Effect.provide(served)),
    30_000,
  )

  it.effect(
    "verifies x-hub-signature-256 HMAC against exact raw wire bytes for pretty-printed JSON webhooks",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const repo = yield* makeRepository
        const rawClient = yield* connect(layout.socket)
        const cli = authed(rawClient, cliHeaders(repo))
        const secret = "pretty-json-hmac-secret"

        const hook = yield* cli["server.automation"]["automation.create"]({
          payload: {
            name: "pretty-webhook",
            directory: repo,
            trigger: { type: "webhook" },
            webhookSecret: secret,
            action: {
              type: "code",
              code: "return { state: { a: webhook.payload.a, b: webhook.payload.b } };",
            },
          },
        })

        const prettyBody = '{\n  "b": 2,\n  "a": 1\n}'
        const sig = `sha256=${crypto.createHmac("sha256", secret).update(prettyBody, "utf8").digest("hex")}`

        const response = yield* Effect.tryPromise(
          () =>
            new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
              const req = http.request(
                {
                  socketPath: layout.socket,
                  path: `/api/automation/${hook.id}/webhook`,
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "content-length": String(Buffer.byteLength(prettyBody, "utf8")),
                    "x-hub-signature-256": sig,
                  },
                },
                (res) => {
                  let data = ""
                  res.setEncoding("utf8")
                  res.on("data", (chunk: string) => {
                    data += chunk
                  })
                  res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }))
                },
              )

              req.on("error", reject)
              req.end(prettyBody)
            }),
        )

        assert.strictEqual(response.status, 200, response.body)

        const parsed = JSON.parse(response.body) as {
          readonly accepted: boolean
          readonly info: { readonly state?: unknown }
        }

        assert.strictEqual(parsed.accepted, true)
        assert.deepStrictEqual(parsed.info.state, { a: 1, b: 2 })
      }).pipe(Effect.provide(served)),
    30_000,
  )
})
