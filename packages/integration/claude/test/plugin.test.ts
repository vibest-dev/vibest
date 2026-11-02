// The Claude plugin as it ships: built by scripts/build.ts into a temp dir, its module found through
// hooks/hooks.json and imported from there. Only the native host beneath it is fake (no Claude, vibest, or files).
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
type RunResult = { exitCode: number; stdout: string; stderr: string }
type CommandRunResult = { text?: string }
type Plugin = {
  register: (on: (event: string, a: unknown, b?: unknown) => { catch: (handler: Function) => void }, options?: unknown) => void
  POLL_MS: number
  RUN_TIMEOUT_MS: number
  BRIDGE_TIMEOUT_MS: number
  GUARD_FAILURE: string
}

let plugin: Plugin
let built: string

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

const gate = <T>() => {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const json = (value: unknown, exitCode = 0): RunResult => ({ exitCode, stdout: JSON.stringify(value), stderr: "" })

const COORDINATOR = { VIBEST_AGENT: "coordinator", VIBEST_SESSION_ID: "vibest-1" }

const host = (env: Record<string, string> = COORDINATOR) => {
  const hooks: {
    start?: Function
    end?: Function
    command?: { matcher: { command: string }; hook: Function }
    stop?: Function
    stopFailure?: Function
    prompt?: Function
    preTool?: Function
  } = {}
  const catches: Record<string, Function> = {}
  const on = (event: string, a: unknown, b?: unknown) => {
    if (event === "session.start") hooks.start = a as Function
    else if (event === "session.end") hooks.end = a as Function
    else if (event === "command.run") hooks.command = { matcher: a as { command: string }, hook: b as Function }
    else if (event === "classic.Stop") hooks.stop = a as Function
    else if (event === "classic.StopFailure") hooks.stopFailure = a as Function
    else if (event === "classic.UserPromptSubmit") hooks.prompt = a as Function
    else if (event === "classic.PreToolUse") hooks.preTool = a as Function
    else throw new Error(`unexpected hook ${event}`)
    return { catch: (handler: Function) => void (catches[event] = handler) }
  }
  const runs: string[][] = []
  const inits: unknown[] = []
  const registered: string[] = []
  const specs: unknown[] = []
  const statuses: Array<string | undefined> = []
  const submitted: string[] = []
  const reads: string[] = []
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
  const files: Record<string, string> = { "/claims/g1-t1": "message one", "/claims/g2-t2": "message two" }
  const state = {
    session: "s1",
    cwd: "/work",
    sessionId: undefined as undefined | (() => Promise<string>),
    idReads: 0,
    replies: {
      attach: async (argv: string[]): Promise<RunResult> => json({ generation: argv.includes("--replace") ? "g2" : "g1" }),
      pull: async (argv: string[]): Promise<RunResult> =>
        argv[3] === "g2" ? json({ token: "t2", file: "/claims/g2-t2" }) : json({ token: "t1", file: "/claims/g1-t1" }),
      ack: async (_argv: string[]): Promise<RunResult> => json({ acked: true }),
      release: async (_argv: string[]): Promise<RunResult> => json({ released: true }),
    } as Record<string, (argv: string[]) => Promise<RunResult>>,
    submit: async (_text: string): Promise<{ text: string; drop?: undefined } | { drop: string }> => ({ text: "entered" }),
  }
  const $: {
    env: { get: (name: string) => Promise<string | undefined> }
    session: { id: () => Promise<string>; cwd: () => Promise<string> }
    process: { run: (argv: readonly string[], init?: { stdin?: string; timeoutMs?: number }) => Promise<RunResult> }
    fs: { read: (file: string) => Promise<string> }
    prompt: { submit: (input: { text: string }) => Promise<{ text: string; drop?: undefined } | { drop: string }> }
    command: { register: (spec: { name: string; description: string; immediate?: true }) => Promise<{ command: string }> }
    clock: { every: (ms: number, fn: () => void) => { cancel: () => void } }
    ui: { status: (text: string | undefined) => void; toast: (text: string) => void }
  } = {
    env: { get: async (name) => env[name] },
    session: {
      id: () => {
        state.idReads += 1
        return state.sessionId ? state.sessionId() : Promise.resolve(state.session)
      },
      cwd: () => Promise.resolve(state.cwd),
    },
    process: {
      run: (argv, init) => {
        runs.push([...argv])
        inits.push(init)
        return state.replies[argv[2]!]!([...argv])
      },
    },
    fs: {
      read: async (file) => {
        reads.push(file)
        const body = files[file]
        if (body === undefined) throw new Error("missing")
        return body
      },
    },
    prompt: {
      submit: (input) => {
        submitted.push(input.text)
        return state.submit(input.text)
      },
    },
    command: { register: async (spec) => (registered.push(spec.name), specs.push(spec), { command: spec.name }) },
    clock: {
      every: (ms, fn) => {
        const t = { ms, fn, cancelled: false }
        timers.push(t)
        return { cancel: () => void (t.cancelled = true) }
      },
    },
    ui: { status: (text) => void statuses.push(text), toast: (text) => void statuses.push(text) },
  }
  plugin.register(on)
  return {
    $, runs, inits, registered, specs, statuses, submitted, reads, timers, state, catches,
    live: () => timers.filter((t) => !t.cancelled),
    start: async () => {
      const r = await hooks.start!($, { cwd: "/work", surface: "terminal", isInteractive: true }, async (e: { cwd: string }) => ({ cwd: e.cwd }))
      await settle()
      return r
    },
    end: async (reason: string) => hooks.end!($, { reason, sessionId: state.session }, async (e: { sessionId: string }) => ({ sessionId: e.sessionId })),
    command: async (name: string): Promise<CommandRunResult | undefined> => {
      if (!hooks.command || hooks.command.matcher.command !== name) return undefined
      const r = await hooks.command.hook($, { command: name, args: "" }, async () => ({}))
      await settle()
      return r
    },
    /** Starts a command run without awaiting it, for runs held at a native call. */
    begin: (name: string): Promise<CommandRunResult> => hooks.command!.hook($, { command: name, args: "" }, async () => ({})),
    stop: (event: object, next: Function = async (e: object) => e) => hooks.stop!($, event, next),
    stopFailure: (event: object, next: Function = async (e: object) => e) => hooks.stopFailure!($, event, next),
    prompt: (event: object, next: Function = async (e: object) => e) => hooks.prompt!($, event, next),
    preTool: (event: object, next: Function = async (e: object) => e) => hooks.preTool!($, event, next),
    /** One period of every live clock.every. */
    tick: async () => {
      for (const t of timers) if (!t.cancelled) t.fn()
      await settle()
    },
  }
}

describe("Claude plugin artifact", () => {
  it("ships a manifest, a hooks.json naming one module, and an import-free bundle", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(built, ".claude-plugin/plugin.json"), "utf8")) as { name: string }
    assert.strictEqual(manifest.name, "vibest")
    const hooks = JSON.parse(fs.readFileSync(path.join(built, "hooks/hooks.json"), "utf8")) as { modules: string[] }
    assert.deepStrictEqual(hooks.modules, ["./register.mjs"])
    const source = fs.readFileSync(path.join(built, "hooks/register.mjs"), "utf8")
    assert.notMatch(source, /^\s*import\s|\bfrom\s*["']|\brequire\(|\bimport\(|process\.execPath|VIBEST_COMMAND|\bBun\./m)
    assert.include(source, 'env.get("VIBEST_AGENT")')
    assert.strictEqual(typeof plugin.register, "function")
  })
})

