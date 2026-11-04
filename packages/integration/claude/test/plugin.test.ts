// The Claude plugin as it ships: built by scripts/build.ts into a temp dir, its module found through
// hooks/hooks.json and imported from there. Only the native host beneath it is fake (no Claude, no vibestd).
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { PROTOCOL } from "@vibest/protocol/protocol"

type Plugin = {
  register: (on: (event: string, a: unknown, b?: unknown) => { catch: (handler: Function) => void }) => void
  POLL_MS: number
  POLL_FAILURES_SHOWN: number
  GUARD_BACKOFF_MS: ReadonlyArray<number>
  UNREACHABLE: string
}

let plugin: Plugin
let built: string
const version = (
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8")) as {
    version: string
  }
).version

beforeAll(async () => {
  built = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-claude-plugin-"))
  const pkg = path.join(import.meta.dirname, "..")
  const r = childProcess.spawnSync("bun", ["scripts/build.ts", built], { cwd: pkg, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`build failed: ${r.stderr}`)
  const hooks = JSON.parse(fs.readFileSync(path.join(built, "hooks/hooks.json"), "utf8")) as { modules: string[] }
  plugin = (await import(path.join(built, "hooks", hooks.modules[0]!))) as Plugin
})

afterAll(() => fs.rmSync(built, { recursive: true, force: true }))

const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

type Request = { url: string; socketPath: string; headers: Record<string, string>; body: unknown }
type Answer = { status: number; body?: unknown } | Error

const COORDINATOR = {
  VIBEST_AGENT: "coordinator",
  VIBEST_SESSION_ID: "a1a10001-a1a1-4a1a-8a1a-a1a10001a1a1",
  VIBEST_PROJECT_ID: "7",
  VIBEST_HOME: "/vh",
  VIBEST_RUNTIME: '{"runtime":"herdr"}',
}
const WORKER = { ...COORDINATOR, VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }

const host = (env: Record<string, string> = COORDINATOR) => {
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
    answer: (_r: Request): Answer => ({ status: 200, body: { ids: [], line: "", text: "" } }),
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
    // A command's parent is Claude Code itself.
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
    /** What the prompt.submit hook passes on for `text` from `origin`. */
    prompt: (text: string, origin: object) => hooks["prompt.submit"]!($, { text, origin }, pass),
    turnComplete: (event: object) => hooks["turn.complete"]!($, event, pass),
    preTool: (event: object) => hooks["tool.call"]!($, event, pass),
    toolCheck: (event: object, verdict: object) => hooks["tool.check"]!($, event, async () => verdict),
    /** Fire every pending clock.after of `ms`. */
    fire: async (ms: number) => {
      for (const t of after.filter((t) => t.ms === ms && !t.cancelled)) {
        t.cancelled = true
        t.fn()
      }
      await settle()
    },
  }
}

const batch = (ids: number[], line: string, text: string) => ({ status: 200, body: { ids, line, text } })
const ownSubmit = { kind: "plugin", name: "vibest" }

describe("Claude plugin artifact", () => {
  it("ships a manifest, a hooks.json naming one module, and an import-free bundle with its version inlined", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(built, ".claude-plugin/plugin.json"), "utf8")) as {
      name: string
    }
    assert.strictEqual(manifest.name, "vibest")
    const hooks = JSON.parse(fs.readFileSync(path.join(built, "hooks/hooks.json"), "utf8")) as { modules: string[] }
    assert.deepStrictEqual(hooks.modules, ["./register.mjs"])
    const source = fs.readFileSync(path.join(built, "hooks/register.mjs"), "utf8")
    assert.notMatch(source, /^\s*import\s|\bfrom\s*["']|\brequire\(|\bimport\(|process\.execPath|\bBun\./m)
    assert.notInclude(source, "VIBEST_PLUGIN_VERSION")
    assert.include(source, JSON.stringify(version))
  })
})

