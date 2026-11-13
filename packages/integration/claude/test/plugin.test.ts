import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, assert, describe, it } from "@effect/vitest"

type Plugin = {
  register: (on: (event: string, a: unknown, b?: unknown) => { catch: (handler: Function) => void }) => void
  POLL_MS: number
  POLL_FAILURES_SHOWN: number
  GUARD_BACKOFF_MS: ReadonlyArray<number>
  UNREACHABLE: string
}

const built = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-claude-plugin-"))
const pkg = path.join(import.meta.dirname, "..")
const r = childProcess.spawnSync("bun", ["scripts/build.ts", built], { cwd: pkg, encoding: "utf8" })
if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`)
const hooks = JSON.parse(fs.readFileSync(path.join(built, "hooks/hooks.json"), "utf8")) as { modules: string[] }
const plugin = (await import(path.join(built, "hooks", hooks.modules[0]!))) as Plugin

afterAll(() => fs.rmSync(built, { recursive: true, force: true }))

const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

type Request = { url: string; socketPath: string; headers: Record<string, string>; body: unknown }
type Answer = { status: number; body?: unknown } | Error

const SESSION = {
  VIBEST_AGENT: "general",
  VIBEST_SESSION_ID: "a1a10001-a1a1-4a1a-8a1a-a1a10001a1a1",
  VIBEST_PROJECT_ID: "7",
  VIBEST_HOME: "/vh",
  VIBEST_RUNTIME: '{"runtime":"herdr"}',
}
const WORKER = { ...SESSION, VIBEST_SESSION_ID: "w1" }

const host = (env: Record<string, string> = SESSION) => {
  const hooks: Record<string, Function> = {}
  const catches: Record<string, Function> = {}
  const on = (event: string, a: unknown, b?: unknown) => {
    hooks[event] = (b ?? a) as Function
    return { catch: (handler: Function) => void (catches[event] = handler) }
  }
  const requests: Request[] = []
  const submitted: string[] = []
  const statuses: Array<string | undefined> = []
  const every: Array<{ ms: number; fn: () => void }> = []
  const after: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
  const state = {
    conversation: "c1",
    redraws: 0,
    answer: (_r: Request): Answer => ({ status: 204 }),
    submit: async (_text: string): Promise<{ text: string; drop?: undefined } | { drop: string }> => ({ text: "x" }),
  }
  const $ = {
    env: { get: async (name: string) => env[name] },
    session: { id: async () => state.conversation, cwd: async () => "/work" },
    plugin: { name: "vibest", root: "/p" },
    http: {
      fetch: async (url: string, init: { socketPath: string; headers: Record<string, string>; body: string }) => {
        const request = { url, socketPath: init.socketPath, headers: init.headers, body: JSON.parse(init.body) }
        requests.push(request)
        const a = state.answer(request)
        if (a instanceof Error) throw a
        return {
          status: a.status,
          ok: a.status < 300,
          headers: {},
          text: a.body === undefined ? "" : JSON.stringify(a.body),
        }
      },
    },
    prompt: {
      submit: (input: { text: string }) => {
        submitted.push(input.text)
        return state.submit(input.text)
      },
    },
    ui: { invalidate: () => void (state.redraws += 1), status: (t: string | undefined) => void statuses.push(t) },
    process: { run: async () => ({ exitCode: 0, stdout: "4242\n", stderr: "" }) },
    clock: {
      every: (ms: number, fn: () => void) => {
        every.push({ ms, fn })
        return { cancel: () => undefined }
      },
      after: (ms: number, fn: () => void) => {
        const t = { ms, fn, cancelled: false }
        after.push(t)
        return { cancel: () => void (t.cancelled = true) }
      },
    },
  }
  plugin.register(on)
  const pass = async (e: object) => e
  return {
    hooks,
    catches,
    requests,
    submitted,
    statuses,
    every,
    state,
    paths: () => requests.map((r) => r.url.replace("http://vibestd", "")),
    start: async () => {
      await hooks["session.start"]!($, { cwd: "/work" }, pass)
      await settle()
    },
    tick: async () => {
      for (const t of every) t.fn()
      await settle()
    },
    draw: async () => {
      const r = await hooks["ui.render"]!($, { component: "AbovePrompt" }, async () => "drawn")
      await settle()
      return r
    },
    prompt: (text: string, origin: object) => hooks["prompt.submit"]!($, { text, origin }, pass),
    executionComplete: (event: object) => hooks["turn.complete"]!($, event, pass),
    preTool: (event: object) => hooks["tool.call"]!($, event, pass),
    fire: async (ms: number) => {
      for (const t of after.filter((t) => t.ms === ms && !t.cancelled)) {
        t.cancelled = true
        t.fn()
      }
      await settle()
    },
  }
}

const batch = (execution: number, line: string, text: string) => ({
  status: 200,
  body: { execution, ids: [execution], line, text },
})
const ownSubmit = { kind: "plugin", name: "vibest" }

describe("Claude plugin requests", () => {
  it("does nothing outside VIBEST: no take, no report, tool calls pass", async () => {
    const h = host({})
    await h.start()
    await h.executionComplete({ reason: "answer", answer: "x" })
    await h.prompt("hi", { kind: "composer" })
    assert.deepStrictEqual(await h.preTool({ tool: "Bash", command: "ls" }), { tool: "Bash", command: "ls" })
    assert.deepStrictEqual([h.requests, h.every], [[], []])
  })

  it("a session reports its execution end and the person's prompt", async () => {
    const h = host(WORKER)
    await h.start()
    await h.executionComplete({ reason: "answer", answer: "done" })
    await h.executionComplete({ reason: "answer", answer: "sub", agentId: "a1" })
    await h.prompt("next", { kind: "composer" })
    await settle()
    assert.deepStrictEqual(h.paths(), [
      "/session/ready",
      "/inbox/take",
      "/hooks/claude/execution-end",
      "/hooks/claude/prompt",
    ])
    assert.deepStrictEqual(h.requests[2]!.body, {
      hook_event_name: "ExecutionComplete",
      session_id: "c1",
      reason: "answer",
      last_assistant_message: "done",
    })
    assert.deepStrictEqual(h.requests[3]!.body, { hook_event_name: "PromptSubmit", text: "next", origin: "composer" })
  })

  it("a report vibestd did not take is tried again later", async () => {
    const h = host(WORKER)
    let down = true
    h.state.answer = () => (down ? new Error("ECONNREFUSED") : { status: 204 })
    await h.executionComplete({ reason: "answer", answer: "done" })
    await settle()
    down = false
    await h.fire(1000)
    assert.deepStrictEqual(h.paths(), ["/hooks/claude/execution-end", "/hooks/claude/execution-end"])
    await h.fire(2000)
    assert.lengthOf(h.requests, 2, "taken: no more tries")
  })
})

describe("Claude plugin inbox", () => {
  it("takes only while idle; each draw submits one batch's line; its own submit reports the accepted execution and gets the full text as context, unless the line already ends with it", async () => {
    const h = host()
    const takes = [
      batch(1, 'General Agent "A" completed (w1)', "full A"),
      batch(2, "Notice: x", "full B"),
      batch(3, "Notice: w1 exited.", "w1 exited."),
    ]
    h.state.answer = (r) => (r.url.endsWith("/take") ? (takes.shift() ?? { status: 204 }) : { status: 204 })
    await h.start()
    await h.tick()
    assert.deepStrictEqual(h.submitted, [], "the take does not submit")
    assert.strictEqual(h.state.redraws, 1)
    assert.lengthOf(
      h.requests.filter((r) => r.url.endsWith("/take")),
      1,
      "no second take while a batch waits",
    )
    assert.strictEqual(await h.draw(), "drawn", "draws nothing of its own")
    assert.deepStrictEqual(h.submitted, ['General Agent "A" completed (w1)'])
    const own = await h.prompt('General Agent "A" completed (w1)', ownSubmit)
    assert.deepStrictEqual((own as { context: string[] }).context, ["full A"])
    assert.deepStrictEqual(h.requests.at(-1)!.body, { hook_event_name: "PromptSubmit", origin: "vibest", execution: 1 })
    await h.tick()
    assert.lengthOf(
      h.requests.filter((r) => r.url.endsWith("/take")),
      1,
      "no take while the execution runs",
    )
    await h.executionComplete({ reason: "answer", answer: "done" })
    await h.tick()
    await h.draw()
    assert.deepStrictEqual(h.submitted.at(-1), "Notice: x")
    assert.notProperty(await h.prompt("Notice: x", { kind: "composer" }), "context")
    assert.deepStrictEqual(((await h.prompt("Notice: x", ownSubmit)) as { context: string[] }).context, ["full B"])
    await h.executionComplete({ reason: "answer", answer: "done" })
    await h.tick()
    await h.draw()
    assert.deepStrictEqual(h.submitted.at(-1), "Notice: w1 exited.")
    assert.notProperty(
      await h.prompt("Notice: w1 exited.", ownSubmit),
      "context",
      "a line that already ends with the full text gets no context",
    )
  })

  it("a submit Claude refuses is reported once for its execution and not submitted again", async () => {
    const h = host()
    const takes = [batch(1, "same", "first")]
    h.state.answer = (r) => (r.url.endsWith("/take") ? (takes.shift() ?? { status: 204 }) : { status: 204 })
    await h.start()
    await h.tick()
    h.state.submit = async () => ({ drop: "the session was stopped and nobody has sent input since" })
    await h.draw()
    await h.draw()
    await settle()
    assert.deepStrictEqual(h.submitted, ["same"])
    const refusals = h.requests.filter((r) => r.url.endsWith("/hooks/claude/prompt"))
    assert.deepStrictEqual(
      refusals.map((r) => r.body),
      [{ hook_event_name: "PromptSubmit", origin: "vibest", execution: 1, refused: true }],
    )
  })

  it("says so once vibestd stops answering, and clears it when it answers again", async () => {
    const h = host()
    let down = true
    h.state.answer = () => (down ? new Error("ENOENT") : { status: 204 })
    await h.start()
    for (let i = 1; i < plugin.POLL_FAILURES_SHOWN; i++) await h.tick()
    assert.lengthOf(h.statuses, 1)
    assert.match(h.statuses[0]!, /vibestd does not answer/)
    await h.tick()
    down = false
    await h.tick()
    assert.deepStrictEqual(h.statuses.at(-1), undefined)
  })
})

describe("Claude plugin protocol mismatch", () => {
  const mismatch = {
    error: "vibest was updated to 9.9.9; run vibest update to restart this agent on it",
    protocol: 99,
    version: "9.9.9",
    message: "vibest was updated to 9.9.9; run vibest update to restart this agent on it",
    action: "vibest update",
  }

  it("a 409 puts vibestd's message and action on the status line, takes on quietly, and clears once it goes through", async () => {
    const h = host()
    let refused = true
    h.state.answer = () => (refused ? { status: 409, body: mismatch } : { status: 204 })
    await h.start()
    for (let i = 0; i < plugin.POLL_FAILURES_SHOWN + 1; i++) await h.tick()
    assert.isTrue(h.statuses.every((t) => t === `VIBEST: ${mismatch.error}`))
    refused = false
    await h.tick()
    assert.deepStrictEqual(h.statuses.at(-1), undefined)
  })

  it("the guard still refuses, with the mismatch and the command as its reason", async () => {
    const h = host(WORKER)
    h.state.answer = () => ({ status: 409, body: mismatch })
    const answer = await h.preTool({ tool: "Read" })
    assert.include(answer.deny, mismatch.error)
    assert.lengthOf(h.requests, 1)
  })
})

describe("Claude plugin guard", () => {
  it("vibestd's answer: a deny refuses, nothing lets the call through, a 4xx refuses with its reason", async () => {
    const h = host(WORKER)
    h.state.answer = () => ({ status: 200, body: { deny: "no" } })
    assert.deepStrictEqual(await h.preTool({ tool: "Write", file_path: "/x", tool_use_id: "t" }), { deny: "no" })
    assert.deepStrictEqual(h.requests[0]!.body, { tool_name: "Write", tool_input: { file_path: "/x" }, cwd: "/work" })
    h.state.answer = () => ({ status: 200, body: {} })
    assert.deepStrictEqual(await h.preTool({ tool: "Read" }), { tool: "Read" })
    h.state.answer = () => ({ status: 403, body: { error: "session w1 is not in project 7" } })
    assert.match((await h.preTool({ tool: "Read" })).deny, /not in project 7/)
  })

  it("nothing answering: tried again after 100, 300 and 900 ms, then refused", async () => {
    const h = host(WORKER)
    h.state.answer = () => new Error("ECONNREFUSED")
    const answer = h.preTool({ tool: "Read" })
    await settle()
    for (const ms of plugin.GUARD_BACKOFF_MS) await h.fire(ms)
    assert.deepStrictEqual(await answer, { deny: plugin.UNREACHABLE })
    assert.lengthOf(h.requests, 4)
  })
})
