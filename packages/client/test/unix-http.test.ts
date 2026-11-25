import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Stream } from "effect"
import { HttpClientRequest } from "effect/http"

import { nodeUnixHttpClient } from "../src/unix-http.node.ts"

const withUnixServer = (handler: http.RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly dir: string; readonly socketPath: string; readonly server: http.Server }>((resolve) => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-unix-http-"))
          const socketPath = path.join(dir, "test.sock")
          const server = http.createServer(handler)
          server.listen(socketPath, () => resolve({ dir, socketPath, server }))
        }),
    ),
    ({ dir, server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => {
              fs.rmSync(dir, { recursive: true, force: true })
              resolve()
            })
          }),
      ),
  )

describe("nodeUnixHttpClient", () => {
  it.effect("sends GET and POST JSON requests over a Unix socket and preserves headers", () =>
    Effect.gen(function* () {
      const { socketPath } = yield* withUnixServer((req, res) => {
        const chunks: Array<Buffer> = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8")
          res.writeHead(200, { "content-type": "application/json", "x-reply": "ok" })
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              header: req.headers["x-test"],
              body: body === "" ? null : JSON.parse(body),
            }),
          )
        })
      })

      const client = nodeUnixHttpClient(socketPath)

      const request = yield* HttpClientRequest.post("http://vibest.local/api/echo?q=1").pipe(
        HttpClientRequest.setHeader("x-test", "hello"),
        HttpClientRequest.bodyJson({ count: 3 }),
      )

      const response = yield* client.execute(request)
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers["x-reply"], "ok")
      assert.deepStrictEqual(yield* response.json, {
        method: "POST",
        url: "/api/echo?q=1",
        header: "hello",
        body: { count: 3 },
      })
    }).pipe(Effect.scoped),
  )

  it.effect("handles 204 null-body responses and chunked streaming responses", () =>
    Effect.gen(function* () {
      const { socketPath } = yield* withUnixServer((req, res) => {
        if (req.url === "/empty") {
          res.writeHead(204).end()

          return
        }

        res.writeHead(200, { "content-type": "text/plain" })
        res.write("one-")
        res.write("two-")
        res.end("three")
      })

      const client = nodeUnixHttpClient(socketPath)
      const empty = yield* client.execute(HttpClientRequest.get("http://vibest.local/empty"))
      assert.strictEqual(empty.status, 204)
      assert.strictEqual(yield* empty.text, "")

      const streamed = yield* client.execute(HttpClientRequest.get("http://vibest.local/stream"))
      assert.strictEqual(streamed.status, 200)
      const text = yield* Stream.mkString(Stream.decodeText(streamed.stream))
      assert.strictEqual(text, "one-two-three")
    }).pipe(Effect.scoped),
  )

  it.effect("fails with TransportError when the Unix socket does not exist", () =>
    Effect.gen(function* () {
      const missing = path.join(os.tmpdir(), `vibest-missing-${Date.now()}.sock`)
      const client = nodeUnixHttpClient(missing)
      const exit = yield* Effect.exit(client.execute(HttpClientRequest.get("http://vibest.local/ping")))

      if (!Exit.isFailure(exit)) return assert.fail("expected failure")

      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      assert.strictEqual(error?._tag, "HttpClientError")
      assert.strictEqual(error?.reason._tag, "TransportError")
    }),
  )
})