describe("Claude plugin requests", () => {
  it("every request goes to $VIBEST_HOME/vibest-http.sock with the session's headers and the current conversation", async () => {
    const h = host()
    await h.start()
    // First that the harness takes input (a ready event), then the main agent's first poll.
    const [ready, poll] = h.requests
    assert.strictEqual(ready!.url, "http://vibestd/events")
    assert.deepStrictEqual(
      ready!.body,
      { type: "ready", pid: 4242, conversation: "c1" },
      "with Claude Code's own pid, which a restart signals",
    )
    assert.strictEqual(poll!.url, "http://vibestd/inbox/poll")
    assert.strictEqual(poll!.socketPath, "/vh/vibest-http.sock")
    assert.deepInclude(poll!.headers, {
      "vibest-protocol": String(PROTOCOL),
      "vibest-caller": "session",
      "vibest-session-id": "a1a10001-a1a1-4a1a-8a1a-a1a10001a1a1",
      "vibest-project-id": "7",
      "vibest-harness-session-id": "c1",
      "vibest-agent": "coordinator",
      "vibest-harness": "claude",
      "vibest-cwd": "%2Fwork",
      "vibest-runtime": '{"runtime":"herdr"}',
      "vibest-plugin-version": version,
    })
    // After /clear: the same clock, the new conversation.
    h.state.conversation = "c2"
    await h.tick()
    assert.strictEqual(h.requests.at(-1)!.headers["vibest-harness-session-id"], "c2")
    assert.isUndefined(h.hooks["session.end"], "nothing stops on session.end (/clear raises it too)")
  })

  it("does nothing outside VIBEST: no poll, no report, tool calls pass", async () => {
    const h = host({})
    await h.start()
    await h.turnComplete({ reason: "answer", answer: "x" })
    await h.prompt("hi", { kind: "composer" })
    assert.deepStrictEqual(await h.preTool({ tool: "Bash", command: "ls" }), { tool: "Bash", command: "ls" })
    assert.deepStrictEqual([h.requests, h.every], [[], []])
  })

  it("a worker reports its turn end and the person's prompt, and takes its own rows: the line is their full text", async () => {
    const h = host(WORKER)
    await h.start()
    assert.lengthOf(h.every, 1)
    await h.turnComplete({ reason: "answer", answer: "done" })
    await h.turnComplete({ reason: "answer", answer: "sub", agentId: "a1" })
    await h.prompt("next", { kind: "composer" })
    await settle()
    const events = h.requests.filter((r) => r.url.endsWith("/events")).map((r) => r.body)
    assert.deepStrictEqual(events.slice(1), [
      { type: "turn.end", outcome: "completed", text: "done" },
      { type: "turn.start", origin: "typed", text: "next" },
    ])
    // Its task arrives by poll: submitted as its own text, reported as the turn start that took row 7, no context.
    h.state.answer = (r) =>
      r.url.endsWith("/inbox/poll")
        ? { status: 200, body: { ids: [7], line: "fix it", text: "fix it" } }
        : { status: 204 }
    await h.tick()
    await h.draw()
    assert.deepStrictEqual(h.submitted, ["fix it"])
    const passed = (await h.prompt("fix it", { kind: "plugin", name: "vibest" })) as { context?: unknown }
    assert.isUndefined(passed.context)
    await settle()
    assert.deepInclude(
      h.requests.map((r) => r.body),
      { type: "turn.start", origin: "inbox", text: "fix it", inbox: [7] },
    )
  })

  it("turn ends as neutral events: aborted is interrupted, an API error with a limit text is limited", async () => {
    const h = host(WORKER)
    h.state.answer = () => ({ status: 204 })
    await h.turnComplete({ reason: "aborted", answer: "half" })
    await h.turnComplete({ reason: "error", answer: "rate_limit: usage limit reached" })
    await h.turnComplete({ reason: "refusal", refusal: { category: "cyber", explanation: "no" } })
    await settle()
    assert.deepStrictEqual(
      h.requests.map((r) => r.body),
      [
        { type: "turn.end", outcome: "interrupted", text: "half" },
        {
          type: "turn.end",
          outcome: "failed",
          text: "rate_limit: usage limit reached",
          failure: { kind: "limited", message: "rate_limit: usage limit reached" },
        },
        { type: "turn.end", outcome: "failed", text: "", failure: { kind: "other", message: "cyber: no" } },
      ],
    )
  })

  it("a report vibestd did not take is tried again later", async () => {
    const h = host(WORKER)
    let down = true
    h.state.answer = () => (down ? new Error("ECONNREFUSED") : { status: 204 })
    await h.turnComplete({ reason: "answer", answer: "done" })
    await settle()
    down = false
    await h.fire(1000)
    assert.deepStrictEqual(h.paths(), ["/events", "/events"])
    await h.fire(2000)
    assert.lengthOf(h.requests, 2, "taken: no more tries")
  })
})

