import childProcess from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { PROTOCOL } from "@vibest/schema/version"
import { afterAll, assert, beforeAll, describe, it } from "vitest"

import pkg from "../package.json" with { type: "json" }
import { files, PLUGIN } from "../src/plugin.ts"

interface Recorded {
  readonly method: string
  readonly path: string
  readonly headers: http.IncomingHttpHeaders
  readonly body: string
}

describe("@vibest/agy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-agy-"))

  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }

  const root = path.join(dir, PLUGIN)
  const sockPath = path.join(dir, "vibest-http.sock")
  const recorded: Array<Recorded> = []

  let responder: (req: Recorded) => { readonly status: number; readonly body?: string } = () => ({
    status: 204,
  })

  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const entry: Recorded = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }

      recorded.push(entry)
      const reply = responder(entry)
      res.writeHead(reply.status, reply.body === undefined ? {} : { "content-type": "application/json" })
      res.end(reply.body ?? "")
    })
  })

  beforeAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(sockPath, () => resolve())
      }),
  )

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const agent = {
    VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
    VIBEST_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    VIBEST_PROCESS: "3",
  }

  const run = (event: string, payload: { readonly conversationId?: string }, env: Record<string, string> = agent) =>
    new Promise<{ readonly code: number; readonly stdout: string }>((resolve, reject) => {
      const hooks = JSON.parse(files[`${PLUGIN}/hooks.json`]!).vibest as Record<
        string,
        Array<{ command?: string; hooks?: Array<{ command: string }> }>
      >

      const entry = hooks[event]![0]!

      const child = childProcess.spawn("sh", ["-c", entry.command ?? entry.hooks![0]!.command], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: dir, VIBEST_HOME: dir, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      })

      const out: Array<Buffer> = []
      child.stdout.on("data", (c: Buffer) => out.push(c))
      child.on("error", reject)
      child.on("close", (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out).toString("utf8").trim(),
        }),
      )
      child.stdin.end(JSON.stringify({ hookEventName: event, ...payload }, null, 2))
    })

  it("only the process's first conversation reports prompt and execution-end with full headers", async () => {
    recorded.length = 0
    responder = () => ({ status: 204 })

    assert.deepStrictEqual(await run("SessionStart", { conversationId: "root" }), { code: 0, stdout: "{}" })
    assert.strictEqual(recorded.length, 1)
    assert.strictEqual(recorded[0]!.method, "POST")
    assert.strictEqual(recorded[0]!.path, "/hooks/agy/prompt")
    assert.strictEqual(recorded[0]!.headers["vibest-protocol"], String(PROTOCOL))
    assert.strictEqual(recorded[0]!.headers["vibest-plugin-version"], pkg.version)
    assert.strictEqual(recorded[0]!.headers["vibest-session-id"], agent.VIBEST_SESSION_ID)
    assert.strictEqual(recorded[0]!.headers["vibest-project-id"], agent.VIBEST_PROJECT_ID)
    assert.strictEqual(recorded[0]!.headers["vibest-harness"], "agy")
    assert.strictEqual(recorded[0]!.headers["vibest-process"], "3")

    assert.deepStrictEqual(await run("SessionStart", { conversationId: "sub" }), { code: 0, stdout: "{}" })
    assert.deepStrictEqual(await run("Stop", { conversationId: "sub" }), { code: 0, stdout: '{"decision":"allow"}' })
    assert.strictEqual(recorded.length, 1)

    assert.deepStrictEqual(await run("PreInvocation", { conversationId: "root" }), { code: 0, stdout: "{}" })
    assert.deepStrictEqual(await run("Stop", { conversationId: "root" }), { code: 0, stdout: '{"decision":"allow"}' })
    assert.deepStrictEqual(
      recorded.map((r) => r.path),
      ["/hooks/agy/prompt", "/hooks/agy/prompt", "/hooks/agy/execution-end"],
    )
  })

  it("posts PreToolUse to /hooks/agy/guard, retries on 503, and fails closed when unreachable", async () => {
    recorded.length = 0
    const deny = '{"decision":"deny","reason":"no"}'
    responder = () => ({ status: 200, body: deny })
    assert.deepStrictEqual(await run("PreToolUse", { conversationId: "sub" }), { code: 0, stdout: deny })
    assert.strictEqual(recorded.length, 1)
    assert.strictEqual(recorded[0]!.path, "/hooks/agy/guard")

    recorded.length = 0
    let attempts = 0
    responder = () => {
      attempts++

      return attempts < 3
        ? { status: 503, body: '{"error":"stopping"}' }
        : { status: 200, body: '{"decision":"allow"}' }
    }

    assert.deepStrictEqual(await run("PreToolUse", { conversationId: "root" }), {
      code: 0,
      stdout: '{"decision":"allow"}',
    })
    assert.strictEqual(recorded.length, 3)

    const missingHome = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-agy-missing-"))

    try {
      const failed = await run("PreToolUse", {}, { ...agent, VIBEST_HOME: missingHome })
      assert.strictEqual(failed.code, 0)
      assert.deepStrictEqual(JSON.parse(failed.stdout), {
        decision: "deny",
        reason: "vibestd unreachable; the tool call is refused.",
      })
      assert.include(fs.readFileSync(path.join(missingHome, "vibestd.log"), "utf8"), "did not reach vibestd")
    } finally {
      fs.rmSync(missingHome, { recursive: true, force: true })
    }
  })

  it("outside a vibest session nothing reaches vibest", async () => {
    recorded.length = 0
    assert.deepStrictEqual(await run("PreToolUse", {}, {}), { code: 0, stdout: '{"decision":"allow"}' })
    assert.deepStrictEqual(await run("Stop", { conversationId: "root" }, {}), {
      code: 0,
      stdout: '{"decision":"allow"}',
    })
    assert.strictEqual(recorded.length, 0)
  })
})