describe("Claude plugin roles", () => {
  for (const [label, env] of [
    ["a worker", { VIBEST_AGENT: "session", VIBEST_SESSION_ID: "w1" }],
    ["a coordinator variable without a session id", { VIBEST_AGENT: "coordinator" }],
    ["a non-VIBEST session", {}],
  ] as const) {
    it(`does nothing for ${label}`, async () => {
      const h = host(env as Record<string, string>)
      assert.deepStrictEqual(await h.start(), { cwd: "/work" })
      await h.tick()
      assert.deepStrictEqual([h.runs, h.registered, h.timers.length, h.statuses], [[], [], 0, []])
      const reply = await h.command("vibest-reattach")
      assert.match(reply!.text!, /Not an VIBEST coordinator/)
      assert.deepStrictEqual(h.runs, [])
    })
  }

  it("registers /vibest-reattach and one bounded poll on coordinator start, then passes session.start on", async () => {
    const h = host()
    assert.deepStrictEqual(await h.start(), { cwd: "/work" })
    assert.deepStrictEqual(h.registered, ["vibest-reattach"])
    assert.deepInclude(h.specs[0] as object, { name: "vibest-reattach", immediate: true }, "runs mid-turn")
    assert.deepStrictEqual(h.timers.map((t) => t.ms), [plugin.POLL_MS])
    assert.deepStrictEqual(h.runs, [], "startup does not block on attach")
    await h.start()
    assert.deepStrictEqual([h.registered.length, h.timers.length], [1, 1], "a second session.start does not register again")
  })
})