describe("Claude plugin inbox", () => {
  it("a poll only queues; each draw submits one batch's line; its own submit gets the full text as context; acked on the next poll", async () => {
    const h = host()
    const polls = [batch([1], 'General Agent "A" completed (w1)', "full A"), batch([2], "Notice: x", "full B")]
    h.state.answer = (r) =>
      r.url.endsWith("/poll") ? (polls.shift() ?? batch([], "", "")) : { status: 200, body: { acked: [] } }
    await h.start()
    await h.tick()
    assert.deepStrictEqual(h.submitted, [], "the poll does not submit")
    assert.strictEqual(h.state.redraws, 2)
    assert.strictEqual(await h.draw(), "drawn", "draws nothing of its own")
    assert.deepStrictEqual(h.submitted, ['General Agent "A" completed (w1)'])
    const own = await h.prompt('General Agent "A" completed (w1)', ownSubmit)
    assert.deepStrictEqual((own as { context: string[] }).context, ["full A"])
    await h.draw()
    assert.deepStrictEqual(h.submitted.at(-1), "Notice: x")
    // The person's own prompt with the same text gets nothing.
    assert.notProperty(await h.prompt("Notice: x", { kind: "composer" }), "context")
    assert.deepStrictEqual(((await h.prompt("Notice: x", ownSubmit)) as { context: string[] }).context, ["full B"])
    await h.tick()
    const ack = h.requests.find((r) => r.url.endsWith("/ack"))
    assert.deepStrictEqual(ack?.body, { ids: [1, 2], release: [] })
    assert.isTrue(h.paths().indexOf("/inbox/ack") < h.paths().lastIndexOf("/inbox/poll"), "ack, then poll")
  })

  it("a line that already ends with the full text (a one-line notice) gets no context", async () => {
    const h = host()
    const polls = [batch([1], "Notice: w1 exited.", "w1 exited."), batch([2], "Notice: w2 exited.", "w2 exited.\nmore")]
    h.state.answer = (r) => (r.url.endsWith("/poll") ? (polls.shift() ?? batch([], "", "")) : { status: 200, body: {} })
    await h.start()
    await h.tick()
    await h.draw()
    assert.notProperty(await h.prompt("Notice: w1 exited.", ownSubmit), "context")
    await h.draw()
    const multi = await h.prompt("Notice: w2 exited.", ownSubmit)
    assert.deepStrictEqual((multi as { context: string[] }).context, ["w2 exited.\nmore"])
  })

  it("a dropped submit goes back to the front of the queue; two batches with one line keep their texts in order", async () => {
    const h = host()
    const polls = [batch([1], "same", "first"), batch([2], "same", "second")]
    h.state.answer = (r) => (r.url.endsWith("/poll") ? (polls.shift() ?? batch([], "", "")) : { status: 200, body: {} })
    await h.start()
    await h.tick()
    h.state.submit = async () => ({ drop: "busy" })
    await h.draw()
    h.state.submit = async () => ({ text: "x" })
    await h.draw()
    await h.draw()
    assert.deepStrictEqual(h.submitted, ["same", "same", "same"])
    assert.deepStrictEqual(((await h.prompt("same", ownSubmit)) as { context: string[] }).context, ["first"])
    assert.deepStrictEqual(((await h.prompt("same", ownSubmit)) as { context: string[] }).context, ["second"])
    assert.notProperty(await h.prompt("same", ownSubmit), "context")
  })

  it("a batch handed out again after its lease ran out is shown once; once submitted it is acked again", async () => {
    const h = host()
    h.state.answer = (r) => (r.url.endsWith("/poll") ? batch([5], "L", "T") : { status: 200, body: {} })
    await h.start()
    await h.tick()
    assert.strictEqual(h.state.redraws, 1)
    await h.draw()
    await h.draw()
    assert.deepStrictEqual(h.submitted, ["L"])
    await h.tick()
    await h.tick()
    const acks = h.requests.filter((r) => r.url.endsWith("/ack")).map((r) => r.body)
    assert.deepStrictEqual(acks, [
      { ids: [5], release: [] },
      { ids: [5], release: [] },
    ])
  })

  it("a batch mixing a row already shown with a new one: the old one is acked, the new one given back, nothing shown twice", async () => {
    const h = host()
    const polls = [batch([5], "L", "T"), batch([5, 6], "M", "T + U"), batch([6], "N", "U")]
    h.state.answer = (r) => (r.url.endsWith("/poll") ? (polls.shift() ?? batch([], "", "")) : { status: 200, body: {} })
    await h.start()
    await h.draw()
    await h.tick()
    await h.draw()
    assert.deepStrictEqual(h.submitted, ["L"], "the mixed batch is not shown")
    await h.tick()
    const ack = h.requests.filter((r) => r.url.endsWith("/ack")).at(-1)
    assert.deepStrictEqual(ack?.body, { ids: [5], release: [6] })
    await h.draw()
    assert.deepStrictEqual(h.submitted, ["L", "N"])
  })

  it("says so once vibestd stops answering, and clears it when it answers again", async () => {
    const h = host()
    let down = true
    h.state.answer = () => (down ? new Error("ENOENT") : batch([], "", ""))
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

  it("a 409 puts vibestd's message and action on the status line, polls on quietly, and clears once it goes through", async () => {
    const h = host()
    let refused = true
    h.state.answer = () => (refused ? { status: 409, body: mismatch } : batch([], "", ""))
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
    assert.deepStrictEqual(h.requests[0]!.body, {
      tool: { kind: "edit", name: "Write", paths: ["/x"], cwd: "/work" },
    })
    h.state.answer = () => ({ status: 200, body: {} })
    assert.deepStrictEqual(await h.preTool({ tool: "Read" }), { tool: "Read" })
    h.state.answer = () => ({ status: 403, body: { error: "session w1 is not in project 7" } })
    assert.match((await h.preTool({ tool: "Read" })).deny, /not in project 7/)
  })

  it("an ask verdict reports blocked on a permission; AskUserQuestion, once allowed, blocked on a question", async () => {
    const h = host(WORKER)
    h.state.answer = () => ({ status: 200, body: {} })
    const check = (decision: string, toolUseId?: string) =>
      h.toolCheck({ tool: "Bash", input: {}, ...(toolUseId ? { tool_use_id: toolUseId } : {}) }, { decision })
    assert.deepStrictEqual(await check("allow", "t1"), { decision: "allow" })
    assert.deepStrictEqual(await check("ask"), { decision: "ask" }, "a query is no wait")
    assert.lengthOf(h.requests, 0)
    assert.deepStrictEqual(await check("ask", "t2"), { decision: "ask" })
    await settle()
    assert.deepStrictEqual(h.requests.at(-1)!.body, { type: "blocked", reason: "permission", detail: "Bash" })
    await h.preTool({ tool: "AskUserQuestion", questions: [] })
    await settle()
    assert.deepStrictEqual(h.requests.at(-1)!.body, { type: "blocked", reason: "question" })
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
