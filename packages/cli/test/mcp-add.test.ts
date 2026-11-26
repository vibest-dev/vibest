import http from "node:http"

import { assert, describe, it } from "@effect/vitest"
import { PROTOCOL } from "@vibest/schema/version"
import { runVibest as vibest, tempDirectory } from "@vibest/testkit/fakes"
import { Effect, Schema } from "effect"

import * as Platform from "#platform"

import { VERSION } from "../src/version.ts"

const TIMEOUT = 30_000

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Array<Buffer> = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })

const replyJson = (res: http.ServerResponse, body: Schema.Json, status = 200) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) })
  res.end(text)
}

describe("vibest mcp add positional command arguments", () => {
  it.effect(
    "accepts variadic command args after -- (including -y flags) and rejects conflicting or empty server specs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* tempDirectory("vibest-mcp-add-")
          const added: Array<{ server: string; payload: unknown }> = []

          const server = http.createServer(async (req, res) => {
            const url = new URL(req.url ?? "/", "http://vibest")

            if (req.method === "GET" && url.pathname === "/api/daemon/ping")
              return replyJson(res, { protocol: PROTOCOL, version: VERSION, runtimes: [], capabilities: {} })

            const match = /^\/api\/mcp\/([^/]+)$/.exec(url.pathname)

            if (req.method === "PUT" && match !== null) {
              const name = decodeURIComponent(match[1]!)
              const payload = JSON.parse((await readBody(req)) || "{}") as { command?: ReadonlyArray<string> }
              added.push({ server: name, payload })

              return replyJson(res, {
                name,
                type: "local",
                exposure: "skill",
                status: { status: "idle" },
                toolCount: 0,
                command: [...(payload.command ?? [])],
              })
            }

            return replyJson(res, { error: "NotFound" }, 404)
          })

          yield* Effect.acquireRelease(
            Effect.callback<void>((resume) => void server.listen(`${home}/vibest.sock`, () => resume(Effect.void))),
            () => Effect.sync(() => server.close()),
          )

          const env = { HOME: home, VIBEST_HOME: home }

          const ok = yield* vibest(home, env, [
            "mcp",
            "add",
            "filesystem",
            "--",
            "npx",
            "-y",
            "@modelcontextprotocol/server-filesystem",
            "/tmp/sample",
          ])

          assert.strictEqual(ok.code, 0, ok.stderr)
          assert.deepStrictEqual(added, [
            {
              server: "filesystem",
              payload: {
                type: "local",
                command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp/sample"],
              },
            },
          ])

          const both = yield* vibest(home, env, [
            "mcp",
            "add",
            "bad",
            "--url",
            "https://mcp.context7.com/mcp",
            "--",
            "npx",
            "-y",
            "@modelcontextprotocol/server-memory",
          ])

          assert.notStrictEqual(both.code, 0)
          assert.include(both.stderr, "not both")

          const neither = yield* vibest(home, env, ["mcp", "add", "empty"])
          assert.notStrictEqual(neither.code, 0)
          assert.include(neither.stderr, "Provide either --url or a local command")
        }),
      ).pipe(Effect.provide(Platform.services)),
    TIMEOUT,
  )

  it.effect(
    "exposes vibest automation subcommands and rejects the old vibest auto command name",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* tempDirectory("vibest-automation-cli-")

          const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://vibest")

            if (req.method === "GET" && url.pathname === "/api/daemon/ping")
              return replyJson(res, {
                protocol: PROTOCOL,
                version: VERSION,
                runtimes: [],
                capabilities: { automation: true },
              })

            if (req.method === "GET" && url.pathname === "/api/automation") return replyJson(res, [])

            return replyJson(res, { error: "NotFound" }, 404)
          })

          yield* Effect.acquireRelease(
            Effect.callback<void>((resume) => void server.listen(`${home}/vibest.sock`, () => resume(Effect.void))),
            () => Effect.sync(() => server.close()),
          )

          const env = { HOME: home, VIBEST_HOME: home }
          const listed = yield* vibest(home, env, ["automation", "list"])
          assert.strictEqual(listed.code, 0, listed.stderr)
          assert.strictEqual(listed.stdout.trim(), "[]")

          const oldAuto = yield* vibest(home, env, ["auto", "list"])
          assert.notStrictEqual(oldAuto.code, 0)
        }),
      ).pipe(Effect.provide(Platform.services)),
    TIMEOUT,
  )
})