describe("Claude plugin delivery", () => {
  it("attaches without replace, pulls, reads the claim file, submits it and acks, with exact bare argv", async () => {
    const h = host()
    await h.start()
    await h.tick()
    assert.deepStrictEqual(h.runs, [["vibest", "inbox", "attach", "s1"]])
    assert.deepStrictEqual(h.statuses, [undefined, "VIBEST inbox attached"])
    await h.tick()
    assert.deepStrictEqual(h.runs.slice(1), [
      ["vibest", "inbox", "pull", "g1", "s1"],
      ["vibest", "inbox", "ack", "g1", "s1", "t1"],
    ])
    assert.deepStrictEqual(h.inits, h.runs.map(() => ({ timeoutMs: plugin.RUN_TIMEOUT_MS })), "no shell, cwd, env, or stdin")
    assert.deepStrictEqual(h.reads, ["/claims/g1-t1"])
    assert.deepStrictEqual(h.submitted, ["message one"])
  })

  for (const [why, reply, text] of [
    ["stale-receiver", json({ error: "stale-receiver" }), /another receiver.*\/vibest-reattach/],
    ["not-reported with a generation", json({ error: "not-reported", generation: "g1" }), /not recorded this Claude session.*\/vibest-reattach/],
    ["not-reported with a nonzero exit", json({ error: "not-reported" }, 1), /exit 1.*inbox command/],
    ["an unsupported vibest", { exitCode: 1, stdout: "", stderr: "unknown subcommand" }, /exit 1.*inbox command/],
  ] as const) {
    it(`stops with an actionable status when attach answers ${why}`, async () => {
      const h = host()
      h.state.replies.attach = async () => reply
      await h.start()
      await h.tick()
      await h.tick()
      assert.deepStrictEqual(h.runs, [["vibest", "inbox", "attach", "s1"]])
      assert.match(h.statuses.at(-1)!, text)
      assert.deepStrictEqual(h.live(), [], "polling stops")
      assert.deepStrictEqual(h.submitted, [])
    })
  }

  it("attaches again while attach answers not-reported, and delivers once VIBEST has recorded the session", async () => {
    const h = host()
    let reported = false
    h.state.replies.attach = async () => (reported ? json({ generation: "g1" }) : json({ error: "not-reported" }))
    await h.start()
    await h.tick()
    await h.tick()
    assert.deepStrictEqual(h.runs, [["vibest", "inbox", "attach", "s1"], ["vibest", "inbox", "attach", "s1"]])
    assert.match(h.statuses.at(-1)!, /waiting for VIBEST to record this Claude session/)
    assert.strictEqual(h.live().length, 1, "polling continues")
    // The first Stop / StopFailure reported this session.
    reported = true
    await h.tick()
    assert.strictEqual(h.statuses.at(-1), "VIBEST inbox attached")
    await h.tick()
    assert.deepStrictEqual(h.runs.slice(-2), [
      ["vibest", "inbox", "pull", "g1", "s1"],
      ["vibest", "inbox", "ack", "g1", "s1", "t1"],
    ])
    assert.deepStrictEqual(h.submitted, ["message one"])
    assert.isFalse(h.runs.some((r) => r.includes("--replace")), "never replaces on its own")
  })

  it("a not-reported answer that arrives after session.end does not attach again", async () => {
    const h = host()
    const attach = gate<RunResult>()
    h.state.replies.attach = () => attach.promise
    await h.start()
    await h.tick()
    await h.end("clear")
    attach.resolve(json({ error: "not-reported" }))
    await settle()
    for (const t of h.timers) t.fn()
    await settle()
    assert.deepStrictEqual(h.runs, [["vibest", "inbox", "attach", "s1"]])
    assert.match(h.statuses.at(-1)!, /session changed.*\/vibest-reattach/)
    assert.deepStrictEqual(h.live(), [])
  })

  it("stops with a status when attach gets no reply (process.run rejects)", async () => {
    const h = host()
    h.state.replies.attach = async () => {
      throw new Error("timed out")
    }
    await h.start()
    await h.tick()
    assert.match(h.statuses.at(-1)!, /refused \(no reply\)/)
    assert.deepStrictEqual(h.live(), [])
  })

  it("never overlaps ticks while an vibest call is outstanding", async () => {
    const h = host()
    await h.start()
    await h.tick()
    const pull = gate<RunResult>()
    h.state.replies.pull = () => pull.promise
    await h.tick()
    await h.tick()
    await h.tick()
    assert.deepStrictEqual(h.runs.filter((r) => r[2] === "pull").length, 1)
    pull.resolve(json({ empty: true }))
    await settle()
    await h.tick()
    assert.deepStrictEqual(h.runs.filter((r) => r[2] === "pull").length, 2)
  })

  it("releases with --retry when the prompt is definitely dropped", async () => {
    const h = host()
    h.state.submit = async () => ({ drop: "blocked by a hook" })
    await h.start()
    await h.tick()
    await h.tick()
    assert.deepStrictEqual(h.runs.at(-1), ["vibest", "inbox", "release", "g1", "s1", "t1", "--retry"])
  })

  it("releases without --retry when submission is ambiguous, and never submits that token again", async () => {
    const h = host()
    h.state.submit = async () => {
      throw new Error("host went away")
    }
    await h.start()
    await h.tick()
    await h.tick()
    assert.deepStrictEqual(h.runs.at(-1), ["vibest", "inbox", "release", "g1", "s1", "t1"])
    assert.deepStrictEqual(h.submitted, ["message one"])
  })

  it("a lost ack retries only the ack, never the pull or the prompt", async () => {
    const h = host()
    await h.start()
    await h.tick()
    h.state.replies.ack = async () => ({ exitCode: 1, stdout: "", stderr: "daemon unreachable" })
    await h.tick()
    h.state.replies.ack = async () => json({ acked: true, already: true })
    await h.tick()
    assert.deepStrictEqual(h.runs.slice(1).map((r) => r[2]), ["pull", "ack", "ack"])
    assert.deepStrictEqual(h.submitted, ["message one"])
    h.state.replies.pull = async () => json({ empty: true })
    await h.tick()
    assert.deepStrictEqual(h.runs.at(-1)!.slice(2, 4), ["pull", "g1"], "after settling it pulls again")
  })

  it("a lost release retries only the release, with the same op", async () => {
    const h = host()
    h.state.submit = async () => ({ drop: "no" })
    await h.start()
    await h.tick()
    h.state.replies.release = async () => {
      throw new Error("timed out")
    }
    await h.tick()
    h.state.replies.release = async () => json({ released: true })
    await h.tick()
    assert.deepStrictEqual(h.runs.slice(1).map((r) => r.slice(2).join(" ")), [
      "pull g1 s1",
      "release g1 s1 t1 --retry",
      "release g1 s1 t1 --retry",
    ])
    assert.deepStrictEqual(h.submitted, ["message one"])
  })

  it("reads session.id on each tick: a changed session stops before submitting", async () => {
    const h = host()
    await h.start()
    await h.tick()
    const pull = gate<RunResult>()
    h.state.replies.pull = () => pull.promise
    await h.tick()
    h.state.session = "s2"
    await h.end("clear")
    pull.resolve(json({ token: "t1", file: "/claims/g1-t1" }))
    await settle()
    await h.tick()
    assert.deepStrictEqual(h.submitted, [])
    assert.deepStrictEqual(h.reads, [])
    assert.match(h.statuses.at(-1)!, /session changed.*\/vibest-reattach/)
    assert.deepStrictEqual(h.live(), [])
  })

  it("session.end during an in-flight submit stops old delivery: no settlement under the ended session", async () => {
    const h = host()
    await h.start()
    await h.tick()
    const submit = gate<{ text: string }>()
    h.state.submit = () => submit.promise
    await h.tick()
    assert.deepStrictEqual(h.submitted, ["message one"])
    await h.end("clear")
    submit.resolve({ text: "entered" })
    await settle()
    assert.deepStrictEqual(h.runs.map((r) => r[2]), ["attach", "pull"])
  })
})

