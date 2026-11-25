import childProcess from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { PROTOCOL } from "@vibest/schema/version"
import { afterAll, assert, beforeAll, describe, it } from "vitest"

import pkg from "../package.json" with { type: "json" }
import { files } from "../src/plugin.ts"

interface Recorded {
  readonly method: string
  readonly path: string
  readonly headers: http.IncomingHttpHeaders
  readonly body: string
}

describe("@vibest/harness-cursor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-cursor-"))

  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }

  const sockPath = path.join(dir, "vibest.sock")
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

  const run = (event: string, env: Record<string, string>, stdin = "{}", index = 0) =>
    new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
      const hooks = JSON.parse(files["hooks/hooks.json"]!).hooks as Record<string, Array<{ command: string }>>

      const child = childProcess.spawn("sh", ["-c", hooks[event]![index]!.command], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", VIBEST_HOME: dir, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      })

      const out: Array<Buffer> = []
      const err: Array<Buffer> = []
      child.stdout.on("data", (c: Buffer) => out.push(c))
      child.stderr.on("data", (c: Buffer) => err.push(c))
      child.on("error", reject)
      child.on("close", (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out).toString("utf8").trim(),
          stderr: Buffer.concat(err).toString("utf8").trim(),
        }),
      )
      child.stdin.end(stdin)
    })

  const agent = {
    VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
    VIBEST_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    VIBEST_PROCESS: "7",
  }

  it("posts preToolUse to /api/hook/cursor/guard with full headers and returns allow or deny", async () => {
    recorded.length = 0
    responder = () => ({ status: 200, body: '{"permission":"allow"}' })
    const allowBody = '{"tool_name":"Shell","tool_input":{"command":"git status"}}'
    const allowed = await run("preToolUse", agent, allowBody)
    assert.deepStrictEqual(allowed, { code: 0, stdout: '{"permission":"allow"}', stderr: "" })
    assert.strictEqual(recorded.length, 1)
    assert.strictEqual(recorded[0]!.method, "POST")
    assert.strictEqual(recorded[0]!.path, "/api/hook/cursor/guard")
    assert.strictEqual(recorded[0]!.body, allowBody)
    assert.strictEqual(recorded[0]!.headers["vibest-protocol"], String(PROTOCOL))
    assert.strictEqual(recorded[0]!.headers["vibest-plugin-version"], pkg.version)
    assert.strictEqual(recorded[0]!.headers["vibest-session-id"], agent.VIBEST_SESSION_ID)
    assert.strictEqual(recorded[0]!.headers["vibest-project-id"], agent.VIBEST_PROJECT_ID)
    assert.strictEqual(recorded[0]!.headers["vibest-harness"], "cursor")
    assert.strictEqual(recorded[0]!.headers["vibest-process"], "7")

    recorded.length = 0
    const deny = '{"permission":"deny","user_message":"no","agent_message":"no"}'
    responder = () => ({ status: 200, body: deny })
    const denied = await run("preToolUse", agent, '{"tool_name":"Shell"}')
    assert.deepStrictEqual(denied, { code: 0, stdout: deny, stderr: "" })
  })

  it("retries guard on HTTP 503 during handover and fails closed when vibestd is unreachable or rejects", async () => {
    recorded.length = 0
    let attempts = 0
    responder = () => {
      attempts++

      return attempts < 3
        ? { status: 503, body: '{"error":"stopping"}' }
        : { status: 200, body: '{"permission":"allow"}' }
    }

    const recovered = await run("preToolUse", agent, '{"tool_name":"Shell"}')
    assert.deepStrictEqual(recovered, { code: 0, stdout: '{"permission":"allow"}', stderr: "" })
    assert.strictEqual(recorded.length, 3)

    recorded.length = 0
    responder = () => ({ status: 409, body: '{"error":"protocol mismatch"}' })
    const mismatch = await run("preToolUse", agent, '{"tool_name":"Shell"}')
    assert.strictEqual(mismatch.code, 2)
    assert.strictEqual(mismatch.stdout, "")
    assert.include(mismatch.stderr, "vibest guard failed")
    assert.strictEqual(recorded.length, 1)

    const missingHome = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-cursor-missing-"))

    try {
      const unreachable = await run("preToolUse", { ...agent, VIBEST_HOME: missingHome }, '{"tool_name":"Shell"}')
      assert.strictEqual(unreachable.code, 2)
      assert.strictEqual(unreachable.stdout, "")
      assert.include(fs.readFileSync(path.join(missingHome, "vibestd.log"), "utf8"), "did not reach vibestd")
    } finally {
      fs.rmSync(missingHome, { recursive: true, force: true })
    }
  })

  it("posts sessionStart prompt, ready, and afterAgentResponse execution-end", async () => {
    const hooks = JSON.parse(files["hooks/hooks.json"]!).hooks as Record<string, Array<{ command: string }>>
    assert.deepStrictEqual(
      hooks.sessionStart!.map((h) => h.command),
      ["sh ./hooks/vibest.sh prompt", "sh ./hooks/vibest.sh ready"],
    )

    recorded.length = 0
    responder = () => ({ status: 204 })
    const start = '{"hook_event_name":"sessionStart","conversation_id":"c1"}'
    assert.strictEqual((await run("sessionStart", agent, start, 0)).code, 0)
    assert.strictEqual((await run("sessionStart", agent, start, 1)).code, 0)
    const stop = '{"hook_event_name":"afterAgentResponse","text":"ok"}'
    assert.strictEqual((await run("afterAgentResponse", agent, stop)).code, 0)

    assert.deepStrictEqual(
      recorded.map((r) => [r.path, r.body]),
      [
        ["/api/hook/cursor/prompt", start],
        ["/api/hook/ready", "{}"],
        ["/api/hook/cursor/execution-end", stop],
      ],
    )
  })

  it("is a no-op outside a vibest session", async () => {
    recorded.length = 0
    assert.deepStrictEqual(await run("preToolUse", {}, '{"tool_name":"Shell"}'), {
      code: 0,
      stdout: '{"permission":"allow"}',
      stderr: "",
    })
    assert.deepStrictEqual(await run("afterAgentResponse", {}, '{"text":"ok"}'), {
      code: 0,
      stdout: "",
      stderr: "",
    })
    assert.strictEqual(recorded.length, 0)
  })
})
