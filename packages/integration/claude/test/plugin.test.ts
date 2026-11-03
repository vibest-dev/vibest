// The Claude plugin as it ships: built by scripts/build.ts into a temp dir, its module found through
// hooks/hooks.json and imported from there. Only the native host beneath it is fake (no Claude, no vibestd).
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"

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

const clone = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown

const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

type Request = { url: string; socketPath: string; headers: Record<string, string>; body: unknown }
type Answer = { status: number; body?: unknown } | Error

const COORDINATOR = {
  VIBEST_AGENT: "coordinator",
  VIBEST_SESSION_ID: "main0001",
  VIBEST_PROJECT_ID: "7",
  VIBEST_HOME: "/vh",
  VIBEST_RUNTIME: '{"runtime":"herdr"}',
}
const WORKER = { ...COORDINATOR, VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }

const ownSubmit = { kind: "plugin", name: "vibest" }
type Entered = { text: string; origin?: object; context?: string[] }

/** Claude Code's `$.state` for one process: what a reload keeps. */
type Store = { value: unknown; version: number }

const host = (env: Record<string, string> = COORDINATOR, store: Store = { value: undefined, version: 0 }) => {
  let hooks: Record<string, Function> = {}
  const catches: Record<string, Function> = {}
  const on = (event: string, a: unknown, b?: unknown) => {
    hooks[event] = (b ?? a) as Function
    return { catch: (handler: Function) => void (catches[event] = handler) }
  }
  const requests: Request[] = []
  const submitted: string[] = []
  const entered: Entered[] = []
  let stateless = false
  const statuses: Array<string | undefined> = []
  const every: Array<{ ms: number; fn: () => void }> = []
  const after: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
  const state = {
    conversation: "c1",
    redraws: 0,
    answer: (_r: Request): Answer => ({ status: 200, body: { ids: [], line: "", text: "" } }),
    /** What Claude Code does with a prompt that reached the bottom of the hooks: it enters, or is dropped. */
    submit: async (e: Entered): Promise<Entered | { drop: string }> => e,
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
      // As Claude Code: this plugin's own submit, made inside one of its hooks, runs its prompt.submit hook.
      submit: async (input: { text: string }) => {
        submitted.push(input.text)
        const result = (await hooks["prompt.submit"]!($, { text: input.text, origin: ownSubmit }, (e: Entered) =>
          state.submit(e),
        )) as Entered | { drop: string }
        if (!("drop" in result)) entered.push(result)
        return result
      },
    },
    ui: { invalidate: () => void (state.redraws += 1), status: (t: string | undefined) => void statuses.push(t) },
    // A command's parent is Claude Code itself.
    process: { run: async () => ({ exitCode: 0, stdout: "4242\n", stderr: "" }) },
    // Claude Code 2.1.316 and 2.1.317: `get(ref)`, `set(ref, value, { ifVersion })`, compare-and-set.
    state: {
      get: async (ref: { plugin: string; key: string }) => {
        if (stateless) throw new Error("$.state is not a function")
        assert.deepStrictEqual(ref, { plugin: "vibest", key: "inbox" })
        return store.value === undefined
          ? { version: store.version }
          : { value: clone(store.value), version: store.version }
      },
      set: async (ref: { plugin: string; key: string }, value: unknown, options: { ifVersion?: number }) => {
        if (stateless) throw new Error("$.state is not a function")
        assert.deepStrictEqual(ref, { plugin: "vibest", key: "inbox" })
        if (options.ifVersion !== undefined && options.ifVersion !== store.version)
          return { isSet: false, version: store.version }
        store.value = clone(value)
        store.version += 1
        return { isSet: true, version: store.version }
      },
    },
    clock: {
      every: (ms: number, fn: () => void) => {
        const t = { ms, fn }
        every.push(t)
        return { cancel: () => void every.splice(every.indexOf(t), 1) }
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
    get hooks() {
      return hooks
    },
    store,
    /** A Claude Code without `$.state`. */
    noState: () => void (stateless = true),
    catches,
    requests,
    submitted,
    /** The prompts that entered, with the context the hook attached. */
    entered,
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
    /**
     * Claude Code loads the module again (a synced plugin directory): new hooks, the same `$.state`; the old load's
     * clock keeps running until it stops itself. Then the new load's session.start.
     */
    reload: async () => {
      hooks = {}
      plugin.register(on)
      await hooks["session.start"]!($, { cwd: "/work" }, pass)
      await settle()
    },
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
    // First that the harness takes input (rpc.ts Session.Ready), then the main agent's first poll.
    const [ready, poll] = h.requests
    assert.strictEqual(ready!.url, "http://vibestd/session/ready")
    assert.deepStrictEqual(
      ready!.body,
      { pid: 4242, plugin: "/p" },
      "with Claude Code's own pid, which a restart signals, and the directory it loaded this module from",
    )
    assert.strictEqual(poll!.url, "http://vibestd/inbox/poll")
    assert.strictEqual(poll!.socketPath, "/vh/vibest-http.sock")
    assert.deepInclude(poll!.headers, {
      "vibest-protocol": "4",
      "vibest-caller": "session",
      "vibest-session-id": "main0001",
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

  it("a worker reports its turn end and the person's prompt, and polls nothing", async () => {
    const h = host(WORKER)
    await h.start()
    assert.deepStrictEqual(h.every, [])
    await h.turnComplete({ reason: "answer", answer: "done", turnId: "t1" })
    await h.turnComplete({ reason: "answer", answer: "sub", agentId: "a1" })
    await h.prompt("next", { kind: "composer" })
    await settle()
    assert.deepStrictEqual(h.paths(), ["/session/ready", "/hooks/claude/turn-end", "/hooks/claude/prompt"])
    assert.deepStrictEqual(h.requests[1]!.body, {
      hook_event_name: "TurnComplete",
      session_id: "c1",
      turn_id: "t1",
      reason: "answer",
      last_assistant_message: "done",
    })
    assert.deepStrictEqual(h.requests[2]!.body, { hook_event_name: "PromptSubmit", text: "next", origin: "composer" })
  })

  it("the main agent's turn end is not reported", async () => {
    const h = host()
    h.state.answer = (r) => (r.url.endsWith("/poll") ? batch([], "", "") : { status: 204 })
    await h.turnComplete({ reason: "answer", answer: "x" })
    await settle()
    assert.deepStrictEqual(h.paths(), [])
  })

  it("a report vibestd did not take is tried again later", async () => {
    const h = host(WORKER)
    let down = true
    h.state.answer = () => (down ? new Error("ECONNREFUSED") : { status: 204 })
    await h.turnComplete({ reason: "answer", answer: "done" })
    await settle()
    down = false
    await h.fire(1000)
    assert.deepStrictEqual(h.paths(), ["/hooks/claude/turn-end", "/hooks/claude/turn-end"])
    await h.fire(2000)
    assert.lengthOf(h.requests, 2, "taken: no more tries")
  })
})

describe("Claude plugin inbox", () => {
  const acks = (h: ReturnType<typeof host>) => h.requests.filter((r) => r.url.endsWith("/ack")).map((r) => r.body)

  it("a poll only queues; each draw submits one batch's line with its full text as context, acked as soon as it entered", async () => {
    const h = host()
    const polls = [batch([1], 'General Agent "A" completed (w1)', "full A"), batch([2], "Notice: x", "full B")]
    h.state.answer = (r) =>
      r.url.endsWith("/poll") ? (polls.shift() ?? batch([], "", "")) : { status: 200, body: { acked: [] } }
    await h.start()
    await h.tick()
    assert.deepStrictEqual(h.submitted, [], "the poll does not submit")
    assert.strictEqual(h.state.redraws, 2)
    assert.strictEqual(await h.draw(), "drawn", "draws nothing of its own")
    assert.deepStrictEqual(
      h.entered.map((e) => [e.text, e.context]),
      [['General Agent "A" completed (w1)', ["full A"]]],
    )
    assert.deepStrictEqual(acks(h), [{ ids: [1], release: [] }], "acked at once, not on the next poll")
    await h.draw()
    assert.deepStrictEqual(h.entered.at(-1)?.context, ["full B"])
    assert.deepStrictEqual(acks(h).at(-1), { ids: [2], release: [] })
    // The person's own prompt with the same text gets nothing.
    assert.notProperty(await h.prompt("Notice: x", { kind: "composer" }), "context")
    await h.draw()
    assert.lengthOf(h.submitted, 2, "nothing left to submit")
  })

  it("a line that already ends with the full text (a one-line notice) gets no context", async () => {
    const h = host()
    const polls = [batch([1], "Notice: w1 exited.", "w1 exited."), batch([2], "Notice: w2 exited.", "w2 exited.\nmore")]
    h.state.answer = (r) => (r.url.endsWith("/poll") ? (polls.shift() ?? batch([], "", "")) : { status: 200, body: {} })
    await h.start()
    await h.tick()
    await h.draw()
    await h.draw()
    assert.deepStrictEqual(
      h.entered.map((e) => e.context),
      [undefined, ["w2 exited.\nmore"]],
    )
  })

  it("a dropped submit stays at the front of the queue and is not acked; two batches with one line keep their texts in order", async () => {
    const h = host()
    const polls = [batch([1], "same", "first"), batch([2], "same", "second")]
    h.state.answer = (r) => (r.url.endsWith("/poll") ? (polls.shift() ?? batch([], "", "")) : { status: 200, body: {} })
    await h.start()
    await h.tick()
    h.state.submit = async () => ({ drop: "busy" })
    await h.draw()
    assert.deepStrictEqual(acks(h), [])
    h.state.submit = async (e) => e
    await h.draw()
    await h.draw()
    assert.deepStrictEqual(h.submitted, ["same", "same", "same"])
    assert.deepStrictEqual(
      h.entered.map((e) => e.context),
      [["first"], ["second"]],
    )
    assert.deepStrictEqual(acks(h), [
      { ids: [1], release: [] },
      { ids: [2], release: [] },
    ])
  })

  it("a batch handed out again after its lease ran out is shown once and acked again", async () => {
    const h = host()
    h.state.answer = (r) => (r.url.endsWith("/poll") ? batch([5], "L", "T") : { status: 200, body: {} })
    await h.start()
    await h.tick()
    assert.strictEqual(h.state.redraws, 1)
    await h.draw()
    await h.draw()
    assert.deepStrictEqual(h.submitted, ["L"])
    // Handed out again: acked on the poll after.
    await h.tick()
    await h.tick()
    assert.deepStrictEqual(acks(h), [
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
    assert.deepStrictEqual(acks(h).at(-1), { ids: [5], release: [6] })
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

describe("Claude plugin reload", () => {
  it("a reload keeps the queue: a batch polled before it is shown once, by the new load", async () => {
    const h = host()
    const polls = [batch([1], "L1", "T1")]
    h.state.answer = (r) => (r.url.endsWith("/poll") ? (polls.shift() ?? batch([], "", "")) : { status: 200, body: {} })
    await h.start()
    await h.tick()
    await h.reload()
    await h.draw()
    await h.draw()
    assert.deepStrictEqual(
      h.entered.map((e) => [e.text, e.context]),
      [["L1", ["T1"]]],
    )
  })

  it("a batch handed out again after a reload (its lease ran out) is not shown twice", async () => {
    const h = host()
    h.state.answer = (r) => (r.url.endsWith("/poll") ? batch([3], "L", "T") : { status: 500, body: { error: "down" } })
    await h.start()
    await h.tick()
    await h.draw()
    assert.deepStrictEqual(h.submitted, ["L"])
    // The ack was not taken, then Claude Code loaded the module again.
    await h.reload()
    await h.tick()
    await h.draw()
    assert.deepStrictEqual(h.submitted, ["L"], "shown once")
    const acked = h.requests.filter((r) => r.url.endsWith("/ack")).map((r) => r.body)
    assert.isTrue(
      acked.length >= 2 && acked.every((b) => JSON.stringify(b) === JSON.stringify({ ids: [3], release: [] })),
    )
  })

  it("only the newest load polls: the old one's clock stops at its next tick", async () => {
    const h = host()
    h.state.answer = () => batch([], "", "")
    await h.start()
    await h.reload()
    assert.lengthOf(h.every, 2, "both clocks run for now")
    const before = h.paths().filter((p) => p === "/inbox/poll").length
    await h.tick()
    assert.lengthOf(h.every, 1, "the old load stopped its clock")
    assert.strictEqual(h.paths().filter((p) => p === "/inbox/poll").length, before + 1, "one poll per tick")
  })

  it("a turn end vibestd did not take is kept across a reload and sent by the new load, with its turn id", async () => {
    const store: Store = { value: undefined, version: 0 }
    const h = host(WORKER, store)
    let down = true
    h.state.answer = (r) =>
      down && r.url.endsWith("/turn-end") ? { status: 503, body: { error: "stopping" } } : { status: 204 }
    await h.start()
    await h.turnComplete({ reason: "answer", answer: "done", turnId: "t1" })
    await settle()
    down = false
    // The old load's retry dies with it; the new load's session.start sends what was kept.
    await h.reload()
    const ends = h.requests.filter((r) => r.url.endsWith("/turn-end"))
    assert.lengthOf(ends, 2)
    assert.deepStrictEqual(ends[1]!.body, ends[0]!.body)
    assert.strictEqual((ends[1]!.body as { turn_id: string }).turn_id, "t1")
    assert.deepStrictEqual((store.value as { reports: unknown[] } | undefined)?.reports, [], "sent: no longer kept")
  })

  it("/clear starts an empty $.state for the new conversation: the same load claims it and goes on delivering", async () => {
    const h = host()
    const polls = [batch([1], "L1", "T1")]
    h.state.answer = (r) => (r.url.endsWith("/poll") ? (polls.shift() ?? batch([], "", "")) : { status: 200, body: {} })
    await h.start()
    await h.draw()
    h.store.value = undefined
    h.store.version = 0
    polls.push(batch([2], "L2", "T2"))
    await h.tick()
    await h.draw()
    assert.deepStrictEqual(
      h.entered.map((e) => e.context),
      [["T1"], ["T2"]],
    )
  })

  it("works without $.state (kept in memory)", async () => {
    const h = host()
    const polls = [batch([1], "L", "T")]
    h.state.answer = (r) => (r.url.endsWith("/poll") ? (polls.shift() ?? batch([], "", "")) : { status: 200, body: {} })
    h.noState()
    await h.start()
    await h.tick()
    await h.draw()
    assert.deepStrictEqual(
      h.entered.map((e) => e.context),
      [["T"]],
    )
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