describe("Claude plugin /vibest-reattach", () => {
  it("attaches with --replace for the current session and continues under the fresh generation", async () => {
    const h = host()
    h.state.replies.attach = async (argv) => (argv.includes("--replace") ? json({ generation: "g2" }) : json({ error: "stale-receiver" }))
    await h.start()
    await h.tick()
    assert.deepStrictEqual(h.live(), [])
    h.state.session = "s2"
    const reply = await h.command("vibest-reattach")
    assert.match(reply!.text!, /reattached/)
    assert.deepStrictEqual(h.runs.at(-1), ["vibest", "inbox", "attach", "s2", "--replace"])
    assert.strictEqual(h.live().length, 1, "polling resumes")
    await h.tick()
    assert.deepStrictEqual(h.runs.slice(-2), [
      ["vibest", "inbox", "pull", "g2", "s2"],
      ["vibest", "inbox", "ack", "g2", "s2", "t2"],
    ])
    assert.deepStrictEqual(h.submitted, ["message two"])
  })

  it("a refused reattach changes nothing and says why", async () => {
    const h = host()
    await h.start()
    await h.tick()
    h.state.replies.attach = async () => json({ error: "stale-receiver" })
    const reply = await h.command("vibest-reattach")
    assert.match(reply!.text!, /not reattached \(stale-receiver\)/)
    await h.tick()
    assert.deepStrictEqual(h.runs.at(-1)!.slice(2, 4), ["ack", "g1"])
  })

  it("fences an old-generation submit that finishes after reattach: it may land once, but never settles", async () => {
    const h = host()
    await h.start()
    await h.tick()
    const submit = gate<{ text: string }>()
    h.state.submit = () => submit.promise
    await h.tick()
    assert.deepStrictEqual(h.submitted, ["message one"])
    await h.command("vibest-reattach")
    submit.resolve({ text: "entered" })
    await settle()
    assert.isFalse(h.runs.some((r) => r[2] === "ack" && r[3] === "g1"), "the old generation's callback does not ack")
    h.state.submit = async () => ({ text: "entered" })
    await h.tick()
    assert.deepStrictEqual(h.runs.slice(-2).map((r) => r.slice(2, 4)), [["pull", "g2"], ["ack", "g2"]])
  })

  it("an old-generation pull that returns after reattach is not consumed", async () => {
    const h = host()
    await h.start()
    await h.tick()
    const pull = gate<RunResult>()
    h.state.replies.pull = () => pull.promise
    await h.tick()
    h.state.replies.pull = async (argv) => (argv[3] === "g2" ? json({ token: "t2", file: "/claims/g2-t2" }) : json({ empty: true }))
    await h.command("vibest-reattach")
    pull.resolve(json({ token: "t1", file: "/claims/g1-t1" }))
    await settle()
    assert.deepStrictEqual(h.reads, [])
    await h.tick()
    assert.deepStrictEqual(h.submitted, ["message two"])
    assert.deepStrictEqual(h.runs.filter((r) => r[2] === "ack").map((r) => r[3]), ["g2"])
  })

  it("polls the new generation while an old step is still unresolved; the old step cannot clear the new busy mark", async () => {
    const h = host()
    await h.start()
    await h.tick()
    const oldSubmit = gate<{ text: string }>()
    h.state.submit = () => oldSubmit.promise
    await h.tick()
    await h.command("vibest-reattach")
    h.state.submit = async () => ({ text: "entered" })
    await h.tick()
    const g2 = () => h.runs.filter((r) => r[3] === "g2").map((r) => r[2])
    assert.deepStrictEqual(g2(), ["pull", "ack"], "progress while the old submit is still pending")
    const newPull = gate<RunResult>()
    h.state.replies.pull = () => newPull.promise
    await h.tick()
    const reads = h.state.idReads
    oldSubmit.resolve({ text: "entered" })
    await settle()
    await h.tick()
    assert.strictEqual(h.state.idReads, reads, "the new step still owns the host: no second step started")
    assert.deepStrictEqual(g2(), ["pull", "ack", "pull"])
    assert.isFalse(h.runs.some((r) => r[3] === "g1" && r[2] !== "pull"), "the old generation never settles")
    newPull.resolve(json({ empty: true }))
    await settle()
    await h.tick()
    assert.deepStrictEqual(g2(), ["pull", "ack", "pull", "pull"])
  })

  it("runs one reattach at a time", async () => {
    const h = host()
    await h.start()
    await h.tick()
    const replace = gate<RunResult>()
    h.state.replies.attach = () => replace.promise
    const first = h.begin("vibest-reattach")
    await settle()
    const second = await h.begin("vibest-reattach")
    assert.match(second.text!, /already running/)
    replace.resolve(json({ generation: "g2" }))
    assert.match((await first).text!, /reattached/)
    assert.strictEqual(h.runs.filter((r) => r.includes("--replace")).length, 1)
  })

  it("a reattach answer that arrives after session.end is not used for the new session", async () => {
    const h = host()
    await h.start()
    await h.tick()
    const replace = gate<RunResult>()
    h.state.replies.attach = () => replace.promise
    const pending = h.begin("vibest-reattach")
    await settle()
    h.state.session = "s2"
    await h.end("clear")
    replace.resolve(json({ generation: "g2" }))
    assert.match((await pending).text!, /session changed while reattaching/)
    for (const t of h.timers) t.fn()
    await settle()
    assert.isFalse(h.runs.some((r) => r[3] === "g2"), "no delivery under the stale answer")
    assert.notInclude(h.statuses.at(-1)!, "attached")
    h.state.replies.attach = async () => json({ generation: "g3" })
    h.state.replies.pull = async () => json({ empty: true })
    assert.match((await h.command("vibest-reattach"))!.text!, /reattached/)
    await h.tick()
    assert.deepStrictEqual(h.runs.at(-1), ["vibest", "inbox", "pull", "g3", "s2"])
  })

  for (const [label, reply] of [
    ["exits non-zero", async (): Promise<RunResult> => ({ exitCode: 1, stdout: "", stderr: "connection reset" })],
    ["times out", async (): Promise<RunResult> => {
      throw new Error("timed out")
    }],
    ["prints no JSON", async (): Promise<RunResult> => ({ exitCode: 0, stdout: "garbage", stderr: "" })],
  ] as const) {
    it(`a replacement that may have committed but ${label} is reported as unknown and never replayed`, async () => {
      const h = host()
      await h.start()
      await h.tick()
      h.state.replies.attach = reply
      // The daemon committed the replacement: the old generation is retired.
      h.state.replies.pull = async (argv) => (argv[3] === "g1" ? json({ error: "stale-receiver" }) : json({ empty: true }))
      const before = h.statuses.length
      const answer = (await h.command("vibest-reattach"))!.text!
      assert.match(answer, /may have replaced this receiver/)
      assert.notMatch(answer, /unchanged/)
      assert.notInclude(h.statuses.slice(before), "VIBEST inbox attached", "never shown attached without a confirmed generation")
      await h.tick()
      await h.tick()
      assert.strictEqual(h.runs.filter((r) => r.includes("--replace")).length, 1, "not replayed")
      assert.match(h.statuses.at(-1)!, /another receiver/)
      assert.deepStrictEqual(h.live(), [])
      h.state.replies.attach = async () => json({ generation: "g3" })
      assert.match((await h.command("vibest-reattach"))!.text!, /reattached/)
    })
  }
})

describe("Claude plugin session lifetime", () => {
  it("a session.id read held across session.end cannot revive the ended session", async () => {
    const h = host()
    await h.start()
    await h.tick()
    const read = gate<string>()
    h.state.sessionId = () => read.promise
    await h.tick()
    await h.end("clear")
    read.resolve("s1")
    await settle()
    h.state.sessionId = undefined
    for (const t of h.timers) t.fn()
    await settle()
    assert.deepStrictEqual(h.runs, [["vibest", "inbox", "attach", "s1"]], "no pull under the ended lifetime")
    assert.match(h.statuses.at(-1)!, /session changed.*\/vibest-reattach/)
    assert.deepStrictEqual(h.live(), [], "session.end stops polling")
  })
})

describe("Claude plugin native listeners", () => {
  const worker = { VIBEST_AGENT: "session", VIBEST_SESSION_ID: "w1" }
  const below = { additionalContext: ["kept"] }
  const bash = { tool: "Bash", tool_use_id: "tu1", command: "ls", timeout: 5, description: "list" }

  const pass = (): RunResult => ({ exitCode: 0, stdout: "\n", stderr: "" })
  const denyBody = (reason: string) =>
    json({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    })

  it("Stop and StopFailure call vibest integration stop with the event, then return next unchanged", async () => {
    const h = host(worker)
    h.state.replies.stop = async () => pass()
    for (const [fire, name] of [
      [h.stop, "Stop"],
      [h.stopFailure, "StopFailure"],
    ] as const) {
      const event = { hook_event_name: name, session_id: "c1", last_assistant_message: "done", extra: true }
      const before = JSON.stringify(event)
      const result = await fire(event, async (e: object) => ({ echoed: e }))
      assert.strictEqual(JSON.stringify(event), before)
      assert.deepStrictEqual(result, { echoed: event })
    }
    assert.deepStrictEqual(h.runs, [
      ["vibest", "integration", "stop", "--harness", "claude"],
      ["vibest", "integration", "stop", "--harness", "claude"],
    ])
    assert.deepStrictEqual(
      h.inits.map((init) => JSON.parse((init as { stdin: string }).stdin).hook_event_name),
      ["Stop", "StopFailure"],
    )
    assert.deepStrictEqual(
      h.inits.map((init) => (init as { timeoutMs: number }).timeoutMs),
      [plugin.BRIDGE_TIMEOUT_MS, plugin.BRIDGE_TIMEOUT_MS],
    )
    assert.isTrue(h.inits.every((init) => !("env" in (init as object)) && !("cwd" in (init as object))))
  })

  it("forwards a subagent stop event for the bridge to ignore, and still returns next", async () => {
    const h = host(worker)
    h.state.replies.stop = async () => pass()
    const event = { hook_event_name: "Stop", agent_id: "sub", session_id: "c1" }
    const result = await h.stop(event, async () => below)
    assert.strictEqual(result, below)
    assert.deepStrictEqual(JSON.parse((h.inits[0] as { stdin: string }).stdin), event)
  })

  it("UserPromptSubmit reports a user-typed prompt, and skips the coordinator, a nested agent, and a non-user source", async () => {
    const h = host(worker)
    h.state.replies.prompt = async () => pass()
    const event = { hook_event_name: "UserPromptSubmit", session_id: "c1", prompt: "look here", source: "user" }
    const before = JSON.stringify(event)
    assert.deepStrictEqual(await h.prompt(event, async (e: object) => ({ echoed: e })), { echoed: event })
    assert.strictEqual(JSON.stringify(event), before)
    assert.deepStrictEqual(h.runs, [["vibest", "integration", "prompt", "--harness", "claude"]])
    assert.deepStrictEqual(JSON.parse((h.inits[0] as { stdin: string }).stdin), event)
    assert.strictEqual((h.inits[0] as { timeoutMs: number }).timeoutMs, plugin.BRIDGE_TIMEOUT_MS)

    for (const skipped of [
      { ...event, source: "system" },
      { ...event, source: "sdk" },
      { ...event, agent_id: "sub" },
    ]) {
      const quiet = host(worker)
      quiet.state.replies.prompt = async () => pass()
      assert.deepStrictEqual(await quiet.prompt(skipped, async () => below), below)
      assert.deepStrictEqual(quiet.runs, [])
    }
    const coordinator = host()
    coordinator.state.replies.prompt = async () => pass()
    assert.deepStrictEqual(await coordinator.prompt(event, async () => below), below)
    assert.deepStrictEqual(coordinator.runs, [])
    const outside = host({})
    outside.state.replies.prompt = async () => pass()
    assert.deepStrictEqual(await outside.prompt(event, async () => below), below)
    assert.deepStrictEqual(outside.runs, [])
  })

  it("a failed prompt bridge still returns next and does not block the prompt", async () => {
    const h = host(worker)
    h.state.replies.prompt = async () => Promise.reject(new Error("timed out"))
    const event = { hook_event_name: "UserPromptSubmit", prompt: "look here" }
    assert.strictEqual(await h.prompt(event, async () => below), below)
  })

  it("does not call the stop bridge outside VIBEST, or without a session id", async () => {
    for (const env of [{}, { VIBEST_AGENT: "session" }, { VIBEST_SESSION_ID: "w1" }, { VIBEST_AGENT: "", VIBEST_SESSION_ID: "w1" }]) {
      const h = host(env)
      const event = { hook_event_name: "Stop", session_id: "c1" }
      assert.deepStrictEqual(await h.stop(event, async () => below), below)
      assert.deepStrictEqual(h.runs, [])
    }
  })

  it("a failed stop bridge still returns next and does not block the turn", async () => {
    const h = host(worker)
    h.state.replies.stop = async () => Promise.reject(new Error("timed out"))
    const event = { hook_event_name: "Stop", session_id: "c1" }
    assert.strictEqual(await h.stop(event, async () => below), below)
  })

  it("PreToolUse maps the envelope to guard stdin, keeps the event, and returns next on an empty pass", async () => {
    const h = host(worker)
    h.state.replies.guard = async () => pass()
    const event = { ...bash }
    const before = JSON.stringify(event)
    let seen: object | undefined
    const result = await h.preTool(event, async (e: object) => {
      seen = e
      return below
    })
    assert.strictEqual(result, below)
    assert.strictEqual(seen, event)
    assert.strictEqual(JSON.stringify(event), before)
    assert.deepStrictEqual(h.runs, [["vibest", "integration", "guard", "--harness", "claude"]])
    assert.deepStrictEqual(h.inits, [{ stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls", timeout: 5, description: "list" }, cwd: "/work" }), timeoutMs: plugin.BRIDGE_TIMEOUT_MS }])
  })

  it("a valid denial returns deny and does not call next", async () => {
    const h = host(worker)
    h.state.replies.guard = async () => denyBody("off limits")
    let called = false
    const result = await h.preTool(bash, async () => {
      called = true
      return below
    })
    assert.isFalse(called)
    assert.deepStrictEqual(result, { deny: "off limits" })
  })

  it("nonzero, rejected, malformed and unexpected guard replies deny with the generic reason", async () => {
    const cases: Array<(argv: string[]) => Promise<RunResult>> = [
      async () => ({ exitCode: 2, stdout: "", stderr: "no" }),
      async () => Promise.reject(new Error("timed out")),
      async () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
      async () => json({ permission: "allow" }),
      async () => json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "no" } }),
      async () => json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "x" }, extra: true }),
    ]
    for (const reply of cases) {
      const h = host(worker)
      h.state.replies.guard = reply
      let called = false
      const result = await h.preTool(bash, async () => {
        called = true
        return below
      })
      assert.isFalse(called)
      assert.deepStrictEqual(result, { deny: plugin.GUARD_FAILURE })
    }
  })

  it("outside VIBEST, PreToolUse returns next and does not call vibest", async () => {
    const h = host({})
    const result = await h.preTool(bash, async () => below)
    assert.strictEqual(result, below)
    assert.deepStrictEqual(h.runs, [])
  })

  it("once VIBEST is known, a failed PreToolUse registration denies instead of passing", async () => {
    const inside = host(worker)
    let called = false
    const fresh = Object.assign(async () => {
      called = true
      return below
    }, { called: false, error: { kind: "throw" } })
    assert.deepStrictEqual(await inside.catches["classic.PreToolUse"]!(inside.$, bash, fresh), { deny: plugin.GUARD_FAILURE })
    assert.isFalse(called)

    const replayed = Object.assign(async () => below, { called: true, error: { kind: "timeout" } })
    assert.strictEqual(await inside.catches["classic.PreToolUse"]!(inside.$, bash, replayed), below)

    const outside = host({})
    assert.strictEqual(await outside.catches["classic.PreToolUse"]!(outside.$, bash, Object.assign(async () => below, { called: false })), undefined)
  })
})
